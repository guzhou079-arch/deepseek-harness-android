/**
 * dsh-user-profile —— 客户端半边：侧边栏「我」入口 + 资料面板
 *
 * 面板是 iframe，内容由引擎自己的 /user-profile 提供（同源、带认证，见 lib/index.js）。
 * 图标画成 16px 描边 SVG，跟侧栏那排图标同风格（不用 emoji、不用文字）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-user-profile',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const jsx = require('react/jsx-runtime').jsx;
    const react = require('react');

    const PANEL_ID = 'user-profile';

    /** 「我」的图标：一个头 + 肩膀的极简人形。 */
    function ProfileIcon({ size }) {
      const s = size || 16;
      const stroke = { stroke: 'currentColor', strokeWidth: 1.15, fill: 'none' };
      return jsx('svg', {
        width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        children: [
          jsx('circle', { key: 'a', cx: 8, cy: 5.1, r: 2.55, ...stroke }),
          jsx('path', {
            key: 'b',
            d: 'M3.15 13.1c0-2.35 2.17-3.85 4.85-3.85s4.85 1.5 4.85 3.85',
            ...stroke,
          }),
        ],
      });
    }

    function ProfilePanel() {
      const [state, setState] = react.useState('checking');
      const [src, setSrc] = react.useState(null);

      react.useEffect(() => {
        let alive = true;
        // 只看「有没有响应」：200/5xx 都交给页面显示真原因（同 memory-ui 的教训）
        fetch('/user-profile/api/profile', { cache: 'no-store' })
          .then((r) => {
            const ct = (r.headers && typeof r.headers.get === 'function' && r.headers.get('content-type')) || '';
            if (r.ok || ct.indexOf('application/json') >= 0) return '/user-profile/';
            return Promise.reject(new Error('HTTP ' + r.status));
          })
          .then((base) => { if (alive) { setSrc(base); setState('ok'); } })
          .catch(() => { if (alive) setState('down'); });
        return () => { alive = false; };
      }, []);

      if (state === 'checking') {
        return jsx('div', { style: { padding: 18, fontSize: 13, opacity: 0.7 }, children: T("正在连接…") });
      }
      if (state === 'down') {
        return jsx('div', { style: { padding: 18, fontSize: 13, lineHeight: 1.75 }, children: [
          jsx('div', { key: 't', style: { fontWeight: 600, marginBottom: 6 }, children: T("用户资料服务未就绪") }),
          jsx('div', { key: 'd', style: { opacity: 0.75 }, children: T("插件刚装好时需要重启一次 App（引擎会重新加载插件）。") }),
        ] });
      }
      return jsx('iframe', {
        src,
        title: T("用户资料"),
        style: { border: 0, width: '100%', height: '100%', display: 'block', background: 'transparent' },
      });
    }

    const NS = "dsh-user-profile";
/** 中文原文即 key：zh 不需要词典（缺词回落成 key 本身），只维护 en。 */
const en = {
 "正在连接…": "Connecting…",
 "用户资料服务未就绪": "User profile service is not ready",
 "插件刚装好时需要重启一次 App（引擎会重新加载插件）。": "Restart the App once after installing the plugin (the engine reloads plugins).",
 "用户资料": "User profile",
 "用户设定": "User settings"
};
let T = (key, params) => {
  const template = en[key] === undefined ? key : en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
};

const inject = ['slots', 'layout', 'locale'];

    function apply(ctx) {
  T = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, 'en', en), "dsh-user-profile: en");
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({}),
      }, ProfilePanel));

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        label: () => T("用户设定"),
      }, ProfileIcon));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
