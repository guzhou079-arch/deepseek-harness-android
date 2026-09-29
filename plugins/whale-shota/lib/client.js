/**
 * whale-shota —— 客户端半边（自用版，请勿分发）
 *
 * 贴画版：桌宠就是从你那张插画里裁出来的圆形贴纸。
 * 用 CSS 的 background-size/position 直接从本机已在对外提供的 /dsh-bg-user.png
 * 裁出脸部区域 —— 零新增字节、零构建、画风天然一致。
 * 图挂了还有一层渐变兜底（background-image 的第二层）。
 *
 * 状态信号：data-error / data-streaming / data-step-process-* / data-phase
 *   —— 只按需要的属性过滤观察，读不到任何信号时安全降级为 idle。
 * 纪律：浮层 z-index 900（DSH 契约 menu 100 / Modal 1000 / portal 1100，一律 < 1000）；
 *       所有 DOM 节点、观察器、定时器都由 ctx.effect 逐一回收。
 *
 * 换裁切只改下面三个系数（与 tools/render-sticker.py 一致）：
 *   A 头+帽   x .100  y .005  side .620   ← 当前
 *   B 紧脸    x .160  y .060  side .460
 *   C 上方块  x .020  y .000  side .780
 *   D 近全身  x .060  y .000  side .880
 */

window.__ModuleLoader__.load({
  id: 'whale-shota',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var BODY_ATTR = 'data-dsh-whale-shota';
    var COLLAPSE_KEY = 'whale-shota:collapsed';
    var DONE_HOLD_MS = 2600;
    var ACCENT = '#5484cc';          // 从插画里提取的主色

    var LINES = {
      idle: '哼！',
      thinking: '你们还不懂…',
      streaming: '其实我早就想到了…',
      done: '我超聪明的！',
      error: '……哼。'
    };

    var CROP_X = 0.100, CROP_Y = 0.005, CROP_SIDE = 0.620;
    var ZOOM = (1 / CROP_SIDE).toFixed(4);
    var OFF_X = (-CROP_X / CROP_SIDE).toFixed(4);
    var OFF_Y = (-CROP_Y / CROP_SIDE).toFixed(4);

    var CSS = [
      '.ws-pet{--ws-pet-d:clamp(56px,15vw,76px);--ws-pet-img:url("/dsh-bg-user.png");',
      'position:fixed;right:16px;bottom:14px;z-index:900;display:flex;flex-direction:column;',
      'align-items:flex-end;gap:8px;pointer-events:none;',
      'font:13px/1.4 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
      '.ws-pet *{box-sizing:border-box}',
      '.ws-pet__bubble{max-width:260px;padding:7px 11px;border-radius:12px 12px 2px 12px;',
      'background:rgba(9,16,34,.92);color:#e8f0ff;border:1px solid color-mix(in srgb,var(--ws-accent) 55%,transparent);',
      'box-shadow:0 6px 20px rgba(0,0,0,.35);opacity:0;transform:translateY(4px);white-space:nowrap;',
      'transition:opacity .18s ease,transform .18s ease}',
      '.ws-pet[data-open="1"] .ws-pet__bubble,.ws-pet[data-state="thinking"] .ws-pet__bubble,',
      '.ws-pet[data-state="streaming"] .ws-pet__bubble,.ws-pet[data-state="done"] .ws-pet__bubble,',
      '.ws-pet[data-state="error"] .ws-pet__bubble{opacity:1;transform:translateY(0)}',
      '.ws-pet__btn{pointer-events:auto;width:var(--ws-pet-d);height:var(--ws-pet-d);padding:0;border:0;',
      'border-radius:50%;cursor:pointer;background-color:#3b57e0;',
      'background-image:var(--ws-pet-img),radial-gradient(circle at 32% 26%,#7d97ff,#3b57e0 62%,#22307a);',
      'background-size:calc(var(--ws-pet-d) * ' + ZOOM + ') calc(var(--ws-pet-d) * ' + ZOOM + '),cover;',
      'background-position:calc(var(--ws-pet-d) * ' + OFF_X + ') calc(var(--ws-pet-d) * ' + OFF_Y + '),center;',
      'background-repeat:no-repeat;',
      'box-shadow:0 6px 18px rgba(20,40,90,.38),inset 0 0 0 3px rgba(255,255,255,.28);',
      'transition:transform .16s ease,opacity .16s ease}',
      '.ws-pet__btn:hover{transform:translateY(-2px) scale(1.05)}',
      '.ws-pet__btn:active{transform:scale(.95)}',
      '.ws-pet[data-state="thinking"] .ws-pet__btn{animation:ws-bob 1.5s ease-in-out infinite}',
      '.ws-pet[data-state="streaming"] .ws-pet__btn{animation:ws-bob .8s ease-in-out infinite}',
      '.ws-pet[data-state="done"] .ws-pet__btn{animation:ws-pop .5s ease-out 2}',
      '.ws-pet[data-state="error"] .ws-pet__btn{filter:grayscale(.45) brightness(.88)}',
      '.ws-pet[data-collapsed="1"] .ws-pet__bubble{display:none}',
      '.ws-pet[data-collapsed="1"] .ws-pet__btn{transform:scale(.58);opacity:.55}',
      '.ws-pet[data-collapsed="1"] .ws-pet__btn:hover{transform:scale(.64);opacity:.85}',
      '@keyframes ws-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
      '@keyframes ws-pop{0%{transform:scale(1)}45%{transform:scale(1.14)}100%{transform:scale(1)}}',
      '@media (prefers-reduced-motion:reduce){.ws-pet__btn{animation:none!important}}'
    ].join('');

    function readState() {
      try {
        if (document.querySelector('[data-error]')) return 'error';
        if (document.querySelector('[data-streaming]')) return 'streaming';
        if (document.querySelector('[data-step-process-content],[data-step-process-body]')) return 'thinking';
      } catch (error) { /* 选择器不可用时安全降级 */ }
      return 'idle';
    }

    exports.apply = function apply(ctx) {
      // ---- 1) 主题层 ----
      ctx.effect(() => {
        const root = document.documentElement;
        const had = root.hasAttribute(BODY_ATTR);
        root.setAttribute(BODY_ATTR, '');
        root.style.setProperty('--ws-accent', ACCENT);
        return () => {
          root.style.removeProperty('--ws-accent');
          if (!had) root.removeAttribute(BODY_ATTR);
        };
      });

      ctx.effect(() => {
        const style = document.createElement('style');
        style.id = 'whale-shota-style';
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
        return () => style.remove();
      });

      // ---- 2) 贴画桌宠 ----
      ctx.effect(() => {
        let pet = null, bubble = null, btn = null;
        let observer = null, timer = null, bootTimer = null;
        let state = 'idle', doneUntil = 0;

        const render = () => {
          if (!pet) return;
          pet.setAttribute('data-state', state);
          if (bubble) bubble.textContent = LINES[state] || LINES.idle;
        };

        const tick = () => {
          const raw = readState();
          let next;
          if (raw !== 'idle') next = raw;
          else if (state === 'streaming' || state === 'thinking') { next = 'done'; doneUntil = Date.now() + DONE_HOLD_MS; }
          else if (state === 'done' && Date.now() < doneUntil) next = 'done';
          else next = 'idle';
          if (next !== state) { state = next; render(); }
        };

        const mount = () => {
          if (pet || !document.body) return false;

          pet = document.createElement('div');
          pet.className = 'ws-pet';
          pet.setAttribute('data-state', 'idle');
          pet.setAttribute('role', 'presentation');

          bubble = document.createElement('div');
          bubble.className = 'ws-pet__bubble';
          bubble.setAttribute('role', 'status');
          bubble.setAttribute('aria-live', 'polite');
          bubble.textContent = LINES.idle;

          btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ws-pet__btn';
          btn.title = '鲸鱼正太：点击折叠 / 展开';
          btn.setAttribute('aria-label', '鲸鱼正太桌宠，点击折叠或展开');

          let collapsed = false;
          try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (error) { /* 隐私模式 */ }
          pet.setAttribute('data-collapsed', collapsed ? '1' : '0');
          btn.addEventListener('click', () => {
            const next = pet.getAttribute('data-collapsed') === '1' ? '0' : '1';
            pet.setAttribute('data-collapsed', next);
            try { localStorage.setItem(COLLAPSE_KEY, next); } catch (error) { /* 忽略 */ }
          });
          pet.addEventListener('mouseenter', () => pet.setAttribute('data-open', '1'));
          pet.addEventListener('mouseleave', () => pet.removeAttribute('data-open'));

          pet.appendChild(bubble);
          pet.appendChild(btn);
          document.body.appendChild(pet);

          observer = new MutationObserver(tick);
          observer.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: ['data-error', 'data-streaming', 'data-phase', 'data-content-phase',
              'data-step-process-content', 'data-step-process-body']
          });
          timer = setInterval(tick, 1000);   // 低频兜底
          tick();
          return true;
        };

        if (!mount()) {
          let tries = 0;
          bootTimer = setInterval(() => {
            tries += 1;
            if (mount() || tries > 100) { clearInterval(bootTimer); bootTimer = null; }
          }, 100);
        }

        return () => {
          if (bootTimer) clearInterval(bootTimer);
          if (timer) clearInterval(timer);
          if (observer) observer.disconnect();
          if (pet && pet.parentNode) pet.parentNode.removeChild(pet);
          pet = bubble = btn = observer = timer = bootTimer = null;
        };
      });
    };

    return module.exports;
  }
});
