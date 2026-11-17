/**
 * dsh-plugin-another-me —— 客户端半边：侧边栏「另一个我」图标 + 对话面板
 *
 * 面板 = iframe 到 /another-me/（引擎自己挂的路由，同源、带认证）。
 * 图标画成两个人形，右边那个半透明 —— 「另一个我」。
 * 不打包、不带 css：改完刷新页面就生效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-another-me',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const jsx = require('react/jsx-runtime').jsx;
    const react = require('react');

    const PANEL_ID = 'another-me';
    const SRC = '/another-me/';

    function TwinIcon({ size }) {
      const s = size || 16;
      const st = { stroke: 'currentColor', strokeWidth: 1.15, fill: 'none', strokeLinecap: 'round' };
      return jsx('svg', {
        width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        children: [
          jsx('circle', { key: 'a', cx: 5.2, cy: 4.9, r: 2.0, ...st }),
          jsx('path', { key: 'b', d: 'M2.0 13.5c0-1.9 1.4-3.4 3.2-3.4s3.2 1.5 3.2 3.4', ...st }),
          jsx('g', {
            key: 'c', opacity: 0.45, children: [
              jsx('circle', { cx: 10.8, cy: 4.9, r: 2.0, ...st }),
              jsx('path', { d: 'M7.6 13.5c0-1.9 1.4-3.4 3.2-3.4s3.2 1.5 3.2 3.4', ...st }),
            ],
          }),
        ],
      });
    }

    function TwinPanel() {
      const [state, setState] = react.useState('checking');
      react.useEffect(() => {
        let alive = true;
        fetch(SRC + 'api/status', { cache: 'no-store' })
          .then((r) => { if (alive) setState(r.ok ? 'ok' : 'down'); })
          .catch(() => { if (alive) setState('down'); });
        return () => { alive = false; };
      }, []);

      if (state === 'checking') {
        return jsx('div', { style: { padding: 18, fontSize: 13, opacity: 0.7 }, children: T("正在连接…") });
      }
      if (state === 'down') {
        return jsx('div', {
          style: { padding: 18, fontSize: 13, lineHeight: 1.75 },
          children: [
            jsx('div', { key: 't', style: { fontWeight: 600, marginBottom: 6 }, children: T("面板没挂上") }),
            jsx('div', {
              key: 'd', style: { opacity: 0.75 },
              children: T("插件路由没起来。先重启 App；还不行就删掉 node_modules/dsh-plugin-another-me 和 profiles/web/cordis.patch.yml 里那段 insert，重启即恢复。"),
            }),
          ],
        });
      }
      return jsx('iframe', {
        src: SRC,
        title: T("另一个我"),
        style: { border: 0, width: '100%', height: '100%', display: 'block', background: 'transparent' },
      });
    }

    const NS = "dsh-plugin-another-me";
/** 中文原文即 key：zh 不需要词典（缺词回落成 key 本身），只维护 en。 */
const en = {
 "正在连接…": "Connecting…",
 "面板没挂上": "Panel did not mount",
 "插件路由没起来。先重启 App；还不行就删掉 node_modules/dsh-plugin-another-me 和 profiles/web/cordis.patch.yml 里那段 insert，重启即恢复。": "The plugin route did not start. Restart the App first; if that fails, remove node_modules/dsh-plugin-another-me and its insert block in profiles/web/cordis.patch.yml, then restart.",
 "另一个我": "Another me"
};
let T = (key, params) => {
  const template = en[key] === undefined ? key : en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
};

const inject = ['slots', 'layout', 'locale'];

    function apply(ctx) {
  T = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, 'en', en), "dsh-plugin-another-me: en");
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({}),
      }, TwinPanel));

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 55,
        label: () => T("另一个我"),
      }, TwinIcon));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
