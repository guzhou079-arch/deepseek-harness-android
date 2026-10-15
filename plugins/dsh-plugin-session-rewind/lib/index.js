/**
 * dsh-plugin-session-rewind —— Host 侧。
 *
 * 给会话加一个 `/rewind` 命令：把「你发的某条消息」及其之后的一切，从**新会话**里去掉。
 *
 * 为什么是 fork 而不是原地删：DSH 的会话是只追加事件日志，界面的时间线又是按
 * 「追加事件」渲染的（内核注释原文：a landed replacement would erase conversation
 * the user already saw）。所以真正能同时清掉「模型上下文」和「界面气泡」的只有
 * 官方那条 fork 通道 —— 也就是聊天里「分支」按钮走的那条：
 *   ctx.sessionController.fork({ sessionId, atSeq })   // atSeq 是【含头】边界
 * 它会把 [0, atSeq] 原样复制进新会话，并自动重建成可继续用的 agent（含工作区挂载）。
 *
 * 本插件的全部价值 = 把 atSeq 算准（= 目标消息 seq − 1），外加人类可读的回执。
 *
 * @module dsh-plugin-session-rewind
 */
import { randomUUID } from 'node:crypto';
import { boundaryIsValid, describeRewindTarget, resolveRewindTarget } from './core.js';

export const name = 'session-rewind';
/** 只需要命令注册表；sessionQuery / sessionController 在运行时按需取，取不到给明确报错。 */
export const inject = ['commands'];

const USAGE = [
  '用法：',
  '  /rewind        回滚到最后一条**你发的**消息之前',
  '  /rewind 2      回滚到倒数第 2 条你发的消息之前',
  '  /rewind <id>   按 messageId 精确指定（客户端长按菜单用这条）',
].join('\n');

/**
 * 读出某会话的完整事件序列（只保留判定需要的字段，脱离观测租约后仍可用）。
 *
 * 走 `sessionQuery.observeSession()` —— 与 session-controller 的 fork 同一条读路径
 * （`eventAt()` / `snapshotEvents()` 已被内核标记为「新代码禁止调用」）。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 目标会话 id。
 * @returns 轻量事件数组（seq 升序）的 Promise。
 */
async function readSessionEvents(ctx, sessionId) {
  const query = ctx.get('sessionQuery');
  if (query === undefined) throw new Error('这个部署里没有 sessionQuery 服务，读不到会话日志。');
  // ⚠️ observeSession 返回的是 **Promise<租约>**（隔离实例 E2E 实测；假 ctx 给同步对象会把它藏住）。
  const lease = await query.observeSession(sessionId);
  try {
    const events = lease?.events;
    if (!Array.isArray(events)) throw new Error('observeSession 没给出事件数组。');
    // 只抄需要的字段：content 可能内嵌图片附件，整份复制没必要。
    return events.map((event) => ({
      seq: event.seq,
      type: event.type,
      time: event.time,
      data: event.type === 'user/message'
        ? { id: event.data?.id, source: event.data?.source, content: event.data?.content }
        : undefined,
    }));
  } finally {
    // 观测租约是 caller-owned，用完必须释放（释放失败不该影响回滚结论）。
    try {
      lease?.[Symbol.dispose]?.();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 读会话标题。
 *
 * ⛔ 别从 `observeSession().header.title` 读 —— `SessionHeader` 里**没有 title 字段**
 * （只有 version/id/createdAt/cwd/parentSession/isSeeded/...），
 * 标题是 `session/title` 事件经 `sessionTitle` 服务折叠出来的。
 * 我第一版就读错字段，结果「继承标题」静默失效（try/catch 吃掉，看起来像成功）。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 目标会话。
 * @returns 标题字符串，或 undefined。
 */
function readTitle(ctx, sessionId) {
  const session = ctx.get('sessions')?.get?.(sessionId);
  const titles = ctx.get('sessionTitle');
  if (session === undefined || titles === undefined) return undefined;
  try {
    const snapshot = titles.get(session);
    const title = typeof snapshot === 'string' ? snapshot : snapshot?.title;
    return typeof title === 'string' && title.trim() !== '' ? title : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 子会话沿用原标题、父会话标记成「…（回滚前）」。
 *
 * 两个会话同名的话，在左侧列表里根本分不清哪个是脏的那个 —— 所以父会话必须改名。
 *
 * @param ctx - Host 上下文。
 * @param controller - sessionController 服务。
 * @param parentSessionId - 被回滚的会话。
 * @param childSessionId - fork 出来的新会话。
 * @returns 沿用的标题，或 undefined。
 */
async function relabel(ctx, controller, parentSessionId, childSessionId) {
  const title = readTitle(ctx, parentSessionId);
  if (title === undefined) return undefined;
  try {
    await controller.rename({ sessionId: childSessionId, title });
  } catch {
    return undefined; // 连子会话都没改成名，就别再动父会话了
  }
  try {
    await controller.rename({ sessionId: parentSessionId, title: `${title}（回滚前）` });
  } catch {
    /* 父会话改名失败不影响回滚本身 */
  }
  return title;
}

/**
 * 回滚核心：算边界 → fork → 抄标题。
 *
 * 独立导出是为了将来客户端插件能直接复用（长按菜单那条路径）。
 *
 * @param ctx - Host 上下文。
 * @param options - `sessionId` 源会话；`messageId` 或 `ordinal` 指定目标。
 * @returns `{ok:true, childSessionId, target}` 或 `{ok:false, text}`。
 */
export async function rewindSession(ctx, options) {
  const controller = ctx.get('sessionController');
  if (controller === undefined) return { ok: false, text: '这个部署里没有 sessionController 服务，做不了回滚。' };

  let events;
  try {
    events = await readSessionEvents(ctx, options.sessionId);
  } catch (error) {
    return { ok: false, text: `读会话日志失败：${error?.message ?? String(error)}` };
  }

  const target = resolveRewindTarget(events, { messageId: options.messageId, ordinal: options.ordinal });
  if (!target.ok) return { ok: false, text: target.text };
  if (!boundaryIsValid(events, target.boundary)) {
    return { ok: false, text: `边界 seq=${target.boundary} 在日志里对不上（日志可能正在被写入），已放弃回滚。` };
  }

  let child;
  try {
    child = await controller.fork({ sessionId: options.sessionId, atSeq: target.boundary });
  } catch (error) {
    return { ok: false, text: `fork 失败：${error?.message ?? String(error)}` };
  }

  const inherited = await relabel(ctx, controller, options.sessionId, child.sessionId);
  return {
    ok: true,
    childSessionId: child.sessionId,
    target,
    inheritedTitle: inherited,
    text: [
      `已回滚：${describeRewindTarget(target)} —— 已不在新会话里。`,
      `新会话：${child.sessionId}${inherited === undefined ? '' : `（标题沿用「${inherited}」）`}`,
      inherited === undefined
        ? '原会话没有删，左侧列表切回去还能看到（要删你说一声，或者客户端菜单里给个删除项）。'
        : `原会话已改名为「${inherited}（回滚前）」，没有删，切回去还能看到。`,
    ].join('\n'),
  };
}

/**
 * 诊断：把 sessionQuery 实际给出来的东西照实报出来。
 *
 * 存在的理由：`/rewind` 报「没有你发过的消息」而磁盘日志里明明有一百多条时，
 * 光靠猜会把锅甩错地方 —— 先用真仪器看 `observeSession().events` 的形状。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 目标会话。
 * @returns 人类可读的诊断文本。
 */
async function debugReport(ctx, sessionId) {
  const events = await readSessionEvents(ctx, sessionId);
  const types = new Map();
  const sources = new Map();
  for (const event of events) {
    types.set(event.type, (types.get(event.type) ?? 0) + 1);
    const kind = event?.data?.source?.kind ?? '(none)';
    sources.set(kind, (sources.get(kind) ?? 0) + 1);
  }
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([key, value]) => `${key}=${value}`).join(' ');
  const userMessages = events.filter((event) => event.type === 'user/message').slice(-3)
    .map((event) => `seq=${event.seq} id=${String(event.data?.id)} source=${String(event.data?.source?.kind)}`);
  return [
    `会话 ${sessionId}`,
    `事件数=${events.length}`,
    `类型：${top(types, 10)}`,
    `source.kind：${top(sources, 8)}`,
    `最后 3 条 user/message：${userMessages.length === 0 ? '(一条都没有)' : ''}`,
    ...userMessages.map((line) => `  · ${line}`),
  ].join('\n');
}

/**
 * 注册 `/rewind` 命令。
 * @param ctx - Host 上下文。
 */
export function apply(ctx) {
  ctx.commands.register({
    name: 'rewind',
    description: '回滚：删掉这条消息及其之后的一切（从这条之前分叉出干净会话）',
    input: { hint: '[条数|messageId|--debug|--seed N]' },
    recordInput: false,
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput ?? '').trim();
      const sessionId = invocation.agent.session.id;
      if (raw === '--debug') {
        try {
          return { kind: 'success', text: await debugReport(ctx, sessionId) };
        } catch (error) {
          return { kind: 'error', text: `诊断失败：${error?.message ?? String(error)}` };
        }
      }
      // 测试专用：按真实事件形状造几条「真人消息」，好在隔离实例里零模型成本地验回滚。
      if (raw.startsWith('--seed')) {
        const count = Math.max(1, Math.min(10, Number(raw.split(/\s+/)[1] ?? 2) || 2));
        try {
          const made = [];
          for (let index = 1; index <= count; index += 1) {
            const event = invocation.agent.session.append('user/message', {
              role: 'user',
              content: [{ type: 'text', text: `测试消息 ${index}（--seed 造的）` }],
              source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Asia/Shanghai' },
              id: randomUUID(),
            }, { surfaceOp: 'append' });
            made.push(`seq=${event.seq} id=${event.data.id}`);
          }
          return { kind: 'success', text: `已造 ${count} 条真人消息：\n${made.join('\n')}` };
        } catch (error) {
          return { kind: 'error', text: `--seed 失败：${error?.message ?? String(error)}` };
        }
      }
      const spec = /^[0-9]+$/.test(raw)
        ? { ordinal: Number(raw) }
        : raw === ''
          ? { ordinal: 1 }
          : { messageId: raw };
      const result = await rewindSession(ctx, { sessionId, ...spec });
      if (!result.ok) return { kind: 'error', text: `${result.text}\n${USAGE}` };
      return { kind: 'success', text: result.text };
    },
  });
}
