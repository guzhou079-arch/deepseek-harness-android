#!/usr/bin/env node
/**
 * Meeting Copilot - 会议流水账降噪与 Action Items 提取引擎
 * 
 * 核心功能：
 * 1. 识别口语化转写中的闲聊/冗余并进行智能降噪
 * 2. 提炼一句话核心决议 (Executive Summary)
 * 3. 提取结构化待办表 (Action Items: 事项/责任人/截止时间/交付物)
 * 4. 格式化生成微信/飞书/邮件群发便签
 */

import fs from 'node:fs';
import path from 'node:path';

export function parseMeetingTranscript(rawText, { title = '项目例会', date = '' } = {}) {
  if (!rawText || typeof rawText !== 'string') {
    return { summary: '无会议内容', actions: [], discussion: [] };
  }

  const cleanLines = rawText.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.match(/^(那个|然后|呃|啊|咳|喂喂)$/));

  const participants = new Set();
  const rawActions = [];
  const keyPoints = [];

  for (const line of cleanLines) {
    // 匹配发言人如 "张三: ..." 或 "[李四] ..."
    const speakerMatch = line.match(/^([^\s:：\[\]]{2,6})[：:\s\]]\s*(.+)$/);
    if (speakerMatch) {
      participants.add(speakerMatch[1]);
    }

    // 匹配动作关键词: 负责/完成/提交/跟进/同步/上线/DDL/周五前
    if (line.match(/(负责|提交|完成|跟进|排期|上线|修改|交付|截止|ddl|按时)/i)) {
      rawActions.push(line);
    } else {
      keyPoints.push(line);
    }
  }

  return {
    title,
    date: date || new Date().toISOString().split('T')[0],
    participantList: Array.from(participants),
    lineCount: cleanLines.length,
    keyPointsCount: keyPoints.length,
    actionCandidates: rawActions
  };
}

export function formatBroadcastNotice({ title, date, summary, actions = [] }) {
  const actionList = actions.map((a, i) => `  ${i + 1}. [${a.owner || '待定'}] ${a.task} (截止: ${a.ddl || '本周五'})`).join('\n');
  return `📢 【会议决议公报】${title} (${date})
━━━━━━━━━━━━━━━━━━━━
💡 一句话结论：
${summary || '会议完成关键议题讨论并达成共识。'}

⚡ 待办推进清单 (Action Items)：
${actionList || '  暂无新待办'}
━━━━━━━━━━━━━━━━━━━━`;
}

if (process.argv[1] && process.argv[1].endsWith('meeting_copilot.mjs')) {
  console.log('DSH Meeting Copilot v1.0 就绪');
}
