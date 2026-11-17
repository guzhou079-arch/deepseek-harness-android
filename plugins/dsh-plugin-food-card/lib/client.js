/**
 * dsh-plugin-food-card —— 客户端半边。
 *
 * 两个落点：
 * 1. `tool.call.toolview`（key=food_card）：工具行本身画成卡片（折叠区里）。
 * 2. `conversation.chat.turnTail`：**卡片提到折叠区外面**，挂在整轮回复末尾，
 *    这样不用点开「已完成 用时 N 秒」就能直接看见。数据从 chat snapshot 里
 *    这一轮的工具调用参数取（argsRaw 是 JSON 字符串）。
 *
 * 样式只用 CSS 变量 + 内联样式：不打包、不带 css 文件，改完刷新页面就生效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-food-card',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const jsx = require('react/jsx-runtime').jsx;
    const { useState } = require('react');

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
      surface: 'var(--dsw-alias-bg-l1, rgba(127,127,127,.06))',
      accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
    };

    function yuan(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '';
      return Number.isInteger(n) ? '¥' + n : '¥' + n.toFixed(1);
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          void navigator.clipboard.writeText(text);
          return true;
        }
      } catch {}
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch {
        return false;
      }
    }

    /** Read one tool-call payload from any of the shapes the chat exposes. */
    function payloadOf(obj) {
      if (!obj || typeof obj !== 'object') return null;
      const nm = obj.name || (obj.call && obj.call.name);
      if (typeof nm === 'string' && nm !== 'food_card') return null;
      const raw = [obj.argsRaw, obj.args];
      if (obj.call) raw.push(obj.call.argsRaw, obj.call.args);
      for (const c of raw) {
        if (c && typeof c === 'object' && Array.isArray(c.items) && c.items.length) return c;
        if (typeof c === 'string' && c.replace(/^\s+/, '').charAt(0) === '{') {
          try {
            const o = JSON.parse(c);
            if (o && Array.isArray(o.items) && o.items.length) return o;
          } catch {}
        }
      }
      return null;
    }

    /** Every food_card payload carried by one chat node. */
    function payloadsOfNode(node) {
      const out = [];
      const d = node && node.data;
      if (!d || typeof d !== 'object') return out;
      for (const root of [d.root, d, d.call, d.block]) {
        const p = payloadOf(root);
        if (p) out.push(p);
      }
      if (Array.isArray(d.blocks)) {
        for (const b of d.blocks) {
          const p = payloadOf(b);
          if (p) out.push(p);
        }
      }
      return out;
    }

    /** food_card payloads for one numeric turn id, newest last. */
    function scanTurn(snap, turn) {
      const seen = new Set();
      const out = [];
      const kinds = [];
      let nodeCount = 0;
      let hasFoodNode = false;
      try {
        const keys = snap.locations.getTurn(Number(turn)) || [];
        for (const k of keys) {
          const n = snap.nodes.get(k);
          if (!n) continue;
          nodeCount += 1;
          if (kinds.length < 10) kinds.push(String(n.kind));
          const d = n.data;
          const nm =
            (d && d.root && (d.root.name || (d.root.call && d.root.call.name))) ||
            (d && d.name) ||
            (d && d.call && d.call.name);
          if (nm === 'food_card') hasFoodNode = true;
          for (const p of payloadsOfNode(n)) {
            const sig =
              (p.items[0] && p.items[0].shop + '|' + p.items[0].dish) || JSON.stringify(p).slice(0, 80);
            if (seen.has(sig)) continue;
            seen.add(sig);
            out.push(p);
          }
        }
      } catch {}
      return { payloads: out, nodeCount, hasFoodNode, kinds: kinds.join(',') };
    }

    function Card({ item }) {
      const [copied, setCopied] = useState(false);
      const pick = () => {
        const phrase = T('pickPhrase', { shop: item.shop, dish: item.dish });
        setCopied(copyText(phrase));
        window.setTimeout(() => setCopied(false), 1800);
      };
      const meta = [];
      if (item.delivery) meta.push(item.delivery);
      if (item.distance) meta.push(item.distance);
      if (item.fee) meta.push(item.fee);
      if (item.sales) meta.push(item.sales);

      const info = jsx('div', {
        key: 'info',
        style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 },
        children: [
          jsx('div', {
            key: 'shop',
            style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
            children: [
              jsx('span', {
                key: 'name',
                style: {
                  fontWeight: 600,
                  fontSize: 13,
                  color: C.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
                children: item.shop,
              }),
              typeof item.rating === 'number'
                ? jsx('span', {
                    key: 'r',
                    style: { fontSize: 11, color: '#e8a33d', whiteSpace: 'nowrap' },
                    children: '★ ' + item.rating,
                  })
                : null,
              item.tag
                ? jsx('span', {
                    key: 'tag',
                    style: {
                      fontSize: 10,
                      color: C.accent,
                      border: '1px solid ' + C.accent,
                      borderRadius: 4,
                      padding: '0 4px',
                      whiteSpace: 'nowrap',
                    },
                    children: item.tag,
                  })
                : null,
            ],
          }),
          jsx('div', {
            key: 'dish',
            style: { fontSize: 14, fontWeight: 600, color: C.text, lineHeight: '19px' },
            children: item.dish,
          }),
          item.spec || item.note
            ? jsx('div', {
                key: 'spec',
                style: { fontSize: 11.5, color: C.muted, lineHeight: '16px' },
                children: [item.spec, item.note].filter(Boolean).join(' · '),
              })
            : null,
        ],
      });

      const thumb = item.image
        ? jsx('img', {
            key: 'img',
            src: item.image,
            alt: '',
            loading: 'lazy',
            style: {
              width: 76,
              height: 76,
              flex: '0 0 auto',
              objectFit: 'cover',
              borderRadius: 10,
              background: C.surface,
            },
          })
        : null;

      return jsx('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '12px',
          border: '1px solid ' + C.border,
          borderRadius: 14,
          background: C.surface,
          minWidth: 0,
        },
        children: [
          jsx('div', {
            key: 'top',
            style: { display: 'flex', gap: 10, minWidth: 0, alignItems: 'flex-start' },
            children: item.image ? [thumb, info] : [info],
          }),
          jsx('div', {
            key: 'foot',
            style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
            children: [
              jsx('span', {
                key: 'p',
                style: { fontSize: 16, fontWeight: 700, color: C.text },
                children: yuan(item.price),
              }),
              typeof item.origin === 'number'
                ? jsx('span', {
                    key: 'o',
                    style: { fontSize: 11, color: C.muted, textDecoration: 'line-through' },
                    children: yuan(item.origin),
                  })
                : null,
              meta.length
                ? jsx('span', {
                    key: 'm',
                    style: { fontSize: 11, color: C.muted },
                    children: meta.join(' · '),
                  })
                : null,
            ],
          }),
          jsx('button', {
            key: 'btn',
            type: 'button',
            onClick: pick,
            style: {
              width: '100%',
              marginTop: 2,
              padding: '7px 12px',
              borderRadius: 10,
              border: copied ? '1px solid ' + C.accent : '1px solid ' + C.border,
              background: copied ? C.accent : 'transparent',
              color: copied ? '#fff' : C.accent,
              fontSize: 13,
              fontWeight: 500,
              lineHeight: '18px',
              cursor: 'pointer',
            },
            children: copied ? T('copied') : T('pick'),
          }),
        ],
      });
    }

    /** One payload rendered as a titled card list (one card per row). */
    function CardStack({ payload }) {
      const items = payload.items.filter(Boolean);
      if (items.length === 0) return null;
      return jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 8, margin: '2px 0' },
        children: [
          jsx('div', {
            key: 't',
            style: { fontSize: 12, fontWeight: 600, color: C.muted, display: 'flex', gap: 6 },
            children: [
              payload.title || null,
              jsx('span', { key: 'v', style: { opacity: 0.45, fontWeight: 400, fontSize: 10 }, children: 'v7' }),
            ],
          }),
          jsx('div', {
            key: 'list',
            style: { display: 'flex', flexDirection: 'column', gap: 8 },
            children: items.map((item, i) => jsx(Card, { item, key: i })),
          }),
          payload.footer
            ? jsx('div', {
                key: 'f',
                style: { fontSize: 11, color: C.muted },
                children: payload.footer,
              })
            : null,
        ],
      });
    }

    /** Tool-row view: the call itself, inside the (collapsed) process group. */
    function FoodCardView({ block, phase }) {
      const payload = payloadOf(block);
      if (!payload) {
        if (phase === 'result') {
          return jsx('div', {
            style: { fontSize: 12, color: C.muted, padding: '4px 0' },
            children: T('noPayload'),
          });
        }
        return null;
      }
      return jsx(CardStack, { payload });
    }

    const VERSION = 'v6';

    /** Turn-tail view: cards hoisted out of the fold, always visible. */
    let diagReported = false;
    function TurnTailCards({ turn, readFoodCards }) {
      if (typeof readFoodCards !== 'function') return null;
      let r = null;
      try {
        r = readFoodCards(turn);
      } catch (err) {
        r = { error: String((err && err.message) || err) };
      }
      if (!r) return null;
      const payloads = r.payloads || [];
      if (payloads.length > 0) {
        return jsx('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 0 4px' },
          children: payloads.map((p, i) => jsx(CardStack, { payload: p, key: i })),
        });
      }
      if (r.hasFoodNode || (r.error && !diagReported)) {
        diagReported = true;
        return jsx('div', {
          style: { fontSize: 11, color: C.muted, padding: '2px 0', wordBreak: 'break-all' },
          children:
            'food-card ' +
            VERSION +
            ' · ' +
            (r.error ? 'err: ' + r.error : 'nodes=' + r.nodeCount + ' kinds=' + r.kinds),
        });
      }
      return null;
    }

    const NS = 'dsh-plugin-food-card';
    const zh = {
      pickPhrase: '就选「{shop}」的「{dish}」',
      copied: '已复制 · 粘给我就行',
      pick: '选这个',
      noPayload: 'food_card：这次调用没带卡片数据',
    }
    const en = {
      pickPhrase: 'Go with "{dish}" from "{shop}"',
      copied: 'Copied · just paste it',
      pick: 'Pick this',
      noPayload: 'food_card: this call carried no card data',
    }
    let T = (key, params) => {
      const template = zh[key] === undefined ? key : zh[key];
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
    };

    function apply(ctx) {
      T = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'food-card: zh');
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'food-card: en');
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: 'food_card' }, FoodCardView),
      );

      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'food-card-tail',
            inject: (sessionId) => ({
              readFoodCards: (turn) => {
                const binding = ctx.sessions.binding(sessionId);
                if (binding === undefined) return { payloads: [], error: 'no binding' };
                const chat = ctx.uiConversation.binding(binding).target('chat');
                const snap = chat.getSnapshot();
                if (snap === undefined) return { payloads: [], error: 'no snapshot' };
                return scanTurn(snap, turn);
              },
            }),
          },
          TurnTailCards,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    return module.exports;
  },
});
