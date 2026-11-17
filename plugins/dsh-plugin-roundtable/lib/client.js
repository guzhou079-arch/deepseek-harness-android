window.__ModuleLoader__.load({
  id: 'dsh-plugin-roundtable',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const jsx = require('react/jsx-runtime').jsx;
    const jsxs = require('react/jsx-runtime').jsxs;
    const React = require('react');
    const MAX_MEMBERS = 6;
    const WRAP_MARK = Symbol.for('dsh.roundtable.promptWrapped.v1');
    const REPEATED_PREFIX = /^(?:\s*<!--dsh-roundtable:[A-Za-z0-9_-]+-->\r?\n?)+/;
    const membersBySession = new Map();
    const wrappedPromptServices = new WeakSet();

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
      surface: 'var(--dsw-alias-bg-l1, rgba(127,127,127,.055))',
      raised: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.12))',
      accent: 'var(--dsw-alias-brand-primary, #6275e8)',
      danger: 'var(--dsw-alias-state-error-primary, #d96c72)',
    };
    // color-mix 在 Chromium < 111 上不认识，赋值会被 CSSOM 静默丢弃 → 用 rgba 兜底，
    // 否则旧 WebView 上选中行只剩边框，深色主题下更难辨认。
    const CAN_MIX = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      && CSS.supports('background', 'color-mix(in srgb, red 10%, transparent)');
    const pickerPanelStyle = {
      width: '100%', boxSizing: 'border-box',
      padding: 12, // 容器内缩 12px，比页面 16px 略紧，给模型名留宽度。
      borderRadius: 14, // 14px 只用于最外层容器，与 10px 成员行形成两级边界。
      border: '1px solid ' + C.border,
      background: C.surface,
      color: C.text,
      display: 'flex', flexDirection: 'column',
      gap: 12, // 区块间固定 12px，手机上能分清段落但不浪费纵向空间。
    };

    function routeKey(member) {
      return `${member.provider}\0${member.model}`;
    }

    function storageKey(sessionId) {
      return `dsh.roundtable.members.v1.${sessionId}`;
    }

    function sentKey(sessionId) {
      return `dsh.roundtable.sent.v1.${sessionId}`;
    }

    // 上一次真正写进消息的配置（只存路由字段）。用来区分「一直没选成员」和「刚把成员清空」：
    // 后者要补发一次空配置让服务端退出多模型，前者一个字都不该写。
    function loadSent(sessionId) {
      try {
        const value = JSON.parse(localStorage.getItem(sentKey(sessionId)) || '[]');
        if (!Array.isArray(value)) return [];
        return value.filter(validMember);
      } catch {
        return [];
      }
    }

    function saveSent(sessionId, members) {
      try { localStorage.setItem(sentKey(sessionId), JSON.stringify(members)); } catch {}
    }

    function validMember(member) {
      return member && typeof member.name === 'string' && typeof member.provider === 'string' && typeof member.model === 'string';
    }

    function loadMembers(sessionId) {
      try {
        const value = JSON.parse(localStorage.getItem(storageKey(sessionId)) || '[]');
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        return value.filter(validMember).filter((member) => {
          const key = routeKey(member);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, MAX_MEMBERS);
      } catch {
        return [];
      }
    }

    function encodeConfig(members) {
      const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, members }));
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    }

    function ensurePromptWrap(ctx, sessionId) {
      if (sessionId && !membersBySession.has(sessionId)) membersBySession.set(sessionId, loadMembers(sessionId));
      const service = ctx.remote?.session;
      if (!service || typeof service.prompt !== 'function') return;
      if (service[WRAP_MARK] || wrappedPromptServices.has(service)) {
        wrappedPromptServices.add(service);
        return;
      }
      const original = service.prompt;
      const wrapped = function (request, ...args) {
        const id = request?.sessionId;
        const members = membersBySession.get(id) || [];
        const clearing = members.length === 0 && loadSent(id).length > 0;
        // 普通聊天不写配置前缀：前缀会随 prompt 落进会话历史，用户消息里原样露出
        // <!--dsh-roundtable:...-->（2026-11-05 实测：一条普通消息一个标记）。
        // 只有选中成员、或刚清空成员要通知服务端退出多模型时，才写这一行。
        if (members.length === 0 && !clearing) {
          let stripped = false;
          const content = (request?.content || []).map((block) => {
            if (stripped || block?.type !== 'text') return block;
            const text = String(block.text || '');
            if (!REPEATED_PREFIX.test(text)) return block;
            stripped = true;
            return { ...block, text: text.replace(REPEATED_PREFIX, '') };
          });
          return original.call(this, { ...request, content }, ...args);
        }
        let prefixed = false;
        const content = (request?.content || []).map((block) => {
          if (prefixed || block?.type !== 'text') return block;
          prefixed = true;
          const text = String(block.text || '').replace(REPEATED_PREFIX, '');
          return { ...block, text: `<!--dsh-roundtable:${encodeConfig(members)}-->\n${text}` };
        });
        saveSent(id, members);
        return original.call(this, { ...request, content }, ...args);
      };
      Object.defineProperty(service, 'prompt', {
        configurable: true, enumerable: true, writable: true, value: wrapped,
      });
      Object.defineProperty(service, WRAP_MARK, { configurable: true, value: true });
      if (service.prompt === wrapped) wrappedPromptServices.add(service);
    }

    function flattenCatalog(result) {
      const groups = result?.value?.groups || [];
      return groups.flatMap((group) => (group.models || []).map((model) => {
        // 目录里每位模型自带可选推理等级（efforts），defaultEffort 只是默认档。
        // 圆桌上要能逐人调档：凑数的那位用便宜档，负责挑刺的那位开高档。
        const reasoning = model.reasoning || {};
        const efforts = Array.isArray(reasoning.efforts)
          ? reasoning.efforts.map((level) => ({ id: level.id, name: level.name || level.id }))
          : [];
        return {
          name: model.name || model.id,
          provider: group.id,
          model: model.id,
          providerName: group.name || group.id,
          ...(reasoning.defaultEffort ? { reasoningEffort: reasoning.defaultEffort } : {}),
          ...(efforts.length ? { reasoningEfforts: efforts } : {}),
        };
      }));
    }

    function loadModelCatalog(ctx) {
      return Promise.resolve().then(() => ctx.remote.session.modelCatalog()).then(flattenCatalog);
    }

    // 行本身不再是 <button>：选人按钮和档位按钮是两组独立操作，嵌套 button 既非法又会抢点击。
    // 外层 div 只负责边框和底色，第一行是选人按钮，第二行是选中后才出现的推理等级。
    function ModelRow({ model, selectedIndex, occupied, onToggle, onEffort }) {
      const selected = selectedIndex >= 0;
      const efforts = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
      const effort = model.reasoningEffort;
      return jsxs('div', {
        style: {
          width: '100%', boxSizing: 'border-box',
          border: '1px solid ' + (selected ? C.accent : C.border),
          borderRadius: 10,
          background: selected ? (CAN_MIX ? 'color-mix(in srgb, ' + C.accent + ' 10%, transparent)' : 'rgba(98,117,232,.14)') : 'transparent',
          opacity: occupied ? 0.45 : 1,
          overflow: 'hidden',
        },
        children: [
          jsxs('button', {
            type: 'button',
            disabled: occupied,
            onClick: onToggle,
            'aria-pressed': selected,
            'aria-label': selected ? T('移除{name}，当前第 {index} 位发言', { name: model.name, index: selectedIndex + 1 }) : T('添加{name}', { name: model.name }),
            style: {
              width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center',
              gap: 12, // 状态位、文案、操作位用 12px 分隔，触屏上不挤成一团。
              minHeight: 44, // 44px 是最小触控高度，也能放下两行文字。
              padding: '4px 12px', // 垂直 4px 补齐到 44px，水平与容器内边距对齐。
              textAlign: 'left',
              border: 0,
              background: 'transparent',
              color: occupied ? C.muted : C.text,
              cursor: occupied ? 'not-allowed' : 'pointer',
              font: 'inherit',
            },
            children: [
              jsx('span', {
                'aria-hidden': true,
                style: {
                  width: 20, height: 20, boxSizing: 'border-box', flex: '0 0 20px',
                  display: 'grid', placeItems: 'center', borderRadius: '50%',
                  border: '1px solid ' + (selected ? C.accent : C.border),
                  background: selected ? C.accent : 'transparent', color: '#fff',
                  fontSize: 11, lineHeight: '16px', fontWeight: 650, // 序号徽标保持 11/16。
                },
                children: selected ? selectedIndex + 1 : '',
                key: 'status',
              }),
              jsxs('span', {
                style: { flex: 1, minWidth: 0 },
                children: [
                  jsx('span', {
                    style: { display: 'block', fontSize: 13, lineHeight: '20px', fontWeight: 400, overflowWrap: 'anywhere' },
                    children: model.name,
                    key: 'name',
                  }),
                  jsx('span', {
                    style: { display: 'block', color: C.muted, fontSize: 11, lineHeight: '16px', fontWeight: 400, overflowWrap: 'anywhere' },
                    children: model.providerName || model.provider,
                    key: 'provider',
                  }),
                ],
                key: 'copy',
              }),
              jsx('span', {
                'aria-hidden': true,
                style: { width: 18, flex: '0 0 18px', textAlign: 'center', color: selected ? C.accent : C.muted, fontSize: 18, lineHeight: '18px', fontWeight: 400 },
                children: selected ? '−' : '+',
                key: 'action',
              }),
            ],
          }),
          selected && efforts.length ? jsx('div', {
            style: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 12px 10px 44px' }, // 左缩进 44px 与名字那一列对齐。
            children: efforts.map((level) => {
              const on = (effort || efforts[0].id) === level.id;
              return jsx('button', {
                type: 'button',
                onClick: () => onEffort(level.id),
                'aria-pressed': on,
                'aria-label': T('{name} 的推理等级 {level}', { name: model.name, level: level.name }),
                style: {
                  minHeight: 28, padding: '2px 10px', borderRadius: 999,
                  border: '1px solid ' + (on ? C.accent : C.border),
                  background: 'transparent',
                  color: on ? C.accent : C.muted,
                  font: 'inherit', fontSize: 11, lineHeight: '16px', fontWeight: on ? 650 : 400, // 11/16，与辅助信息同级。
                  cursor: 'pointer', whiteSpace: 'nowrap',
                },
                children: level.name,
                key: level.id,
              });
            }),
            key: 'efforts',
          }) : null,
        ],
      });
    }

    function MultiModelPicker({ ctx, sessionId }) {
      const [members, setMembers] = React.useState(() => loadMembers(sessionId));
      const [catalog, setCatalog] = React.useState([]);
      const [error, setError] = React.useState('');
      const active = members.length >= 2;
      ensurePromptWrap(ctx, sessionId);

      React.useEffect(() => {
        membersBySession.set(sessionId, members);
        try { localStorage.setItem(storageKey(sessionId), JSON.stringify(members)); } catch {}
      }, [sessionId, members]);

      React.useEffect(() => {
        let alive = true;
        setError('');
        loadModelCatalog(ctx).then((models) => {
          if (!alive) return;
          if (!models.length) setError(T('模型目录为空，请先在设置里配置模型。'));
          setCatalog(models);
        }).catch((reason) => {
          if (alive) setError(reason?.message || String(reason));
        });
        return () => { alive = false; };
      }, [ctx]);

      function toggle(model) {
        const key = routeKey(model);
        if (members.some((member) => routeKey(member) === key)) {
          setMembers(members.filter((member) => routeKey(member) !== key));
        } else if (members.length < MAX_MEMBERS) {
          setMembers([...members, model]);
        }
      }

      function setEffort(model, effort) {
        const key = routeKey(model);
        setMembers(members.map((member) => (routeKey(member) === key ? { ...member, reasoningEffort: effort } : member)));
      }

      // 存进 localStorage 的成员只有路由字段，档位要现从目录补回来，否则刷新后等级按钮会消失。
      const memberKeys = new Set(members.map(routeKey));
      const catalogByKey = new Map(catalog.map((model) => [routeKey(model), model]));
      const orderedModels = [
        ...members.map((member) => {
          const base = catalogByKey.get(routeKey(member));
          return base ? { ...base, reasoningEffort: member.reasoningEffort ?? base.reasoningEffort } : member;
        }),
        ...catalog.filter((model) => !memberKeys.has(routeKey(model))),
      ];

      return jsxs('section', {
        role: 'region',
        'aria-label': T('圆桌发言顺序'),
        style: pickerPanelStyle,
        children: [
          jsxs('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 4 }, // 标题与说明只隔 4px，读起来是一个信息组。
            children: [
              jsxs('div', {
                style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }, // 标题和计数至少留 8px，避免长中文挤碰。
                children: [
                  jsx('div', { style: { fontSize: 13, lineHeight: '20px', fontWeight: 650 }, children: T('发言顺序'), key: 'title' }), // 13/20 与成员名同级，符合工具面板的高密度。
                  jsx('div', { style: { color: C.muted, fontSize: 11, lineHeight: '16px', fontWeight: 400 }, children: `${members.length}/${MAX_MEMBERS}`, key: 'count' }), // 11/16 只承载辅助计数。
                ],
                key: 'heading',
              }),
              jsx('div', {
                style: { color: C.muted, fontSize: 11, lineHeight: '16px', fontWeight: 400 }, // 说明保持 11/16，最多两行，不与正文争注意力。
                children: T('点选即加入队尾；移除后重选可调整顺序。'),
                key: 'hint',
              }),
            ],
            key: 'header',
          }),
          error ? jsx('div', {
            style: { color: C.danger, fontSize: 11, lineHeight: '16px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, // 错误也用 11/16，避免异常状态破坏面板密度。
            children: error,
            key: 'error',
          }) : null,
          !members.length ? jsx('div', {
            style: { border: '1px dashed ' + C.border, borderRadius: 10, padding: 12, color: C.muted, fontSize: 11, lineHeight: '16px', textAlign: 'center' }, // 空态用 12px 内边距和 11/16 文案，轻量提示而不另造卡片。
            children: T('还没选人，从下方按发言顺序点选。'),
            key: 'empty',
          }) : null,
          jsx('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 8 }, // 行间距 8px 能看清 1px 边框，又不把列表拉得过长。
            children: orderedModels.length ? orderedModels.map((model) => {
              const selectedIndex = members.findIndex((member) => routeKey(member) === routeKey(model));
              return jsx(ModelRow, {
                model,
                selectedIndex,
                occupied: selectedIndex < 0 && members.length >= MAX_MEMBERS,
                onToggle: () => toggle(model),
                onEffort: (effort) => setEffort(model, effort),
                key: routeKey(model),
              });
            }) : (!error ? jsx('div', {
              style: { padding: '12px 0', color: C.muted, fontSize: 11, lineHeight: '16px', textAlign: 'center' }, // 加载态与空态同尺寸，加载完成时不会突然跳动。
              children: T('正在读取模型…'),
              key: 'loading',
            }) : null),
            key: 'list',
          }),
          jsx('div', {
            style: { paddingTop: 12, borderTop: '1px solid ' + C.border, color: !active && members.length ? C.danger : C.muted, fontSize: 11, lineHeight: '16px', fontWeight: 400 }, // 底部留 12px 并以 11/16 显示结果，规则明确但不抢眼。
            children: active ? T('下次发送将按以上顺序共同回答。') : members.length ? T('再选 1 个模型才会开启圆桌。') : T('至少选 2 个；清空即恢复普通聊天。'),
            key: 'status',
          }),
        ],
      });
    }
    function RoundtableView({ ctx, sessionId }) {
      if (!sessionId) return null;
      return jsxs('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 12, // 页面头部与设置容器相隔 12px，层次仅靠留白和边框。
          width: '100%', maxWidth: 680, margin: '0 auto', boxSizing: 'border-box',
          padding: '16px 16px 24px', // 左右 16px 是 412dp 下的安全阅读边距，底部 24px 留触屏余量。
          color: C.text,
        },
        children: [
          jsxs('header', {
            style: { display: 'flex', flexDirection: 'column', gap: 4 }, // 标题和说明压成一组，避免制造第三层卡片。
            children: [
              jsx('div', { style: { fontSize: 15, lineHeight: '22px', fontWeight: 650 }, children: T('圆桌'), key: 'title' }), // 15/22 只做页面标题，足够明确又不像营销页。
              jsx('div', {
                style: { color: C.muted, fontSize: 11, lineHeight: '16px', fontWeight: 400 }, // 11/16 两行内讲完规则，保留空间给成员列表。
                children: T('同一句话按顺序回答；后一位能看到前一位的原话。'),
                key: 'desc',
              }),
            ],
            key: 'header',
          }),
          jsx(MultiModelPicker, { ctx, sessionId, key: 'picker' }),
        ],
      });
    }
    const NS = 'dsh-plugin-roundtable';
    /** 中文原文即 key：zh 不需要词典（缺词回落成 key 本身），只维护 en。 */
    const en = {
 "移除{name}，当前第 {index} 位发言": "Remove {name}, currently speaking position {index}",
 "添加{name}": "Add {name}",
 "{name} 的推理等级 {level}": "Reasoning tier for {name}: {level}",
 "模型目录为空，请先在设置里配置模型。": "The model catalog is empty; configure models in Settings first.",
 "圆桌发言顺序": "Roundtable speaking order",
 "发言顺序": "Speaking order",
 "点选即加入队尾；移除后重选可调整顺序。": "Tap to append to the end; remove and re-add to reorder.",
 "还没选人，从下方按下方按发言顺序点选。": "Nobody selected yet; pick from below in speaking order.",
 "还没选人，从下方按发言顺序点选。": "Nobody selected yet; pick from below in speaking order.",
 "正在读取模型…": "Loading models…",
 "下次发送将按以上顺序共同回答。": "The next message will be answered by all of them in this order.",
 "再选 1 个模型才会开启圆桌。": "Pick one more model to start the roundtable.",
 "至少选 2 个；清空即恢复普通聊天。": "Pick at least 2; clearing restores normal chat.",
 "圆桌": "Roundtable",
 "同一句话按顺序回答；后一位能看到前一位的原话。": "They answer one after another; each sees the previous answer."
};
    let T = (key, params) => {
      const template = en[key] === undefined ? key : en[key];
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
    };

    function apply(ctx) {
      T = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'roundtable: en');
      ctx.slots.inject('conversation.view', () => ctx.slots.register(
        {
          name: 'conversation.view',
          id: 'roundtable',
          order: 30,
          label: () => T('圆桌'),
          inject: (sessionId) => ({ sessionId }),
        },
        (props) => jsx(RoundtableView, { ...props, ctx }),
      ));
    }

    exports.apply = apply;
    exports.inject = ['slots', 'sessions', 'remote', 'remote.session', 'locale'];
    exports.roundtableInternals = { encodeConfig, ensurePromptWrap, flattenCatalog, loadModelCatalog, membersBySession, pickerPanelStyle, wrappedPromptServices };
    return module.exports;
  },
});
