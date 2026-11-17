/**
 * dsh-self-card —— 客户端：侧边栏入口 + 只读面板（iframe → 插件自己的路由）
 *
 * 面板就是 iframe 到服务端那份页面，同源、带认证，不需要额外桥接。
 * 侧栏名字和后端路由都走 config：分发包用默认的「我是谁」，本机可以在
 * profiles/web/cordis.patch.yml 里覆盖成自己喜欢的叫法和路径。
 */
window.__ModuleLoader__.load({
  id: 'dsh-self-card',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const jsx = require('react/jsx-runtime').jsx;
    const react = require('react');

    const PANEL_ID = 'self-card';
    const DEFAULTS = { prefix: '/self-card', label: '我是谁' };

    const NS = 'dsh-self-card';
    const zh = {
      panelLabel: '我是谁',
      checking: '正在读取…',
      notReady: '面板还没就绪',
      notReadyHint: '插件刚装好时需要重启一次 App（引擎会重新加载插件）。',
    }
    const en = {
      panelLabel: 'Who am I',
      checking: 'Loading…',
      notReady: 'Panel is not ready yet',
      notReadyHint: 'Restart the App once after installing the plugin so the engine reloads it.',
    }
    let T = (key, params) => {
      const template = zh[key] === undefined ? key : zh[key];
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
    };

    function settings(config) {
      var raw = config && typeof config === 'object' ? config : {};
      var prefix = typeof raw.prefix === 'string' && raw.prefix ? raw.prefix : DEFAULTS.prefix;
      if (prefix.charAt(0) !== '/') prefix = '/' + prefix;
      return {
        prefix: prefix.replace(/\/+$/, ''),
        label: typeof raw.label === 'string' && raw.label ? raw.label : T('panelLabel'),
      };
    }

    /** 地平线上升起的一道光：半个日轮 + 三道光芒 + 水平线。 */
    function LightIcon({ size }) {
      const s = size || 16;
      const st = { stroke: 'currentColor', strokeWidth: 1.15, fill: 'none', strokeLinecap: 'round' };
      return jsx('svg', {
        width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        children: [
          jsx('path', { key: 'sun', d: 'M4.6 10.6a3.4 3.4 0 0 1 6.8 0', ...st }),
          jsx('path', { key: 'r1', d: 'M8 3.2v1.6', ...st }),
          jsx('path', { key: 'r2', d: 'M3.3 5.6l1.1 1.1', ...st }),
          jsx('path', { key: 'r3', d: 'M12.7 5.6l-1.1 1.1', ...st }),
          jsx('path', { key: 'w1', d: 'M2.2 10.6h11.6', ...st }),
          jsx('path', { key: 'w2', d: 'M4.6 12.9h6.8', ...st }),
        ],
      });
    }

    function makePanel(cfg) {
      return function Panel() {
        const [state, setState] = react.useState('checking');
        react.useEffect(() => {
          let alive = true;
          fetch(cfg.prefix + '/api/me', { cache: 'no-store' })
            .then((r) => (r.ok ? 'ok' : Promise.reject(new Error('HTTP ' + r.status))))
            .then(() => { if (alive) setState('ok'); })
            .catch(() => { if (alive) setState('down'); });
          return () => { alive = false; };
        }, []);
        if (state === 'checking') {
          return jsx('div', { style: { padding: 18, fontSize: 13, opacity: 0.7 }, children: T('checking') });
        }
        if (state === 'down') {
          return jsx('div', { style: { padding: 18, fontSize: 13, lineHeight: 1.75 }, children: [
            jsx('div', { key: 't', style: { fontWeight: 600, marginBottom: 6 }, children: T('notReady') }),
            jsx('div', { key: 'd', style: { opacity: 0.75 }, children: T('notReadyHint') }),
          ] });
        }
        return jsx('iframe', {
          src: cfg.prefix + '/',
          title: cfg.label,
          style: { border: 0, width: '100%', height: '100%', display: 'block', background: 'transparent' },
        });
      };
    }

    const inject = ['slots', 'layout', 'locale'];
    async function apply(ctx, config) {
      T = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'self-card: zh');
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'self-card: en');
      const cfg = settings(config);
      // 浏览器侧的 entry 不带 patch 里的 config，所以叫法问服务端要一次（/api/me 的 meta）；
      // 拿不到就退回默认的中性名，面板照常能用。
      try {
        const r = await fetch(cfg.prefix + '/api/me', { cache: 'no-store' });
        if (r.ok) {
          const data = await r.json();
          const meta = data && data.meta;
          if (meta && typeof meta.label === 'string' && meta.label) cfg.label = meta.label;
        }
      } catch { /* 用默认值 */ }
      const Panel = makePanel(cfg);
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID, inject: () => ({}),
      }, Panel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 41, label: () => cfg.label,
      }, LightIcon));
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
