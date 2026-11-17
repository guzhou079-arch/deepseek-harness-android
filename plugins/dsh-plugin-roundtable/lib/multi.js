const PREFIX = /^\s*<!--dsh-roundtable:([A-Za-z0-9_-]+)-->\r?\n?/;
const directRequests = new WeakSet();

export function isDirectModelRequest(request) {
  return directRequests.has(request);
}

export function parseMember(value) {
  if (!value || typeof value !== 'object') return null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!name || !provider || !model || name.length > 80 || provider.length > 200 || model.length > 200) return null;
  return {
    name,
    provider,
    model,
    ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}),
  };
}

export function readRoundtablePrefix(text) {
  if (typeof text !== 'string') return { found: false, text };
  let clean = text;
  let match;
  let members;
  let error;
  while ((match = PREFIX.exec(clean))) {
    clean = clean.slice(match[0].length);
    try {
      const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      if (payload?.v !== 1 || !Array.isArray(payload.members)) throw new Error('invalid payload');
      const current = payload.members.map(parseMember);
      if (current.some((member) => member === null)) throw new Error('invalid member');
      if (members && JSON.stringify(members) !== JSON.stringify(current)) {
        error = '多模型配置重复且不一致，本次已按普通聊天处理。';
      } else {
        members = current;
      }
    } catch {
      error = '多模型配置无法读取，本次已按普通聊天处理。';
    }
  }
  if (!match && clean === text) return { found: false, text };
  return { found: true, text: clean, members: error ? [] : (members || []), ...(error ? { error } : {}) };
}

export function cleanPromptMessages(messages, onConfig) {
  let changed = false;
  const cleaned = messages.map((message) => {
    if (message?.role !== 'user' || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((block) => {
      if (block?.type !== 'text') return block;
      const parsed = readRoundtablePrefix(block.text);
      if (!parsed.found) return block;
      onConfig(parsed);
      messageChanged = true;
      changed = true;
      return { ...block, text: parsed.text };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? cleaned : messages;
}

function errorText(reason) {
  const failure = reason?.failure;
  return failure?.message || reason?.message || '模型调用失败';
}

// 只认「用户亲自发的」那条消息。引擎会在用户消息之后追加 time-context /
// agent-instructions / compact-checkpoint 等同为 user 角色的注入消息，按位置取最后一条
// 用户消息会把它们当成正文 → 成员只会看到时间戳，看不到用户真正说的话。
export function currentUserMessage(messages) {
  if (!Array.isArray(messages)) return undefined;
  let legacy;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const kind = message.source?.kind;
    if (kind === 'user') return message;
    if (kind === undefined && !legacy) legacy = message;
  }
  return legacy;
}

function visibleContent(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const blocks = content.filter((block) => block?.type === 'text' || block?.type === 'image');
  return blocks.length ? blocks : undefined;
}

// 前几位已经发过言的记录。拼进系统提示，让后发言的人真的能看见前面的人说了什么；
// 走系统提示而不是再塞一条 user 消息，避免不同厂商对「多条 user」处理不一致。
// 总预算截断：6 位成员各打满 4096 token 时，第 6 位的系统提示会到两万 token，
// 成本按成员数平方涨，小上下文成员还会直接溢出。超预算的发言保留头部并标注截断。
function meetingTranscript(transcript, budget = 12000) {
  if (!Array.isArray(transcript) || transcript.length === 0) return '';
  let used = 0;
  return transcript.map((entry, index) => {
    const label = `【第 ${index + 1} 位 · ${entry.name}】\n`;
    const room = Math.max(0, budget - used - label.length);
    const body = room < 40
      ? '（篇幅超限，此条略）'
      : entry.text.length > room ? `${entry.text.slice(0, room)}…（截断）` : entry.text;
    used += label.length + body.length;
    return label + body;
  }).join('\n\n');
}

function participantMessages(messages, transcript) {
  const current = currentUserMessage(messages);
  const content = visibleContent(current);
  if (!current || !content) return null;
  const prior = meetingTranscript(transcript);
  const text = prior
    ? '你正在参加一场圆桌会议：与会者轮流回答同一个问题，前面几位已经发过言，他们的原话附在本提示末尾。'
      + '你的任务是接着他们往下说——明确你在哪一点上同意谁、在哪一点上反对谁、他们共同漏掉了什么，'
      + '并给出你自己更硬的判断或更具体的做法。不要复述或改写他们已经说过的内容，不要用「综上所述」收尾。'
      + '只输出给用户看的最终发言，不继承或继续主助手的内部任务，不要调用或模拟工具，'
      + '不要输出 DSML、XML 或其他工具控制协议。\n\n'
      + '以下是前面几位的发言原文：\n\n' + prior
    : '你是这场圆桌会议的第一位发言人。只回答当前这条用户消息，不继承或继续主助手的内部任务。'
      + '不要调用或模拟工具，不要输出 DSML、XML 或其他工具控制协议，只输出给用户看的最终发言。';
  return [
    {
      id: 'roundtable-participant-system',
      role: 'system',
      source: { kind: 'system-prompt' },
      content: [{ type: 'text', text }],
    },
    { ...current, content },
  ];
}

async function* participantStream(ctx, options, member, index, maxTokens, transcript) {
  const messages = participantMessages(options.messages, transcript);
  if (!messages) throw new Error('roundtable: 没有可回答的用户消息');
  const request = {
    ...options,
    provider: member.provider,
    messages,
    model: member.model,
    reasoningEffort: member.reasoningEffort,
    maxTokens,
    tools: undefined,
    toolHistory: { tools: [], updates: [] },
  };
  directRequests.add(request);
  // 多位成员共用一个 assistant 消息，块之间必须留空行，否则第二位的标题会
  // 直接粘在第一位正文末尾，看起来像同一个人说的话。
  const heading = `${index === 0 ? '' : '\n\n'}**${member.name}**\n\n`;
  let text = heading;
  yield { type: 'block-start', index, blockType: 'text' };
  yield { type: 'text-delta', index, text: heading };
  let terminal;
  let failed = false; // 本次不构成有效发言（失败/中断/空），不许被后面的人当成观点引用
  try {
    for await (const chunk of ctx.llm.stream(request)) {
      if (chunk.type === 'text-delta') {
        text += chunk.text;
        yield { type: 'text-delta', index, text: chunk.text };
      } else if (chunk.type === 'finish') {
        terminal = chunk.reason;
      }
    }
    if (terminal?.kind === 'aborted') {
      const error = new Error(errorText(terminal));
      error.name = 'AbortError';
      throw error;
    }
    if (terminal?.kind === 'error') {
      failed = true;
      const notice = text === heading ? `（未能回答：${errorText(terminal)}）` : `\n\n（回答中断：${errorText(terminal)}）`;
      text += notice;
      yield { type: 'text-delta', index, text: notice };
    } else if (text === heading) {
      failed = true;
      text += '（没有返回文字）';
      yield { type: 'text-delta', index, text: '（没有返回文字）' };
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    failed = true;
    const notice = `\n\n（未能回答：${error instanceof Error ? error.message : String(error)}）`;
    text += notice;
    yield { type: 'text-delta', index, text: notice };
  }
  yield { type: 'block-end', index, block: { type: 'text', text, failed } };
}

/** 把标题行（`**名字**`）剥掉，只留正文，避免记录里出现两层名字。 */
function stripHeading(text, name) {
  const marker = `**${name}**`;
  const at = text.indexOf(marker);
  if (at < 0) return text.trim();
  return text.slice(at + marker.length).replace(/^\s+/, '').trim();
}

export function multiModelStream(ctx, options, members, maxTokens = 4096) {
  return (async function* () {
    // 会议记录：每位发完言就落一条，后面的成员在系统提示里能看到全部原文。
    const transcript = [];
    for (let index = 0; index < members.length; index += 1) {
      options.signal?.throwIfAborted();
      const member = members[index];
      let spoken = '';
      let failed = false;
      for await (const chunk of participantStream(ctx, options, member, index, maxTokens, transcript)) {
        if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
          spoken = chunk.block.text;
          failed = chunk.block.failed === true;
        }
        yield chunk;
      }
      transcript.push({
        name: member.name,
        text: failed
          ? '（该成员本次调用失败，没有有效发言，请勿当作观点评价）'
          : stripHeading(spoken, member.name),
      });
    }
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}
