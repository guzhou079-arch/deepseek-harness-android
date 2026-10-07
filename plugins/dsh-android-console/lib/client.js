/**
 * dsh-android-console —— 客户端半边：DSH 设置弹窗里的「控制台」页
 *
 * 这一页就是原先**安卓壳原生控制台**的全部功能与文字，照「通用设置」那一页的样子重做：
 *   · 解压文件 / 启动·重启·停止引擎 / 救援（安全模式 · 导出·导入备份）
 *   · 授予权限 / 插件 / 自建环境 / 日志 / 时光机全站备份 / 界面主题 / 检查更新
 *
 * 动作怎么落地：这些事全在**安卓壳**里（解压 payload、拉起 node、申请权限、装构建环境…），
 * 所以每个动作都经 `window.dshshell.ctlAct(id, arg)` 回到原生执行，状态经
 * `window.dshshell.ctlState()` 取回（JSON 字符串）。在桌面浏览器里没有这条桥，
 * 页面会明确说「只在安卓 App 内可用」，而不是白屏或假装成功。
 *
 * 只用两个外部模块：react 与 @deepseek-ai/dsh-client-ui-primitives（前端自带的共享模块，
 * 见 web 前端的 shared 表）。按钮/开关用 primitives 的真组件 —— 这样深浅色、圆角、
 * 焦点环跟「通用设置」逐像素一致，不用自己仿。
 */
window.__ModuleLoader__.load({
  id: 'dsh-android-console',
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

    // ---------------------------------------------------------------- 样式
    // 与 ui-settings-general 的行规格对齐：标准单行 Flex、标题+说明在左、控件紧凑在右
    const CSS_ID = 'dsh-android-console/console-v3.css';
    const CSS = [
      '.ctl-root{display:flex;flex-direction:column;width:100%}',
      '.ctl-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-bottom:4px}',
      '.ctl-brand{font-family:var(--dsw-font-family-brand,var(--dsw-font-family));font-size:11px;letter-spacing:.14em;color:var(--dsw-alias-label-tertiary);font-weight:600}',
      '.ctl-ver{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;text-align:right}',
      '.ctl-group{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-tertiary);padding:18px 0 4px}',
      '.ctl-row{display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:12px;min-height:46px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.ctl-row.ctl-click{cursor:pointer;margin:0 -6px;padding:10px 6px;border-radius:var(--dsw-radius-md)}',
      '.ctl-row.ctl-click:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ctl-row.ctl-last{border-bottom:none}',
      '.ctl-main{min-width:0;flex:1}',
      '.ctl-title{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.ctl-desc{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word}',
      '.ctl-desc.ctl-warn{color:var(--dsw-alias-state-error-primary)}',
      '.ctl-right{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex:none;max-width:55%}',
      '.ctl-right>button{flex:none;white-space:nowrap}',
      '.ctl-btn-group{display:flex;align-items:center;gap:6px;flex-wrap:nowrap}',
      '.ctl-state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.ctl-state.ctl-ok{color:var(--dsw-alias-state-business-primary)}',
      '.ctl-state.ctl-bad{color:var(--dsw-alias-state-error-primary)}',
      '.ctl-sep{height:.5px;background:var(--dsw-alias-border-l2);margin:8px 0}',
      '.ctl-back{display:flex;align-items:center;gap:6px;height:32px;margin:0 0 4px -6px;padding:0 8px 0 4px;border:none;border-radius:var(--dsw-radius-md);background:0 0;cursor:pointer;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:15px;font-weight:600}',
      '.ctl-back:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ctl-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:10px 0 2px;overflow-wrap:anywhere}',
      '.ctl-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0 0}',
      '.ctl-empty{padding:18px 0;display:flex;flex-direction:column;gap:6px}',
      '@media(max-width:640px){',
      '.VOzbGW_overlay{inset:0!important;width:100vw!important;height:100%!important;height:100dvh!important;max-height:100%!important;display:flex!important;align-items:stretch!important;justify-content:stretch!important;position:fixed!important;z-index:1000!important;background:var(--dsw-alias-bg-layer-1,#121214)!important}',
      '.VOzbGW_mask{display:none!important}',
      '.VOzbGW_panel{position:relative!important;width:100vw!important;max-width:100vw!important;height:100%!important;max-height:100%!important;border-radius:0!important;border:none!important;box-shadow:none!important;flex-direction:column!important;background:var(--dsw-alias-bg-layer-1,#121214)!important;overflow:hidden!important}',
      '.VOzbGW_nav{box-sizing:border-box!important;width:100%!important;flex-direction:row!important;align-items:center!important;gap:8px!important;height:auto!important;min-height:48px!important;padding:max(12px,env(safe-area-inset-top,12px)) 60px 10px 14px!important;background:var(--dsw-alias-bg-layer-2,#1c1c1f)!important;border-bottom:.5px solid var(--dsw-alias-border-l2)!important;overflow-x:auto!important;flex:none!important;scrollbar-width:none!important}',
      '.VOzbGW_nav::-webkit-scrollbar{display:none!important}',
      '.VOzbGW_navTitle{display:none!important}',
      '.VOzbGW_navList{flex-direction:row!important;align-items:center!important;gap:6px!important;flex:1!important;min-width:0!important;overflow-x:auto!important;scrollbar-width:none!important}',
      '.VOzbGW_navList::-webkit-scrollbar{display:none!important}',
      '.VOzbGW_navCell{flex:none!important;white-space:nowrap!important;height:32px!important;padding:0 14px!important;border-radius:16px!important;font-size:13.5px!important;font-weight:500!important;color:var(--dsw-alias-label-secondary)!important;background:transparent!important;transition:all .2s ease!important}',
      '.VOzbGW_navCell:hover{background:var(--dsw-alias-interactive-bg-hover)!important;color:var(--dsw-alias-label-primary)!important}',
      '.VOzbGW_navCell.VOzbGW_active{background:var(--dsw-alias-interactive-bg-active,#4D6BFE)!important;color:#FFFFFF!important;font-weight:600!important;box-shadow:0 2px 8px rgba(77,107,254,0.3)!important}',
      '.VOzbGW_content{flex:1!important;display:flex!important;flex-direction:column!important;min-height:0!important;overflow:hidden!important}',
      '.VOzbGW_header{position:absolute!important;top:max(12px,env(safe-area-inset-top,12px))!important;right:12px!important;width:34px!important;height:34px!important;padding:0!important;margin:0!important;z-index:100!important;display:flex!important;align-items:center!important;justify-content:center!important;background:transparent!important;border:none!important}',
      '.VOzbGW_actions{display:none!important}',
      '.VOzbGW_close{width:34px!important;height:34px!important;border-radius:50%!important;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08))!important;color:var(--dsw-alias-label-primary)!important;display:flex!important;align-items:center!important;justify-content:center!important;cursor:pointer!important;border:none!important;font-size:16px!important;flex:none!important;transition:transform .15s ease!important}',
      '.VOzbGW_close:active{transform:scale(0.9)!important}',
      '.VOzbGW_options{flex:1!important;overflow-y:auto!important;min-height:0!important;padding:16px 16px max(40px,env(safe-area-inset-bottom,40px))!important;-webkit-overflow-scrolling:touch!important}',
      '}',
    ].join('');

    function ensureCss() {
      try {
        if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') !== null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-android-console';
        tag.dataset.pluginCss = CSS_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (e) { /* 样式失败不该拖垮整页 */ }
    }

    // ------------------------------------------------------------ 原生桥
    /** 拿到壳的桥（只有安卓 WebView 里有）。 */
    function shell() {
      try {
        const s = window.dshshell;
        if (s && typeof s.ctlState === 'function' && typeof s.ctlAct === 'function') return s;
      } catch (e) { /* 桥不存在 */ }
      return null;
    }

    function readState() {
      const s = shell();
      if (!s) return null;
      try {
        const raw = s.ctlState();
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function callAction(id, arg) {
      const s = shell();
      if (!s) return { ok: false, msg: '需要在本应用内使用' };
      try {
        const raw = s.ctlAct(String(id), arg === undefined || arg === null ? '' : String(arg));
        return raw ? JSON.parse(raw) : { ok: true };
      } catch (e) {
        return { ok: false, msg: String(e && e.message ? e.message : e) };
      }
    }

    /** 安全打开外部链接（桥 / window.open / 模拟点击三重保险） */
    function openUrl(url) {
      try {
        const s = shell();
        if (s && typeof s.ctlAct === 'function') s.ctlAct('open.url', url);
      } catch (e) { /* ignore */ }
      try {
        window.open(url, '_blank');
      } catch (e) { /* ignore */ }
      try {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (e) { /* ignore */ }
    }

    /** 控制台状态轮询（原生控制台是 1s tick；这里 2s，够用又不吵）。 */
    function useConsoleState() {
      const [state, setState] = react.useState(() => readState());
      react.useEffect(() => {
        let alive = true;
        const tick = () => {
          const next = readState();
          if (alive && next) setState(next);
        };
        tick();
        const timer = setInterval(tick, 2000);
        const onFocus = () => tick();
        window.addEventListener('focus', onFocus);
        return () => {
          alive = false;
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
        };
      }, []);
      return state;
    }

    // -------------------------------------------------------------- 小组件
    function Row(props) {
      const { title, desc, right, onClick, last, descWarn } = props;
      return jsxs('div', {
        className: 'ctl-row' + (onClick ? ' ctl-click' : '') + (last ? ' ctl-last' : ''),
        onClick: onClick,
        children: [
          jsxs('div', { className: 'ctl-main', children: [
            jsx('div', { className: 'ctl-title', children: title }),
            desc ? jsx('div', { className: 'ctl-desc' + (descWarn ? ' ctl-warn' : ''), children: desc }) : null,
          ] }),
          right ? jsx('div', { className: 'ctl-right', children: right }) : null,
        ],
      });
    }

    function Back(props) {
      return jsxs('button', {
        type: 'button',
        className: 'ctl-back',
        onClick: props.onBack,
        children: [
          jsx(primitives.IconChevronLeftOutlineRegular, { size: 16 }),
          jsx('span', { children: props.title }),
        ],
      });
    }

    function Note(props) {
      return jsx('div', { className: 'ctl-note', children: props.children });
    }

    /**
     * 二次确认：**必须用弹层**（Modal 会 portal 到 body，永不随页面滚动跑出视野）。
     *
     * 血的教训（2026-10-07 用户当场报）：第一版把确认条与提示写成页面 JSX 末尾的一行，
     * 于是点「重启」时它在屏幕外 —— 用户以为"按钮没绑功能"，划到最底才看到。
     * 凡是"点了要有反馈"的东西，都不能放在滚动容器的末尾。
     */
    function Confirm(props) {
      const pending = props.pending;
      return jsx(Modal, {
        open: true,
        onClose: props.onCancel,
        title: pending.title || '确认',
        closeLabel: '关闭',
        description: pending.text,
        footer: jsxs(Fragment, { children: [
          jsx(Button, { variant: 'outline', onClick: props.onCancel, children: '取消' }),
          jsx(Button, { variant: 'primary', onClick: props.onOk, children: pending.okLabel || '确定' }),
        ] }),
      });
    }

    /** 动作反馈：同样 portal 到 body 的 toast，4 秒后自己消失。 */
    function Flash(props) {
      return jsx(Toast, { text: props.text, onDone: props.onDone });
    }

    // ---------------------------------------------------------------- 页面
    /**
     * 兜底边界：这一页是我们自己写的，出异常时**不能让整个设置弹窗跟着崩**。
     * 出错就渲染一段可读的说明（并且提醒原生控制台仍在：文件未解压或引擎起不来时会自动出现）。
     */
    // 取 React.Component：错误边界必须是类组件。前端把 react 作为共享模块给插件，
    // 具名导出（useState…）实测可用；这里仍做一层兜底 —— 万一拿不到 Component，
    // 就**不装边界**、直接渲染（宁可少一层保险，也不能在 factory 阶段抛异常把整包拖垮）。
    const ReactComponent = react.Component || (react.default && react.default.Component) || null;
    let Boundary = null;
    if (ReactComponent !== null) {
      Boundary = class Boundary extends ReactComponent {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }
        static getDerivedStateFromError(error) {
          return { error: error };
        }
        componentDidCatch(error) {
          try { console.error('[dsh-android-console]', error); } catch (e) { /* ignore */ }
        }
        render() {
          if (this.state.error) {
            const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error);
            return jsxs('div', { className: 'ctl-empty', children: [
              jsx('div', { className: 'ctl-title', children: '控制台页面出错了' }),
              jsx('div', { className: 'ctl-desc', children: msg }),
              jsx('div', { className: 'ctl-desc', children: '原生控制台没有删：文件没解压、或引擎启动失败时会自动出现。' }),
            ] });
          }
          return this.props.children;
        }
      };
    }

    function ConsoleSection(ownerProps) {
      ensureCss();
      const close = ownerProps && typeof ownerProps.close === 'function' ? ownerProps.close : () => {};
      const [page, setPage] = react.useState('main');
      const [pending, setPending] = react.useState(null);
      const [flash, setFlash] = react.useState('');
      const state = useConsoleState();
      const flashTimer = react.useRef(null);

      const say = react.useCallback((text) => {
        setFlash(text || '');
        if (flashTimer.current) clearTimeout(flashTimer.current);
        if (text) flashTimer.current = setTimeout(() => setFlash(''), 4000);
      }, []);
      react.useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

      /** 发一个动作；需要二次确认的走 ask()。 */
      const run = react.useCallback((id, arg, done) => {
        const res = callAction(id, arg);
        if (res && res.ok === false && res.msg) say(res.msg);
        else if (done) say(done);
        return res;
      }, [say]);

      const ask = react.useCallback((title, text, id, arg, done) => {
        setPending({ title: title, text: text, run: () => run(id, arg, done) });
      }, [run]);

      if (!state) {
        return jsx('div', { className: 'ctl-empty', children: [
          jsx('div', { className: 'ctl-title', children: '控制台只在安卓应用内可用' }),
          jsx('div', { className: 'ctl-desc', children: '这一页通过手机壳的桥（dshshell）执行解压 / 起引擎 / 授权等动作；桌面浏览器里没有这条通道。' }),
        ] });
      }

      const confirmBar = pending
        ? jsx(Confirm, {
            pending: pending,
            onOk: () => { const act = pending.run; setPending(null); act(); },
            onCancel: () => setPending(null),
          })
        : null;
      const flashBar = flash ? jsx(Flash, { text: flash, onDone: () => setFlash('') }) : null;

      // ---------------- 权限页
      if (page === 'perm') {
        const rows = (state.perm && state.perm.rows) || [];
        return jsxs('div', { className: 'ctl-root', children: [
          jsx(Back, { title: '授予权限', onBack: () => setPage('main') }),
          jsx(Note, { children: 'root / Shizuku 二选一即可（root 优先）。root 只能由你在 root 管理器（Magisk / KernelSU）里授予本应用；设备没 root 时这一项显示「本机无 root」。' }),
          jsx('div', { className: 'ctl-sep' }),
          rows.map((r) => jsx(Row, {
            key: r.id,
            title: r.title,
            desc: r.desc,
            right: jsxs(Fragment, { children: [
              jsx('span', { className: 'ctl-state' + (r.ok ? ' ctl-ok' : (r.disabled ? '' : ' ctl-bad')), children: r.state }),
              jsx(Button, {
                variant: 'outline',
                size: 'sm',
                disabled: !!r.disabled,
                onClick: () => run('perm.action', r.id),
                children: r.ok ? '管理' : '去授权',
              }),
            ] }),
          }, r.id)),
          state.workspace ? jsx(Row, {
            key: 'workspace',
            title: 'AI 工作区（可选）',
            desc: state.workspace.unset ? '未设置（AI 文件操作在内部目录）' : state.workspace.path,
            right: jsx(Button, {
              variant: 'outline',
              size: 'sm',
              onClick: () => run('workspace.change', ''),
              children: state.workspace.unset ? '选择' : '更改',
            }),
          }, 'workspace') : null,
          confirmBar,
          flashBar,
        ] });
      }

      // ---------------- 插件页
      if (page === 'plug') {
        const rows = (state.plugins && state.plugins.rows) || [];
        return jsxs('div', { className: 'ctl-root', children: [
          jsx(Back, { title: '插件', onBack: () => setPage('main') }),
          jsx(Note, { children: '关掉的插件不加载：工具不进 AI 的工具表，也少占上下文。改动在重启引擎后生效。' }),
          jsx('div', { className: 'ctl-sep' }),
          rows.map((r) => jsx(Row, {
            title: r.title,
            desc: r.desc,
            right: jsx(Switch, {
              checked: !!r.on,
              label: r.title,
              onChange: (next) => run('plugin.toggle', r.id + ':' + (next ? '1' : '0')),
            }),
          }, r.id)),
          jsx('div', { className: 'ctl-bar', children: jsx(Button, {
            variant: 'outline',
            size: 'sm',
            onClick: () => ask('重启引擎', '插件的加载与关闭要重启引擎才生效。', 'engine.restart', '', '正在重启引擎…'),
            children: '重启引擎生效',
          }) }),
          confirmBar,
          flashBar,
        ] });
      }

      // ---------------- 自建环境页
      if (page === 'buildenv') {
        const be = state.buildEnv || {};
        const sources = be.sources || [];
        return jsxs('div', { className: 'ctl-root', children: [
          jsx(Back, { title: '自建环境', onBack: () => setPage('main') }),
          jsx(Note, { children: '装上它之后，你可以在这台手机上自己编译、打包、签名、安装这个 App —— 也就是这个项目本来的核心能力。主包不含这部分（约 193MB），所以按需下载。GitHub 与 Gitee 都放了同样的分卷，任选其一。' }),
          jsx('div', { className: 'ctl-sep' }),
          jsx(Row, { title: be.summary || '', desc: be.statusText || '', descWarn: false }),
          be.installing && be.stage ? jsx(Row, { title: be.stage, desc: '正在安装，请保持网络与前台。' }) : null,
          jsx('div', { className: 'ctl-bar', children: be.installing
            ? jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('buildenv.cancel', ''), children: '取消安装' })
            : jsxs(Fragment, { children: [
                sources.map((s, i) => jsx(Button, {
                  variant: 'outline',
                  size: 'sm',
                  onClick: () => ask(be.installed ? '重新安装自建环境' : '下载并安装自建环境', String(s.label) + '：' + (be.installed ? '重新安装 / 修复自建环境？' : '开始下载并安装自建环境？') + '（约 193MB，保持前台与网络）', 'buildenv.install', String(i), '已开始下载安装…'),
                  children: (be.installed ? '用 ' + s.label + ' 重新安装 / 修复' : '从 ' + s.label + ' 下载安装'),
                }, 'src' + i)),
                jsx(Button, {
                  variant: 'ghost',
                  size: 'sm',
                  onClick: () => run('buildenv.resolve', ''),
                  disabled: !!be.resolving,
                  children: be.resolving ? '正在查询…' : (sources.length ? '重新查询两个仓库' : '查询两个仓库'),
                }),
              ] }) }),
          be.err ? jsx(Note, { children: be.err }) : null,
          jsx(Note, { children: '⚠️ 解压必须落在内部存储 —— /sdcard 是 FUSE，存不了 rootfs 里的符号链接（918 个）。分卷会留在 /sdcard/DeepSeekHarness/buildenv，重装 App 后不用重新下载，重新解压即可。' }),
          confirmBar,
          flashBar,
        ] });
      }

      // ---------------- 语音设置页
      if (page === 'voice') {
        const vo = state.voice || {};
        return jsxs('div', { className: 'ctl-root', children: [
          jsx(Back, { title: '语音交互与唤醒词', onBack: () => setPage('main') }),
          jsx(Note, { children: '支持三种唤醒方式：①长按小鲸鱼悬浮球；②按蓝牙耳机播放/暂停键；③纯语音热词唤醒。' }),
          jsx('div', { className: 'ctl-sep' }),
          jsx(Row, {
            title: '语音热词唤醒 (实验性)',
            desc: vo.hotwordEnabled ? '后台麦克风监听中，喊出唤醒词自动开麦' : '已关闭（更省电，仍可通过长按悬浮球或耳机键随时唤醒）',
            right: jsx(Switch, {
              checked: !!vo.hotwordEnabled,
              label: '语音热词唤醒',
              onChange: (next) => run('voice.hotword.toggle', next ? '1' : '0'),
            }),
          }),
          jsx(Row, {
            title: '自定义唤醒词',
            desc: '当前唤醒词：' + (vo.wakeWords || '小鲸鱼,DeepSeek') + '（多个词用逗号隔开）',
            right: jsx(Button, {
              variant: 'outline',
              size: 'sm',
              onClick: () => {
                const cur = vo.wakeWords || '小鲸鱼,DeepSeek';
                const input = window.prompt('请输入自定义唤醒词（支持多个，逗号隔开）：', cur);
                if (input !== null && input.trim() !== '') {
                  run('voice.wakewords.set', input.trim());
                }
              },
              children: '修改',
            }),
          }),
          jsx(Row, {
            title: '音效与播报测试',
            desc: '测试提示音、TTS 语音播报与麦克风录音',
            right: jsxs('div', { className: 'ctl-btn-group', children: [
              jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('voice.test.tone', ''), children: '提示音' }),
              jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('voice.test.tts', ''), children: 'TTS' }),
              jsx(Button, { variant: 'primary', size: 'sm', onClick: () => run('voice.test.listen', ''), children: '开麦' }),
            ] }),
          }),
          jsx(Note, { children: '提示：戴蓝牙耳机时，按一下耳机上的播放/暂停键可直接唤醒，无需掏出手机。' }),
          confirmBar,
          flashBar,
        ] });
      }

      // ---------------- 日志页
      if (page === 'log') {
        const log = state.log || {};
        return jsxs('div', { className: 'ctl-root', children: [
          jsx(Back, { title: '日志', onBack: () => setPage('main') }),
          jsx(Row, { title: log.summary || '', desc: log.path || '' }),
          jsx(Note, { children: '「查看」直接看末尾 200 行；「分享」调用系统分享（QQ / 微信 / 邮件…都能选），正文里带完整日志路径与末尾 400 行。日志会随使用不断追加，太长不好读时可「清空日志」。' }),
          jsx('div', { className: 'ctl-bar', children: [
            jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('log.view', ''), children: '查看日志' }),
            jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('log.share', ''), children: '分享' }),
            jsx(Button, {
              variant: 'ghost',
              size: 'sm',
              onClick: () => ask('清空日志', (log.summary || '') + '\n\n清空不影响正在运行的引擎，之后的新日志会继续正常写入。', 'log.clear', '', '日志已清空'),
              children: '清空日志',
            }),
          ] }),
          confirmBar,
          flashBar,
        ] });
      }

      // ---------------- 主页
      const ex = state.extract || {};
      const en = state.engine || {};
      const rescue = state.rescue || {};
      const theme = state.theme || {};
      const reasoning = state.reasoning || {};
      const log = state.log || {};

      return jsxs('div', { className: 'ctl-root', children: [
        jsxs('div', { className: 'ctl-head', children: [
          jsx('span', { className: 'ctl-brand', children: 'DEEPSEEK HARNESS' }),
          jsx('span', { className: 'ctl-ver', children: state.version || '' }),
        ] }),

        jsx('div', { className: 'ctl-group', children: '运行环境' }),
        jsx(Row, {
          title: ex.state || '',
          desc: ex.meta || '',
          right: jsx(Button, {
            variant: ex.ready ? 'outline' : 'primary',
            size: 'sm',
            disabled: !!(ex.busy || en.starting),
            onClick: () => {
              if (ex.ready) ask('重新解压', '会覆盖内部运行环境与内核树（会话 / 凭证 / 设置都在 dshhome，不受影响）。继续？', 'extract', '', '正在重新解压…');
              else run('extract', '');
            },
            children: ex.busy ? '解压中…' : (ex.ready ? '重新解压' : '解压文件'),
          }),
        }),
        jsx(Row, {
          title: en.state || '',
          desc: en.meta || '',
          right: jsxs('div', { className: 'ctl-btn-group', children: en.running
            ? [
                jsx(Button, { key: 'restart', variant: 'outline', size: 'sm', onClick: () => ask('重启引擎', '当前会话会被中断一会儿，界面会自己连回来。', 'engine.restart', '', '正在重启引擎…'), children: '重启' }),
                jsx(Button, { key: 'stop', variant: 'outline', size: 'sm', onClick: () => ask('停止引擎', '停止后这个设置页也会跟着断开，需要重新启动引擎。', 'engine.stop', '', '正在停止引擎…'), children: '停止' }),
              ]
            : [
                jsx(Button, { key: 'start', variant: 'primary', size: 'sm', disabled: !!(en.busy || !ex.ready), onClick: () => run('engine.start', ''), children: en.busy ? '启动中…' : '启动引擎' }),
              ] }),
        }),

        jsx('div', { className: 'ctl-group', children: '救援' }),
        jsx(Row, {
          title: rescue.safeMode ? '安全模式：已开启' : '安全模式',
          desc: rescue.desc || '',
          descWarn: !!rescue.warn,
          right: jsx(Button, {
            variant: rescue.safeMode ? 'primary' : 'outline',
            size: 'sm',
            onClick: () => ask(rescue.safeMode ? '退出安全模式' : '安全模式启动', rescue.safeMode ? '会把旁置的用户层还回去，并重启引擎。' : '会旁置 profile 的用户层，用出厂配置启动引擎（会话 / 凭证 / 设置都还在）。', 'rescue.toggle', '', rescue.safeMode ? '正在退出安全模式…' : '正在进入安全模式…'),
            children: rescue.safeMode ? '退出安全模式' : '安全模式启动',
          }),
        }),
        jsx(Row, {
          title: '导出全部数据',
          desc: '把 dshhome（会话/凭证/设置）打包至 DSH_Backups',
          right: jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('backup.export', ''), children: '导出' }),
        }),
        jsx(Row, {
          title: '从备份导入还原',
          desc: '选择之前导出的 zip 压缩包，还原 dshhome',
          right: jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('backup.import', ''), children: '选择文件' }),
        }),

        jsx('div', { className: 'ctl-group', children: '设置' }),
        jsx(Row, {
          title: '语音唤醒与交互',
          desc: (state.voice && state.voice.summary) || '自定义唤醒词 · 蓝牙耳机控制 · 开麦测试',
          right: jsxs(Fragment, { children: [
            jsx('span', { className: 'ctl-state', children: state.voice && state.voice.hotwordEnabled ? '已开启' : '已配置' }),
            jsx(primitives.IconChevronRightOutlineRegular, { size: 14 }),
          ] }),
          onClick: () => setPage('voice'),
        }),
        jsx(Row, {
          title: '授予权限',
          desc: '存储 · 通知 · 悬浮窗 · 电池 · root · Shizuku · 无障碍',
          right: jsxs(Fragment, { children: [
            jsx('span', { className: 'ctl-state', children: (state.perm && state.perm.summary) || '' }),
            jsx(primitives.IconChevronRightOutlineRegular, { size: 14 }),
          ] }),
          onClick: () => setPage('perm'),
        }),
        jsx(Row, {
          title: '插件',
          desc: '关掉用不到的，省上下文',
          right: jsxs(Fragment, { children: [
            jsx('span', { className: 'ctl-state', children: (state.plugins && state.plugins.summary) || '' }),
            jsx(primitives.IconChevronRightOutlineRegular, { size: 14 }),
          ] }),
          onClick: () => setPage('plug'),
        }),
        jsx(Row, {
          title: '自建环境',
          desc: '在手机上自己编译 / 打包 / 签名（可选，约 193MB）',
          right: jsxs(Fragment, { children: [
            jsx('span', { className: 'ctl-state', children: (state.buildEnv && state.buildEnv.summary) || '' }),
            jsx(primitives.IconChevronRightOutlineRegular, { size: 14 }),
          ] }),
          onClick: () => setPage('buildenv'),
        }),
        jsx(Row, {
          title: '日志',
          desc: log.summary || '',
          right: jsxs(Fragment, { children: [
            jsx(Button, { variant: 'ghost', size: 'sm', onClick: (ev) => { ev.stopPropagation(); run('log.view', ''); }, children: '查看' }),
            jsx(Button, { variant: 'ghost', size: 'sm', onClick: (ev) => { ev.stopPropagation(); run('log.share', ''); }, children: '分享' }),
            jsx(primitives.IconChevronRightOutlineRegular, { size: 14 }),
          ] }),
          onClick: () => setPage('log'),
        }),
        jsx(Row, {
          title: '时光机全站备份',
          desc: '一键打包记忆库、历史会话与配置',
          right: jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('snapshot', ''), children: '立即备份' }),
        }),
        jsx(Row, {
          title: '界面主题',
          desc: theme.label || '',
          right: jsx(primitives.SegmentedControl, {
            id: 'dshctl-theme',
            value: String(theme.mode == null ? 0 : theme.mode),
            label: '界面主题',
            options: [
              { value: '0', label: '跟随系统' },
              { value: '1', label: '浅色' },
              { value: '2', label: '深色' },
            ],
            onChange: (v) => run('theme.set', v),
          }),
        }),
        jsx(Row, {
          title: '检查更新',
          desc: '当前版本 ' + (state.version || ''),
          right: jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('update.check', ''), children: '检查' }),
        }),
        jsx(Row, {
          title: '开源主页与 Star 支持',
          desc: '欢迎前往 GitHub 给作者点一颗 ⭐ 支持！',
          right: jsx(Button, {
            variant: 'outline',
            size: 'sm',
            onClick: () => {
              openUrl('https://github.com/guzhou079-arch/deepseek-harness-android');
              say('正在打开 GitHub 开源主页…');
            },
            children: '去 Star ⭐',
          }),
          last: true,
        }),

        jsx(Note, { children: '换内核版本 / 覆盖安装后需要重新解压；平时只用到「启动引擎」。' }),
        confirmBar,
        flashBar,
      ] });
    }

    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'android-console',
        order: 20,
        label: () => '控制台',
      }, function ConsoleSectionGuarded(props) {
        return Boundary === null
          ? jsx(ConsoleSection, props)
          : jsx(Boundary, { children: jsx(ConsoleSection, props) });
      }));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
