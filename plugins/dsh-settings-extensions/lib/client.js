/**
 * dsh-settings-extensions —— 客户端半边：设置页「插件与技能」分区。
 *
 * 两个页签：
 *   技能 —— 列 $DSH_HOME/skills，每行一个真开关（写 SKILL.md frontmatter，见 lib/index.js），可看 SKILL.md 原文。
 *   插件 —— 列自建插件（动态扫描，出包里没有的自然不出现），有侧栏面板的给「打开」，
 *           有设置分区的标出分区名。
 * 侧栏入口不动；这里只是集中入口。行样式照 dsh-android-console（与「通用设置」同规格）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-settings-extensions',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
    const react = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const Button = primitives.Button;
    const Switch = primitives.Switch;
    const Modal = primitives.Modal;
    const Toast = primitives.Toast;
    const SegmentedControl = primitives.SegmentedControl;

    const API = '/settings-ext/api';
    const CSS_ID = 'dsh-settings-extensions/v2.css';
    const CSS = [
      '.sx-root{display:flex;flex-direction:column;width:100%;box-sizing:border-box;overflow-x:hidden}',
      '.sx-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0 6px}',
      '.sx-count{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.sx-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:46px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.sx-row:last-child{border-bottom:none}',
      '.sx-main{min-width:0;flex:1}',
      '.sx-title{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);word-break:break-word;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.sx-off .sx-title{color:var(--dsw-alias-label-tertiary)}',
      '.sx-desc{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.sx-right{display:flex;align-items:center;gap:6px;flex:none}',
      '.sx-tag{font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-weight:400}',
      '.sx-tag.sx-bad{color:var(--dsw-alias-state-error-primary)}',
      '.sx-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:10px 0 2px}',
      '.sx-err{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);padding:12px 0}',
      // 开关开态不用品牌蓝，改中性主色（浅色主题黑底白点、深色主题白底黑点）；只作用于本页
      '.sx-switch[aria-checked="true"]{background:var(--dsw-alias-label-primary)}',
      '.sx-switch[aria-checked="true"]>span{background:var(--dsw-alias-label-primary-foreground)}',
      '.sx-pre{margin:0;max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:18px;font-family:var(--dsw-font-family-mono,monospace);color:var(--dsw-alias-label-primary)}',
    ].join('\n');

    function ensureCss() {
      try {
        if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') !== null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-settings-extensions';
        tag.dataset.pluginCss = CSS_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (e) { /* 样式失败不拖垮整页 */ }
    }

    const NS = 'dsh-settings-extensions';
    const zh = {
      sectionTitle: '插件与技能',
      tabSkills: '技能',
      tabPlugins: '插件',
      retry: '重试',
      refresh: '刷新',
      reading: '正在读取…',
      skillLoadFailed: '技能列表读取失败：{error}',
      pluginLoadFailed: '插件列表读取失败：{error}',
      skillCount: '共 {total} 个，开着 {on} 个',
      pluginCount: '自建插件 {total} 个',
      deprecated: '已废弃',
      partial: '半关',
      view: '查看',
      enableName: '开启 {name}',
      disableName: '关闭 {name}',
      close: '关闭',
      skillNote: '关闭 = 模型不再自动加载、/ 菜单里也不出现。改的是 SKILL.md 开头两行，首次改动前原文备份在 $DSH_HOME/settings-extensions/backups/。',
      pluginNote: '「设置·xx」表示它在设置左侧有自己的分区；「打开」会关掉设置、切到侧栏对应面板。「未加载」= 包在、但配置里没挂上它。',
      notLoaded: '未加载',
      sectionTag: '设置·{label}',
      openPanel: '打开{label}',
      openPanelFailed: '打不开「{label}」：{error}',
      pageError: '「插件与技能」页出错了：{error}',
      toggledOn: '已开启 {name}，下一轮对话生效',
      toggledOff: '已关闭 {name}，下一轮对话生效',
      toggleFailed: '没改成：{error}',
      readFailed: '读不到：{error}',
      restartHint: '（插件刚装好要重启一次 App）',
    }
    const en = {
      sectionTitle: 'Plugins & Skills',
      tabSkills: 'Skills',
      tabPlugins: 'Plugins',
      retry: 'Retry',
      refresh: 'Refresh',
      reading: 'Loading…',
      skillLoadFailed: 'Failed to load skills: {error}',
      pluginLoadFailed: 'Failed to load plugins: {error}',
      skillCount: '{total} total, {on} enabled',
      pluginCount: '{total} local plugins',
      deprecated: 'Deprecated',
      partial: 'Partial',
      view: 'View',
      enableName: 'Enable {name}',
      disableName: 'Disable {name}',
      close: 'Close',
      skillNote: 'Disabling means the model no longer auto-loads it and it disappears from the / menu. This edits the first two lines of SKILL.md; the original is backed up under $DSH_HOME/settings-extensions/backups/ before the first change.',
      pluginNote: '"Settings·xx" means it owns a section on the left of Settings; "Open" closes Settings and switches to that sidebar panel. "Not loaded" means the package exists but nothing mounted it.',
      notLoaded: 'Not loaded',
      sectionTag: 'Settings·{label}',
      openPanel: 'Open {label}',
      openPanelFailed: 'Cannot open "{label}": {error}',
      pageError: 'The Plugins & Skills page failed: {error}',
      toggledOn: 'Enabled {name}; takes effect next turn',
      toggledOff: 'Disabled {name}; takes effect next turn',
      toggleFailed: 'Not changed: {error}',
      readFailed: 'Cannot read: {error}',
      restartHint: ' (restart the App once after installing the plugin)',
    }
    let T = (key, params) => {
      const template = zh[key] === undefined ? key : zh[key];
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
    };

    async function api(path, opts) {
      const r = await fetch(API + path, Object.assign({ cache: 'no-store' }, opts || {}));
      let body = null;
      try { body = await r.json(); } catch (_e) { /* 非 JSON */ }
      if (!r.ok || !body || body.ok === false) {
        throw new Error((body && body.error) || ('HTTP ' + r.status + (r.status === 404 ? T('restartHint') : '')));
      }
      return body;
    }

    function Tag(props) {
      return jsx('span', { className: 'sx-tag' + (props.bad ? ' sx-bad' : ''), children: props.children });
    }

    function Row(props) {
      return jsxs('div', {
        className: 'sx-row' + (props.off ? ' sx-off' : ''),
        children: [
          jsxs('div', { className: 'sx-main', children: [
            jsx('div', { className: 'sx-title', children: props.title }),
            props.desc ? jsx('div', { className: 'sx-desc', children: props.desc }) : null,
          ] }),
          props.right ? jsx('div', { className: 'sx-right', children: props.right }) : null,
        ],
      });
    }

    // ------------------------------------------------------------------ 技能页
    function SkillsTab(props) {
      const [skills, setSkills] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [busy, setBusy] = react.useState(null);
      const [viewing, setViewing] = react.useState(null);

      const load = react.useCallback(() => {
        setError(null);
        api('/skills').then((b) => setSkills(b.skills)).catch((e) => setError(String(e.message || e)));
      }, []);
      react.useEffect(load, [load]);

      const toggle = (s, next) => {
        setBusy(s.dir);
        api('/skill/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: s.dir, enabled: next }) })
          .then((b) => { setSkills(b.skills); props.flash(next ? T('toggledOn', { name: s.name }) : T('toggledOff', { name: s.name })); })
          .catch((e) => props.flash(T('toggleFailed', { error: e.message || e })))
          .then(() => setBusy(null));
      };

      const view = (s) => {
        api('/skill?name=' + encodeURIComponent(s.dir))
          .then((b) => setViewing({ name: s.name, text: b.text }))
          .catch((e) => props.flash(T('readFailed', { error: e.message || e })));
      };

      if (error) return jsxs(Fragment, { children: [
        jsx('div', { className: 'sx-err', children: T('skillLoadFailed', { error: error }) }),
        jsx(Button, { variant: 'outline', size: 'sm', onClick: load, children: T('retry') }),
      ] });
      if (!skills) return jsx('div', { className: 'sx-note', children: T('reading') });

      const on = skills.filter((s) => s.enabled).length;
      return jsxs(Fragment, { children: [
        jsxs('div', { className: 'sx-bar', children: [
          jsx('span', { className: 'sx-count', children: T('skillCount', { total: skills.length, on: on }) }),
          jsx(Button, { variant: 'ghost', size: 'sm', onClick: load, children: T('refresh') }),
        ] }),
        skills.map((s) => jsx(Row, {
          key: s.dir,
          off: !s.enabled,
          title: [
            jsx('span', { key: 'n', children: s.name }),
            s.deprecated ? jsx(Tag, { key: 'd', children: T('deprecated') }) : null,
            s.partial ? jsx(Tag, { key: 'p', bad: true, children: T('partial') }) : null,
          ],
          desc: s.description,
          right: [
            jsx(Button, { key: 'v', variant: 'ghost', size: 'sm', onClick: () => view(s), children: T('view') }),
            jsx(Switch, { key: 's', className: 'sx-switch', checked: s.enabled, disabled: busy === s.dir, label: s.enabled ? T('disableName', { name: s.name }) : T('enableName', { name: s.name }), onChange: (next) => toggle(s, next) }),
          ],
        })),
        jsx('div', { className: 'sx-note', children: T('skillNote') }),
        viewing ? jsx(Modal, {
          open: true,
          title: viewing.name,
          closeLabel: T('close'),
          onClose: () => setViewing(null),
          children: jsx('pre', { className: 'sx-pre', children: viewing.text }),
          footer: jsx(Button, { variant: 'primary', onClick: () => setViewing(null), children: T('close') }),
        }) : null,
      ] });
    }

    // ------------------------------------------------------------------ 插件页
    function PluginsTab(props) {
      const [plugins, setPlugins] = react.useState(null);
      const [error, setError] = react.useState(null);
      const load = react.useCallback(() => {
        setError(null);
        api('/plugins').then((b) => setPlugins(b.plugins)).catch((e) => setError(String(e.message || e)));
      }, []);
      react.useEffect(load, [load]);

      if (error) return jsxs(Fragment, { children: [
        jsx('div', { className: 'sx-err', children: T('pluginLoadFailed', { error: error }) }),
        jsx(Button, { variant: 'outline', size: 'sm', onClick: load, children: T('retry') }),
      ] });
      if (!plugins) return jsx('div', { className: 'sx-note', children: T('reading') });

      return jsxs(Fragment, { children: [
        jsxs('div', { className: 'sx-bar', children: [
          jsx('span', { className: 'sx-count', children: T('pluginCount', { total: plugins.length }) }),
          jsx(Button, { variant: 'ghost', size: 'sm', onClick: load, children: T('refresh') }),
        ] }),
        plugins.map((p) => jsx(Row, {
          key: p.dir,
          off: !p.configured,
          title: [
            jsx('span', { key: 'n', children: p.name }),
            p.version ? jsx(Tag, { key: 'v', children: 'v' + p.version }) : null,
            p.configured ? null : jsx(Tag, { key: 'c', bad: true, children: T('notLoaded') }),
            p.sections.map((s) => jsx(Tag, { key: 's-' + s.id, children: T('sectionTag', { label: s.label }) })),
          ],
          desc: p.description,
          right: p.panels.map((pn) => jsx(Button, {
            key: pn.id,
            variant: 'outline',
            size: 'sm',
            onClick: () => props.openPanel(pn),
            children: T('openPanel', { label: pn.label }),
          })),
        })),
        jsx('div', { className: 'sx-note', children: T('pluginNote') }),
      ] });
    }

    // ------------------------------------------------------------------ 分区
    function makeSection(ctx) {
      return function SettingsExtensionsSection() {
        ensureCss();
        const [tab, setTab] = react.useState('skills');
        const [toast, setToast] = react.useState(null);
        const flash = (text) => setToast({ text, at: Date.now() });

        const openPanel = (pn) => {
          try {
            // 设置弹窗挂在 useModalLayer 上，Escape 是它唯一对外的关闭口；先关弹窗再切面板
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            ctx.layout.selectPanel(pn.id);
          } catch (e) {
            flash(T('openPanelFailed', { label: pn.label, error: (e && e.message) || e }));
          }
        };

        return jsxs('div', { className: 'sx-root', children: [
          jsx('div', { className: 'sx-bar', children: jsx(SegmentedControl, {
            value: tab,
            options: [{ value: 'skills', label: T('tabSkills') }, { value: 'plugins', label: T('tabPlugins') }],
            onChange: setTab,
          }) }),
          tab === 'skills' ? jsx(SkillsTab, { flash }) : jsx(PluginsTab, { flash, openPanel }),
          toast ? jsx(Toast, { key: toast.at, text: toast.text, onDone: () => setToast(null) }) : null,
        ] });
      };
    }

    /** 兜底：这页出异常不能把整个设置弹窗带崩。 */
    class Boundary extends react.Component {
      constructor(p) { super(p); this.state = { err: null }; }
      static getDerivedStateFromError(err) { return { err }; }
      render() {
        if (this.state.err) return jsx('div', { className: 'sx-err', children: T('pageError', { error: String(this.state.err && this.state.err.message || this.state.err) }) });
        return this.props.children;
      }
    }

    const inject = ['slots', 'layout', 'locale'];

    function apply(ctx) {
      T = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'settings-extensions: zh');
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'settings-extensions: en');
      const Section = makeSection(ctx);
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'settings-extensions',
        order: 20,
        label: () => T('sectionTitle'),
        inject: () => ({}),
      }, function SettingsExtensionsGuarded() {
        return jsx(Boundary, { children: jsx(Section, {}) });
      }));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
