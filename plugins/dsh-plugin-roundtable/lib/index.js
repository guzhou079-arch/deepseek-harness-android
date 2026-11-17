import { cleanPromptMessages, currentUserMessage, isDirectModelRequest, multiModelStream } from './multi.js';

export const name = 'roundtable';
export const inject = ['llm'];

export function apply(ctx, config = {}) {
  const maxTokens = config.maxTokens ?? 4096;
  const maxMembers = config.maxMembers ?? 6;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 256 || maxTokens > 16384) {
    throw new Error('roundtable maxTokens must be an integer from 256 to 16384');
  }
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 2 || maxMembers > 12) {
    throw new Error('roundtable maxMembers must be an integer from 2 to 12');
  }

  const membersBySession = new Map();
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    const sessionId = agent.session.id;
    const cleaned = cleanPromptMessages(decision.messages, ({ members, error }) => {
      if (error || members.length === 0) membersBySession.delete(sessionId);
      else if (members.length <= maxMembers && new Set(members.map((member) => `${member.provider}\0${member.model}`)).size === members.length) {
        membersBySession.set(sessionId, members);
      } else {
        membersBySession.delete(sessionId);
      }
    });
    return cleaned === decision.messages ? decision : { ...decision, messages: cleaned };
  });

  ctx.on('llm/stream', (options, next) => {
    if (isDirectModelRequest(options)) return next();
    const members = membersBySession.get(options.sessionId);
    const history = options.toolHistory;
    if (!members || members.length < 2 || !Array.isArray(history?.tools) || !Array.isArray(history?.updates)) return next();
    // 没有「用户亲自发的」消息可回答时（例如后台任务通知、上下文刷新），
    // 交给主模型处理，避免成员对着时间戳瞎猜。
    if (!currentUserMessage(options.messages)) return next();
    return multiModelStream(ctx, options, members.slice(0, maxMembers), maxTokens);
  }, { global: true });

  ctx.on('session/disposed', (session) => {
    membersBySession.delete(session.id);
  });
}
