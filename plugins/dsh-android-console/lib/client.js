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
        const timer = setInterval(fetchLan, 3500);
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

      return { lan: lan, setClipboard: setClipboard, refresh: fetchLan };
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
        const ips = lan.ips || [];
        const files = lan.files || [];

        return jsxs('div', { className: 'ctl-root', children: [
          jsx(Back, { title: '局域网协同与隔空投送', onBack: () => setPage('main') }),
          jsx(Note, { children: '跨设备互联：电脑浏览器直连手机 DSH 控制台，支持跨设备剪贴板双向同步与大文件拖拽隔空投送。' }),
          jsx('div', { className: 'ctl-sep' }),

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
    function AndroidDraftInput({ sessionId, inputActions, draftConversation }) {
      const [voice, setVoice] = react.useState(null);
      const [share, setShare] = react.useState(null);
      const [transcript, setTranscript] = react.useState('');
      const [message, setMessage] = react.useState('');
      const [importing, setImporting] = react.useState(false);
      const active = react.useRef(null), alive = react.useRef(true), epoch = react.useRef(0), received = react.useRef(new Set());
      react.useEffect(() => {
        alive.current = true;
        const poll = () => {
          if (!nativeInput()) return;
          try { setShare(nativeJson('shareState')); } catch (e) { setMessage(e.message); }
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
      if (!nativeInput() || !inputActions || !sessionId) return null;
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
          if (current()) { setShare(nativeJson('shareState')); setMessage('分享已加入草稿，请检查后发送'); }
        } catch (e) { if (alive.current) setMessage(e.message); }
        finally { if (alive.current) setImporting(false); }
      };
      const discard = () => {
        try { nativeJson('shareAck', batch.id); setShare(nativeJson('shareState')); }
        catch (e) { setMessage(e.message); }
      };
      return jsxs('div', { className: 'ctl-input-native', style: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%', fontSize: 12 }, children: [
        jsxs('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }, children: [
          jsx(Button, { size: 'sm', variant: busy ? 'primary' : 'secondary', disabled: importing, onClick: () => callVoice(busy ? 'stop' : 'start'), children: busy ? '结束收音' : '🎤 听写' }),
          busy ? jsx(Button, { size: 'sm', variant: 'ghost', onClick: () => callVoice('cancel'), children: '取消' }) : null,
          busy ? jsx('span', { role: 'status', children: voice?.text || ({ permission: '等待麦克风权限', recognizing: '正在识别…', recording: '正在收音…' }[voice?.state] || '请说话…') }) : null,
          message ? jsx('span', { role: 'status', children: message }) : null,
        ] }),
        transcript ? jsxs('div', { children: [jsx('span', { children: transcript }), ' ', jsx(Button, { size: 'sm', onClick: () => {
          if (insertTranscript(inputActions, transcript, inputActions.captureInsertion())) { setTranscript(''); setMessage('转写已加入草稿'); }
        }, children: '加入草稿' })] }) : null,
        batch ? jsxs('div', { style: { padding: 8, border: '1px solid var(--border, #8885)', borderRadius: 8 }, children: [
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

    /** 到货横幅的文案（纯函数，方便隔离测试）：说清"是什么 / 多大 / 副本在哪"。 */
    function shareNoticeText(share) {
      const batch = share?.latest;
      if (!batch) return '';
      const files = (batch.files || []).map(file => file.name + (Number.isSafeInteger(file.bytes) ? '（' + fileSizeText(file.bytes) + '）' : ''));
      const head = batch.text ? batch.text.trim().slice(0, 60) : files.join('、');
      const rest = share.count > 1 ? '（另有 ' + (share.count - 1) + ' 条待处理）' : '';
      const where = batch.archive ? '，副本已存到 ' + batch.archive : '，请在聊天框点「加入草稿」';
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

    const inject = ['slots', 'sessions', 'modelDirectories'];

    function apply(ctx) {
      ctx.slots.inject('conversation.composer.dock', () => ctx.inject(['uiConversation'], scope => scope.slots.register({
        name: 'conversation.composer.dock', key: 'android-draft-input', order: 20,
        inject: () => ({ draftConversation: scope.uiConversation }),
      }, AndroidDraftInput)));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'android-console',
        order: 20,
        label: () => '控制台',
      }, function ConsoleSectionGuarded(props) {
        props = { ...props, modelServices: { sessions: ctx.sessions, modelDirectories: ctx.modelDirectories } };
        return Boundary === null
          ? jsx(ConsoleSection, props)
          : jsx(Boundary, { children: jsx(ConsoleSection, props) });
      }));
      // 帧级浮层：分享到货提示（不依赖会话，任何页面都能看到）
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'android-share-notice',
        order: 30,
        label: () => '分享到货提示',
      }, ShareNotice));
    }

    exports.sharedFiles = sharedFiles;
    exports.insertTranscript = insertTranscript;
    exports.putShareInDraft = putShareInDraft;
    exports.ShareNotice = ShareNotice;
    exports.shareNoticeText = shareNoticeText;
    exports.ModelRouteController = ModelRouteController;
    exports.ModelRoutingPage = ModelRoutingPage;
    // 导出「全部账目」页与日期格式化：离线用假 react 渲染一遍做冒烟测试（见 test-ledger-render.cjs）。
    exports.LedgerPage = LedgerPage;
    exports.fmtDay = fmtDay;
    exports.MODEL_ROLES = MODEL_ROLES;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
