/**
 * 会话回滚的纯逻辑层。
 *
 * 刻意不碰任何 ctx / 服务：只吃「事件数组」，这样可以直接拿真机上的
 * session.v4.jsonl.zstd 解出来的事件做测试（见 test/core.test.mjs）。
 *
 * @module dsh-plugin-session-rewind/core
 */

/**
 * 是不是「人发的那条」用户消息。
 *
 * ⚠️ user/message 这个类型不只属于人：注入的上下文（agent-instructions）、
 * 压缩检查点（compact-checkpoint）也都用它。只有 source.kind === 'user'
 * 才是用户在输入框里敲的那条 —— 回滚只能以它为锚点，否则会误伤注入内容。
 *
 * @param event - 一条会话事件。
 * @returns true 表示这是用户手发的一条消息。
 */
export function isHumanUserMessage(event) {
  return event?.type === 'user/message' && event?.data?.source?.kind === 'user';
}

/**
 * 按时间顺序列出所有「人发」的用户消息事件。
 * @param events - 完整事件数组（按 seq 升序）。
 * @returns 用户消息事件数组。
 */
export function userMessageEvents(events) {
  return (Array.isArray(events) ? events : []).filter(isHumanUserMessage);
}

/** 取消息文本的第一行，做确认文案里的预览。 */
function previewOf(event, maxLength = 60) {
  const content = event?.data?.content;
  const text = Array.isArray(content)
    ? content.filter((block) => block?.type === 'text').map((block) => block.text).join(' ')
    : '';
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine;
}

/** 取消息时间戳（毫秒），没有就返回 undefined。 */
function timeOf(event) {
  const time = event?.time ?? event?.data?.time;
  return Number.isFinite(time) ? time : undefined;
}

/**
 * 从事件数组里定位「要回滚到它之前」的那条用户消息，并算出 fork 边界。
 *
 * 语义：**回滚到这条之前** = 新会话保留 [0, seq-1]，这条和它之后全部不在新会话里。
 * 之所以不是「只删这一条」：日志里 assistant 的工具调用和工具结果是成对写的，
 * 中间挖洞会让会话结构不合法（详见 README「为什么不是删单条」）。
 *
 * @param events - 完整事件数组（按 seq 升序）。
 * @param spec - 定位方式：`{ordinal}` 倒着数第 N 条（1 = 最后一条），或 `{messageId}` 精确指定。
 * @returns 成功时 `{ok:true, targetSeq, boundary, dropped, preview, time, count}`；
 *   失败时 `{ok:false, reason, text}`（text 可直接给用户看）。
 */
export function resolveRewindTarget(events, spec = {}) {
  const list = Array.isArray(events) ? events : [];
  const users = userMessageEvents(list);
  if (users.length === 0) {
    return { ok: false, reason: 'no-user-message', text: '这个会话里还没有你发过的消息，没什么可回滚的。' };
  }

  let target;
  if (spec.messageId !== undefined && spec.messageId !== null && spec.messageId !== '') {
    const wanted = String(spec.messageId);
    target = users.find((event) => String(event?.data?.id) === wanted);
    if (target === undefined) {
      return { ok: false, reason: 'message-not-found', text: `没找到 messageId=${wanted} 的用户消息。` };
    }
  } else {
    const ordinal = Number.isSafeInteger(spec.ordinal) && spec.ordinal >= 1 ? spec.ordinal : 1;
    if (ordinal > users.length) {
      return {
        ok: false,
        reason: 'ordinal-out-of-range',
        text: `你一共只发过 ${users.length} 条消息，倒数第 ${ordinal} 条不存在。`,
      };
    }
    target = users[users.length - ordinal];
  }

  const targetSeq = Number(target.seq);
  if (!Number.isSafeInteger(targetSeq) || targetSeq < 0) {
    return { ok: false, reason: 'bad-seq', text: `这条消息的 seq 不合法（${String(target.seq)}），不敢回滚。` };
  }
  if (targetSeq === 0) {
    return { ok: false, reason: 'nothing-before', text: '这条消息前面没有任何事件，回滚它会得到一个空会话，已放弃。' };
  }

  return {
    ok: true,
    targetSeq,
    boundary: targetSeq - 1,
    dropped: list.length - targetSeq,
    count: users.length,
    ordinal: users.length - users.indexOf(target),
    preview: previewOf(target),
    time: timeOf(target),
  };
}

/**
 * fork 边界自检：与 session-controller 的 fork 同源判据
 * （`events[boundary]?.seq !== boundary` 就拒绝）。
 * @param events - 完整事件数组。
 * @param boundary - 含头边界 seq。
 * @returns true 表示这个边界在日志里确实存在且连续。
 */
export function boundaryIsValid(events, boundary) {
  const list = Array.isArray(events) ? events : [];
  return Number.isSafeInteger(boundary) && boundary >= 0 && list[boundary]?.seq === boundary;
}

/**
 * 中文确认文案（客户端弹确认框、命令回执都用它，保证口径一致）。
 * @param target - `resolveRewindTarget` 的成功结果。
 * @returns 一句给用户看的话。
 */
export function describeRewindTarget(target) {
  const when = target.time === undefined ? '你' : new Date(target.time).toLocaleString('zh-CN', { hour12: false });
  const preview = target.preview === '' ? '(无文字内容)' : target.preview;
  return `${when} 发的那条「${preview}」及之后 ${target.dropped} 条事件`;
}
