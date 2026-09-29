/**
 * whale-shota —— 客户端半边（自用版，请勿分发）
 *
 * 这是**模板**：由 tools/build-client.py 把 layers/body.webp 与 layers/head.webp
 * 转成 data URL 填进 __BODY_IMG__ / __HEAD_IMG__，产出 lib/client.js。
 * 不要直接改 lib/client.js —— 下次构建会覆盖。
 *
 * 2.5D 分层：身体层几乎不动（呼吸），头层绕脖子转轴做歪头 + 微摆。
 * 图层由 tools/build-layers.py 从 assets/whale-shota.png 抠像切分而来。
 *
 * 状态信号：data-error / data-streaming / data-step-process-* / data-phase
 *   —— 只按需要的属性过滤观察，读不到任何信号时安全降级为 idle。
 * 纪律：浮层 z-index 900（DSH 契约 menu 100 / Modal 1000 / portal 1100，一律 < 1000）；
 *       所有 DOM 节点、观察器、定时器、rAF 都由 ctx.effect 回收。
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

    var BODY_SRC = '__BODY_IMG__';
    var HEAD_SRC = '__HEAD_IMG__';

    // 与 tools/render-motion.py 的常量一一对应（改一边记得改另一边）
    var PERIOD = 3.2;                // 呼吸周期（秒）
    var HEAD_DEG = 1.7;              // 歪头幅度（度）
    var HEAD_LAG = 0.35;             // 头相对身体的相位滞后（弧度）
    var BREATH_PCT = 0.55;           // 呼吸位移（占图形高度百分比，自动随尺寸缩放）
    var BREATH_SCALE = 0.004;        // 身体纵向缩放幅度
    var SWAY_PCT = 0.25;             // 头部横向微摆（占宽百分比）
    var SWAY_PERIOD = 4.3;

    var LINES = {
      idle: '哼！',
      thinking: '你们还不懂…',
      streaming: '其实我早就想到了…',
      done: '我超聪明的！',
      error: '……哼。'
    };

    var CSS = [
      '.ws-pet{--ws-pet-w:clamp(120px,26vw,200px);position:fixed;right:14px;bottom:12px;z-index:900;',
      'display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none;',
      'font:13px/1.4 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
      '.ws-pet *{box-sizing:border-box}',
      '.ws-pet__bubble{max-width:260px;padding:7px 11px;border-radius:12px 12px 2px 12px;',
      'background:rgba(9,16,34,.92);color:#e8f0ff;border:1px solid color-mix(in srgb,var(--ws-accent) 55%,transparent);',
      'box-shadow:0 6px 20px rgba(0,0,0,.35);opacity:0;transform:translateY(4px);white-space:nowrap;',
      'transition:opacity .18s ease,transform .18s ease}',
      '.ws-pet[data-open="1"] .ws-pet__bubble,.ws-pet[data-state="thinking"] .ws-pet__bubble,',
      '.ws-pet[data-state="streaming"] .ws-pet__bubble,.ws-pet[data-state="done"] .ws-pet__bubble,',
      '.ws-pet[data-state="error"] .ws-pet__bubble{opacity:1;transform:translateY(0)}',
      '.ws-pet__figure{position:relative;width:var(--ws-pet-w);aspect-ratio:520/380;pointer-events:auto;cursor:pointer;',
      'filter:drop-shadow(0 10px 20px rgba(18,36,80,.30));transition:width .2s ease,opacity .2s ease}',
      '.ws-pet__figure img{position:absolute;inset:0;width:100%;height:100%;display:block;',
      'user-select:none;-webkit-user-drag:none;pointer-events:none}',
      '.ws-pet__body{transform-origin:50% 100%}',
      '.ws-pet__head{transform-origin:49.6% 79.1%}',
      '.ws-pet[data-state="error"] .ws-pet__figure{filter:drop-shadow(0 10px 20px rgba(18,36,80,.30)) grayscale(.45) brightness(.88)}',
      '.ws-pet[data-collapsed="1"] .ws-pet__figure{width:calc(var(--ws-pet-w) * .42);opacity:.62}',
      '.ws-pet[data-collapsed="1"] .ws-pet__bubble{display:none}',
      '@media (prefers-reduced-motion:reduce){.ws-pet__figure img{transition:none}}'
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

      // ---- 2) 桌宠层 ----
      ctx.effect(() => {
        let pet = null, bubble = null, bodyImg = null, headImg = null, figure = null;
        let observer = null, timer = null, bootTimer = null, raf = 0;
        let state = 'idle', doneUntil = 0;
        let acc = 0, prev = 0, reduced = false;

        try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (error) { /* 忽略 */ }

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

        const pose = () => {
          const t = acc;
          const phase = 2 * Math.PI * t / PERIOD;
          const breath = Math.sin(phase);
          const sway = Math.sin(2 * Math.PI * t / SWAY_PERIOD);
          if (bodyImg) {
            bodyImg.style.transform = 'translateY(' + (BREATH_PCT * breath / 100 * 380).toFixed(2) + 'px) scaleY(' + (1 + BREATH_SCALE * breath).toFixed(4) + ')';
          }
          if (headImg) {
            headImg.style.transform = 'translate(' + (SWAY_PCT * sway / 100 * 520).toFixed(2) + 'px,' +
              (BREATH_PCT * breath / 100 * 380).toFixed(2) + 'px) rotate(' + (HEAD_DEG * Math.sin(phase - HEAD_LAG)).toFixed(3) + 'deg)';
          }
        };

        const loop = (now) => {
          if (!prev) prev = now;
          acc += (now - prev) / 1000;
          prev = now;
          pose();
          raf = requestAnimationFrame(loop);
        };

        const startAnim = () => {
          if (reduced || raf) return;
          prev = 0;
          raf = requestAnimationFrame(loop);
        };
        const stopAnim = () => {
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
        };
        const onVisibility = () => { if (document.hidden) stopAnim(); else startAnim(); };

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

          figure = document.createElement('div');
          figure.className = 'ws-pet__figure';
          figure.setAttribute('role', 'img');
          figure.setAttribute('aria-label', '鲸鱼正太桌宠，点击折叠或展开');

          bodyImg = document.createElement('img');
          bodyImg.className = 'ws-pet__body';
          bodyImg.alt = '';
          bodyImg.src = BODY_SRC;

          headImg = document.createElement('img');
          headImg.className = 'ws-pet__head';
          headImg.alt = '';
          headImg.src = HEAD_SRC;

          figure.appendChild(bodyImg);
          figure.appendChild(headImg);

          let collapsed = false;
          try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (error) { /* 隐私模式 */ }
          pet.setAttribute('data-collapsed', collapsed ? '1' : '0');
          figure.addEventListener('click', () => {
            const next = pet.getAttribute('data-collapsed') === '1' ? '0' : '1';
            pet.setAttribute('data-collapsed', next);
            try { localStorage.setItem(COLLAPSE_KEY, next); } catch (error) { /* 忽略 */ }
          });
          figure.addEventListener('mouseenter', () => pet.setAttribute('data-open', '1'));
          figure.addEventListener('mouseleave', () => pet.removeAttribute('data-open'));

          pet.appendChild(bubble);
          pet.appendChild(figure);
          document.body.appendChild(pet);

          observer = new MutationObserver(tick);
          observer.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: ['data-error', 'data-streaming', 'data-phase', 'data-content-phase',
              'data-step-process-content', 'data-step-process-body']
          });
          timer = setInterval(tick, 1000);   // 低频兜底
          document.addEventListener('visibilitychange', onVisibility);
          tick();
          pose();
          startAnim();
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
          document.removeEventListener('visibilitychange', onVisibility);
          stopAnim();
          if (pet && pet.parentNode) pet.parentNode.removeChild(pet);
          pet = bubble = figure = bodyImg = headImg = observer = timer = bootTimer = null;
        };
      });
    };

    return module.exports;
  }
});
