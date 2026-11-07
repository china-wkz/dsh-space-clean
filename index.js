/**
 * 空间清理插件的 Host 半边。
 *
 * 只做两件事：
 *  1. 扫描已知的 DSH / dsh-ops 临时目录家族，报告每个家族的占用与可清理量；
 *  2. 在用户确认后，把“确实空闲”的目录原子改名后再删除。
 *
 * 冗余设计（任何一条失效都不至于删坏东西）：
 *  - 只认白名单前缀，客户端永远不能传路径；
 *  - 每个家族有最小存活时间，正在跑的命令不会被删；
 *  - 先 rename 认领再 rm，rename 失败（被占用）就跳过并报告原因；
 *  - 单飞锁：并发点两次只会跑一次；
 *  - 单条失败不影响其余条目，结果里逐条给出原因；
 *  - 有时限和条目上限，扫描慢时返回“不完整”而不是超时崩掉；
 *  - 只统计大小、只读的数据目录（会话/附件/技能）标为不可清理。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

export const name = 'space-clean';
export const inject = ['webServer'];

const ROUTE_BASE = '/api/dsh-space-clean';
const BODY_LIMIT = 64 * 1024;
const MAX_ENTRIES = 4000;
const SCAN_BUDGET_MS = 8000;
const DATA_BUDGET_MS = 5000;
const REPORT_TTL_MS = 60_000;
const MAX_RUN_MS = 30_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 可清理的临时目录家族；minAgeMs 是“可以被视为空闲”的最小存活时间。 */
export const FAMILIES = [
    { id: 'niu-exec', prefix: 'dsh-ops-niu-exec-', minAgeMs: 30 * MINUTE, label: 'Niubash 执行副本' },
    { id: 'ops-session', prefix: 'dsh-ops-session-', minAgeMs: 24 * HOUR, label: 'dsh-ops 会话临时目录' },
    { id: 'ops-ipc-stage', prefix: 'stage-', minAgeMs: 6 * HOUR, label: 'Bash 运行时中断暂存' },
    { id: 'spill', prefix: 'dsh-spill-', minAgeMs: 2 * HOUR, label: '命令输出溢出缓存' },
    { id: 'subprocess', prefix: 'dsh-subprocess-', minAgeMs: 2 * HOUR, label: '子进程临时目录' },
    { id: 'acl-skill', prefix: 'dsh-acl-skill-', minAgeMs: 1 * HOUR, label: '沙箱 ACL 探测目录' },
    { id: 'workspace-changes', prefix: 'dsh-workspace-changes-', minAgeMs: 1 * HOUR, label: '工作区变更快照' },
    { id: 'trash', prefix: '.deleting-', minAgeMs: 0, label: '上次中断的清理残留' },
];

/** 只统计、不清理的目录（里面有用户数据，删了不可恢复）。 */
const DATA_TARGETS = [
    { id: 'sessions', sub: 'sessions', label: '会话记录' },
    { id: 'attachments', sub: 'attachments', label: '附件' },
    { id: 'cache', sub: 'cache', label: '缓存' },
    { id: 'skills', sub: 'skills', label: '技能' },
    { id: 'dsh-ops', sub: 'dsh-ops', label: 'dsh-ops 运行时' },
    { id: 'dsh-runtimes', sub: 'dsh-runtimes', label: '内置 Node / Python' },
];

const QUARANTINE = /\.(bad|stale)-[a-z0-9]+$/i;

const home = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const tempRoot = () => process.env.DSH_SPACE_CLEAN_TEMP || os.tmpdir();

// ---------------------------------------------------------------- 扫描

/** 判断一个目录名属于哪个可清理家族。 */
function familyOf(entryName) {
    for (const family of FAMILIES) {
        if (entryName.startsWith(family.prefix)) return family;
    }
    if (QUARANTINE.test(entryName)) return { id: 'quarantine', minAgeMs: 24 * HOUR, label: 'Bash 运行时隔离副本' };
    return undefined;
}

/** 递归统计一个目录的真实字节数；符号链接一律跳过，不跟出去。 */
async function measure(target, deadline) {
    let bytes = 0;
    let files = 0;
    const stack = [target];
    while (stack.length > 0) {
        if (Date.now() > deadline) return { bytes, files, complete: false };
        const current = stack.pop();
        let entries;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (Date.now() > deadline) return { bytes, files, complete: false };
            const child = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                stack.push(child);
            }
            else if (entry.isFile()) {
                try {
                    const info = await fs.lstat(child);
                    bytes += info.size;
                    files += 1;
                }
                catch { /* 读不到就跳过，不打断整体统计 */ }
            }
        }
    }
    return { bytes, files, complete: true };
}

/** 扫描一个根目录下所有能识别的家族条目。 */
async function scanRoot(root, deadline) {
    const rows = [];
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    }
    catch {
        return rows;
    }
    const now = Date.now();
    for (const entry of entries) {
        if (rows.length >= MAX_ENTRIES || Date.now() > deadline) break;
        if (!entry.isDirectory()) continue;
        const family = familyOf(entry.name);
        if (!family) continue;
        const target = path.join(root, entry.name);
        let info;
        try {
            info = await fs.lstat(target);
        }
        catch {
            continue;
        }
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        rows.push({
            id: family.id,
            label: family.label,
            path: target,
            name: entry.name,
            minAgeMs: family.minAgeMs,
            ageMs: Math.max(0, now - info.mtimeMs),
            eligible: now - info.mtimeMs >= family.minAgeMs,
        });
    }
    for (const row of rows) {
        if (Date.now() > deadline) break;
        const size = await measure(row.path, deadline);
        row.bytes = size.bytes;
        row.files = size.files;
    }
    return rows;
}

/** 汇总一次完整报告。 */
export async function buildReport() {
    const now = Date.now();
    const scanDeadline = now + SCAN_BUDGET_MS;

    const tempRows = await scanRoot(tempRoot(), scanDeadline);
    const ipcRows = await scanRoot(path.join(home(), 'dsh-ops', 'bash-ipc'), scanDeadline);
    const rows = [...tempRows, ...ipcRows];

    const byFamily = new Map();
    for (const row of rows) {
        const bucket = byFamily.get(row.id) ?? {
            id: row.id,
            label: row.label,
            minAgeMinutes: Math.round(row.minAgeMs / MINUTE),
            entries: 0,
            staleEntries: 0,
            bytes: 0,
            staleBytes: 0,
            files: 0,
        };
        bucket.entries += 1;
        bucket.bytes += row.bytes ?? 0;
        bucket.files += row.files ?? 0;
        if (row.eligible) {
            bucket.staleEntries += 1;
            bucket.staleBytes += row.bytes ?? 0;
        }
        byFamily.set(row.id, bucket);
    }

    const categories = [...byFamily.values()].sort((a, b) => b.staleBytes - a.staleBytes || b.bytes - a.bytes);
    const data = [];
    const dataDeadline = Date.now() + DATA_BUDGET_MS;
    for (const target of DATA_TARGETS) {
        if (Date.now() > dataDeadline) {
            data.push({ id: target.id, label: target.label, path: path.join(home(), target.sub), bytes: null, files: null, note: 'skipped: time budget' });
            continue;
        }
        const dir = path.join(home(), target.sub);
        const size = await measure(dir, dataDeadline);
        data.push({
            id: target.id,
            label: target.label,
            path: dir,
            bytes: size.bytes,
            files: size.files,
            complete: size.complete,
            cleanable: false,
        });
    }

    const totalBytes = categories.reduce((sum, item) => sum + item.bytes, 0);
    const cleanableBytes = categories.reduce((sum, item) => sum + item.staleBytes, 0);

    return {
        at: now,
        platform: process.platform,
        roots: { temp: tempRoot(), home: home() },
        categories,
        data,
        totals: { bytes: totalBytes, cleanableBytes, entries: rows.length },
        truncated: rows.length >= MAX_ENTRIES,
    };
}

// ---------------------------------------------------------------- 清理

let running = false;

/** 认领并删除一个目录：先原子改名，改不动就是有人在用。 */
async function claimAndRemove(row) {
    const claim = `${row.path}.deleting-${randomBytes(3).toString('hex')}`;
    try {
        await fs.rename(row.path, claim);
    }
    catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const reason = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' ? 'in-use' : (code || 'rename-failed');
        return { ok: false, reason };
    }
    try {
        await fs.rm(claim, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
        return { ok: true, reason: undefined };
    }
    catch (error) {
        // 改名成功但删不掉：残留带 .deleting- 前缀，下次扫描自动回收。
        return { ok: false, reason: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'remove-failed' };
    }
}

/** 按家族清理；返回逐条结果，绝不整体失败。 */
export async function cleanFamilies(ids) {
    const wanted = new Set(ids);
    const started = Date.now();
    const deadline = started + MAX_RUN_MS;
    const tempRows = await scanRoot(tempRoot(), deadline);
    const ipcRows = await scanRoot(path.join(home(), 'dsh-ops', 'bash-ipc'), deadline);
    const candidates = [...tempRows, ...ipcRows]
        .filter(row => wanted.has(row.id) && row.eligible)
        .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));

    const removed = [];
    const skipped = [];
    let freed = 0;
    for (const row of candidates) {
        if (Date.now() > deadline) {
            skipped.push({ path: row.path, reason: 'time-budget' });
            continue;
        }
        const outcome = await claimAndRemove(row);
        if (outcome.ok) {
            removed.push({ path: row.path, bytes: row.bytes ?? 0, id: row.id });
            freed += row.bytes ?? 0;
        }
        else {
            skipped.push({ path: row.path, reason: outcome.reason, id: row.id });
        }
    }
    return { freed, removed, skipped, tookMs: Date.now() - started, candidates: candidates.length };
}

// ---------------------------------------------------------------- HTTP

function isIPv4Loopback(value) {
    const parts = String(value).split('.');
    return parts.length === 4 && parts[0] === '127'
        && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isLoopbackName(value) {
    const text = String(value).toLowerCase();
    if (text === '::1' || text === '[::1]' || text === 'localhost') return true;
    if (text.startsWith('::ffff:')) return isIPv4Loopback(text.slice(7));
    return isIPv4Loopback(text);
}

/** 只接受本机直连的同源请求：反向代理、跨站请求一律拒绝。 */
function allowed(req) {
    const socket = req.socket && req.socket.remoteAddress;
    if (!isLoopbackName(socket)) return false;
    if (req.headers['cf-connecting-ip'] !== undefined || req.headers['x-forwarded-for'] !== undefined) return false;
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== 'string') return false;
    let hostUrl;
    try {
        hostUrl = new URL(`http://${hostHeader}`);
    }
    catch {
        return false;
    }
    if (!isLoopbackName(hostUrl.hostname)) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
        return new URL(origin).host === hostUrl.host;
    }
    catch {
        return false;
    }
}

function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
    });
    res.end(payload);
}

/** 读取并限制请求体。 */
async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('body-too-large');
        chunks.push(chunk);
    }
    if (size === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

let cached = null;

export async function commandReport() {
    if (cached && Date.now() - cached.at < REPORT_TTL_MS) return cached.value;
    const value = await buildReport();
    cached = { at: Date.now(), value };
    return value;
}

export function apply(ctx) {
    const routes = [
        {
            kind: 'exact',
            path: `${ROUTE_BASE}/report`,
            handler: async (req, res) => {
                if (!allowed(req)) return send(res, 403, { error: 'forbidden: loopback-only' });
                if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
                try {
                    return send(res, 200, await commandReport());
                }
                catch (error) {
                    ctx.logger?.warn?.(`space-clean: report failed: ${error?.message ?? error}`);
                    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        },
        {
            kind: 'exact',
            path: `${ROUTE_BASE}/clean`,
            handler: async (req, res) => {
                if (!allowed(req)) return send(res, 403, { error: 'forbidden: loopback-only' });
                if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
                if (running) return send(res, 409, { error: 'busy: another cleanup is running' });
                let body;
                try {
                    body = await readBody(req, BODY_LIMIT);
                }
                catch (error) {
                    return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
                }
                if (body?.confirm !== true) return send(res, 400, { error: 'confirm required' });
                const ids = Array.isArray(body.ids) ? body.ids.filter(id => typeof id === 'string') : [];
                const known = new Set(FAMILIES.map(family => family.id).concat('quarantine'));
                const selected = ids.filter(id => known.has(id));
                if (selected.length === 0) return send(res, 400, { error: 'no known category selected' });
                running = true;
                try {
                    const result = await cleanFamilies(selected);
                    cached = null;
                    ctx.logger?.info?.(`space-clean: freed ${result.freed} bytes from ${result.removed.length} directories`);
                    return send(res, 200, result);
                }
                catch (error) {
                    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
                }
                finally {
                    running = false;
                }
            },
        },
    ];
    ctx.effect(() => {
        const disposers = routes.map(route => ctx.webServer.register(route));
        return () => {
            for (const dispose of disposers) {
                try {
                    dispose();
                }
                catch { /* 卸载阶段不再抛错 */ }
            }
        };
    }, 'space-clean: routes');
}
