# dsh-space-clean

一个 [DSH](https://github.com/deepseek-ai) 插件。在消息输入框下方显示 DSH / dsh-ops 临时文件的闲置占用，
二次确认后一键回收。

[English](README.en.md) | 中文

---

## 适用范围：它是为 dsh-ops **0.5.0** 的一个问题做的

dsh-ops 0.5.0 把随包 **Niubash** 设为 Windows 默认 shell。每条命令都会把一份私有执行副本暂存到
`%TEMP%\dsh-ops-niu-exec-<随机>`：

- 约 62 MB 的载荷树，加上
- 153 个命令 face，每个复制一份 4.65 MB 的 `winuxcmd.exe` ——

**实测每次约 787 MB。**

这份副本只在下发结果后的 `finally` 里删除（`dsh-ops/lib/shells/session-execution.js`），而这个暂存家族
**没有开机扫尾**——不像 `bash-ipc` 的 generation 有 `STAGING_TTL_MS` 和 `bash-runtime clean-cache`。
于是崩溃、强退、命令被杀、或 Windows 文件被占用，都会**永久**留下约 790 MB；13 次就够 10 GB。
作者已公开承认这个泄漏并预告 0.5.1 修复；写作时 `npm view dsh-ops dist-tags` 仍然是 `latest = 0.5.0`。

**对本插件的含义**

- 它是 0.5.0 的**临时补丁**。0.5.1 发布后，`niu-exec` 家族自然扫不到东西。
- 但之后仍然有用：下面其它 DSH 临时家族同样会累积，宿主从不回收。
- 它不改 dsh-ops，只按白名单前缀看目录、回收空闲的。

## 做了什么

1. 输入框下方一行小字：`◍ 可清理 12.7 MB`（没有可清理项时显示“空间干净”）。
2. 点开：面板**向上**弹出（portal + `position: fixed`，并夹在视口内），按家族列出占用，并显示每个家族
   的闲置门槛。
3. 两次点击才清理：第一次只是“待确认”，第二次才发请求；按钮固定在面板底部，列表再长也不会把它顶出屏幕。
4. 结果如实回报：释放多少字节、删了几个目录、跳过几个。
5. 另有一段“只统计、不清理”，显示用户数据目录的大小。

## 清理家族（白名单）

客户端永远不能传路径，只能传家族 id。

| 家族 id | 位置 | 最小闲置时间 |
| --- | --- | --- |
| `niu-exec` | `%TEMP%\dsh-ops-niu-exec-*` | 30 分钟 |
| `ops-session` | `%TEMP%\dsh-ops-session-*` | 24 小时 |
| `ops-ipc-stage` | `%TEMP%\stage-*`、`~/.dsh/dsh-ops/bash-ipc\stage-*` | 6 小时 |
| `spill` | `%TEMP%\dsh-spill-*` | 2 小时 |
| `subprocess` | `%TEMP%\dsh-subprocess-*` | 2 小时 |
| `acl-skill` | `%TEMP%\dsh-acl-skill-*` | 1 小时 |
| `workspace-changes` | `%TEMP%\dsh-workspace-changes-*` | 1 小时 |
| `quarantine` | `~/.dsh/dsh-ops/bash-ipc\*.bad-*`、`*.stale-*` | 24 小时 |
| `trash` | `*.deleting-*`（自己上次中断的清理残留） | 不限 |

只统计、**永不删除**：`~/.dsh/sessions`、`attachments`、`cache`、`skills`、`dsh-ops`、`dsh-runtimes`。

## 冗余设计

1. **只认白名单**：接口接收家族 id，不接收路径。
2. **闲置门槛**：不到门槛的目录永远不入选——你正在跑的那条命令的暂存副本被保护。
3. **原子认领**：先 `rename` 成 `*.deleting-<随机>`，再 `rm -rf`；改名失败（被占用）就跳过，不会删一半。
4. **单飞锁**：并发点第二次返回 `409 busy`，不会两个清理互相踩。
5. **逐条隔离**：一条失败不影响其余，每个跳过都带原因。
6. **有界执行**：4000 条目、8 秒扫描预算、30 秒执行预算；预算耗尽的扫描返回 `truncated: true`，不会挂住。
7. **只限本机**：拒绝带代理头（`X-Forwarded-For` / `CF-Connecting-IP`）的请求、跨站 Origin、非 loopback Host，
   方法只允许 `GET` / `POST`。
8. **必须确认**：`POST /clean` 不带 `confirm: true` 一律 `400`。
9. **诚实 UI**：读取失败保留上一次的好数据并显示“不可用”，绝不假装 0。
10. **幂等**：连点两次，第二次释放 0 字节、删除 0 个。
11. **不跟随符号链接**：统计与删除都不跟出去。
12. **只用主题 token**（`--dsw-alias-*`）并带 CSS 兜底：token 改名只会影响观感，不会白屏。

## 安装

在 DSH **0.2.2-rc.1** 发行线（客户端 `slots` + `dsh.client`）、Desktop profile、Windows 上验证。

1. 克隆本仓库（或复制目录）。
2. 在 DSH 里作为**本地 bundle** 安装：插件页 → 从本地目录安装；智能体侧则是 `plugin_manager` 工具，
   `action: install_bundle`，`target` 指向本包目录。
3. 安装后**刷新页面**：浏览器 bundle 从磁盘取，页面需要重新加载才会挂上。

包名是 `@local/dsh-space-clean`（按本地 bundle 命名）；fork 后可自行改名，注意包名、行 id `space-clean`
与客户端模块 id 三者保持一致。

## HTTP 接口

由宿主半边注册在 DSH web server 上，客户端用文档相对路径调用。

| 方法 | 路径 | 请求体 | 返回 |
| --- | --- | --- | --- |
| `GET` | `/api/dsh-space-clean/report` | — | 家族、字节数、闲置门槛、只统计数据目录 |
| `POST` | `/api/dsh-space-clean/clean` | `{ "ids": ["niu-exec"], "confirm": true }` | `{ freed, removed, skipped, tookMs }` |

## 测试

- `node --check index.js client.js` —— 语法。
- `smoke/dom-smoke.mjs` —— jsdom + `react-dom/client`：挂载 → 读报告 → 开面板 → 断言 portal /
  `position: fixed` / `z-index` → 第一次点击**不**清理 → 第二次点击才 POST `{ confirm: true }` →
  结果提示 → `Esc` 关闭 → 卸载。所需两个环境变量见文件头注释。
- 宿主路由在 Windows 上实测：报告 `200`；带 `X-Forwarded-For` 的请求 `403`；不带 `confirm` 的 `POST` `400`；
  真实清理一次释放 1.3 MB、删除 40 个目录、耗时 323 ms、0 跳过。

## 已知限制

- 前缀表是 Windows 形状的，因为 dsh-ops 就在那里暂存；根目录取自 `os.tmpdir()` 与 `$DSH_HOME`，逻辑在
  其它平台同样成立。
- 被活进程占用的目录每次都会被跳过，不做排队；稍后重试即可。
- 小字挂在 `conversation.composer.dock` 上，因此继承 composer 的层叠规则，弹层才用 portal。

## 许可

MIT，见 [LICENSE](LICENSE)。
