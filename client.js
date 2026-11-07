/**
 * 空间清理插件的浏览器半边。
 *
 * 挂在 conversation.composer.dock：输入框下方一行小字显示“可清理多少”，
 * 点开后向上弹出明细浮层，二次确认才真正清理。
 *
 * 浮层用 portal 挂到 body + position:fixed，并按 chip 的位置在视口内夹取，
 * 所以它只向上生长：底部永远不会被页面下沿裁掉，按钮固定贴在浮层底部，
 * 中间列表自己滚动。
 *
 * 冗余设计：
 *  - 浮层位置在打开/缩放/滚动时重算，夹在视口内；
 *  - 只读展示失败时保留上一次好数据并显示“不可用”，不假装 0；
 *  - 清理按钮需要两次点击（armed），防误触；
 *  - 请求可中止，卸载后不再 setState；
 *  - 轮询 60s + 页面重新可见时刷新；
 *  - 清理后以服务端重新扫描结果为准。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-space-clean',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;
    const createPortal = ReactDOM.createPortal;

    const REPORT_URL = 'api/dsh-space-clean/report';
    const CLEAN_URL = 'api/dsh-space-clean/clean';

    const DICT = {
      zh: {
        title: '空间占用',
        loading: '空间 · 读取中',
        unavailable: '空间 · 不可用',
        busy: '清理中…',
        cleanable: '可清理 {size}',
        clean: '空间干净',
        refresh: '刷新',
        cleaning: '正在清理…',
        empty: '暂时没有识别到可回收的目录。',
        dataTitle: '只统计、不清理',
        minAge: '闲置 ≥ {minutes} 分钟',
        total: '共 {size}',
        confirmHint: '将删除上列闲置目录，正在运行的任务不受影响。',
        confirm: '确认清理 {size}',
        cancel: '取消',
        done: '已释放 {size}，删除 {count} 个目录，跳过 {skipped} 个。',
        failed: '清理失败：{message}',
        truncated: '条目过多，只统计了前 {max} 个。',
        retryHint: '稍后自动重试。',
      },
      en: {
        title: 'Disk usage',
        loading: 'Space · reading',
        unavailable: 'Space · unavailable',
        busy: 'Cleaning…',
        cleanable: '{size} reclaimable',
        clean: 'Nothing to clean',
        refresh: 'Refresh',
        cleaning: 'Cleaning…',
        empty: 'No reclaimable directory was found right now.',
        dataTitle: 'Reported, never deleted',
        minAge: 'idle ≥ {minutes} min',
        total: '{size} total',
        confirmHint: 'These idle directories are deleted; running tasks are not touched.',
        confirm: 'Confirm: free {size}',
        cancel: 'Cancel',
        done: 'Freed {size}, removed {count} directories, skipped {skipped}.',
        failed: 'Cleanup failed: {message}',
        truncated: 'Too many entries; only the first {max} were measured.',
        retryHint: 'Retrying automatically.',
      },
    };

    function fmtBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return value + ' B';
      const units = ['KB', 'MB', 'GB', 'TB'];
      let scaled = value / 1024;
      let index = 0;
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
      }
      return (scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)) + ' ' + units[index];
    }

    function browserLang() {
      try {
        return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
      }
      catch {
        return 'en';
      }
    }

    /** 优先用宿主的 t，缺失或抛错时退回自带字典，保证文案永不空白。 */
    function makeT(external, lang) {
      const dict = DICT[lang] ?? DICT.en;
      return (key, vars) => {
        let text;
        if (typeof external === 'function') {
          try {
            text = external(key, vars);
          }
          catch {
            text = undefined;
          }
        }
        if (typeof text !== 'string' || text.length === 0 || text === key) text = dict[key] ?? DICT.en[key] ?? key;
        if (vars) {
          for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]));
        }
        return text;
      };
    }

    const tokens = {
      text: 'var(--dsw-alias-label-primary, #e8e8ea)',
      muted: 'var(--dsw-alias-label-tertiary, #9a9aa0)',
      panel: 'var(--dsw-alias-bg-layer-1, #1c1c1f)',
      border: 'var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))',
      accent: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      danger: 'var(--dsw-alias-state-error-primary, #e5534b)',
      ok: 'var(--dsw-alias-state-success-primary, #3fb950)',
    };

    const buttonBase = {
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      borderRadius: 8,
      padding: '4px 10px',
      cursor: 'pointer',
    };

    function Row(props) {
      return h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          gap: '4px 12px',
          padding: '5px 0',
          alignItems: 'baseline',
        },
      },
      h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.label),
      h('span', { style: { color: props.muted ? tokens.muted : tokens.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, props.value));
    }

    function SpaceClean(props) {
      const t = makeT(props && props.t, browserLang());
      const [report, setReport] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [open, setOpen] = useState(false);
      const [armed, setArmed] = useState(false);
      const [notice, setNotice] = useState(null);
      const [anchor, setAnchor] = useState(null);
      const rootRef = useRef(null);
      const panelRef = useRef(null);
      const abortRef = useRef(null);

      const load = useCallback(async () => {
        try {
          abortRef.current?.abort();
        }
        catch { /* 旧请求已结束 */ }
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const response = await fetch(REPORT_URL, {
            signal: controller.signal,
            cache: 'no-store',
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const body = await response.json();
          if (body && Array.isArray(body.categories)) {
            setReport(body);
            setError(null);
            return body;
          }
          throw new Error('malformed report');
        }
        catch (failure) {
          if (failure && failure.name === 'AbortError') return null;
          setError(failure instanceof Error ? failure.message : String(failure));
          return null;
        }
      }, []);

      useEffect(() => {
        void load();
        const timer = setInterval(() => {
          if (!document.hidden) void load();
        }, 60_000);
        const onVisible = () => {
          if (!document.hidden) void load();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
          try {
            abortRef.current?.abort();
          }
          catch { /* 已卸载 */ }
        };
      }, [load]);

      /** 把浮层夹在视口内，并且只向上生长。 */
      const measure = useCallback(() => {
        const node = rootRef.current;
        if (!node || typeof window === 'undefined') return;
        const rect = node.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const width = Math.min(360, Math.max(220, vw - 24));
        const left = Math.min(Math.max(12, rect.right - width), Math.max(12, vw - width - 12));
        const bottom = Math.max(8, vh - rect.top + 8);
        const maxHeight = Math.max(150, Math.min(340, rect.top - 16));
        setAnchor({ left, bottom, width, maxHeight });
      }, []);

      useEffect(() => {
        if (!open) {
          setAnchor(null);
          return undefined;
        }
        measure();
        const onMove = () => measure();
        window.addEventListener('resize', onMove);
        window.addEventListener('scroll', onMove, true);
        return () => {
          window.removeEventListener('resize', onMove);
          window.removeEventListener('scroll', onMove, true);
        };
      }, [open, measure]);

      useEffect(() => {
        if (!open) return undefined;
        const onDown = event => {
          const chip = rootRef.current;
          const panel = panelRef.current;
          const target = event.target;
          if (!(target instanceof Node)) return;
          if (chip && chip.contains(target)) return;
          if (panel && panel.contains(target)) return;
          setOpen(false);
          setArmed(false);
        };
        const onKey = event => {
          if (event.key === 'Escape') {
            setOpen(false);
            setArmed(false);
          }
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open]);

      const clean = useCallback(async () => {
        if (busy) return;
        const current = report;
        const ids = (current?.categories ?? []).filter(item => item.staleBytes > 0).map(item => item.id);
        if (ids.length === 0) return;
        setBusy(true);
        setNotice(null);
        try {
          const response = await fetch(CLEAN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ ids, confirm: true }),
          });
          let body = null;
          try {
            body = await response.json();
          }
          catch { /* 非 JSON 响应按状态码处理 */ }
          if (!response.ok) throw new Error((body && body.error) || 'HTTP ' + response.status);
          setNotice({
            kind: 'ok',
            text: t('done', {
              size: fmtBytes(body && body.freed),
              count: Array.isArray(body && body.removed) ? body.removed.length : 0,
              skipped: Array.isArray(body && body.skipped) ? body.skipped.length : 0,
            }),
          });
          setArmed(false);
          await load();
        }
        catch (failure) {
          setNotice({ kind: 'err', text: t('failed', { message: failure instanceof Error ? failure.message : String(failure) }) });
          setArmed(false);
        }
        finally {
          setBusy(false);
        }
      }, [busy, load, report, t]);

      const cleanable = report ? Number(report.totals?.cleanableBytes) || 0 : 0;
      const label = busy
        ? t('busy')
        : report
          ? (cleanable > 0 ? t('cleanable', { size: fmtBytes(cleanable) }) : t('clean'))
          : (error ? t('unavailable') : t('loading'));

      const chip = h('button', {
        type: 'button',
        'aria-expanded': String(open),
        title: error ? error + ' · ' + t('retryHint') : t('title'),
        onClick: () => {
          setArmed(false);
          setOpen(value => !value);
          if (!open) void load();
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 8px',
          margin: 0,
          border: '1px solid transparent',
          borderRadius: 999,
          background: open ? tokens.hover : 'transparent',
          color: error && !report ? tokens.danger : (cleanable > 0 ? tokens.text : tokens.muted),
          font: 'inherit',
          fontSize: 12,
          lineHeight: '18px',
          cursor: 'pointer',
        },
      }, h('span', { 'aria-hidden': true, style: { fontSize: 12, opacity: 0.9 } }, '◍'), h('span', null, label));

      // ---- 浮层内容：头部 / 可滚动的明细 / 固定底部按钮，三段分开构建。
      const header = h('div', {
        style: {
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid ' + tokens.border,
        },
      },
      h('strong', { style: { fontSize: 12, fontWeight: 600 } }, t('title')),
      h('button', {
        type: 'button',
        onClick: () => void load(),
        disabled: busy,
        style: { border: 'none', background: 'transparent', color: tokens.muted, font: 'inherit', fontSize: 12, cursor: busy ? 'default' : 'pointer', padding: 0 },
      }, t('refresh')));

      const categoryRows = (report?.categories ?? []).map(item => h(Row, {
        key: item.id,
        label: item.label + ' · ' + t('minAge', { minutes: item.minAgeMinutes }),
        value: fmtBytes(item.staleBytes) + ' / ' + t('total', { size: fmtBytes(item.bytes) }),
        muted: item.staleBytes === 0,
      }));

      const dataRows = (report?.data ?? []).map(item => h(Row, {
        key: 'data-' + item.id,
        label: item.label,
        value: item.bytes === null ? '—' : fmtBytes(item.bytes),
        muted: true,
      }));

      const scroll = h('div', { style: { overflowY: 'auto', flex: '1 1 auto', minHeight: 0, padding: '0 12px' } },
        categoryRows.length === 0
          ? h('div', { style: { color: tokens.muted, padding: '4px 0' } }, t('empty'))
          : categoryRows,
        report?.truncated
          ? h('div', { style: { color: tokens.danger, marginTop: 4 } }, t('truncated', { max: report.totals?.entries ?? 0 }))
          : null,
        dataRows.length > 0
          ? h('div', { style: { marginTop: 8, borderTop: '1px solid ' + tokens.border, paddingTop: 6 } },
            h('div', { style: { color: tokens.muted, marginBottom: 2 } }, t('dataTitle')),
            dataRows)
          : null,
        notice
          ? h('div', { role: 'status', style: { margin: '8px 0', color: notice.kind === 'ok' ? tokens.ok : tokens.danger } }, notice.text)
          : null);

      const idleButton = h('button', {
        type: 'button',
        onClick: () => setArmed(true),
        disabled: busy || cleanable <= 0,
        title: t('confirmHint'),
        style: {
          ...buttonBase,
          border: '1px solid ' + tokens.border,
          background: cleanable > 0 ? tokens.accent : 'transparent',
          color: cleanable > 0 ? '#fff' : tokens.muted,
          cursor: cleanable > 0 && !busy ? 'pointer' : 'default',
          opacity: cleanable > 0 ? 1 : 0.6,
        },
      }, busy ? t('cleaning') : t('cleanable', { size: fmtBytes(cleanable) }));

      const armedButtons = h(React.Fragment, null,
        h('span', { style: { color: tokens.muted, flex: '1 1 120px', minWidth: 0 } }, t('confirmHint')),
        h('button', {
          type: 'button',
          onClick: () => void clean(),
          disabled: busy,
          style: { ...buttonBase, border: 'none', background: tokens.danger, color: '#fff', cursor: busy ? 'default' : 'pointer' },
        }, busy ? t('cleaning') : t('confirm', { size: fmtBytes(cleanable) })),
        h('button', {
          type: 'button',
          onClick: () => setArmed(false),
          disabled: busy,
          style: { ...buttonBase, border: '1px solid ' + tokens.border, background: 'transparent', color: tokens.text },
        }, t('cancel')));

      const actions = h('div', {
        style: {
          flex: '0 0 auto',
          borderTop: '1px solid ' + tokens.border,
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        },
      }, armed ? armedButtons : idleButton);

      const panelContent = h('div', {
        ref: panelRef,
        role: 'dialog',
        'aria-label': t('title'),
        style: {
          position: 'fixed',
          left: anchor ? anchor.left : 12,
          bottom: anchor ? anchor.bottom : 72,
          width: anchor ? anchor.width : 320,
          maxHeight: anchor ? anchor.maxHeight : 320,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid ' + tokens.border,
          borderRadius: 12,
          background: tokens.panel,
          color: tokens.text,
          boxShadow: '0 8px 28px rgba(0,0,0,0.32)',
          fontSize: 12,
          lineHeight: '18px',
          textAlign: 'left',
          zIndex: 60,
        },
      }, header, scroll, actions);

      const portalTarget = typeof document !== 'undefined' && document.body ? document.body : null;
      const floating = open && portalTarget ? createPortal(panelContent, portalTarget) : null;

      return h('div', {
        ref: rootRef,
        style: { display: 'inline-flex', alignItems: 'center', position: 'relative', minWidth: 0 },
      }, chip, floating);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let localeKey;
        try {
          ctx.locale.register('spaceClean', { en: DICT.en, zh: DICT.zh });
          localeKey = 'spaceClean';
        }
        catch (failure) {
          // 注册字典失败不影响功能：组件内置文案兜底。
          ctx.logger?.warn?.('space-clean: locale registration failed: ' + (failure && failure.message ? failure.message : failure));
        }
        const options = { name: 'conversation.composer.dock', id: 'space-clean', order: 40 };
        if (localeKey) options.locale = localeKey;
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(options, SpaceClean));
      },
    };
  },
});
