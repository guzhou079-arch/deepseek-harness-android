/**
 * dsh-plugin-session-rewind —— 客户端（Web GUI）侧。
 *
 * 干两件事：
 *  1) 在 `conversation.chat.turnTail` 挂一个**不渲染任何东西**的占位组件 ——
 *     它的 `inject(sessionId)` 会拿到当前会话 id，并借此拿到 chat 视图 store
 *     （`ctx.uiConversation.binding(binding).target('chat')`），存进模块级 `current`。
 *  2) 装一个全局长按监听：长按**你发的那条消息** → 弹确认框 → fork 到这条之前 → 切到新会话。
 *
 * 之所以能看到「这条消息在日志里的 seq」：chat 视图节点带 `anchorSeq`（= 该事件的 seq），
 * 而 DOM 上每条消息的外层有 `data-chat-node-key`（= 节点 key），两者一对就得到了 atSeq - 1。
 * 回滚本身走的是官方 fork 通道（和聊天里「分支」按钮同一条），所以模型上下文和界面一起干净。
 *
 * ⚠️ 本文件是**手写**的客户端 bundle（宿主要求 `lib/client.js` 存在且是
 * `window.__ModuleLoader__.load({id, factory})` 形式）。刻意不 require 任何包：
 * 组件返回 null、菜单用原生 DOM 画 —— 少一个依赖就少一处版本漂移。
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-session-rewind',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		/** 服务：槽注册表、会话 store、会话→视图绑定、工作区（切会话）。 */
		const inject = ['slots', 'sessions', 'uiConversation', 'uiWorkspace'];
		/** 长按判定阈值：按住这么久算「长按」。 */
		const HOLD_MS = 550;
		/** 手指/指针移动超过这么多像素就不算长按（用户在滚动列表）。 */
		const MOVE_TOLERANCE = 12;

		/**
		 * 当前会话的视图上下文，由挂在 turnTail 上的占位组件在每次 render 时喂进来。
		 * 形如 `{ sessionId, chat }`；`chat.getSnapshot()` 给 `{ nodes, timeline, ... }`。
		 */
		let current = null;

		/** 从 chat 视图 store 里按 DOM 上的 node key 找出这条消息的事件 seq。 */
		function resolveMessage(key) {
			const snapshot = current?.chat?.getSnapshot?.();
			const node = snapshot?.nodes?.get?.(key);
			if (node === undefined || node === null) return undefined;
			const seq = Number(node.anchorSeq);
			if (!Number.isSafeInteger(seq) || seq < 1) return undefined;
			return { seq, id: node.id, kind: node.kind };
		}

		// ── 原生 DOM 小工具（不引 React，避免依赖漂移） ────────────────────────
		function makeElement(tag, style, text) {
			const node = document.createElement(tag);
			if (style !== undefined) Object.assign(node.style, style);
			if (text !== undefined) node.textContent = text;
			return node;
		}

		/**
		 * 弹一个确认框（原生 DOM + 主题变量），返回用户是否确认。
		 * @param options - 标题、正文、确认按钮文案。
		 * @returns Promise<boolean>。
		 */
		function confirmDialog(options) {
			return new Promise((resolve) => {
				const backdrop = makeElement('div', {
					position: 'fixed', inset: '0', zIndex: '2147483000',
					background: 'rgba(0,0,0,.45)', display: 'flex',
					alignItems: 'center', justifyContent: 'center', padding: '16px',
				});
				const card = makeElement('div', {
					maxWidth: '420px', width: '100%', borderRadius: '16px', padding: '20px',
					background: 'var(--dsw-specific-menu, #22262e)',
					color: 'var(--dsw-alias-label-primary, #e8eaed)',
					boxShadow: '0 12px 40px rgba(0,0,0,.5)', fontSize: '14px', lineHeight: '22px',
				});
				card.appendChild(makeElement('div', { fontSize: '16px', fontWeight: '600', marginBottom: '10px' }, options.title));
				card.appendChild(makeElement('div', { color: 'var(--dsw-alias-label-secondary, #b6bcc6)', whiteSpace: 'pre-wrap' }, options.body));

				const row = makeElement('div', { display: 'flex', gap: '10px', marginTop: '18px', justifyContent: 'flex-end' });
				const cancel = makeElement('button', {
					padding: '8px 16px', borderRadius: '10px', fontSize: '14px', cursor: 'pointer',
					background: 'transparent', color: 'var(--dsw-alias-label-secondary, #b6bcc6)',
					border: '1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.18))',
				}, '取消');
				const confirm = makeElement('button', {
					padding: '8px 16px', borderRadius: '10px', fontSize: '14px', cursor: 'pointer',
					background: 'var(--dsw-alias-button-primary-fill, #4c8dff)', color: '#fff', border: 'none',
				}, options.confirmText ?? '确认回滚');

				const close = (value) => {
					document.removeEventListener('keydown', onKey, true);
					backdrop.remove();
					resolve(value);
				};
				const onKey = (event) => {
					if (event.key === 'Escape') close(false);
				};
				cancel.addEventListener('click', () => close(false));
				confirm.addEventListener('click', () => close(true));
				backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(false); });

				row.appendChild(cancel);
				row.appendChild(confirm);
				card.appendChild(row);
				backdrop.appendChild(card);
				document.body.appendChild(backdrop);
				document.addEventListener('keydown', onKey, true);
				confirm.focus();
			});
		}

		/** 一句轻提示（失败/成功都用它，不引第三方 toast）。 */
		function toast(text) {
			const node = makeElement('div', {
				position: 'fixed', left: '50%', bottom: '88px', transform: 'translateX(-50%)',
				zIndex: '2147483001', maxWidth: '86vw', padding: '10px 14px', borderRadius: '12px',
				background: 'var(--dsw-specific-menu, #22262e)', color: 'var(--dsw-alias-label-primary, #e8eaed)',
				boxShadow: '0 8px 24px rgba(0,0,0,.45)', fontSize: '13px', lineHeight: '20px', whiteSpace: 'pre-wrap',
			}, text);
			document.body.appendChild(node);
			setTimeout(() => node.remove(), 6000);
		}

		/**
		 * 回滚到这条消息之前：确认 → fork → 切到新会话。
		 * @param ctx - 客户端根上下文。
		 * @param key - 被长按那条消息的视图节点 key（= messageId）。
		 */
		async function rollbackBefore(ctx, key) {
			if (current === null) {
				toast('回滚失败：还没识别出当前会话，刷新页面后再试。');
				return;
			}
			const target = resolveMessage(key);
			if (target === undefined) {
				toast('回滚失败：拿不到这条消息在日志里的位置（界面可能还没同步完），刷新页面后再试。');
				return;
			}
			const confirmed = await confirmDialog({
				title: '确认回滚',
				body: [
					'将删除此消息之后的所有消息（含这条），并把会话回滚到此消息之前的状态。',
					'原会话不会被删，会改名为「…（回滚前）」留作备份。',
					'此操作不可撤销，确定继续吗？',
				].join('\n'),
			});
			if (!confirmed) return;
			try {
				const childId = await ctx.sessions.fork({ sessionId: current.sessionId, atSeq: target.seq - 1 });
				ctx.uiWorkspace.openSession(childId);
				toast(`已回滚：这条消息及之后的内容已不在新会话里。\n新会话：${childId}`);
			} catch (error) {
				toast(`回滚失败：${error?.message ?? String(error)}`);
			}
		}

		/**
		 * 装全局长按监听。只有落在「你发的消息」上的长按才会触发菜单。
		 * @param ctx - 客户端根上下文。
		 * @returns 卸载函数。
		 */
		function installLongPress(ctx) {
			const onPointerDown = (event) => {
				if (event.button !== undefined && event.button !== 0) return;
				const target = event.target;
				if (target === null || target === undefined || typeof target.closest !== 'function') return;
				const node = target.closest('[data-chat-flow-kind="user"]');
				if (node === null) return;
				const key = node.getAttribute('data-chat-node-key');
				if (key === null || key === '') return;

				const startX = event.clientX;
				const startY = event.clientY;
				let settled = false;
				const cleanup = () => {
					document.removeEventListener('pointermove', onMove);
					document.removeEventListener('pointerup', onUp);
					document.removeEventListener('pointercancel', onUp);
				};
				const abort = () => { settled = true; clearTimeout(timer); cleanup(); };
				const onMove = (moveEvent) => {
					if (Math.abs(moveEvent.clientX - startX) > MOVE_TOLERANCE || Math.abs(moveEvent.clientY - startY) > MOVE_TOLERANCE) abort();
				};
				const onUp = () => abort();
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					cleanup();
					// 长按往往会顺带选中文字：先清掉选区，免得菜单后面挂着一片高亮。
					try { window.getSelection()?.removeAllRanges?.(); } catch { /* 忽略 */ }
					void rollbackBefore(ctx, key);
				}, HOLD_MS);

				document.addEventListener('pointermove', onMove, { passive: true });
				document.addEventListener('pointerup', onUp);
				document.addEventListener('pointercancel', onUp);
			};
			document.addEventListener('pointerdown', onPointerDown, { passive: true });
			return () => document.removeEventListener('pointerdown', onPointerDown);
		}

		/**
		 * 客户端插件主体。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			// 占位组件：不渲染任何东西，只负责把「当前会话 + chat store」喂进模块级 current。
			ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
				name: 'conversation.chat.turnTail',
				id: 'session-rewind-context',
				order: 90,
				inject: (sessionId) => {
					const binding = ctx.sessions.binding(sessionId);
					if (binding !== undefined) {
						const chat = ctx.uiConversation.binding(binding).target('chat');
						current = { sessionId, chat };
					}
					return {};
				},
			}, () => null));

			ctx.effect(() => installLongPress(ctx), 'session-rewind: long-press listener');
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
