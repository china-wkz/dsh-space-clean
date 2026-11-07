// DOM smoke test for the browser half of dsh-space-clean.
//
// It needs react, react-dom and jsdom, installed OUTSIDE this package (that keeps the
// plugin free of runtime dependencies):
//
//   mkdir -p "$TEMP/sc-smoke" && cd "$TEMP/sc-smoke"
//   npm init -y && npm i react@18 react-dom@18 jsdom
//
// Then run it with two environment variables:
//
//   SMOKE_ROOT="$TEMP/sc-smoke" \
//   PLUGIN_CLIENT="/absolute/path/to/dsh-space-clean/client.js" \
//   node smoke/dom-smoke.mjs
//
// It asserts: mount -> report read -> panel portalled with position:fixed -> first click
// does not clean -> second click posts {confirm:true} -> result notice -> Escape closes.
// 真实 DOM 冒烟：jsdom + react-dom/client，验证 chip → 点击 → 向上浮层 → 两次确认。
// 只验证交互与结构（jsdom 无布局，几何值不作为断言）。
import { createRequire } from 'node:module';

const requireFrom = process.env.SMOKE_ROOT;
if (!requireFrom) throw new Error('SMOKE_ROOT must point at the directory holding node_modules');
const require = createRequire(requireFrom + '/index.js');

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react-dom/test-utils');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div id="composer"></div></body></html>', {
  url: 'http://127.0.0.1:11240/',
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.getComputedStyle = window.getComputedStyle;
Object.defineProperty(window, 'innerWidth', { value: 1240, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
try {
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
} catch { /* 已有 navigator */ }

const report = {
  at: Date.now(),
  categories: [
    { id: 'subprocess', label: '子进程临时目录', minAgeMinutes: 120, entries: 15, staleEntries: 14, bytes: 18_300_000, staleBytes: 13_300_000, files: 9 },
    { id: 'spill', label: '命令输出溢出缓存', minAgeMinutes: 120, entries: 9, staleEntries: 0, bytes: 126_000, staleBytes: 0, files: 14 },
  ],
  data: [
    { id: 'sessions', label: '会话记录', bytes: 21_600_000, files: 40 },
    { id: 'attachments', label: '附件', bytes: 268_000_000, files: 90 },
  ],
  totals: { bytes: 18_426_000, cleanableBytes: 13_300_000, entries: 24 },
  truncated: false,
};

const requests = [];
globalThis.fetch = window.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
  if (String(url).includes('/clean')) {
    return { ok: true, status: 200, json: async () => ({ freed: 13_300_000, removed: [{ path: 'x', bytes: 13_300_000, id: 'subprocess' }], skipped: [], tookMs: 120 }) };
  }
  return { ok: true, status: 200, json: async () => report };
};

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let definition;
window.__ModuleLoader__ = { load: value => { definition = value; } };
await import(require('node:url').pathToFileURL(process.env.PLUGIN_CLIENT).href);

if (!definition || definition.id !== '@local/dsh-space-clean') throw new Error('module definition missing or misnamed');

const moduleExports = definition.factory(specifier => {
  if (specifier === 'react') return React;
  if (specifier === 'react-dom') return require('react-dom');
  throw new Error('unexpected require: ' + specifier);
});

let registered;
const ctx = {
  locale: { register: (key, dict) => { ctx._locale = [key, Object.keys(dict)]; } },
  slots: {
    inject: (owner, callback) => callback(),
    register: (options, component) => { registered = { options, component }; return () => {}; },
  },
  logger: { warn: message => console.error('warn:', message) },
};
moduleExports.apply(ctx);
if (!registered || registered.options.name !== 'conversation.composer.dock') throw new Error('slot registration missing');
if (registered.options.locale !== 'spaceClean') throw new Error('locale not attached');

const container = window.document.getElementById('composer');
const root = createRoot(container);
await act(async () => {
  root.render(React.createElement(registered.component, {}));
});

const chip = container.querySelector('button');
if (!chip) throw new Error('chip button missing');
if (!/可清理|reclaimable/.test(chip.textContent)) throw new Error('chip label should show reclaimable size, got: ' + chip.textContent);
if (requests.length === 0) throw new Error('report not fetched on mount');

await act(async () => {
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});

const dialog = window.document.body.querySelector('[role="dialog"]');
if (!dialog) throw new Error('panel portal missing after click');
const dialogStyle = dialog.getAttribute('style') ?? '';
if (!dialogStyle.includes('position: fixed')) throw new Error('panel should be position:fixed, got: ' + dialogStyle);
if (!dialogStyle.includes('z-index: 60')) throw new Error('panel z-index missing');
if (dialog.parentElement !== window.document.body) throw new Error('panel should be portalled to document.body');
if (!/空间占用|Disk usage/.test(dialog.textContent)) throw new Error('panel title missing');
if (!/子进程临时目录/.test(dialog.textContent)) throw new Error('category row missing');
if (!/只统计|Reported/.test(dialog.textContent)) throw new Error('data section missing');

// 第一次点击只是“待确认”，不能发清理请求。
const firstButton = [...dialog.querySelectorAll('button')].find(node => /可清理|reclaimable/.test(node.textContent));
if (!firstButton) throw new Error('clean button missing');
await act(async () => {
  firstButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});
if (requests.some(item => item.url.includes('/clean'))) throw new Error('first click must not clean');

const confirmButton = [...window.document.body.querySelectorAll('[role="dialog"] button')]
  .find(node => /确认清理|Confirm/.test(node.textContent));
if (!confirmButton) throw new Error('confirm button missing after arming');
if (!/正在运行的任务不受影响|running tasks/.test(window.document.body.querySelector('[role="dialog"]').textContent)) throw new Error('confirm hint missing');

await act(async () => {
  confirmButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});

const cleanCall = requests.find(item => item.url.includes('/clean'));
if (!cleanCall) throw new Error('clean request missing');
if (cleanCall.method !== 'POST') throw new Error('clean must be POST');
const payload = JSON.parse(cleanCall.body);
if (payload.confirm !== true || !Array.isArray(payload.ids) || payload.ids[0] !== 'subprocess') throw new Error('bad clean payload: ' + cleanCall.body);

const after = window.document.body.querySelector('[role="dialog"]');
if (!/已释放|Freed/.test(after.textContent)) throw new Error('result notice missing: ' + after.textContent.slice(0, 200));

await act(async () => {
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
if (window.document.body.querySelector('[role="dialog"]')) throw new Error('Escape did not close the panel');

await act(async () => {
  root.unmount();
});

console.log('requests:', requests.map(item => item.method + ' ' + item.url.replace('http://127.0.0.1:11240/', '')).join(', '));
console.log('SMOKE OK');
