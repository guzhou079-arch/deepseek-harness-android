/**
 * dsh-doc-actions —— 文件预览上的安卓文件动作
 *
 * 为什么需要它：
 *   内核的 @deepseek-ai/dsh-host-open-in-app 里，OPEN_IN_APP_CATALOG 只声明了
 *   darwin / win32 / linux 三套平台，**没有 android**。于是文件预览右上角那个
 *   「显示文件位置」在手机上是结构性死路 —— 点了只会得到
 *   「无法显示文件位置，请重试」，而且重试多少次都一样。
 *
 *   1.42 起 App 壳新增了一个 /open 桥（127.0.0.1:3081），用系统自带的
 *   DocumentsProvider 构造 content:// URI，把文件交给系统应用。
 *   本插件只负责在预览工具栏上放三个按钮，并把 absolutePath 发过去。
 *
 * 按钮：
 *   打开     → 系统默认应用（apk 进安装器，视频进播放器，图片进相册）
 *   文件夹   → 文件管理器打开所在目录
 *   分享     → 系统分享面板
 *
 * 失败要把原因显示出来，别做成"点了没反应"——这是这轮改版的初衷。
 */
window.__ModuleLoader__.load({
  id: 'dsh-doc-actions',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** App 壳的文件动作桥。端口和路径与 MainActivity 的 handleOpenRequest 对应。 */
    const OPEN_BRIDGE = 'http://127.0.0.1:3081/open';

    /** 只留 id；标签在渲染时取词，语言切换后无需重建数组。 */
    const ACTIONS = [
      { id: 'view' },
      { id: 'reveal' },
      { id: 'share' },
    ];

    const NS = 'dsh-doc-actions';
    const zh = {
      'view.label': '打开', 'view.title': '用系统应用打开',
      'reveal.label': '文件夹', 'reveal.title': '打开所在文件夹',
      'share.label': '分享', 'share.title': '分享这个文件',
      bridgeDown: '连不上 App 桥（需要 1.42 或更新的壳）',
      bridgeHttp: 'App 桥返回 HTTP {status}',
      bridgeBad: 'App 桥返回了无法解析的内容',
      openFailed: '打开失败',
    }
    const en = {
      'view.label': 'Open', 'view.title': 'Open with a system app',
      'reveal.label': 'Folder', 'reveal.title': 'Open the containing folder',
      'share.label': 'Share', 'share.title': 'Share this file',
      bridgeDown: 'Cannot reach the App bridge (requires shell 1.42 or newer)',
      bridgeHttp: 'App bridge returned HTTP {status}',
      bridgeBad: 'App bridge returned an unparseable response',
      openFailed: 'Open failed',
    }
    let T = (key, params) => {
      const template = zh[key] === undefined ? key : zh[key];
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
    };

    const styles = {
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexShrink: 0,
      },
      button: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.28))',
        background: 'transparent',
        color: 'var(--dsw-alias-text-secondary, #8b949e)',
        borderRadius: '999px',
        padding: '3px 9px',
        fontSize: '12px',
        lineHeight: '16px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonBusy: {
        opacity: 0.5,
      },
      error: {
        maxWidth: '220px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: '#e5534b',
        fontSize: '12px',
      },
    };

    /** 发一次 /open；返回 {ok, error?}。桥不在（例如装的是旧壳）要能说清楚。 */
    async function runOpen(path, action) {
      let response;
      try {
        response = await fetch(OPEN_BRIDGE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path, action }),
        });
      } catch (error) {
        return { ok: false, error: T('bridgeDown') };
      }
      if (!response.ok) return { ok: false, error: T('bridgeHttp', { status: response.status }) };
      try {
        return await response.json();
      } catch (error) {
        return { ok: false, error: T('bridgeBad') };
      }
    }

    /**
     * 预览工具栏上的三个按钮。
     * props 由宿主拼好：{ absolutePath }（见 documentpreview 的 fileOwner）。
     */
    function DocActions(props) {
      const path = props === undefined ? undefined : props.absolutePath;
      const [busy, setBusy] = React.useState('');
      const [failure, setFailure] = React.useState('');

      const timer = React.useRef(undefined);
      React.useEffect(() => () => {
        if (timer.current !== undefined) clearTimeout(timer.current);
      }, []);

      const run = (action) => {
        if (path === undefined || path === '' || busy !== '') return;
        setBusy(action);
        setFailure('');
        runOpen(path, action).then((result) => {
          setBusy('');
          if (result !== undefined && result !== null && result.ok === true) return;
          const reason = result !== undefined && result !== null && result.error ? result.error : T('openFailed');
          setFailure(reason);
          if (timer.current !== undefined) clearTimeout(timer.current);
          timer.current = setTimeout(() => setFailure(''), 4000);
        });
      };

      if (path === undefined || path === '') return null;

      return h(
        'div',
        { style: styles.row, 'data-doc-actions': true },
        failure !== '' ? h('span', { style: styles.error, title: failure }, failure) : null,
        ...ACTIONS.map((action) =>
          h(
            'button',
            {
              key: action.id,
              type: 'button',
              title: T(action.id + '.title'),
              style: busy === action.id ? { ...styles.button, ...styles.buttonBusy } : styles.button,
              disabled: busy !== '',
              onClick: () => run(action.id),
              'data-doc-action': action.id,
            },
            busy === action.id ? '…' : T(action.id + '.label'),
          ),
        ),
      );
    }

    function apply(ctx) {
      T = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'doc-actions: zh');
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'doc-actions: en');
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.document.actions', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.tab.document.actions',
                id: '@local/dsh-doc-actions/file-actions',
              },
              DocActions,
            ),
          ),
        'doc-actions: file actions',
      );
    }

    exports.DocActions = DocActions;
    exports.runOpen = runOpen;
    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    return module.exports;
  },
});
