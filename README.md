# dsh-space-clean

A [DSH](https://github.com/deepseek-ai) plugin. It shows, under the message composer, how much space stale
DSH / dsh-ops temporary files are holding, and reclaims them after a two-step confirmation.

English | [中文](README.zh.md)

---

## Scope: this exists because of a dsh-ops **0.5.0** problem

dsh-ops 0.5.0 makes the packaged **Niubash** payload the default Windows shell. Every command stages a private
execution copy into `%TEMP%\dsh-ops-niu-exec-<random>`:

- the ~62 MB payload tree, plus
- one 4.65 MB `winuxcmd.exe` copy per command face (153 faces) —

**≈ 787 MB per call, measured on a real machine.**

That copy is deleted in a `finally` after the command settles
(`dsh-ops/lib/shells/session-execution.js`), and this staging family has **no startup sweep** — unlike the
`bash-ipc` generations, which have `STAGING_TTL_MS` plus a `bash-runtime clean-cache` command. So a crash, a
force-quit, a killed command, or a Windows file lock leaves ~790 MB behind **permanently**. Thirteen leftovers
reach 10 GB. The plugin author has acknowledged the leak publicly and announced a 0.5.1 fix; at the time of
writing `npm view dsh-ops dist-tags` still answers `latest = 0.5.0`.

**What that means for this plugin**

- It is a **stopgap for 0.5.0**. After 0.5.1 lands, the `niu-exec` family simply reports nothing.
- It remains useful afterwards: the other DSH temp families below also accumulate and are never reclaimed by the host.
- It does not patch dsh-ops. It only looks at whitelisted temp prefixes and reclaims idle ones.

## What it does

1. A small chip under the composer: `◍ 12.7 MB reclaimable` (or `空间干净` when there is nothing).
2. Click it: a panel opens **upward** (portal + `position: fixed`, clamped inside the viewport) with a per-family
   breakdown and the idle threshold applied to each family.
3. Two clicks to clean: the first arms the action, the second posts it. The button stays pinned at the panel
   bottom, so a long list cannot push it off-screen.
4. The panel reports what actually happened: freed bytes, removed directories, skipped ones.
5. A separate "reported, never deleted" section shows the size of user-data directories.

## Cleanup families (whitelist)

The client can never name a path — only these family ids.

| Family id | Location | Min idle time |
| --- | --- | --- |
| `niu-exec` | `%TEMP%\dsh-ops-niu-exec-*` | 30 min |
| `ops-session` | `%TEMP%\dsh-ops-session-*` | 24 h |
| `ops-ipc-stage` | `%TEMP%\stage-*`, `~/.dsh/dsh-ops/bash-ipc\stage-*` | 6 h |
| `spill` | `%TEMP%\dsh-spill-*` | 2 h |
| `subprocess` | `%TEMP%\dsh-subprocess-*` | 2 h |
| `acl-skill` | `%TEMP%\dsh-acl-skill-*` | 1 h |
| `workspace-changes` | `%TEMP%\dsh-workspace-changes-*` | 1 h |
| `quarantine` | `~/.dsh/dsh-ops/bash-ipc\*.bad-*`, `*.stale-*` | 24 h |
| `trash` | `*.deleting-*` (our own interrupted runs) | none |

Reported only, **never deleted**: `~/.dsh/sessions`, `attachments`, `cache`, `skills`, `dsh-ops`, `dsh-runtimes`.

## Safety design (redundancy)

1. **Whitelist only.** The HTTP API takes family ids, never paths.
2. **Idle gates.** A directory younger than its family threshold is never a candidate — the staging copy of the
   command you are running right now is protected.
3. **Atomic claim.** Each candidate is `rename`d to `*.deleting-<rand>` before `rm -rf`; a rename that fails
   because the directory is in use means it is skipped, not half-deleted.
4. **Single flight.** A module-level lock makes a concurrent second click answer `409 busy` instead of racing.
5. **Per-item isolation.** One failure never aborts the run; each skip carries its reason.
6. **Bounded work.** 4 000 entries, 8 s scan budget, 30 s run budget; an exhausted scan returns
   `truncated: true` instead of hanging.
7. **Loopback only.** The host refuses proxied requests (`X-Forwarded-For` / `CF-Connecting-IP`), cross-site
   origins, non-loopback hosts, and any method other than `GET` / `POST`.
8. **Confirm required.** `POST /clean` without `confirm: true` is `400`.
9. **Honest UI.** A failed report keeps the last good numbers and shows "unavailable"; it never renders 0.
10. **Idempotent.** Running it twice frees 0 bytes and reports nothing removed.
11. **Symlinks are never followed** during measurement or deletion.
12. **Theme tokens only** (`--dsw-alias-*`) with CSS fallbacks, so a renamed token degrades the look but never
    breaks rendering.

## Install

Tested against the DSH **0.2.2-rc.1** line (client `slots` + `dsh.client`), Desktop profile, Windows.

1. Clone this repository (or copy the directory).
2. Install it as a **local bundle** in DSH: Plugins page → install from a local directory, or, for an agent,
   the `plugin_manager` tool with `action: install_bundle` and this package directory as `target`.
3. **Reload the page** after installation: the browser bundle is served from disk and the page has to pick it up.

The package name is `@local/dsh-space-clean` because it is authored as a local bundle; fork and rename freely
(the row id `space-clean` and the client module id must stay in sync with the package name).

## HTTP API

Served by the host half on the DSH web server; the client calls them document-relative.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| `GET` | `/api/dsh-space-clean/report` | — | families, bytes, idle thresholds, report-only sizes |
| `POST` | `/api/dsh-space-clean/clean` | `{ "ids": ["niu-exec"], "confirm": true }` | `{ freed, removed, skipped, tookMs }` |

## Tests

- `node --check index.js client.js` — syntax.
- `smoke/dom-smoke.mjs` — jsdom + `react-dom/client`: mount → read report → open panel → assert portal /
  `position: fixed` / `z-index` → first click does **not** clean → second click posts `{ confirm: true }` →
  result notice → `Esc` closes → unmount. See the file header for the two environment variables it needs.
- Host routes verified live on Windows: report `200`; `X-Forwarded-For` request `403`; `POST` without `confirm`
  `400`; a real run freed 1.3 MB across 40 directories in 323 ms with zero skips.

## Limitations

- The prefix table is Windows-shaped because that is where dsh-ops stages its copies; the roots come from
  `os.tmpdir()` and `$DSH_HOME`, so the same logic runs elsewhere.
- A directory held open by a live process is skipped each run. It is not queued; retry later.
- The chip is a contribution to `conversation.composer.dock`; it inherits the composer's stacking rules and uses
  a portal for the popover for that reason.

## License

MIT — see [LICENSE](LICENSE).
