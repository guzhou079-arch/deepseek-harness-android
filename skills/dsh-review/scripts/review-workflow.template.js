/* ============================================================================
 * dsh-review —— 跨厂商会审 workflow 模板
 * ----------------------------------------------------------------------------
 * 怎么用：把本文件整份读出来 → 填掉 3 处 TODO → 作为 `workflow` 工具的 script 提交。
 * 不要直接提交本文件：它带占位符，且 model id 必须用你自己授权清单里的（见
 *   scripts/review-channels.mjs --gate 的输出）。
 *
 * ⚠️ 这不是"能用 node 直接跑"的脚本：它用的是 workflow 工具注入的钩子
 *    （agent / parallel / phase），并且带顶层 await —— `node review-workflow.template.js`
 *    会报 "await is only valid in async functions"。它只能当 workflow 的 script 正文用。
 *
 * 硬规则（别改）：≥2 个不同厂商、同题（所有通道拿完全相同的 prompt）、各自独立上下文、
 *                收尾报账。
 * 成本纪律：按次计费的通道每个请求都收钱 →
 *   · 产物已在本文件里 → prompt 里写死「禁止调用任何工具」；
 *   · 产物太大塞不下 → 由**你**展开后复制进 prompt，别让 agent 自己去 read。
 * ========================================================================== */

const ARTIFACT = `<<<TODO-1: 把要审的产物粘在这里（代码 / 方案 / 文档 / 差异清单 / 结论）>>>`;

const QUESTION = `<<<TODO-2: 这次要回答的具体问题（越具体越有用；例如"这段实现有没有会误导用户的边界情况"）>>>`;

// TODO-3：填你自己授权清单里的模型 id（vendor 用配置里的 provider id）
// ⚠️ 每条通道的 prompt 必须**完全相同**（同题），所以"额外侧面"是**公共常量**，
//    不是每家各问一句 —— 提示一不同，两份答案就不能严格比较，共识/分歧也算不准。
const SIDES = [
  { vendor: 'claude', model: '逆[kiro5-次-0.04￥]claude-opus-5-5' },
  { vendor: 'gpt', model: '逆[codex1-量-0.2x]gpt-5.6-sol' },
  // 第三家（可选）：两家结论相反 / 只有一家提到时最有用
  // { vendor: 'gemini', model: '<gemini id>' },
];

/** 所有通道共用的额外侧面（每家都答这两问，而不是各答一问） */
const EXTRA = [
  '- 反例与边界条件是什么？什么情况下这个结论会不成立？',
  '- 结构性缺陷 / 表述过头 / 可执行性问题在哪？',
].join('\n');

const COMMON = [
  '你是一次**独立技术会审**。只回答下面这份产物的问题，不要客套、不要复述产物。',
  '',
  '## 纪律（违反则本次审查作废）',
  '- 产物已在下面给全，**禁止调用任何工具**（包括 read）—— 按次计费，每个请求都花钱。',
  '- 只报**你能指出具体位置/后果**的问题；没有就明确说"没发现"，**不要凑数**。',
  '- 不知道就写"不确定"，不要编机制。',
  '',
  '## 本次问题',
  QUESTION,
  '',
  '## 额外侧面（每家都要答）',
  EXTRA,
  '',
  '## 输出格式',
  '1) 结论一句话；2) 问题清单（每条：严重度 / 位置 / 为什么是问题 / 建议）；3) 你不确定的地方。',
  '',
  '## 产物',
  '```',
  ARTIFACT,
  '```',
].join('\n');

phase('多厂商独立会审');

const results = await parallel(SIDES.map((s) => async () => {
  const text = await agent(COMMON, {
    provider: s.vendor,
    model: s.model,
    label: `会审·${s.vendor}`,
  });
  return { vendor: s.vendor, model: s.model, text: text || null };
}));

return {
  artifactChars: ARTIFACT.length,
  sides: results.filter(Boolean).map((r) => ({
    vendor: r.vendor,
    model: r.model,
    ok: !!r.text,
    chars: r.text ? r.text.length : 0,
    text: r.text,
  })),
  mergeRule: '两家都提到=高置信采纳；只有一家提到=标注来源待裁决；结论相反=做「能二选一的最小实验」，不许挑顺耳的。',
  reportRule: '收尾必须报：用了哪几条通道 + 各自花费 + 共识/分歧。便宜通道报出问题=强信号，沉默≠通过。',
};
