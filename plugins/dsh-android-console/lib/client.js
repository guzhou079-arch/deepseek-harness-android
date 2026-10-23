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
    const SegmentedControl = primitives.SegmentedControl;
    const fileSizeText = primitives.fileSizeText;

    // ---------------------------------------------------------------- 样式
    // 与 ui-settings-general 的行规格对齐：标准单行 Flex、标题+说明在左、控件紧凑在右
    const CSS_ID = 'dsh-android-console/console-v3.css';
    const CSS = [
      '.ctl-root{display:flex;flex-direction:column;width:100%;max-width:100%;box-sizing:border-box;overflow-x:hidden}',
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
      '.ctl-btn-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.ctl-state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.ctl-state.ctl-ok{color:var(--dsw-alias-state-business-primary)}',
      '.ctl-state.ctl-bad{color:var(--dsw-alias-state-error-primary)}',
      '.ctl-sep{height:.5px;background:var(--dsw-alias-border-l2);margin:8px 0}',
      '.ctl-back{display:flex;align-items:center;gap:6px;height:32px;margin:0 0 4px -6px;padding:0 8px 0 4px;border:none;border-radius:var(--dsw-radius-md);background:0 0;cursor:pointer;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:15px;font-weight:600}',
      '.ctl-back:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ctl-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:10px 0 2px;overflow-wrap:anywhere}',
      '.ctl-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0 0}',
      '.ctl-empty{padding:18px 0;display:flex;flex-direction:column;gap:6px}',
      '.ctl-life-grid{display:flex;flex-direction:column;gap:12px;margin:12px 0}',
      '.ctl-life-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.04));border:.5px solid var(--dsw-alias-border-l2)}',
      '.ctl-life-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.ctl-life-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.ctl-code-pill{font-family:monospace;font-size:15px;font-weight:700;letter-spacing:.05em;color:var(--dsw-alias-state-business-primary,#4D6BFE);background:rgba(77,107,254,0.12);padding:2px 8px;border-radius:6px}',
      '.ctl-amt-neg{font-size:13.5px;font-weight:600;color:var(--dsw-alias-state-error-primary,#f87171)}',
      '.ctl-amt-pos{font-size:13.5px;font-weight:600;color:var(--dsw-alias-state-business-primary,#34d399)}',
      '.ctl-tag{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08));color:var(--dsw-alias-label-secondary)}',
      '.ctl-item-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.ctl-item-row:last-child{border-bottom:none}',
      '.ctl-voice-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:8px 0}',
      '.ctl-voice-card{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.04));border:1px solid var(--dsw-alias-border-l2);cursor:pointer;transition:all .15s ease}',
      '.ctl-voice-card:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ctl-voice-card.active{border-color:var(--dsw-alias-state-business-primary,#4D6BFE);background:rgba(77,107,254,0.12)}',
      '.ctl-voice-card-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.ctl-voice-card-tags{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.ctl-voice-input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:var(--dsw-radius-md,6px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.04));color:var(--dsw-alias-label-primary);font-size:13px;outline:none;transition:border-color .15s ease}',
      '.ctl-voice-input:focus{border-color:var(--dsw-alias-state-business-primary,#4D6BFE)}',
      '.ctl-voice-wave{display:flex;align-items:center;gap:3px;height:18px}',
      '.ctl-voice-bar{width:3px;height:12px;border-radius:2px;background:var(--dsw-alias-state-business-primary,#4D6BFE);animation:ctl-wave 1s ease-in-out infinite alternate}',
      '.ctl-voice-bar:nth-child(2){animation-delay:.2s;height:16px}',
      '.ctl-voice-bar:nth-child(3){animation-delay:.4s;height:10px}',
      '.ctl-voice-bar:nth-child(4){animation-delay:.1s;height:14px}',
      '@keyframes ctl-wave{0%{transform:scaleY(0.4)}100%{transform:scaleY(1)}}',
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
      '.VOzbGW_options{flex:1!important;overflow-y:auto!important;overflow-x:hidden!important;max-width:100vw!important;box-sizing:border-box!important;padding:16px 16px max(40px,env(safe-area-inset-bottom,40px))!important;-webkit-overflow-scrolling:touch!important}',
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

    /** 独立轮询生活助理状态（同时支持 HTTP API 与原生桥） */
    function useLifeState(fallbackLife) {
      const [life, setLife] = react.useState(fallbackLife || null);
      react.useEffect(() => {
        let alive = true;
        const fetchLife = async () => {
          try {
            const res = await fetch('/life/api/status');
            if (res.ok) {
              const data = await res.json();
              if (alive && data && data.ok) {
                setLife(data);
                return;
              }
            }
          } catch (_) {}
          if (alive && fallbackLife) setLife(fallbackLife);
        };
        fetchLife();
        const timer = setInterval(fetchLife, 2500);
        return () => { alive = false; clearInterval(timer); };
      }, [fallbackLife]);
      return life || fallbackLife || {};
    }

    /** 独立轮询语音中枢与 TTS 调音台状态（支持配置保存与实时试听） */
    function useVoiceHubState(fallbackVoice) {
      const [voiceHub, setVoiceHub] = react.useState({
        config: {
          hotword_enabled: '1',
          wake_words: '流光,小鲸鱼,DeepSeek',
          wake_mode: 'single_breath',
          stt_engine: 'system',
          tts_engine: 'edge',
          tts_voice: 'zh-CN-XiaoxiaoNeural',
          tts_speed: '1.0',
          custom_api_url: '',
          custom_api_key: '',
          custom_model_name: 'tts-1',
        },
        presets: [
          { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 温柔女声', engine: 'edge', gender: 'female', tags: '清晰/自然/推荐' },
          { id: 'zh-CN-YunxiNeural', name: '云希 · 沉稳男声', engine: 'edge', gender: 'male', tags: '沉稳/磁性/播报' },
          { id: 'zh-CN-YunjianNeural', name: '云健 · 阳光男声', engine: 'edge', gender: 'male', tags: '活力/解说' },
          { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 灵动少女', engine: 'edge', gender: 'female', tags: '甜美/对话' },
          { id: 'nova', name: 'Nova · 温暖知性 (OpenAI)', engine: 'openai', gender: 'female', tags: '高保真/细腻' },
          { id: 'shimmer', name: 'Shimmer · 元气甜美 (OpenAI)', engine: 'openai', gender: 'female', tags: '清脆/活力' },
          { id: 'alloy', name: 'Alloy · 科技极客 (OpenAI)', engine: 'openai', gender: 'neutral', tags: '中性/平衡' },
          { id: 'onyx', name: 'Onyx · 低沉浑厚 (OpenAI)', engine: 'openai', gender: 'male', tags: '磁性/低音' },
          { id: 'system_default', name: '系统原生 · 默认音色', engine: 'system', gender: 'auto', tags: '零延迟/离线' },
        ],
      });

      react.useEffect(() => {
        let alive = true;
        const fetchVoice = async () => {
          try {
            const res = await fetch('/voice-hub/api/config');
            if (res.ok) {
              const data = await res.json();
              if (alive && data && data.ok) {
                setVoiceHub({
                  config: data.config || {},
                  presets: data.presets || [],
                  bridgeStatus: data.bridgeStatus || {},
                });
                return;
              }
            }
          } catch (_) {}
        };
        fetchVoice();
        const timer = setInterval(fetchVoice, 3000);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      const saveConfig = (patch) => {
        setVoiceHub((prev) => ({ ...prev, config: { ...prev.config, ...patch } }));
        try {
          fetch('/voice-hub/api/config/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          }).catch(function() {});
        } catch (_) {}
      };

      const testSpeak = async (text, opts) => {
        try {
          const res = await fetch('/voice-hub/api/test/speak', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: text, ...opts }),
          });
          return await res.json();
        } catch (e) {
          return { ok: false, error: e.message };
        }
      };

      return { voiceHub: voiceHub || {}, saveConfig: saveConfig, testSpeak: testSpeak };
    }

    /** 独立轮询本地 RAG 知识库状态 */
    function useRagState() {
      const [rag, setRag] = react.useState({ kbs: [], searchResults: [], isSearching: false, lastQuery: '' });
      const fetchList = async () => {
        try {
          const res = await fetch('/rag/api/list');
          if (res.ok) {
            const data = await res.json();
            if (data && data.ok) {
              setRag((prev) => Object.assign({}, prev, { kbs: data.kbs || [] }));
            }
          }
        } catch (_) {}
      };

      react.useEffect(() => {
        fetchList();
      }, []);

      const search = async (query, kb) => {
        setRag((prev) => Object.assign({}, prev, { isSearching: true, lastQuery: query }));
        try {
          const res = await fetch('/rag/api/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: query, kb: kb || '', limit: 5 }),
          });
          const data = await res.json();
          setRag((prev) => Object.assign({}, prev, { isSearching: false, searchResults: (data && data.results) || [] }));
          return data;
        } catch (e) {
          setRag((prev) => Object.assign({}, prev, { isSearching: false, searchResults: [] }));
          return { ok: false, error: e.message };
        }
      };

      const clip = async (payload) => {
        try {
          const res = await fetch('/rag/api/clip', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          fetchList();
          return data;
        } catch (e) {
          return { ok: false, error: e.message };
        }
      };

      return { rag: rag, search: search, clip: clip, refresh: fetchList };
    }

    /** 独立轮询局域网协同状态 */
    function useLanMeshState() {
      const [lan, setLan] = react.useState({ ips: [], clipboard: '', files: [] });
      const [access, setAccessState] = react.useState({ enabled: false, host: '127.0.0.1', urls: [] });
      const fetchAccess = async () => {
        try {
          const res = await fetch('/lan-mesh/api/access');
          if (res.ok) {
            const d = await res.json();
            if (d && d.ok) setAccessState({ enabled: !!d.enabled, host: d.host || '', urls: d.urls || [] });
          }
        } catch (_) {}
      };
      const fetchLan = async () => {
        try {
          const res = await fetch('/lan-mesh/api/status');
          if (res.ok) {
            const data = await res.json();
            if (data && data.ok) {
              setLan({ ips: data.ips || [], clipboard: data.clipboard || '', files: data.files || [] });
            }
          }
        } catch (_) {}
      };

      react.useEffect(() => {
        fetchLan();
        fetchAccess();
        const timer = setInterval(() => { fetchLan(); fetchAccess(); }, 3500);
        return () => clearInterval(timer);
      }, []);

      const setClipboard = async (text) => {
        try {
          const res = await fetch('/lan-mesh/api/clipboard', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: text }),
          });
          const data = await res.json();
          fetchLan();
          return data;
        } catch (e) {
          return { ok: false, error: e.message };
        }
      };

      const setAccess = async (enabled) => {
        try {
          const res = await fetch('/lan-mesh/api/access', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: !!enabled }),
          });
          const data = await res.json();
          setTimeout(fetchAccess, 1200);
          setTimeout(fetchAccess, 6000);
          return data;
        } catch (e) {
          return { ok: false, error: e.message };
        }
      };

      return { lan: lan, access: access, setAccess: setAccess, setClipboard: setClipboard, refresh: fetchLan };
    }

    function executeAction(id, arg) {
      if (typeof fetch === 'function' && String(id).startsWith('life.')) {
        try {
          fetch('/life/api/act', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: id, arg: arg }),
          }).catch(function() {});
        } catch (_) {}
      }
      if (typeof fetch === 'function' && String(id).startsWith('voice.')) {
        try {
          fetch('/voice-hub/api/act', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: id, arg: arg }),
          }).catch(function() {});
        } catch (_) {}
      }
      return callAction(id, arg);
    }

    // -------------------------------------------------------------- 小组件
    function SegmentGrid(props) {
      const value = props.value;
      const options = props.options || [];
      const onChange = props.onChange || function() {};
      const cols = props.columns || 2;
      return jsx('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(' + cols + ', 1fr)',
          gap: '6px',
          width: '100%',
          boxSizing: 'border-box',
          margin: '6px 0',
        },
        children: options.map(function(opt) {
          const active = opt.value === value;
          return jsx('button', {
            key: opt.value,
            type: 'button',
            style: {
              padding: '8px 4px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: active ? '600' : '400',
              color: active ? '#FFFFFF' : 'var(--dsw-alias-label-primary)',
              background: active ? 'var(--dsw-alias-state-business-primary, #4D6BFE)' : 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05))',
              border: active ? '1px solid var(--dsw-alias-state-business-primary, #4D6BFE)' : '1px solid var(--dsw-alias-border-l2)',
              cursor: 'pointer',
              textAlign: 'center',
              transition: 'all 0.15s ease',
              outline: 'none',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
            onClick: function() { onChange(opt.value); },
            children: opt.label,
          });
        }),
      });
    }

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

    // Model routing uses the same live directory as the composer model selector.
    const MODEL_ROLES = [
      { id: 'cheap', label: '日常与重复任务', provider: 'dp', model: 'deepseek-v4.1-flash', use: '取数、转格式、常规问答、写测试', cost: '参考倍率 0.15' },
      { id: 'code', label: '代码实现', provider: 'dp', model: 'kimi-k2.7-code', use: '实现功能、批量修改、补注释', cost: '参考倍率 0.15' },
      { id: 'fast', label: '快速处理', provider: 'dp', model: 'gemini-3.8-flash', use: '摘要、翻译、分类、初筛', cost: '参考倍率 0.15' },
      { id: 'claude', label: '分析与审查', provider: 'claude', model: 'claude-opus-5-5', use: '需求分析、代码审查、多轮推敲', cost: '参考倍率 0.75' },
      { id: 'plan', label: '架构与规划', provider: 'gpt', model: 'gpt-5.6-sol', use: '架构设计、技术选型、方案比较', cost: '参考倍率 0.27' },
      { id: 'ds', label: 'DeepSeek 官方 · 暂停使用', provider: 'deepseek-official', model: 'deepseek-flash', use: '你近期不续费官方 API，暂不从此页切入', paused: true },
    ];
    const routeName = value => value ? value.provider + '/' + value.model : '尚未读取';
    const routeMatch = (a, b) => !!a && !!b && a.provider === b.provider && a.model === b.model;
    const routeModel = (groups, value) => groups.find(g => g.id === value?.provider)?.models.find(m => m.id === value?.model);

    class ModelRouteController {
      constructor(services) {
        this.services = services;
        this.listeners = new Set();
        this.state = { sessionId: null, title: '', directory: null, previous: null, busy: false, error: '', message: '' };
        this.generation = 0;
        this.stopDirectory = () => {};
        this.stopSessions = () => {};
        this.previous = new Map();
      }
      emit(patch) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
      start() {
        if (!this.services?.sessions || !this.services?.modelDirectories) { this.emit({ error: '模型服务尚未就绪，请刷新页面后再进入。' }); return; }
        this.state = { ...this.state, sessionId: null };
        this.stopSessions = this.services.sessions.list.subscribe(() => this.bind());
        this.bind();
      }
      bind() {
        const rows = Object.values(this.services.sessions.list.getSnapshot().byId);
        const main = rows.filter(r => (r.retainedBy?.mainView ?? this.services.sessions.retainInfo(r.id).getSnapshot().retainedBy.mainView ?? 0) > 0 && this.services.sessions.subagentAddress(r.id) === undefined);
        const row = main.length === 1 ? main[0] : null;
        if (row && row.id === this.state.sessionId) { if (row) this.emit({ title: row.title || '当前会话' }); return; }
        ++this.generation;
        this.stopDirectory();
        this.directory = null;
        if (!row) {
          this.emit({ sessionId: null, directory: null, previous: null, busy: false, title: '', error: main.length > 1 ? '有多个会话在主视图，请先打开一个会话。' : '' });
          return;
        }
        try {
          this.directory = this.services.modelDirectories.directoryFor(row.id);
          const directory = this.directory, generation = this.generation;
          const sync = () => { if (generation === this.generation) this.emit({ directory: directory.store.getSnapshot() }); };
          this.stopDirectory = this.directory.store.subscribe(sync);
          let previous = this.previous.get(row.id) || null;
          try { previous = previous || JSON.parse(window.localStorage.getItem('dsh.model-route.previous.' + row.id) || 'null'); } catch (_) {}
          this.emit({ sessionId: row.id, title: row.title || '当前会话', directory: this.directory.store.getSnapshot(), previous, busy: false, error: '', message: '' });
          this.refresh();
        } catch (e) { this.emit({ sessionId: row.id, directory: null, previous: null, busy: false, error: String(e.message || e) }); }
      }
      async refresh() {
        const directory = this.directory, generation = this.generation;
        if (!directory) return;
        try { await directory.load(); if (generation === this.generation) this.emit({ directory: directory.store.getSnapshot(), error: '' }); }
        catch (e) { if (generation === this.generation) this.emit({ error: String(e.message || e) }); }
      }
      async select(target) {
        if (this.state.busy || !this.directory) return;
        const row = this.services.sessions.list.getSnapshot().byId[this.state.sessionId];
        if (!row || (this.services.sessions.retainInfo(row.id).getSnapshot().retainedBy.mainView ?? 0) === 0) {
          this.emit({ error: '目标会话已离开主视图，请重新打开后再切换。' }); return;
        }
        const directory = this.directory, before = directory.store.getSnapshot().current;
        const model = routeModel(directory.store.getSnapshot().groups, target);
        if (target.provider === 'deepseek-official') { this.emit({ error: 'DeepSeek 官方已暂停使用。' }); return; }
        if (!model) { this.emit({ error: '目标模型不在当前目录中，请刷新后再试。' }); return; }
        if (target.reasoningEffort !== undefined && !model.reasoning?.efforts.some(e => e.id === target.reasoningEffort)) {
          this.emit({ error: '该模型未提供此思考档位，请重新选择。' }); return;
        }
        if (routeMatch(before, target) && before.reasoningEffort === target.reasoningEffort) {
          this.emit({ error: '', message: '当前已使用此配置。' }); return;
        }
        const generation = this.generation, sessionId = this.state.sessionId;
        this.emit({ busy: true, error: '', message: '' });
        try {
          const result = await directory.select(target);
          if (!result?.ok) throw new Error(result?.error?.message || '模型切换未成功');
          if (before) {
            this.previous.set(sessionId, before);
            try { window.localStorage.setItem('dsh.model-route.previous.' + sessionId, JSON.stringify(before)); } catch (_) {}
          }
          if (generation !== this.generation) return;
          this.emit({ directory: directory.store.getSnapshot(), previous: before, message: '已切换为 ' + routeName(target) + '，后续请求使用新配置。' });
        } catch (e) { if (generation === this.generation) this.emit({ error: String(e.message || e) }); }
        finally { if (generation === this.generation) this.emit({ busy: false }); }
      }
      dispose() { ++this.generation; this.stopSessions(); this.stopDirectory(); this.listeners.clear(); }
    }

    function ModelRoutingPage({ services, onBack }) {
      const [controller] = react.useState(() => new ModelRouteController(services));
      const [state, setState] = react.useState(controller.state);
      const [chosen, setChosen] = react.useState(null);
      const [effort, setEffort] = react.useState('');
      const [pending, setPending] = react.useState(null);
      react.useEffect(() => {
        const stop = controller.subscribe(() => setState(controller.state));
        controller.start();
        return () => { stop(); controller.dispose(); };
      }, [controller]);
      const currentKey = state.sessionId + ':' + routeName(state.directory?.current) + ':' + (state.directory?.current?.reasoningEffort || '');
      react.useEffect(() => { setChosen(null); setPending(null); setEffort(''); }, [currentKey]);
      const directory = state.directory || {}, current = directory.current;
      const groups = directory.groups || [];
      const target = chosen || current;
      const model = routeModel(groups, target);
      const levels = model?.reasoning?.efforts || [];
      const currentRole = MODEL_ROLES.find(r => routeMatch(r, current));
      const unavailable = !state.sessionId || !current || directory.status === 'loading' || directory.status === 'error' || directory.status === 'selecting' || state.busy;
      const targetEffort = effort || (routeMatch(target, current) ? current?.reasoningEffort : undefined) || model?.reasoning?.defaultEffort;
      const request = target ? { provider: target.provider, model: target.model, ...(targetEffort ? { reasoningEffort: targetEffort } : {}) } : null;
      const pick = value => { setChosen(value); setEffort(''); setPending(null); };
      const confirm = value => setPending({ sessionId: state.sessionId, target: value });
      return jsxs('div', { className: 'ctl-root', children: [
        jsx(Back, { title: '模型分工', onBack }),
        jsx(Note, { children: '按任务手动选模型。当前页面只操作正在打开的会话，切换时也会更新引擎默认模型。' }),
        jsxs('div', { className: 'ctl-life-card', style: { margin: '12px 0' }, children: [
          jsx('div', { className: 'ctl-brand', children: '当前使用' }),
          jsx('div', { className: 'ctl-title', children: routeName(current) }),
          jsx('div', { className: 'ctl-desc', children: (currentRole?.label || '自定义模型') + ' · 思考深度 ' + (current?.reasoningEffort || routeModel(groups, current)?.reasoning?.defaultEffort || '模型默认') }),
          jsx('div', { className: 'ctl-desc', children: state.sessionId ? state.title + ' · ' + state.sessionId.slice(0, 12) : '先打开一个会话，再进入模型分工' }),
          jsx(Button, { variant: 'outline', size: 'sm', disabled: state.busy, onClick: () => controller.refresh(), children: '刷新状态' }),
        ] }),
        (state.error || directory.error) ? jsx('div', { role: 'alert', className: 'ctl-desc ctl-warn', children: state.error || String(directory.error?.message || directory.error) }) : null,
        state.message ? jsx('div', { role: 'status', className: 'ctl-note', children: state.message }) : null,
        jsx('div', { className: 'ctl-group', children: '按任务选择' }),
        jsx('div', { className: 'ctl-life-grid', children: MODEL_ROLES.map(role => {
          const available = !!routeModel(groups, role), selected = routeMatch(role, target);
          return jsxs('div', { className: 'ctl-life-card', style: selected ? { borderColor: 'var(--dsw-alias-state-business-primary)' } : {}, children: [
            jsxs('div', { className: 'ctl-life-card-head', children: [jsx('div', { className: 'ctl-life-card-title', children: role.label }), jsx('span', { className: 'ctl-tag', children: role.paused ? '已暂停' : routeMatch(role, current) ? '使用中' : role.cost })] }),
            jsx('div', { className: 'ctl-desc', children: routeName(role) }),
            jsx('div', { className: 'ctl-desc', children: role.use }),
            jsx(Button, { variant: 'outline', size: 'sm', disabled: unavailable || role.paused || !available, onClick: () => pick({ provider: role.provider, model: role.model }), children: role.paused ? '暂不使用' : !available ? '目录中不可用' : selected ? '已选定' : '选择此角色' }),
          ] }, role.id);
        }) }),
        jsx('div', { className: 'ctl-group', children: '本次配置' }),
        jsx(Row, { title: '目标模型', desc: routeName(target) }),
        levels.length ? jsxs('label', { className: 'ctl-note', children: ['思考深度', jsx('select', { className: 'ctl-voice-input', value: effort, disabled: unavailable, onChange: e => setEffort(e.target.value), children: [jsx('option', { value: '', children: routeMatch(target, current) ? '保持当前档位 / 模型默认' : '模型默认' }), ...levels.map(level => jsx('option', { value: level.id, children: level.name + ' (' + level.id + ')' }, level.id))] })] }) : jsx(Note, { children: '此模型未声明思考档位，使用模型默认值。' }),
        jsxs('div', { className: 'ctl-bar', children: [
          jsx(Button, { variant: 'primary', size: 'sm', disabled: unavailable || !model || target?.provider === 'deepseek-official', onClick: () => confirm(request), children: state.busy ? '正在切换…' : '应用配置' }),
          jsx(Button, { variant: 'outline', size: 'sm', disabled: unavailable || !state.previous || state.previous.provider === 'deepseek-official' || !routeModel(groups, state.previous), onClick: () => confirm(state.previous), children: '回到上一次配置' }),
          chosen ? jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => pick(null), children: '保持当前模型' }) : null,
        ] }),
        jsx(Note, { children: '参考倍率来自既有角色配置，可能变化，也不是每条消息的实际价格。模型目录可用不代表账户有余额；此页不发起付费试聊。' }),
        jsx(Note, { children: '日常与重复任务中的 DeepSeek 走 dp 中继，不使用 DeepSeek 官方余额。切换模型会把当前对话上下文交给对应服务。' }),
        pending ? jsx(Confirm, { pending: { title: '应用模型配置', text: state.title + '：' + routeName(current) + ' → ' + routeName(pending.target) + '，思考深度 ' + (pending.target.reasoningEffort || '模型默认') }, onCancel: () => setPending(null), onOk: () => {
          const operation = pending; setPending(null);
          if (operation.sessionId === controller.state.sessionId) controller.select(operation.target);
        } }) : null,
      ] });
    }

    const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    /** 10月15日 周四（今天）—— 全部账目页的日期分组标题。 */
    function fmtDay(ts) {
      const d = new Date(ts);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const that = new Date(d.getTime());
      that.setHours(0, 0, 0, 0);
      const diff = Math.round((today.getTime() - that.getTime()) / 86400000);
      return (d.getFullYear() !== today.getFullYear() ? d.getFullYear() + '年' : '') + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK_CN[d.getDay()] + (diff === 0 ? '（今天）' : diff === 1 ? '（昨天）' : '');
    }

    /**
     * 全部账目页：按天分组、每页 60 笔、可「加载更多」。
     * 入口在「💰 今日记账与消费流水」卡片底部 —— 那张卡片只列**今天**（用户 2026-10-15 要求），
     * 更早的账都在这里翻。
     */
    function LedgerPage({ onBack }) {
      const PAGE = 60;
      const [rows, setRows] = react.useState([]);
      const [meta, setMeta] = react.useState({ total: 0, expense: 0, income: 0 });
      const [err, setErr] = react.useState('');
      const [loading, setLoading] = react.useState(true);
      const active = react.useRef(false);
      const request = react.useRef(null);

      const load = react.useCallback(async (offset) => {
        // Ref 同步加锁：按钮禁用要等重渲染，挡不住同一帧的连续点击。
        if (request.current || !active.current) return;
        const controller = new AbortController();
        request.current = controller;
        setLoading(true);
        setErr('');
        try {
          const res = await fetch('/life/api/tx?limit=' + PAGE + '&offset=' + offset, { signal: controller.signal });
          const data = await res.json();
          if (!res.ok || !data || !data.ok || !Array.isArray(data.txs)) {
            throw new Error((data && data.error) || '读取失败（HTTP ' + res.status + '）');
          }
          if (controller.signal.aborted || !active.current) return;
          setRows((prev) => (offset > 0 ? prev.concat(data.txs) : data.txs));
          setMeta({ total: data.total || 0, expense: data.expense || 0, income: data.income || 0 });
        } catch (e) {
          if (!controller.signal.aborted && active.current) setErr(String((e && e.message) || e));
        } finally {
          if (request.current === controller) {
            request.current = null;
            if (active.current) setLoading(false);
          }
        }
      }, []);

      react.useEffect(() => {
        active.current = true;
        load(0);
        return () => {
          active.current = false;
          if (request.current) request.current.abort();
          request.current = null;
        };
      }, [load]);

      const groups = [];
      const index = {};
      for (const tx of rows) {
        const key = fmtDay(tx.created_at);
        if (!(key in index)) {
          index[key] = groups.length;
          groups.push({ key, at: tx.created_at, txs: [], expense: 0, income: 0 });
        }
        const g = groups[index[key]];
        g.txs.push(tx);
        if (tx.type === 'income') g.income += Number(tx.amount || 0);
        else g.expense += Number(tx.amount || 0);
      }

      const rowOf = (tx) => jsxs('div', { key: tx.id, className: 'ctl-item-row', children: [
        jsxs('div', { className: 'ctl-main', children: [
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' }, children: [
            jsx('span', { style: { fontSize: '13.5px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }, children: tx.merchant || '消费' }),
            tx.category ? jsx('span', { className: 'ctl-tag', children: tx.category }) : null,
          ] }),
          jsx('div', { className: 'ctl-desc', children: (tx.account || '自动记账') + ' · ' + new Date(tx.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) }),
        ] }),
        jsx('span', { className: tx.type === 'income' ? 'ctl-amt-pos' : 'ctl-amt-neg', children: (tx.type === 'income' ? '+ ¥' : '- ¥') + Number(tx.amount || 0).toFixed(2) }),
      ] });

      return jsxs('div', { className: 'ctl-root', children: [
        jsx(Back, { title: '全部账目', onBack }),
        jsx(Note, { children: loading && rows.length === 0 ? '正在读取全部账目…' : err && rows.length === 0 ? '暂时无法读取账目，请重试。' : '自动记账 + 手工补录的全部流水，按天倒序。共 ' + meta.total + ' 笔：支出 ¥' + Number(meta.expense).toFixed(2) + '，收入 ¥' + Number(meta.income).toFixed(2) + '。' }),
        jsx('div', { className: 'ctl-sep' }),
        err ? jsx('div', { className: 'ctl-warn', children: '读取失败：' + err }) : null,
        (!loading && !err && rows.length === 0) ? jsx('div', { className: 'ctl-note', children: '这里还没有账目。' }) : null,
        groups.map((g) => jsxs('div', { key: g.key, className: 'ctl-life-card', children: [
          jsxs('div', { className: 'ctl-life-card-head', children: [
            jsx('span', { className: 'ctl-life-card-title', children: fmtDay(g.at) }),
            jsxs('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: [
              '已加载合计 · 支出 ', jsx('span', { className: 'ctl-amt-neg', children: '¥' + g.expense.toFixed(2) }),
              ' 收入 ', jsx('span', { className: 'ctl-amt-pos', children: '¥' + g.income.toFixed(2) }),
            ] }),
          ] }),
          g.txs.map(rowOf),
        ] })),
        err || rows.length < meta.total
          ? jsx('div', { style: { display: 'flex', justifyContent: 'center', padding: '10px 0 6px' }, children: jsx(Button, {
              variant: 'outline',
              size: 'sm',
              disabled: loading,
              onClick: () => load(rows.length),
              children: loading ? '加载中…' : err ? '重试读取' : '加载更多（还有 ' + (meta.total - rows.length) + ' 笔）',
            }) })
          : null,
      ] });
    }

    function ConsoleSection(ownerProps) {
      ensureCss();
      const close = ownerProps && typeof ownerProps.close === 'function' ? ownerProps.close : () => {};
      const [page, setPage] = react.useState('main');
      const [pending, setPending] = react.useState(null);
      const [flash, setFlash] = react.useState('');
      const rawState = useConsoleState();
      const lifeData = useLifeState(rawState && rawState.life);
      const voiceHubHook = useVoiceHubState(rawState && rawState.voice);
      const voiceHub = voiceHubHook.voiceHub || {};
      const saveVoiceConfig = voiceHubHook.saveConfig;
      const testSpeak = voiceHubHook.testSpeak;
      const ragHook = useRagState();
      const lanHook = useLanMeshState();
      const [ragQuery, setRagQuery] = react.useState('');
      const [clipTitle, setClipTitle] = react.useState('');
      const [clipText, setClipText] = react.useState('');
      const [lanInput, setLanInput] = react.useState('');
      const [testText, setTestText] = react.useState('你好！我是 DeepSeek 智能语音分身，随时为您服务。');
      const [isAuditioning, setIsAuditioning] = react.useState(false);
      const state = rawState ? Object.assign({}, rawState, { life: lifeData }) : null;
      const flashTimer = react.useRef(null);

      const say = react.useCallback((text) => {
        setFlash(text || '');
        if (flashTimer.current) clearTimeout(flashTimer.current);
        if (text) flashTimer.current = setTimeout(() => setFlash(''), 4000);
      }, []);
      react.useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

      /** 发一个动作；需要二次确认的走 ask()。 */
      const run = react.useCallback((id, arg, done) => {
        const res = executeAction(id, arg);
        if (res && res.ok === false && res.msg) say(res.msg);
        else if (done) say(done);
        return res;
      }, [say]);

      const ask = react.useCallback((title, text, id, arg, done) => {
        setPending({ title: title, text: text, run: () => run(id, arg, done) });
      }, [run]);

      if (page === 'models') return jsx(ModelRoutingPage, { services: ownerProps.modelServices, onBack: () => setPage('main') });

      if (page === 'ledger') return jsx(LedgerPage, { onBack: () => setPage('life') });

      if (!state) {
        return jsx('div', { className: 'ctl-empty', children: [
          jsx('div', { className: 'ctl-title', children: '控制台只在安卓应用内可用' }),
          jsx('div', { className: 'ctl-desc', children: '这一页通过手机壳的桥（dshshell）执行解压 / 起引擎 / 授权等动作；桌面浏览器里没有这条通道。' }),
          jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setPage('models'), children: '进入模型分工' }),
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

      // ---------------- 语音设置与 TTS 调音台页
      if (page === 'voice') {
        const vo = state.voice || {};
        const vCfg = voiceHub.config || {};
        const presets = voiceHub.presets || [];
        const isHotword = vCfg.hotword_enabled === '1' || vo.hotwordEnabled;
        const currentWords = vCfg.wake_words || vo.wakeWords || '流光,小鲸鱼,DeepSeek';
        const currentVoice = vCfg.tts_voice || 'zh-CN-XiaoxiaoNeural';
        const currentSpeed = vCfg.tts_speed || '1.0';
        const currentEngine = vCfg.tts_engine || 'edge';

        return jsxs('div', { className: 'ctl-root', children: [
          jsx(Back, { title: '语音交互与 TTS 调音台', onBack: () => setPage('main') }),
          jsx(Note, { children: '全能语音中枢：支持端侧低功耗语音唤醒、多模型超自然 TTS 音色调优、一句话连贯问答与小鲸鱼悬浮球对讲。' }),
          jsx('div', { className: 'ctl-sep' }),

          // ========== 第一板块：⚡ 语音唤醒与识别 ==========
          jsx('div', { className: 'ctl-group', children: '⚡ 语音唤醒与识别 (Wake-up & STT)' }),
          jsx(Row, {
            title: '语音热词唤醒',
            desc: isHotword ? '🟢 待命监听中 · 喊出唤醒词自动开麦（支持一句话直达）' : '已关闭（更省电，仍可通过长按悬浮球或耳机按键随时唤醒）',
            right: jsx(Switch, {
              checked: !!isHotword,
              label: '语音热词唤醒',
              onChange: (next) => {
                saveVoiceConfig({ hotword_enabled: next ? '1' : '0' });
                run('voice.hotword.toggle', next ? '1' : '0');
              },
            }),
          }),
          jsx(Row, {
            title: '自定义唤醒词',
            desc: '当前唤醒词：' + currentWords + '（支持同音字与拼音智能容错）',
            right: jsx(Button, {
              variant: 'outline',
              size: 'sm',
              onClick: () => {
                const input = window.prompt('请输入自定义唤醒词（支持多个，逗号隔开）：', currentWords);
                if (input !== null && input.trim() !== '') {
                  saveVoiceConfig({ wake_words: input.trim() });
                  run('voice.wakewords.set', input.trim());
                }
              },
              children: '修改',
            }),
          }),
          jsx(Row, {
            title: '唤醒交互模式',
            desc: vCfg.wake_mode === 'two_step' ? '双步交互：喊唤醒词 ➔ 叮~ 冒泡提示 ➔ 等待您说指令' : '一句话直达：一口气说「小鲸鱼 帮我查天气」连贯执行（推荐）',
            right: jsx(SegmentedControl, {
              value: vCfg.wake_mode || 'single_breath',
              options: [
                { value: 'single_breath', label: '一句话直达' },
                { value: 'two_step', label: '双步等待' },
              ],
              onChange: (mode) => saveVoiceConfig({ wake_mode: mode }),
            }),
          }),

          jsx('div', { className: 'ctl-sep' }),

          // ========== 第二板块：🔊 TTS 语音模型与音色调音台 ==========
          jsx('div', { className: 'ctl-group', children: '🔊 TTS 语音模型与音色调音台' }),
          jsxs('div', { style: { padding: '8px 0 6px' }, children: [
            jsx('div', { className: 'ctl-title', children: 'TTS 播报引擎' }),
            jsx('div', { className: 'ctl-desc', style: { marginBottom: '8px' }, children: '选择语音合成服务来源（微软自然音 / OpenAI / 系统原生 / 自定义 API）' }),
            jsx(SegmentGrid, {
              columns: 2,
              value: currentEngine,
              options: [
                { value: 'edge', label: '微软自然音' },
                { value: 'openai', label: 'OpenAI' },
                { value: 'system', label: '系统原生' },
                { value: 'custom', label: '自定义 API' },
              ],
              onChange: (eng) => saveVoiceConfig({ tts_engine: eng }),
            }),
          ] }),

          // 预设音色库卡片选择
          jsx('div', { style: { padding: '8px 0 2px' }, children: [
            jsx('div', { className: 'ctl-title', style: { fontSize: '13px', marginBottom: '6px' }, children: '精选音色预设库（点击切换）' }),
            jsx('div', { className: 'ctl-voice-grid', children: presets.map((p) => {
              const active = currentVoice === p.id;
              return jsxs('div', {
                key: p.id,
                className: 'ctl-voice-card' + (active ? ' active' : ''),
                onClick: () => {
                  saveVoiceConfig({ tts_voice: p.id, tts_engine: p.engine });
                  say('已切换音色：' + p.name);
                },
                children: [
                  jsx('div', { className: 'ctl-voice-card-name', children: p.name }),
                  jsx('div', { className: 'ctl-voice-card-tags', children: p.tags }),
                ],
              });
            }) }),
          ] }),

          // 语速微调
          jsxs('div', { style: { padding: '8px 0 6px' }, children: [
            jsx('div', { className: 'ctl-title', children: '播报语速' }),
            jsx('div', { className: 'ctl-desc', style: { marginBottom: '8px' }, children: '当前倍速：' + currentSpeed + 'x（标准为 1.0x）' }),
            jsx(SegmentGrid, {
              columns: 4,
              value: currentSpeed,
              options: [
                { value: '0.8', label: '0.8x 舒缓' },
                { value: '1.0', label: '1.0x 标准' },
                { value: '1.25', label: '1.25x 快速' },
                { value: '1.5', label: '1.5x 极速' },
              ],
              onChange: (spd) => saveVoiceConfig({ tts_speed: spd }),
            }),
          ] }),

          // 自定义 API 折叠配置
          (currentEngine === 'custom' || currentEngine === 'openai') ? jsxs('div', { className: 'ctl-life-card', style: { marginTop: '8px' }, children: [
            jsx('div', { className: 'ctl-life-card-title', children: '⚙️ 云端 TTS / 中转站 API 配置' }),
            jsx('div', { className: 'ctl-desc', children: '支持 OpenAI、CosyVoice、豆包TTS、FishSpeech 等兼容接口' }),
            jsx('input', {
              className: 'ctl-voice-input',
              style: { marginTop: '6px' },
              placeholder: 'API 地址，如 https://api.openai.com/v1/audio/speech',
              value: vCfg.custom_api_url || '',
              onChange: (e) => saveVoiceConfig({ custom_api_url: e.target.value }),
            }),
            jsx('input', {
              className: 'ctl-voice-input',
              type: 'password',
              style: { marginTop: '6px' },
              placeholder: 'API Key (sk-...)，留空默认使用系统环境变量',
              value: vCfg.custom_api_key || '',
              onChange: (e) => saveVoiceConfig({ custom_api_key: e.target.value }),
            }),
            jsx('input', {
              className: 'ctl-voice-input',
              style: { marginTop: '6px' },
              placeholder: '模型名称，如 tts-1 / cosyvoice-v1 / doubao-tts',
              value: vCfg.custom_model_name || 'tts-1',
              onChange: (e) => saveVoiceConfig({ custom_model_name: e.target.value }),
            }),
          ] }) : null,

          jsx('div', { className: 'ctl-sep' }),

          // ========== 第三板块：🎧 实时试听与对讲调音 ==========
          jsx('div', { className: 'ctl-group', children: '🎧 实时试听与对讲调音 (Live Audition)' }),
          jsxs('div', { className: 'ctl-life-card', children: [
            jsx('div', { className: 'ctl-life-card-head', children: [
              jsx('div', { className: 'ctl-life-card-title', children: '🎵 试听文案与声音测试' }),
              isAuditioning ? jsxs('div', { className: 'ctl-voice-wave', children: [
                jsx('div', { className: 'ctl-voice-bar' }),
                jsx('div', { className: 'ctl-voice-bar' }),
                jsx('div', { className: 'ctl-voice-bar' }),
                jsx('div', { className: 'ctl-voice-bar' }),
              ] }) : null,
            ] }),
            jsx('input', {
              className: 'ctl-voice-input',
              placeholder: '输入试听文案...',
              value: testText,
              onChange: (e) => setTestText(e.target.value),
            }),
            jsxs('div', { className: 'ctl-btn-group', style: { marginTop: '8px', justifyContent: 'flex-end' }, children: [
              jsx(Button, {
                variant: 'primary',
                size: 'sm',
                disabled: isAuditioning,
                onClick: async () => {
                  setIsAuditioning(true);
                  say('正在生成并播报语音…');
                  await testSpeak(testText || '你好！我是 DeepSeek 智能语音分身，随时为您服务。', {
                    voice: currentVoice,
                    engine: currentEngine,
                    speed: currentSpeed,
                  });
                  setTimeout(() => setIsAuditioning(false), 2500);
                },
                children: isAuditioning ? '正在播报…' : '🎵 试听当前音色',
              }),
              jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('voice.test.tone', '', '已播放提示音'), children: '🔔 提示音' }),
              jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('voice.test.listen', '', '已开麦收音'), children: '🎤 实时开麦' }),
            ] }),
          ] }),

          jsx(Note, { children: '💡 提示：按蓝牙耳机播放/暂停键，或长按桌宠小鲸鱼悬浮球，也可一键唤醒语音对讲。' }),
          confirmBar,
          flashBar,
        ] });
      }

      // ---------------- 生活助理页
      if (page === 'life') {
        const lf = state.life || {};
        const pkgs = lf.packages || [];
        const codes = lf.codes || [];
        const txs = lf.transactions || [];
        const schedules = state.schedules || {};
        const tasks = schedules.items || (lf.tasks || []).map(t => Object.assign({ source: 'life' }, t));
        const history = schedules.history || [];
        const isRunning = !!lf.daemonRunning;

        return jsxs('div', { className: 'ctl-root', children: [
          jsx(Back, { title: '智能生活助理', onBack: () => setPage('main') }),
          jsx(Note, { children: '全自动无感感知：短信/通知验证码自动提取写入剪贴板、微信/支付宝/银行动账自动记账、快递取件码聚合与定时任务调度。' }),
          jsx('div', { className: 'ctl-sep' }),

          // 守护状态卡片
          jsx(Row, {
            title: isRunning ? '生活助理守护进程：运行中' : '生活助理守护进程：未运行',
            desc: isRunning ? '正在实时监听系统通知流，自动提取验证码、记账与包裹' : '启动后可在后台自动感知通知并写入剪贴板与记账数据库',
            right: jsxs('div', { className: 'ctl-btn-group', children: isRunning
              ? [
                  jsx(Button, { key: 'res', variant: 'outline', size: 'sm', onClick: () => run('life.daemon.restart', '', '正在重启守护进程…'), children: '重启' }),
                  jsx(Button, { key: 'stp', variant: 'ghost', size: 'sm', onClick: () => run('life.daemon.stop', '', '已停止守护进程'), children: '停止' }),
                ]
              : [
                  jsx(Button, { key: 'sta', variant: 'primary', size: 'sm', onClick: () => run('life.daemon.start', '', '正在启动守护进程…'), children: '启动守护' }),
                ] }),
          }),

          jsx('div', { className: 'ctl-life-grid', children: [
            // 0. 智能生活情境与每日简报
            jsxs('div', { className: 'ctl-life-card', children: [
              jsxs('div', { className: 'ctl-life-card-head', children: [
                jsx('span', { className: 'ctl-life-card-title', children: '🌟 情境模式与每日简报' }),
                jsxs('div', { className: 'ctl-btn-group', children: [
                  jsx(Button, {
                    variant: 'outline',
                    size: 'sm',
                    onClick: async () => {
                      const res = await run('life.scene.morning', '', '正在生成晨间生活早报…');
                      if (res && res.result && res.result.content) say('早报已生成并推送系统通知');
                    },
                    children: '☀️ 晨间早报',
                  }),
                  jsx(Button, {
                    variant: 'outline',
                    size: 'sm',
                    onClick: async () => {
                      const res = await run('life.scene.night', '', '正在生成晚间收支复盘…');
                      if (res && res.result && res.result.content) say('复盘已生成并推送系统通知');
                    },
                    children: '🌙 晚间复盘',
                  }),
                ] }),
              ] }),
              jsx('div', { className: 'ctl-desc', style: { lineHeight: '18px' }, children: (lf.morningBrief && lf.morningBrief.summary) || '早晨汇总包裹与记账预算，夜间复盘今日开销流水与未取提醒' }),
            ] }),

            // 1. 待取快递
            jsxs('div', { className: 'ctl-life-card', children: [
              jsxs('div', { className: 'ctl-life-card-head', children: [
                jsx('span', { className: 'ctl-life-card-title', children: '📦 待取快递包裹 (' + pkgs.length + '件)' }),
                jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => run('life.scan', '', '正在扫描历史通知…'), children: '扫描通知' }),
              ] }),
              pkgs.length === 0
                ? jsx('div', { className: 'ctl-note', children: '🎉 暂无待取包裹，所有快递都已取完！' })
                : pkgs.map((p) => jsxs('div', { key: p.id, className: 'ctl-item-row', children: [
                    jsxs('div', { className: 'ctl-main', children: [
                      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' }, children: [
                        jsx('span', { className: 'ctl-code-pill', children: p.pickup_code }),
                        jsx('span', { className: 'ctl-tag', children: p.carrier || '快递' }),
                      ] }),
                      jsx('div', { className: 'ctl-desc', style: { marginTop: '4px' }, children: (p.station || '快递驿站/柜') + ' · ' + (p.created_at ? new Date(p.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '') }),
                    ] }),
                    jsx(Button, {
                      variant: 'outline',
                      size: 'sm',
                      onClick: () => run('life.pkg.pick', String(p.id), '已标记取件完成'),
                      children: '已取',
                    }),
                  ] })),
            ] }),

            // 2. 今日记账
            jsxs('div', { className: 'ctl-life-card', children: [
              jsxs('div', { className: 'ctl-life-card-head', children: [
                jsx('span', { className: 'ctl-life-card-title', children: '💰 今日记账与消费流水' }),
                jsxs('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }, children: [
                  '支出: ',
                  jsx('span', { className: 'ctl-amt-neg', children: '¥' + (lf.todayExpense || 0).toFixed(2) }),
                  '  收入: ',
                  jsx('span', { className: 'ctl-amt-pos', children: '¥' + (lf.todayIncome || 0).toFixed(2) }),
                ] }),
              ] }),
              (lf.balances && lf.balances.length)
                ? jsx('div', { className: 'ctl-desc', style: { padding: '2px 12px 6px' }, children: '账户余额：' + lf.balances.map((b) => (b.account || '账户') + ' ¥' + Number(b.amount || 0).toFixed(2)).join('｜') + (lf.balances[0] && lf.balances[0].at ? '（' + new Date(lf.balances[0].at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + '）' : '') })
                : null,
              (typeof lf.monthIncome === 'number' && typeof lf.monthExpense === 'number')
                ? jsxs('div', { className: 'ctl-desc', style: { padding: '0 12px 6px' }, children: [
                    jsx('span', { children: '本月结余 ' }),
                    jsx('span', {
                      className: (lf.monthIncome - lf.monthExpense) >= 0 ? 'ctl-amt-pos' : 'ctl-amt-neg',
                      children: '¥' + (lf.monthIncome - lf.monthExpense).toFixed(2),
                    }),
                    jsx('span', {
                      children: ' · 支出 ¥' + lf.monthExpense.toFixed(2) + ' / 收入 ¥' + lf.monthIncome.toFixed(2)
                        + (lf.monthTxCount ? '（' + lf.monthTxCount + ' 笔）' : ''),
                    }),
                  ] })
                : null,
              txs.length === 0
                ? jsx('div', { className: 'ctl-note', children: '今日暂无新记账记录。收到微信/支付宝/银行支付通知时将自动记账。' })
                : txs.map((tx) => jsxs('div', { key: tx.id, className: 'ctl-item-row', children: [
                    jsxs('div', { className: 'ctl-main', children: [
                      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' }, children: [
                        jsx('span', { style: { fontSize: '13.5px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }, children: tx.merchant || '消费' }),
                        tx.category ? jsx('span', { className: 'ctl-tag', children: tx.category }) : null,
                      ] }),
                      jsx('div', { className: 'ctl-desc', children: (tx.account || '自动记账') + ' · ' + (tx.created_at ? new Date(tx.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '') }),
                    ] }),
                    jsx('span', { className: tx.type === 'income' ? 'ctl-amt-pos' : 'ctl-amt-neg', children: (tx.type === 'income' ? '+ ¥' : '- ¥') + Number(tx.amount || 0).toFixed(2) }),
                  ] })),
              (lf.txToday > txs.length)
                ? jsx('div', { className: 'ctl-desc', style: { padding: '0 12px' }, children: '今日还有 ' + (lf.txToday - txs.length) + ' 笔未显示（进「全部账目」看）' })
                : null,
              jsx('div', { style: { display: 'flex', justifyContent: 'flex-end', padding: '2px 12px 0' }, children: jsx(Button, {
                variant: 'ghost',
                size: 'sm',
                onClick: () => setPage('ledger'),
                children: '全部账目（共 ' + (lf.txTotal || 0) + ' 笔）›',
              }) }),
            ] }),

            // 3. 验证码
            jsxs('div', { className: 'ctl-life-card', children: [
              jsx('div', { className: 'ctl-life-card-head', children: [
                jsx('span', { className: 'ctl-life-card-title', children: '📱 最近验证码' }),
                jsx('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }, children: '收到自动复制进剪贴板' }),
              ] }),
              codes.length === 0
                ? jsx('div', { className: 'ctl-note', children: '暂无最近验证码记录。' })
                : codes.map((c) => jsxs('div', { key: c.id, className: 'ctl-item-row', children: [
                    jsxs('div', { className: 'ctl-main', children: [
                      jsx('span', { className: 'ctl-code-pill', children: c.code }),
                      jsx('div', { className: 'ctl-desc', style: { marginTop: '4px' }, children: (c.source || '短信验证码') + ' · ' + (c.created_at ? new Date(c.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '') }),
                    ] }),
                    jsx(Button, {
                      variant: 'outline',
                      size: 'sm',
                      onClick: () => run('life.code.copy', c.code, '验证码已复制'),
                      children: '复制',
                    }),
                  ] })),
            ] }),

            // 4. 两套调度器的任务及原生执行历史
            jsxs('div', { className: 'ctl-life-card', children: [
              jsx('div', { className: 'ctl-life-card-title', children: '⏰ 定时任务 (' + tasks.length + '项)' }),
              schedules.lifeError ? jsx(Note, { children: '生活助理任务读取失败: ' + schedules.lifeError }) : null,
              tasks.length === 0 ? jsx(Note, { children: '暂无等待触发的任务。' }) : tasks.map(t => jsxs('div', {
                key: t.source + ':' + t.id, className: 'ctl-item-row', children: [
                  jsxs('div', { className: 'ctl-main', children: [
                    jsx('span', { style: { fontSize: '13.5px', fontWeight: 500 }, children: t.name }),
                    jsx('div', { className: 'ctl-desc', children: (t.source === 'app' ? 'App 闹钟' : '生活助理') + ' · ' +
                      (t.cron_expr || (t.repeat === 'daily' ? '每天' : t.repeat === 'interval' ? '每 ' + t.intervalMin + ' 分钟' : '一次性')) +
                      ' · ' + (t.enabled ? (t.last_status || '等待触发') : '已暂停') +
                      (t.next_run_at ? ' · 下次: ' + new Date(t.next_run_at).toLocaleString('zh-CN') : '') }),
                    jsx('div', { className: 'ctl-desc', children: t.id }),
                  ] }),
                  t.source === 'life' ? jsx(Button, { variant: 'outline', size: 'sm',
                    onClick: () => run('life.task.run', String(t.id), '正在执行生活助理任务…'), children: '立即执行' }) : null,
                  jsx(Button, { variant: 'ghost', size: 'sm', disabled: !t.enabled,
                    onClick: () => run('schedule.cancel', JSON.stringify({source: t.source, id: t.id}), '取消请求已提交'), children: '取消' }),
                  jsx(Button, { variant: 'ghost', size: 'sm',
                    onClick: () => ask('删除定时任务', t.source === 'app'
                      ? '确定删除 App 闹钟任务「' + t.name + '」？会从任务列表里移除。注意：已经注册进系统的闹钟在老版本 App 上撤不掉，可能仍触发最后一次。'
                      : '确定永久删除生活助理任务「' + t.name + '」？删除后不会再触发，也无法从界面恢复。',
                      'life.task.delete', JSON.stringify({ source: t.source, id: String(t.id) }), '已删除任务: ' + t.name), children: '删除' }),
                ]
              })),
              jsxs('details', { children: [
                jsx('summary', { children: '最近执行记录 (' + history.length + ')' }),
                jsx('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '11px', maxHeight: '200px', overflow: 'auto' },
                  children: history.length ? history.join('\n') : '暂无 App 闹钟执行记录。' }),
              ] }),
              jsx(Note, { children: '取消 = 暂停（阻止后续触发，已开始的会继续）；删除 = 从列表永久移除。App 闹钟任务的登记行会被清掉，但老版本 App 里已注册进系统的闹钟撤不掉，可能仍触发最后一次。' }),
            ] }),
          ] }),

          confirmBar,
          flashBar,
        ] });
      }

      // ---------------- 本地知识库与检索页 (RAG)
      if (page === 'rag') {
        const kbs = ragHook.rag.kbs || [];
        const searchRes = ragHook.rag.searchResults || [];
        const isSearching = !!ragHook.rag.isSearching;

        return jsxs('div', { className: 'ctl-root', children: [
          jsx(Back, { title: '本地知识库与全域检索', onBack: () => setPage('main') }),
          jsx(Note, { children: '零 Token 开销端侧语义检索：全域扫描手机 Download / Documents 目录文档，支持随时快速剪藏笔记并实时构建倒排索引。' }),
          jsx('div', { className: 'ctl-sep' }),

          // 1. 全局搜索卡片
          jsxs('div', { className: 'ctl-life-card', children: [
            jsx('div', { className: 'ctl-life-card-title', children: '🔍 本地全域秒级检索' }),
            jsxs('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' }, children: [
              jsx('input', {
                className: 'ctl-voice-input',
                placeholder: '输入问题、代码关键词或文档标题...',
                value: ragQuery,
                onChange: (e) => setRagQuery(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter' && ragQuery) ragHook.search(ragQuery); },
              }),
              jsx(Button, {
                variant: 'primary',
                size: 'sm',
                disabled: isSearching || !ragQuery,
                onClick: () => ragHook.search(ragQuery),
                children: isSearching ? '检索中…' : '搜索',
              }),
            ] }),
            searchRes.length > 0
              ? jsxs('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }, children: [
                  searchRes.map((r, idx) => jsxs('div', { key: idx, className: 'ctl-item-row', children: [
                    jsxs('div', { className: 'ctl-main', children: [
                      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' }, children: [
                        jsx('span', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }, children: r.file }),
                        jsx('span', { className: 'ctl-tag', children: 'L' + r.startLine + '-' + r.endLine }),
                      ] }),
                      jsx('div', { className: 'ctl-desc', style: { whiteSpace: 'pre-wrap', marginTop: '4px', fontSize: '11.5px', fontFamily: 'monospace' }, children: r.snippet || r.content.slice(0, 150) }),
                    ] }),
                  ] })),
                ] })
              : (ragHook.rag.lastQuery ? jsx('div', { className: 'ctl-note', children: '未找到相关匹配段落。' }) : null),
          ] }),

          // 2. 随手剪藏卡片
          jsxs('div', { className: 'ctl-life-card', children: [
            jsx('div', { className: 'ctl-life-card-title', children: '📝 随手剪藏 (Quick Clip)' }),
            jsx('input', {
              className: 'ctl-voice-input',
              placeholder: '笔记/剪藏标题 (如: 关键配置备份)',
              value: clipTitle,
              onChange: (e) => setClipTitle(e.target.value),
            }),
            jsx('textarea', {
              className: 'ctl-voice-input',
              rows: 3,
              placeholder: '粘贴网页摘录、代码片段或备忘事项...',
              value: clipText,
              onChange: (e) => setClipText(e.target.value),
              style: { marginTop: '6px', resize: 'vertical' },
            }),
            jsxs('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }, children: [
              jsx(Button, {
                variant: 'outline',
                size: 'sm',
                disabled: !clipText,
                onClick: async () => {
                  const res = await ragHook.clip({ title: clipTitle, text: clipText });
                  if (res && res.ok) {
                    say('剪藏成功并已自动建立索引！');
                    setClipTitle('');
                    setClipText('');
                  } else {
                    say('剪藏失败: ' + (res && res.error));
                  }
                },
                children: '保存并索引',
              }),
            ] }),
          ] }),

          // 3. 知识库列表卡片
          jsxs('div', { className: 'ctl-life-card', children: [
            jsx('div', { className: 'ctl-life-card-title', children: '📚 已建索引库 (' + kbs.length + ' 个)' }),
            kbs.length === 0
              ? jsx('div', { className: 'ctl-note', children: '暂无已构建知识库。' })
              : kbs.map((k) => jsxs('div', { key: k.name, className: 'ctl-item-row', children: [
                  jsxs('div', { className: 'ctl-main', children: [
                    jsx('span', { style: { fontSize: '13.5px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }, children: k.name }),
                    jsx('div', { className: 'ctl-desc', children: '文件: ' + k.filesCount + ' 个 · 切片: ' + k.chunksCount + ' · ' + (k.rootPath || '') }),
                  ] }),
                ] })),
          ] }),

          confirmBar,
          flashBar,
        ] });
      }

      // ---------------- 局域网协同与文件投送 (LAN Mesh)
      if (page === 'lan') {
        const lan = lanHook.lan || {};
        const access = lanHook.access || {};
        const ips = lan.ips || [];
        const files = lan.files || [];

        return jsxs('div', { className: 'ctl-root', children: [
          jsx(Back, { title: '局域网协同与隔空投送', onBack: () => setPage('main') }),
          jsx(Note, { children: '跨设备互联：电脑浏览器直连手机 DSH 控制台，支持跨设备剪贴板双向同步与大文件拖拽隔空投送。' }),
          jsx('div', { className: 'ctl-sep' }),

          // 0. 局域网访问总开关
          jsxs('div', { className: 'ctl-life-card', children: [
            jsx(Row, {
              title: '局域网访问',
              desc: access.enabled
                ? '已开启 · 引擎绑 ' + (access.host || '0.0.0.0') + ' · 同网段浏览器可直连'
                : '已关闭 · 只有手机自己能打开。开启会重启引擎（几秒）',
              right: jsx(Switch, {
                checked: !!access.enabled,
                label: '局域网访问',
                onChange: (next) => {
                  lanHook.setAccess(next).then((r) => {
                    if (r && r.ok) say(next ? '已开启，引擎重启中…' : '已关闭局域网访问');
                    else say((r && r.error) || '操作失败');
                  });
                },
              }),
            }),
            (access.urls && access.urls.length)
              ? jsx('div', { style: { padding: '0 12px 10px' }, children: access.urls.map((u) => jsxs('div', { key: u.address, className: 'ctl-item-row', children: [
                  jsxs('div', { className: 'ctl-main', children: [
                    jsx('a', { href: u.url, target: '_blank', rel: 'noreferrer', className: 'ctl-code-pill', children: 'http://' + u.address + ':3080/' }),
                    jsx('div', { className: 'ctl-desc', children: u.name + (u.hasToken ? ' · 带登录令牌，点开即用' : ' · 无令牌，需手动带 token') }),
                  ] }),
                ] }))
              })
              : jsx('div', { className: 'ctl-desc', style: { padding: '0 12px 10px' }, children: '令牌走明文 HTTP（同网段可嗅探），只在可信 Wi-Fi 下开启；不用时记得关掉。' }),
          ] }),

          // 1. 局域网 IP
          jsxs('div', { className: 'ctl-life-card', children: [
            jsx('div', { className: 'ctl-life-card-title', children: '🌐 局域网访问地址' }),
            ips.length === 0
              ? jsx('div', { className: 'ctl-note', children: '未连接局域网 Wi-Fi。请连接同一 Wi-Fi 后刷新。' })
              : ips.map((ip) => jsxs('div', { key: ip.address, className: 'ctl-item-row', children: [
                  jsxs('div', { className: 'ctl-main', children: [
                    jsx('span', { className: 'ctl-code-pill', children: 'http://' + ip.address + ':3080/' }),
                    jsx('div', { className: 'ctl-desc', children: ip.name + ' · 电脑浏览器直接打开' }),
                  ] }),
                ] })),
          ] }),

          // 2. 双向剪贴板
          jsxs('div', { className: 'ctl-life-card', children: [
            jsx('div', { className: 'ctl-life-card-title', children: '📋 跨设备双向剪贴板' }),
            jsx('input', {
              className: 'ctl-voice-input',
              placeholder: '输入文本推送至手机剪贴板...',
              value: lanInput,
              onChange: (e) => setLanInput(e.target.value),
            }),
            jsxs('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }, children: [
              jsx('span', { className: 'ctl-desc', children: '当前手机剪贴板: ' + (lan.clipboard ? lan.clipboard.slice(0, 30) + '…' : '空') }),
              jsx(Button, {
                variant: 'primary',
                size: 'sm',
                disabled: !lanInput,
                onClick: async () => {
                  await lanHook.setClipboard(lanInput);
                  say('已同步推送到手机剪贴板');
                  setLanInput('');
                },
                children: '推送到手机',
              }),
            ] }),
          ] }),

          // 3. 投送文件箱
          jsxs('div', { className: 'ctl-life-card', children: [
            jsx('div', { className: 'ctl-life-card-title', children: '📦 隔空投送文件箱 (' + files.length + ' 个)' }),
            files.length === 0
              ? jsx('div', { className: 'ctl-note', children: '暂无投送文件。电脑端可通过 /lan-mesh 接口快速投送文件至手机。' })
              : files.map((f) => jsxs('div', { key: f.name, className: 'ctl-item-row', children: [
                  jsxs('div', { className: 'ctl-main', children: [
                    jsx('span', { style: { fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }, children: f.name }),
                    jsx('div', { className: 'ctl-desc', children: (f.size / 1024).toFixed(1) + ' KB · ' + f.path }),
                  ] }),
                ] })),
          ] }),

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

        jsx(Row, {
          title: '通知历史',
          desc: '查看最近 100 条 AI 通知的完整内容',
          right: jsx(Button, { variant: 'outline', size: 'sm', onClick: () => run('notification.history', ''), children: '查看' }),
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
          title: '模型分工',
          desc: '查看当前模型 · 按任务切换 · 调整思考深度',
          right: jsx(Button, { variant: 'outline', size: 'sm', onClick: () => setPage('models'), children: '进入' }),
          onClick: () => setPage('models'),
        }),
        jsx(Row, {
          title: '智能生活助理',
          desc: (state.life && state.life.summary) || '验证码 · 待取快递 · 自动记账 · 定时任务',
          right: jsxs(Fragment, { children: [
            jsx('span', { className: 'ctl-state' + (state.life && state.life.daemonRunning ? ' ctl-ok' : ''), children: state.life && state.life.daemonRunning ? '守护中' : '未启动' }),
            jsx(primitives.IconChevronRightOutlineRegular, { size: 14 }),
          ] }),
          onClick: () => setPage('life'),
        }),
        jsx(Row, {
          title: '本地知识库与全域检索',
          desc: '秒级全文搜索 · 随手剪藏 · 0 Token 端侧 RAG',
          right: jsxs(Fragment, { children: [
            jsx('span', { className: 'ctl-state', children: (ragHook.rag.kbs && ragHook.rag.kbs.length ? ragHook.rag.kbs.length + ' 个库' : '已就绪') }),
            jsx(primitives.IconChevronRightOutlineRegular, { size: 14 }),
          ] }),
          onClick: () => setPage('rag'),
        }),
        jsx(Row, {
          title: '局域网协同与隔空投送',
          desc: '跨设备剪贴板双向同步 · 电脑文件秒传投送',
          right: jsxs(Fragment, { children: [
            jsx('span', { className: 'ctl-state', children: (lanHook.lan.ips && lanHook.lan.ips.length ? lanHook.lan.ips.length + ' 个IP' : '已就绪') }),
            jsx(primitives.IconChevronRightOutlineRegular, { size: 14 }),
          ] }),
          onClick: () => setPage('lan'),
        }),
        jsx(Row, {
          title: '语音交互与 TTS 调音台',
          desc: (state.voice && state.voice.summary) || '语音唤醒 · 多模型 TTS 音色 · 实时对讲调音',
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

    // The composer owns draft revisions and attachments; no DOM mutation or submit action is used.
    function nativeInput() { return typeof window.__DSH_INPUT_TOKEN === 'string' ? window.dshinput || null : null; }
    function nativeJson(method, ...args) {
      const bridge = nativeInput();
      if (!bridge || typeof bridge[method] !== 'function') throw new Error('需要在更新后的安卓 App 内使用');
      const result = JSON.parse(bridge[method](window.__DSH_INPUT_TOKEN, ...args));
      if (!result.ok) throw new Error(result.error || '操作失败');
      return result;
    }
    async function sharedFiles(batch, call = nativeJson) {
      const output = []; let total = 0;
      for (const item of batch.files || []) {
        if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 16 * 1024 * 1024) throw new Error('无效附件大小');
        total += item.bytes;
        if (total > 32 * 1024 * 1024) throw new Error('分享附件总量超过 32MB');
        const parts = []; let offset = 0;
        do {
          const part = call('shareChunk', batch.id, item.index, offset);
          const bytes = atob(part.data); const chunk = new Uint8Array(bytes.length);
          if (bytes.length > 65536 || offset + bytes.length > item.bytes || (!part.eof && !bytes.length)) throw new Error('附件分块不完整');
          for (let i = 0; i < bytes.length; i++) chunk[i] = bytes.charCodeAt(i);
          parts.push(chunk); offset += chunk.length;
          if (part.eof) { if (offset !== item.bytes) throw new Error('附件长度不匹配'); break; }
          await new Promise(resolve => setTimeout(resolve, 0));
        } while (offset < item.bytes);
        output.push(new File(parts, item.name, { type: item.mime }));
      }
      return output;
    }
    function insertTranscript(inputActions, text, span) {
      return !!text && inputActions.insertText(text, span);
    }
    async function putShareInDraft(batch, sessionId, inputActions, conversation, call = nativeJson, current = () => true) {
      const files = await sharedFiles(batch, call);
      if (!current()) throw new Error("聊天已切换，分享仍保留在收件箱");
      const drafts = files.length ? conversation.createDrafts(sessionId, files) : [];
      if (drafts.length && !inputActions.addAttachments(drafts.map(file => file.id))) {
        conversation.releaseDraftAttachments(drafts); throw new Error('草稿暂时不可编辑，请稍后重试');
      }
      // Attachment insertion changes draftRev, so capture the text span after adding them.
      if (batch.text && !insertTranscript(inputActions, batch.text, inputActions.captureInsertion())) {
        if (drafts.length) { inputActions.pruneAttachments(drafts.map(file => file.id)); conversation.releaseDraftAttachments(drafts); }
        throw new Error('草稿已改变，请重新选择加入草稿');
      }
      return true;
    }
    /**
     * 分享进来就自动挂到输入栏（像从相册分享照片那样），不再要求先点「加入草稿」。
     * 只有全部挂上才回执收件箱；失败由调用方退回手动卡片，内容仍留在收件箱里。
     */
    async function autoPutShareInDraft(batch, sessionId, inputActions, conversation, call = nativeJson, current = () => true) {
      await putShareInDraft(batch, sessionId, inputActions, conversation, call, current);
      if (!current()) throw new Error('聊天已切换，分享仍保留在收件箱');
      call('shareAck', batch.id);
      return true;
    }
    function AndroidDraftInput({ sessionId, inputActions, draftConversation }) {
      const [voice, setVoice] = react.useState(null);
      const [share, setShare] = react.useState(null);
      const [transcript, setTranscript] = react.useState('');
      const [message, setMessage] = react.useState('');
      const [importing, setImporting] = react.useState(false);
      const [autoFailed, setAutoFailed] = react.useState('');
      const active = react.useRef(null), alive = react.useRef(true), epoch = react.useRef(0), received = react.useRef(new Set());
      const autoTried = react.useRef(''), autoBusy = react.useRef(false), sessionRef = react.useRef(sessionId);
      react.useEffect(() => {
        alive.current = true;
        const poll = () => {
          if (!nativeInput()) return;
          try { setShare(nativeJson('shareState')); } catch (e) { /* 分享桥异常不挤占输入栏下方那行 */ }
          const current = active.current;
          if (!current) return;
          try {
            const result = nativeJson('voiceState');
            if (result.id !== current.id) return;
            setVoice(result);
            if (['final', 'empty', 'error', 'cancelled'].includes(result.state)) {
              active.current = null;
              if (result.state === 'final') {
                if (insertTranscript(inputActions, result.text, current.span)) { setTranscript(''); setMessage('听写已加入草稿'); }
                else { setTranscript(result.text); setMessage('草稿已改变，转写已保留，可手动加入'); }
              } else setMessage(result.error || (result.state === 'empty' ? '未识别到内容' : '听写已取消'));
            }
          } catch (e) { setMessage(e.message); active.current = null; }
        };
        poll(); const timer = setInterval(poll, 400);
        return () => {
          alive.current = false; epoch.current++; clearInterval(timer);
          if (active.current) try { nativeJson('voiceAct', 'cancel', active.current.id); } catch {}
          active.current = null;
        };
      }, [sessionId, inputActions]);
      sessionRef.current = sessionId;
      // 分享自动挂载：收件箱里一出现就贴上输入栏，不要求用户再点一次「加入草稿」。
      // 成功即回执；失败（草稿不可编辑 / 文件读不出）才退回下方的手动卡片。
      react.useEffect(() => {
        const pending = share?.batch;
        if (!pending || !nativeInput() || !sessionId) return;
        if (autoTried.current === pending.id || autoBusy.current) return;
        autoTried.current = pending.id; autoBusy.current = true;
        const target = sessionId;
        const current = () => alive.current && sessionRef.current === target;
        (async () => {
          try {
            await autoPutShareInDraft(pending, target, inputActions, draftConversation, nativeJson, current);
            if (current()) { try { setShare(nativeJson('shareState')); } catch (_) {} }
          } catch (e) {
            if (alive.current) {
              setAutoFailed(pending.id);
              setMessage('自动挂载失败：' + ((e && e.message) || e) + '，可点「加入草稿」');
              try { setShare(nativeJson('shareState')); } catch (_) {}
            }
          } finally { autoBusy.current = false; }
        })();
      }, [share, sessionId, inputActions, draftConversation]);
      if (!nativeInput() || !inputActions || !sessionId) {
        const why = !nativeInput()
          ? (typeof window.__DSH_INPUT_TOKEN === "string" ? "window.dshinput 缺失" : "window.__DSH_INPUT_TOKEN 未注入")
          : (!inputActions ? "宿主没给 inputActions" : "会话未就绪 sessionId=undefined");
        return jsxs("div", { className: "ctl-input-native", style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 8px", margin: "0 0 6px", fontSize: 12, lineHeight: 1.4, border: "1px solid #f5a524", borderRadius: 8 }, children: [
          jsx("span", { children: "⚠ 分享桥未就绪：" + why }),
          jsx(Button, { size: "sm", variant: "secondary", onClick: () => { try { location.reload(); } catch (e) {} }, children: "重新加载页面" })
        ] });
      }
      const busy = active.current !== null;
      const batch = share?.batch;
      const callVoice = action => {
        try {
          if (action === 'start') {
            const id = 'voice-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
            active.current = { id, span: inputActions.captureInsertion() };
            setMessage(''); setTranscript(''); setVoice({ state: 'starting' }); nativeJson('voiceAct', action, id);
          } else if (active.current) nativeJson('voiceAct', action, active.current.id);
        } catch (e) { setMessage(e.message); active.current = null; }
      };
      const receive = async () => {
        const targetEpoch = epoch.current; const current = () => alive.current && epoch.current === targetEpoch;
        setImporting(true); setMessage('');
        try {
          if (!received.current.has(batch.id)) {
            await putShareInDraft(batch, sessionId, inputActions, draftConversation, nativeJson, current);
            received.current.add(batch.id);
          }
          if (!current()) return;
          nativeJson('shareAck', batch.id);
          if (current()) { try { setShare(nativeJson('shareState')); } catch (_) {} }
        } catch (e) { if (alive.current) setMessage(e.message); }
        finally { if (alive.current) setImporting(false); }
      };
      const discard = () => {
        try { nativeJson('shareAck', batch.id); setShare(nativeJson('shareState')); }
        catch (e) { setMessage(e.message); }
      };
      // 2026-10-19：dock 跟内核的用量/耗时小字共用一个 flex 行。
      // 这里以前恒渲染一个 width:100% 的块，把小字挤成「7…」「50…」；没内容时干脆不占位。
      if (!(batch && autoFailed === batch.id)) {
        return message ? jsx('span', { role: 'status', style: { fontSize: 12, opacity: 0.8 }, children: message }) : null;
      }
      return jsxs('div', { className: 'ctl-input-native', style: { display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 auto', minWidth: 0, fontSize: 12 }, children: [
        message ? jsx('span', { role: 'status', children: message }) : null,

        batch && autoFailed === batch.id ? jsxs('div', { style: { padding: 8, border: '1px solid var(--border, #8885)', borderRadius: 8 }, children: [
          jsx('strong', { children: '收到分享' + (share.count > 1 ? ' · 待处理 ' + share.count + ' 条' : '') }),
          jsx('div', { style: { whiteSpace: 'pre-wrap', maxHeight: 100, overflow: 'auto' }, children: batch.text?.slice(0, 600) || '' }),
          jsx('div', { children: (batch.files || []).map(file => file.name + (Number.isSafeInteger(file.bytes) ? '（' + fileSizeText(file.bytes) + '）' : '')).join('、') }),
          batch.archive ? jsx('div', { style: { opacity: .7 }, children: '副本：' + batch.archive }) : null,
          (batch.errors || []).length ? jsx('div', { children: batch.errors.join('；') }) : null,
          jsxs('div', { style: { display: 'flex', gap: 8, marginTop: 6 }, children: [
            jsx(Button, { size: 'sm', disabled: importing || busy, onClick: receive, children: importing ? '正在接收…' : received.current.has(batch.id) ? '清理收件箱' : '加入草稿' }),
            jsx(Button, { size: 'sm', variant: 'ghost', disabled: importing, onClick: discard, children: '忽略' }),
          ] }),
        ] }) : null,
      ] });
    }

    // 分享挂进输入栏的那一步：聊天框卡片和 overlay 自动挂载共用，按批次去重，
    // 避免两边同时看到同一批内容时插两次。
    let shareMounting = '';
    async function mountShareOnce(batch, sessionId, inputActions, conversation, current = () => true) {
      if (!batch || !batch.id || !sessionId || !inputActions || !conversation) return false;
      if (shareMounting === batch.id) return false;
      shareMounting = batch.id;
      try {
        await putShareInDraft(batch, sessionId, inputActions, conversation, nativeJson, current);
        if (!current()) throw new Error('聊天已切换，分享仍保留在收件箱');
        nativeJson('shareAck', batch.id);
        return true;
      } finally {
        if (shareMounting === batch.id) shareMounting = '';
      }
    }

    // 新会话（hero 形态）不渲染 conversation.composer.dock，分享就没地方挂；
    // input.overlay 只要会话存在就渲染，所以这里补一个纯逻辑挂载点：不出任何 UI，
    // 也不往输入栏下方那行写字。挂载失败时内容留在收件箱，聊天框卡片仍可手动处理。
    function ShareAutoMount({ sessionId, inputActions, draftConversation }) {
      react.useEffect(() => {
        if (!nativeInput() || !sessionId || !inputActions || !draftConversation) return;
        let alive = true, last = '', tries = 0;
        const poll = async () => {
          let state;
          try { state = nativeJson('shareState'); } catch (e) { return; }
          if (!alive || !state || !state.batch || state.batch.id === last) return;
          const batch = state.batch; last = batch.id;
          try { await mountShareOnce(batch, sessionId, inputActions, draftConversation, () => alive); }
          catch (e) { if (alive && ++tries < 3) last = ''; }
        };
        poll(); const timer = setInterval(poll, 600);
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId, inputActions, draftConversation]);
      return null;
    }

    /** 到货横幅的文案（纯函数，方便隔离测试）：说清"是什么 / 多大 / 副本在哪"。 */
    function shareNoticeText(share) {
      const batch = share?.latest;
      if (!batch) return '';
      const files = (batch.files || []).map(file => file.name + (Number.isSafeInteger(file.bytes) ? '（' + fileSizeText(file.bytes) + '）' : ''));
      const head = batch.text ? batch.text.trim().slice(0, 60) : files.join('、');
      const rest = share.count > 1 ? '（另有 ' + (share.count - 1) + ' 条待处理）' : '';
      const where = batch.archive ? '，副本已存到 ' + batch.archive : '';
      return '收到分享：' + head + where + rest;
    }

    // 分享到货提示：分享卡片只挂在聊天输入框里（conversation.composer.dock），用户若停在
    // 设置/控制台页就**完全看不到**，内容会烂在 cache 里（2026-10-15 用户分享的 pptx 与 PDF
    // 就这样躺了 20 分钟）。这里挂到帧级浮层 shell.overlay —— 任何页面都在，
    // 用 primitives 的 Toast（顶部横幅，自带淡出），文案里说清副本落在哪个目录。
    // 只报"最新一条"（latest）；聊天框里的卡片仍按顺序处理"最旧一条"，两边各取一头。
    function ShareNotice() {
      // 初值就同步取一次：挂载即可见，不留"最多 2.5 秒空白"；也方便隔离测试注入假桥。
      const [share, setShare] = react.useState(() => {
        try { return nativeInput() ? nativeJson('shareState') : null; } catch (e) { return null; }
      });
      const [shown, setShown] = react.useState('');
      const [hidden, setHidden] = react.useState('');
      react.useEffect(() => {
        if (!nativeInput()) return;
        let alive = true;
        const poll = () => { if (!alive || !nativeInput()) return; try { setShare(nativeJson('shareState')); } catch (e) { /* 桌面浏览器没有这条桥 */ } };
        poll(); const timer = setInterval(poll, 2500);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      const batch = share?.latest;
      if (!batch || batch.id === shown || batch.id === hidden) return null;
      return jsx(Toast, {
        tone: 'success', holdMs: 9000, text: shareNoticeText(share),
        actions: [{ label: '忽略', onClick: () => {
          try { nativeJson('shareAck', batch.id); setHidden(batch.id); setShare(nativeJson('shareState')); } catch (e) {}
        } }],
        onDone: () => setShown(batch.id),
      });
    }

    const inject = ['slots', 'sessions'];

    /**
     * 「文档预览」设置页 —— 按需安装 LibreOffice 引擎。
     *
     * 引擎（解压后 ~150MB）不随安装包分发：没有它 docx/xlsx/pptx 预览会失败，
     * 但其它功能完全不受影响。宿主侧插件 dsh-office-kit 提供两条路由，
     * 这里只负责显示状态和触发下载；装好即生效（office-to-pdf 失败时会重建 converter）。
     */
    function OfficeKitSection() {
      const [state, setState] = react.useState(null);
      const [note, setNote] = react.useState('');
      const [starting, setStarting] = react.useState(false);
      const [reload, setReload] = react.useState(0);
      react.useEffect(() => {
        let alive = true;
        const load = () => {
          fetch('/dsh-office-kit/status', { credentials: 'same-origin', cache: 'no-store' })
            .then((response) => response.json())
            .then((data) => { if (alive) setState(data); })
            .catch((error) => { if (alive) setNote('读不到安装状态：' + (error && error.message || error)); });
        };
        load();
        const timer = setInterval(load, 1200);
        return () => { alive = false; clearInterval(timer); };
      }, [reload]);
      const start = () => {
        setStarting(true); setNote('');
        fetch('/dsh-office-kit/install', { method: 'POST', credentials: 'same-origin' })
          .then((response) => response.json())
          .then((data) => { setState(data); setReload((n) => n + 1); })
          .catch((error) => setNote('启动下载失败：' + (error && error.message || error)));
        setTimeout(() => setStarting(false), 800);
      };
      const fmt = (bytes) => {
        const value = Number(bytes) || 0;
        if (value >= 1024 * 1024 * 1024) return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(0) + ' MB';
        if (value >= 1024) return (value / 1024).toFixed(0) + ' KB';
        return value + ' B';
      };
      const phase = state && state.phase || 'idle';
      const busy = phase === 'downloading' || phase === 'extracting';
      const pct = state && state.total > 0 ? Math.min(99, Math.floor(state.received * 100 / state.total)) : 0;
      let line, tone;
      if (!state) { line = '正在读取…'; tone = 'var(--dsh-text-secondary, #888)'; }
      else if (state.installed) { line = '已安装 v' + state.version + '（占用 ' + fmt(state.bytesOnDisk) + '）'; tone = '#2e7d32'; }
      else if (phase === 'downloading') { line = '正在下载 ' + (state.total > 0 ? pct + '%（' + fmt(state.received) + ' / ' + fmt(state.total) + '）' : fmt(state.received)); tone = 'var(--dsh-text-secondary, #888)'; }
      else if (phase === 'extracting') { line = '正在解压…'; tone = 'var(--dsh-text-secondary, #888)'; }
      else if (phase === 'error') { line = '安装失败：' + (state.error || '未知错误'); tone = '#c62828'; }
      else { line = '未安装'; tone = 'var(--dsh-text-secondary, #888)'; }
      return jsxs('div', { style: { padding: '4px 0', display: 'flex', flexDirection: 'column', gap: '10px' }, children: [
        jsx('div', { style: { fontSize: '15px', fontWeight: 600 }, children: '文档预览组件' }),
        jsx('div', { style: { fontSize: '13px', lineHeight: 1.6, opacity: 0.85 }, children: 'docx / xlsx / pptx 的预览需要一个 LibreOffice 引擎（下载约 48MB，装好后占约 150MB）。它不随安装包分发，用到再装；装好立即生效，不用重启。不装只影响这几种文档的预览，其它功能不受影响。' }),
        jsx('div', { style: { fontSize: '13px', color: tone }, children: line }),
        state && !state.installed && !busy
          ? jsx(Button, { variant: 'primary', onClick: start, disabled: starting, children: starting ? '正在启动…' : '下载并安装（约 48MB）' })
          : null,
        note ? jsx('div', { style: { fontSize: '12px', color: '#c62828' }, children: note }) : null,
      ] });
    }

    // ---------------------------------------------------------------- 大肥鱼桌宠
    // 参考 dsh-pet 的做法（fixed + pointer-events:none 的壳 + 只有宠物本体接收触摸 +
    // touch-action:none + 拖拽/点按分开判定），但**不搬它的素材与实现**：
    // 这里是一只自绘的圆胖 3D 大肥鱼（渐变高光 + 软阴影 + 厨师帽），几 KB，没有 webm/Electron/宿主轮询。
    // 只挂在 shell.overlay 与 settings.section 两个官方槽上，不碰会话与输入框。
    const PET_STORE_KEY = 'dsh-whale-pet.prefs.v1';
    const PET_GREET_KEY = 'dsh-whale-pet.greeted.v1';
    const PET_SIZES = { small: 88, medium: 112, large: 140 };
    const PET_LINES = [
      '我在。',
      '别戳，痒。',
      '慢慢来，不着急。',
      '写完这段就歇会儿。',
      '今天也一起加油。',
      '记得喝水。',
      '这个 bug 会怕你的。',
      '摸鱼也是正经事。',
      '嗯……让我想想。',
      '你忙，我就在旁边。',
    ];
    const PET_CSS_ID = 'dsh-android-console/whale-pet-v2.css';
    const PET_CSS = [
      '.dsh-whale-root{position:fixed;left:0;top:0;z-index:45;pointer-events:none;user-select:none;-webkit-user-select:none;will-change:transform}',
      '.dsh-whale-root.is-snapping{transition:transform .22s cubic-bezier(.2,.8,.2,1)}',
      '.dsh-whale-hit{position:relative;display:block;width:100%;height:100%;pointer-events:auto;touch-action:none;cursor:grab;outline:none;-webkit-tap-highlight-color:transparent}',
      '.dsh-whale-hit:active,.dsh-whale-root.is-dragging .dsh-whale-hit{cursor:grabbing}',
      '.dsh-whale-art{position:relative;display:block;width:100%;height:100%;transform-origin:50% 100%}',
      '.dsh-whale-art svg{display:block;width:100%;height:100%;overflow:visible;transform-origin:50% 100%;filter:drop-shadow(0 8px 12px rgba(20,35,100,.22))}',
      '.dsh-whale-art svg{animation:dshWhaleFloat 4.2s ease-in-out infinite}',
      '.dsh-whale-root.is-dragging .dsh-whale-art svg{animation:none}',
      '.dsh-whale-art.is-poking{animation:dshWhalePoke .55s cubic-bezier(.2,1.6,.4,1)}',
      '.dsh-whale-art .whale-tail{transform-box:fill-box;transform-origin:100% 50%;animation:dshWhaleTail 3.4s ease-in-out infinite}',
      '.dsh-whale-art .whale-gloss{animation:dshWhaleGloss 5.2s ease-in-out infinite}',
      '.dsh-whale-art .whale-hat{transform-box:fill-box;transform-origin:50% 100%;animation:dshWhaleHat 5.2s ease-in-out infinite}',
      '.dsh-whale-bubble{position:absolute;bottom:calc(100% - 2px);max-width:min(190px,calc(100vw - 28px));box-sizing:border-box;padding:8px 11px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b1f);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));box-shadow:0 8px 24px rgba(15,23,42,.18);font-size:12.5px;line-height:1.45;white-space:normal;pointer-events:none;z-index:2;animation:dshWhaleBubbleIn .16s ease-out}',
      '.dsh-whale-bubble:after{content:"";position:absolute;top:100%;width:0;height:0;border:5px solid transparent;border-top-color:var(--dsw-alias-bg-layer-1,#fff);filter:drop-shadow(0 1px 0 var(--dsw-alias-border-l2,rgba(0,0,0,.12)))}',
      '.dsh-whale-root[data-side="right"] .dsh-whale-bubble{right:2px}',
      '.dsh-whale-root[data-side="right"] .dsh-whale-bubble:after{right:18px}',
      '.dsh-whale-root[data-side="left"] .dsh-whale-bubble{left:2px}',
      '.dsh-whale-root[data-side="left"] .dsh-whale-bubble:after{left:18px}',
      '.dsh-whale-root.is-flipped .dsh-whale-bubble{bottom:auto;top:calc(100% - 2px)}',
      '.dsh-whale-root.is-flipped .dsh-whale-bubble:after{top:auto;bottom:100%;border-top-color:transparent;border-bottom-color:var(--dsw-alias-bg-layer-1,#fff);filter:drop-shadow(0 -1px 0 var(--dsw-alias-border-l2,rgba(0,0,0,.12)))}',
      '.dsh-whale-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:3px;border-radius:12px}',
      '.dsh-whale-hearts{position:absolute;left:58%;top:12%;width:0;height:0;pointer-events:none;z-index:3}',
      '.dsh-whale-heart{position:absolute;left:0;top:0;color:#ff7d9c;font-size:11px;line-height:1;text-shadow:0 1px 2px rgba(0,0,0,.12);animation:dshWhaleHeart .9s ease-out forwards}',
      '.dsh-whale-heart.h1{animation-delay:.06s}',
      '.dsh-whale-heart.h2{animation-delay:.12s}',
      '@keyframes dshWhaleFloat{0%,100%{transform:translateY(0) scale(1,1)}50%{transform:translateY(-3px) scale(1.012,.988)}}',
      '@keyframes dshWhaleTail{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(7deg)}}',
      '@keyframes dshWhaleGloss{0%,100%{opacity:.31}50%{opacity:.42}}',
      '@keyframes dshWhaleHat{0%,100%{transform:rotate(-1.1deg)}50%{transform:rotate(1.1deg)}}',
      '@keyframes dshWhalePoke{0%{transform:scale(1)}35%{transform:scale(1.08,.92)}65%{transform:scale(.97,1.04)}100%{transform:scale(1)}}',
      '@keyframes dshWhaleBubbleIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}',
      '@keyframes dshWhaleHeart{0%{opacity:1;transform:translate(0,0) scale(.8)}100%{opacity:0;transform:translate(var(--hx,10px),-26px) scale(1.15)}}',
      '@media (prefers-reduced-motion:reduce){.dsh-whale-art svg,.dsh-whale-art .whale-tail,.dsh-whale-art .whale-hat,.dsh-whale-art .whale-gloss,.dsh-whale-heart{animation:none!important}}',
      ".ctl-pet-hero{display:flex;align-items:center;gap:12px;margin:0;padding:12px 0 10px;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
      ".ctl-pet-avatar{flex:none;width:54px;height:54px;display:flex;align-items:center;justify-content:center;border-radius:14px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));border:.5px solid var(--dsw-alias-border-l2)}",
      ".ctl-pet-avatar img{width:50px;height:50px;object-fit:contain}",
      ".ctl-pet-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}",
      ".ctl-pet-name-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
      ".ctl-pet-name{font-size:16px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".ctl-pet-tag{font-size:10px;line-height:15px;padding:0 6px;border-radius:4px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".ctl-pet-status{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".ctl-pet-status:before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}",
      ".ctl-pet-status.ctl-pet-ok{color:var(--dsw-alias-state-business-primary,#16a34a)}",
      ".ctl-pet-status.ctl-pet-bad{color:var(--dsw-alias-state-error-primary,#dc2626)}",
      ".ctl-pet-desc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}",
      ".ctl-pet-tips{display:flex;flex-wrap:wrap;gap:6px;margin-top:1px;color:var(--dsw-alias-label-tertiary)}",
      ".ctl-pet-tip{font-size:11px;line-height:16px}",
      ".ctl-pet-tip+.ctl-pet-tip:before{content:'·';margin-right:6px;color:var(--dsw-alias-label-tertiary)}",
      ".ctl-pet-actions{display:flex;flex-wrap:wrap;gap:8px}",
      ".ctl-pet-feedback{margin:10px 0 2px;padding:9px 11px;border-radius:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.06))}",
      ".ctl-pet-feedback-bad{color:var(--dsw-alias-state-error-primary,#e5484d);background:rgba(229,72,77,.1)}",
      ".ctl-pet-actions button{transition:transform .12s ease,filter .12s ease}",
      ".ctl-pet-actions button:active:not(:disabled){transform:scale(.93);filter:brightness(.9)}",
      ".ctl-pet-actions button:disabled{opacity:.65;cursor:default}",
      "@media (max-width:420px){.ctl-pet-avatar{width:48px;height:48px}.ctl-pet-avatar img{width:44px;height:44px}.ctl-pet-hero{gap:10px}}",
      "@media (prefers-reduced-motion:reduce){.ctl-pet-avatar img{animation:none}}"
    ].join('');

    function ensurePetCss() {
      try {
        if (document.querySelector('style[data-plugin-css="' + PET_CSS_ID + '"]') !== null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-android-console';
        tag.dataset.pluginCss = PET_CSS_ID;
        tag.textContent = PET_CSS;
        document.head.appendChild(tag);
      } catch (e) { /* 样式失败不该拖垮整页 */ }
    }

const PET_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 322 335\" preserveAspectRatio=\"xMidYMax meet\" aria-hidden=\"true\" focusable=\"false\"><image x=\"0\" y=\"0\" width=\"322\" height=\"335\" href=\"data:image/png;base64,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\"/></svg>";

    // v2.00：设置页头像直接复用 PET_SVG 里那张立绘（同一张 322×335 的大肥鱼），
    // 不再往 JS 里塞第二份 231KB 的 base64。
    const PET_ART_URI = (() => {
      try {
        const m = PET_SVG.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/);
        return m ? m[0] : '';
      } catch (e) { return ''; }
    })();

    function petDefaults() { return { enabled: true, size: 'medium', x: null, y: null }; }
    function petLoad() {
      try {
        const raw = window.localStorage.getItem(PET_STORE_KEY);
        if (!raw) return petDefaults();
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return petDefaults();
        return {
          enabled: obj.enabled !== false,
          size: Object.prototype.hasOwnProperty.call(PET_SIZES, obj.size) ? obj.size : 'medium',
          x: Number.isFinite(obj.x) ? obj.x : null,
          y: Number.isFinite(obj.y) ? obj.y : null,
        };
      } catch (e) { return petDefaults(); }
    }
    let petPrefs = petLoad();
    const petWatchers = new Set();
    function petSave(next) {
      petPrefs = next;
      try { window.localStorage.setItem(PET_STORE_KEY, JSON.stringify(next)); } catch (e) {}
      petWatchers.forEach((fn) => { try { fn(next); } catch (e) {} });
    }
    function petSet(patch) { petSave(Object.assign({}, petPrefs, patch)); }
    function usePetPrefs() {
      const [value, setValue] = react.useState(petPrefs);
      react.useEffect(() => {
        const fn = (next) => setValue(next);
        petWatchers.add(fn);
        setValue(petPrefs);
        return () => { petWatchers.delete(fn); };
      }, []);
      return value;
    }

    /** 把宠物框限制在视口内；视口比宠物还小时贴左上角，绝不让它跑到屏幕外。 */
    function petClamp(x, y, w, h, vw, vh) {
      const maxX = Math.max(4, vw - w - 4);
      const maxY = Math.max(4, vh - h - 4);
      return { x: Math.min(Math.max(4, x), maxX), y: Math.min(Math.max(4, y), maxY) };
    }
    /** 松手后吸附到最近的一侧（只吸左右，不吸上下），像贴边的小挂件。 */
    function petSnapX(x, w, vw) {
      const right = Math.max(8, vw - w - 8);
      return (x + w / 2) < vw / 2 ? 8 : right;
    }
    /** 随机一句台词，避免连续两次一样。 */
    function petLine(last) {
      const pool = PET_LINES.filter((line) => line !== last);
      return pool[Math.floor(Math.random() * pool.length)] || PET_LINES[0];
    }

    let PetBoundary = null;
    if (ReactComponent !== null) {
      PetBoundary = class PetBoundary extends ReactComponent {
        constructor(props) { super(props); this.state = { error: null }; }
        static getDerivedStateFromError(error) { return { error: error }; }
        componentDidCatch(error) { try { console.warn('[dsh-whale-pet]', error); } catch (e) {} }
        render() { return this.state.error ? null : this.props.children; }
      };
    }

    function WhalePet() {
      const prefs = usePetPrefs();
      const size = PET_SIZES[prefs.size] || PET_SIZES.medium;
      const height = size;
      const [pos, setPos] = react.useState(null);
      const posRef = react.useRef(null);
      const [dragging, setDragging] = react.useState(false);
      const [snapping, setSnapping] = react.useState(false);
      const [poking, setPoking] = react.useState(0);
      const [bubble, setBubble] = react.useState(null);
      const dragRef = react.useRef(null);
      const aliveRef = react.useRef(true);
      const bubbleTimer = react.useRef(null);
      const snapTimer = react.useRef(null);
      const lastLine = react.useRef('');

      react.useEffect(() => () => {
        aliveRef.current = false;
        clearTimeout(bubbleTimer.current);
        clearTimeout(snapTimer.current);
      }, []);

      // 初始位置：优先用户拖过的位置；没有就落在右下角、输入框上方。
      react.useEffect(() => {
        if (!prefs.enabled) return;
        const vw = window.innerWidth || 360;
        const vh = window.innerHeight || 720;
        const saved = (Number.isFinite(prefs.x) && Number.isFinite(prefs.y))
          ? { x: prefs.x, y: prefs.y }
          : { x: vw - size - 16, y: vh - height - 120 };
        const next = petClamp(saved.x, saved.y, size, height, vw, vh);
        posRef.current = next;
        setPos(next);
      }, [prefs.enabled, prefs.size, prefs.x, prefs.y, size, height]);

      // 转屏 / 键盘弹出时别把宠物留在屏幕外。
      react.useEffect(() => {
        if (!prefs.enabled) return;
        const onResize = () => {
          setPos((current) => {
            if (!current) return current;
            const next = petClamp(current.x, current.y, size, height, window.innerWidth || 360, window.innerHeight || 720);
            posRef.current = next;
            return next;
          });
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [prefs.enabled, size, height]);

      // 第一次出现时打个招呼（只打一次），让用户知道可以拖。
      react.useEffect(() => {
        if (!prefs.enabled) return;
        let greeted = false;
        try { greeted = window.localStorage.getItem(PET_GREET_KEY) === '1'; } catch (e) {}
        if (greeted) return;
        const timer = setTimeout(() => {
          if (!aliveRef.current) return;
          setBubble({ text: '我是大肥鱼。按住我可以拖到别处。', key: Date.now() });
          try { window.localStorage.setItem(PET_GREET_KEY, '1'); } catch (e) {}
          clearTimeout(bubbleTimer.current);
          bubbleTimer.current = setTimeout(() => { if (aliveRef.current) setBubble(null); }, 4200);
        }, 900);
        return () => clearTimeout(timer);
      }, [prefs.enabled]);

      if (!prefs.enabled) return null;

      const say = (text, ms) => {
        setBubble({ text: text, key: Date.now() });
        clearTimeout(bubbleTimer.current);
        bubbleTimer.current = setTimeout(() => { if (aliveRef.current) setBubble(null); }, ms || 2800);
      };

      const poke = () => {
        const text = petLine(lastLine.current);
        lastLine.current = text;
        setPoking((n) => n + 1);
        say(text, 2800);
      };

      const onPointerDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (!posRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
        dragRef.current = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          x: posRef.current.x,
          y: posRef.current.y,
          moved: false,
        };
        setDragging(true);
      };

      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
        if (!drag.moved) return;
        event.preventDefault();
        event.stopPropagation();
        const next = petClamp(drag.x + dx, drag.y + dy, size, height, window.innerWidth || 360, window.innerHeight || 720);
        posRef.current = next;
        setPos(next);
      };

      const finishDrag = (event, allowPoke) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (e) {}
        if (allowPoke && !drag.moved) { poke(); return; }
        if (!drag.moved) return;
        const current = posRef.current || { x: drag.x, y: drag.y };
        const snapped = petClamp(
          petSnapX(current.x, size, window.innerWidth || 360),
          current.y,
          size, height,
          window.innerWidth || 360,
          window.innerHeight || 720,
        );
        posRef.current = snapped;
        setPos(snapped);
        setSnapping(true);
        petSet({ x: snapped.x, y: snapped.y });
        clearTimeout(snapTimer.current);
        snapTimer.current = setTimeout(() => { if (aliveRef.current) setSnapping(false); }, 260);
      };

      const side = pos && (pos.x + size / 2) > (window.innerWidth || 360) / 2 ? 'right' : 'left';
      const flip = !!(pos && pos.y < 96);
      const style = pos ? {
        width: size,
        height: height,
        transform: 'translate3d(' + Math.round(pos.x) + 'px,' + Math.round(pos.y) + 'px,0)',
      } : { width: size, height: height, visibility: 'hidden' };

      return jsxs('div', {
        className: 'dsh-whale-root' + (dragging ? ' is-dragging' : '') + (snapping ? ' is-snapping' : '') + (flip ? ' is-flipped' : ''),
        style: style,
        'data-side': side,
        children: [
          bubble ? jsx('div', { className: 'dsh-whale-bubble', role: 'status', children: bubble.text }) : null,
          jsxs('div', {
            className: 'dsh-whale-hit',
            role: 'button',
            tabIndex: 0,
            'aria-label': '大肥鱼桌宠：点一下互动，按住拖动',
            onPointerDown: onPointerDown,
            onPointerMove: onPointerMove,
            onPointerUp: (event) => finishDrag(event, true),
            onPointerCancel: (event) => finishDrag(event, false),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); poke(); }
            },
            children: [
              jsx('div', {
                className: 'dsh-whale-art' + (poking > 0 ? ' is-poking' : ''),
                key: poking,
                dangerouslySetInnerHTML: { __html: PET_SVG },
              }),
              poking > 0 ? jsx('div', {
                className: 'dsh-whale-hearts',
                key: 'h' + poking,
                'aria-hidden': 'true',
                children: [0, 1, 2].map((i) => jsx('span', {
                  className: 'dsh-whale-heart h' + i,
                  style: { '--hx': (i === 0 ? '-12px' : i === 1 ? '6px' : '18px') },
                  children: '♥',
                }, i)),
              }) : null,
            ],
          }),
        ],
      });
    }

    // ---------------------------------------------------------- 安卓桌宠（悬浮窗）
    // 2026-10-20：桌宠统一成**安卓悬浮窗那只**，网页里的大肥鱼不再出现。
    // 三个开关直接打 App 本地桥 127.0.0.1:3081（GET 简单请求，免得触发 CORS 预检）。
    const OVERLAY_BRIDGE = 'http://127.0.0.1:3081/overlay';

    function overlayCall(query, timeoutMs) {
      // 2026-10-20：桌宠动作以前没有超时。原生桥偶尔会被系统重启/服务正在拉起，
      // fetch 一直挂着 → 按钮永远停在「召回中…」且整页按钮 disabled，看着就是点了没反应。
      // 这里 6 秒收口，失败也能把 busy 清掉并给用户一句话。
      return new Promise((resolve, reject) => {
        let settled = false;
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (ctrl) { try { ctrl.abort(); } catch (e) {} }
          reject(new Error('请求超时'));
        }, timeoutMs || 6000);
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
        let request;
        try {
          request = fetch(OVERLAY_BRIDGE + '?' + query, {
            cache: 'no-store',
            signal: ctrl ? ctrl.signal : undefined,
          });
        } catch (e) {
          finish(reject, e);
          return;
        }
        request.then((r) => r.json()).then((j) => finish(resolve, j)).catch((e) => finish(reject, e));
      });
    }

    function petActionError(e) {
      const raw = String(e && e.message ? e.message : e || '');
      if (/请求超时|timeout|abort/i.test(raw)) return 'App 没响应，等两秒再点一次。';
      if (/overlay not running/i.test(raw)) return '悬浮窗还没启动，先点「召回桌宠」。';
      if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(raw)) return '连不上 App 本地桥，刷新页面再试。';
      return raw || '动作没有成功，再点一次试试。';
    }

    function WhalePetSection() {
      // 2026-10-20：桌宠页以前只 ensurePetCss()，没有 ensureCss()。
      // ctl-row / ctl-title / ctl-desc / ctl-group / ctl-note 这套行样式在
      // console 的 CSS 里，不开控制台页就不会注入 → 桌宠页退化成裸 div 堆叠。
      ensureCss();
      const [st, setSt] = react.useState(null);
      const [err, setErr] = react.useState('');
      const [busy, setBusy] = react.useState('');
      const [feedback, setFeedback] = react.useState(null);
      const [toast, setToast] = react.useState(null);
      const reload = () => {
        overlayCall('action=status')
          .then((j) => {
            if (!j || j.ok === false) throw new Error((j && j.error) || '状态读取失败');
            setSt(j);
            setErr('');
          })
          .catch((e) => {
            setErr(String(e && e.message ? e.message : '连不上 App 本地桥（127.0.0.1:3081）'));
          });
      };
      react.useEffect(() => {
        reload();
        const timer = setInterval(reload, 5000);
        return () => { clearInterval(timer); };
      }, []);
      const notify = (text, bad) => {
        // 2026-10-20：底部那行 note 在按钮下面，用户点完看不到（lesson-web-feedback-...）。
        // 动作反馈必须立刻出现在眼前：顶部 Toast + 按钮上方的短条，两处都放。
        const item = { id: Date.now() + Math.random(), text, bad: !!bad };
        setFeedback(item);
        setToast(item);
      };
      const run = (tag, query) => {
        setBusy(tag);
        setFeedback(null);
        setErr('');
        const call = () => overlayCall(query);
        const request = tag === 'panel'
          ? call().then((j) => {
              // 服务刚被拉起时 instance 还没挂上，panel 会立刻回 overlay not running。
              // 先召回、等服务起来，再开一次面板；用户只点一下按钮。
              if (j && j.ok === false && /overlay not running/i.test(String(j.error || ''))) {
                return overlayCall('action=show')
                  .then(() => new Promise((resolve) => setTimeout(resolve, 1000)))
                  .then(call);
              }
              return j;
            })
          : call();
        request
          .then((j) => {
            if (!j || j.ok === false) throw new Error((j && j.error) || '动作失败');
            const hide = query.indexOf('action=hide') >= 0;
            if (tag === 'refresh') setSt(j);
            setSt((prev) => {
              if (!prev) return prev;
              if (tag === 'show') return { ...prev, running: !hide, visible: !hide };
              if (tag === 'fluid') return { ...prev, fluid: !!j.on };
              if (tag === 'vscreen') return { ...prev, vscreen: !!j.on };
              return prev;
            });
            let msg = '已生效。';
            if (tag === 'show') msg = hide ? '桌宠已收起。' : '桌宠已召回，正在当前界面显示。';
            else if (tag === 'panel') msg = '桌宠面板已打开。';
            else if (tag === 'fluid') msg = j.on ? '流体云已开启。' : '流体云已关闭。';
            else if (tag === 'vscreen') msg = j.on ? '悬浮屏预览已开启。' : '悬浮屏预览已关闭。';
            else if (tag === 'refresh') msg = '状态已刷新。';
            notify(msg, false);
            // 原生服务 start 是异步的：立刻查可能还是 running=false，700ms 后再对一次。
            setTimeout(reload, 700);
          })
          .catch((e) => {
            const msg = petActionError(e);
            notify(msg, true);
          })
          .then(() => { setBusy(''); reload(); });
      };
      const running = !!(st && st.running);
      const visible = !!(st && st.visible);
      const fluid = !!(st && st.fluid);
      const vscreen = !!(st && st.vscreen);
      let stateText = '检测中…';
      let stateCls = '';
      if (err && !st) { stateText = '未连接'; stateCls = ' ctl-pet-bad'; }
      else if (st) {
        if (!running) { stateText = '未运行'; stateCls = ' ctl-pet-bad'; }
        else if (visible) { stateText = '在线'; stateCls = ' ctl-pet-ok'; }
        else { stateText = '已隐藏'; }
      }
      const note = err ? ('状态读不到：' + err)
        : (running
          ? '改完立即生效。点「召回桌宠」会取消贴边半藏，直接把它叫到当前界面；状态每 5 秒自动刷新。'
          : '悬浮窗现在没开：打开「显示桌宠」或点「召回桌宠」即可。');
      return jsxs('div', { className: 'ctl-root', children: [
        toast ? jsx(Toast, {
          key: toast.id,
          text: toast.text,
          tone: toast.bad ? undefined : 'success',
          holdMs: toast.bad ? 4200 : 2400,
          onDone: () => setToast((t) => (t && t.id === toast.id ? null : t)),
        }) : null,
        jsxs('div', { className: 'ctl-pet-hero', children: [
          jsx('div', { className: 'ctl-pet-avatar', children: PET_ART_URI
            ? jsx('img', { src: PET_ART_URI, alt: '大肥鱼' })
            : null }),
          jsxs('div', { className: 'ctl-pet-main', children: [
            jsxs('div', { className: 'ctl-pet-name-row', children: [
              jsx('span', { className: 'ctl-pet-name', children: '大肥鱼' }),
              jsx('span', { className: 'ctl-pet-tag', children: '鲸鱼娘' }),
              jsx('span', { className: 'ctl-pet-status' + stateCls, children: stateText }),
            ] }),
            jsx('div', { className: 'ctl-pet-desc', children: '安卓悬浮窗里那只鲸鱼娘。点一下听她说句话，点台词才打开面板。' }),
            jsxs('div', { className: 'ctl-pet-tips', children: [
              jsx('span', { className: 'ctl-pet-tip', children: '轻点 → 台词' }),
              jsx('span', { className: 'ctl-pet-tip', children: '点台词 → 面板' }),
              jsx('span', { className: 'ctl-pet-tip', children: '长按 → 说话' }),
            ] }),
          ] }),
        ] }),
        jsx('div', { className: 'ctl-group', children: '桌宠设置' }),
        jsx(Row, {
          title: '显示桌宠',
          desc: '在桌面和其他应用上显示整只大肥鱼。按住可拖到别处；关掉即收起悬浮窗。',
          right: jsx(Switch, {
            checked: running,
            label: '显示桌宠',
            onChange: (next) => run('show', next ? 'action=show' : 'action=hide'),
          }),
        }),
        jsx(Row, {
          title: '流体云',
          desc: 'AI 回复时把一张卡片飘到桌宠旁边；通知栏按钮也能开关。',
          right: jsx(Switch, {
            checked: fluid,
            label: '流体云',
            onChange: (next) => run('fluid', 'action=fluid&on=' + (next ? 1 : 0)),
          }),
        }),
        jsx(Row, {
          title: '悬浮屏预览',
          desc: '把虚拟屏画面实时缩到桌宠上看，适合盯自动化在做什么。',
          last: true,
          right: jsx(Switch, {
            checked: vscreen,
            label: '悬浮屏预览',
            onChange: (next) => run('vscreen', 'action=vscreen&on=' + (next ? 1 : 0)),
          }),
        }),
        feedback ? jsx('div', {
          className: 'ctl-pet-feedback' + (feedback.bad ? ' ctl-pet-feedback-bad' : ''),
          role: 'status',
          children: feedback.text,
        }) : null,
        jsxs('div', { className: 'ctl-bar ctl-pet-actions', children: [
          jsx(Button, {
            variant: 'outline', size: 'sm', disabled: busy !== '',
            onClick: () => run('show', 'action=show'),
            children: busy === 'show' ? '召回中…' : '召回桌宠',
          }),
          jsx(Button, {
            variant: 'outline', size: 'sm', disabled: busy !== '',
            onClick: () => run('panel', 'action=panel&show=1'),
            children: busy === 'panel' ? '打开中…' : '打开桌宠面板',
          }),
          jsx(Button, {
            variant: 'ghost', size: 'sm', disabled: busy !== '',
            onClick: () => run('refresh', 'action=status'),
            children: busy === 'refresh' ? '刷新中…' : '刷新状态',
          }),
        ] }),
        jsx(Note, { children: note }),
      ] });
    }

    function apply(ctx) {
      ensurePetCss();
      // 2026-10-19 修两个坑（实测导致整块 dock 完全不渲染）：
      // ① 列表槽位注册必须给 id，给 key 会抛 'list slot "..." requires options.id'；
      // ② 回调**不能返回** ctx.inject 的返回值，内核按 effect 校验并抛 'Invalid effect''，
      //    整个 apply 被回滚 —— 表现为卡片、听写、设置页全都不出现，但控制台无任何报错。
      ctx.slots.inject('conversation.composer.dock', () => {
        ctx.inject(['conversation'], scope => { scope.slots.register({
          name: 'conversation.composer.dock', id: 'android-draft-input', order: 20,
          inject: () => ({ draftConversation: scope.conversation }),
        }, AndroidDraftInput); });
      });
      // 分享自动挂载：新会话还没发第一句时（hero 形态）dock 不渲染，
      // 这里挂在只要会话存在就渲染的 input.overlay 上，保证分享能直接落到输入栏。
      // 用 try 包住：老内核没有这个槽时最多少了这条路径，不能让整个插件回滚。
      try {
        ctx.slots.inject('conversation.input.overlay', () => {
          ctx.inject(['conversation'], scope => { scope.slots.register({
            name: 'conversation.input.overlay', id: 'android-share-automount', order: 10,
            inject: () => ({ draftConversation: scope.conversation }),
          }, ShareAutoMount); });
        });
      } catch (e) { /* 槽不存在就退回 dock 原有的自动挂载 */ }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'android-console',
        order: 30,
        label: () => '控制台',
        inject: () => ({}),
      }, function ConsoleSectionGuarded(props) {
        var _md = null;
        try { _md = ctx.modelDirectories || null; } catch (_e) { _md = null; }
        props = { ...props, modelServices: { sessions: ctx.sessions, modelDirectories: _md } };
        return Boundary === null
          ? jsx(ConsoleSection, props)
          : jsx(Boundary, { children: jsx(ConsoleSection, props) });
      }));
      // v1.39.5：文档预览组件按需安装（LibreOffice WASM 不随安装包分发）
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'android-office-kit',
        order: 25,
        label: () => '文档预览',
        inject: () => ({}),
      }, function OfficeKitSectionGuarded() {
        return Boundary === null
          ? jsx(OfficeKitSection, {})
          : jsx(Boundary, { children: jsx(OfficeKitSection, {}) });
      }));
      // 帧级浮层：分享到货提示（不依赖会话，任何页面都能看到）
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'android-share-notice',
        order: 30,
        label: () => '分享到货提示',
      }, ShareNotice));
      // 小鲸鱼桌宠：设置页开关 + 帧级浮层。两个槽都走官方注册，不碰会话与输入框。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'android-whale-pet-settings',
        order: 35,
        label: () => '桌宠',
        inject: () => ({}),
      }, function WhalePetSectionGuarded() {
        return PetBoundary === null
          ? jsx(WhalePetSection, {})
          : jsx(PetBoundary, { children: jsx(WhalePetSection, {}) });
      }));
      // 2026-10-20：网页里的大肥鱼**不再挂载** —— 桌宠统一成安卓悬浮窗那只。
      // WhalePet/WhalePetSection 的旧代码与导出仍保留（隔离测试还引用 petClamp/petLine），
      // 只是不再注册 shell.overlay，页面上不会再多出一只鱼。
    }

    exports.sharedFiles = sharedFiles;
    exports.insertTranscript = insertTranscript;
    exports.putShareInDraft = putShareInDraft;
    exports.autoPutShareInDraft = autoPutShareInDraft;
    exports.ShareNotice = ShareNotice;
    exports.shareNoticeText = shareNoticeText;
    exports.ModelRouteController = ModelRouteController;
    exports.ModelRoutingPage = ModelRoutingPage;
    // 导出「全部账目」页与日期格式化：离线用假 react 渲染一遍做冒烟测试（见 test-ledger-render.cjs）。
    exports.LedgerPage = LedgerPage;
    exports.fmtDay = fmtDay;
    exports.MODEL_ROLES = MODEL_ROLES;
    exports.petClamp = petClamp;
    exports.petSnapX = petSnapX;
    exports.petLine = petLine;
    exports.WhalePet = WhalePet;
    exports.WhalePetSection = WhalePetSection;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
