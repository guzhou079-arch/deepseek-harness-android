#!/usr/bin/env node
// 去 AI 味体检 · 报警器（不是门禁）
// 用法：
//   node ai-flavor-check.mjs 稿子.txt                  # 两套指纹都查（默认）
//   node ai-flavor-check.mjs --mode biz 汇报.md         # 只查职场套（黑话/口号/齐平分点）
//   node ai-flavor-check.mjs --mode prose --last-block "/sdcard/authorapp/book/备份/第一章 xxx.txt"
//   cat 稿子.txt | node ai-flavor-check.mjs
//   node ai-flavor-check.mjs --selftest                # 自检：prose / biz 两个样本都必须命中
//   node ai-flavor-check.mjs --gate 稿子.txt           # 命中强指纹时退出码 3（默认只报警，不挡）
//
// 立场：删掉这些词 ≠ 去掉了 AI 味。真正的保证是 SKILL.md 里 S0–S5 / B0–B4 的生成顺序。
//       命不中不代表没问题；样本 <300 字时句长与占比数不可信。

import fs from "node:fs";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const modeIdx = argv.indexOf("--mode");
const MODE = modeIdx >= 0 ? argv[modeIdx + 1] || "both" : "both";
if (!["prose", "biz", "both"].includes(MODE)) {
  console.error(`--mode 只接受 prose|biz|both，收到：${MODE}`);
  process.exit(2);
}
const skipIdx = modeIdx >= 0 ? modeIdx + 1 : -1;
const filePath = argv.filter((a, i) => !a.startsWith("--") && i !== skipIdx)[0];

const SAMPLES = {
  prose: `在这个快节奏的时代，我们总在寻找某种答案。
先说结论：努力值得被看见。他不由得心里一暖，仿佛整个世界都温柔以待。
不是因为没有光，而是因为有人点了灯。
说到底，这才是我们坚持下去的理由，这才是最动人的底色。`,
  biz: `随着业务的快速发展，本季度我们持续赋能一线，打通了从线索到回款的闭环。
一是抓手明确，颗粒度对齐，形成了可复用的方法论。
二是协同高效，拉通各方资源，沉淀了完整的打法矩阵。
三是势能向好，生态位清晰，护城河持续加深。
展望未来，我们将携手共进，再上新台阶，为公司的发展贡献力量。`,
};

// ── 强指纹：命中就该停下来回看原文 ───────────────────────────────
// [标签, 正则, 适用范围]  适用范围 prose=叙事 biz=非虚构 both=两者
const STRONG = [
  ["元话语（中文 LLM 强指纹）", /先说结论|说句实话|不得不说|值得一提的是|需要注意的是|总而言之|说到底|换句话说|简单来说|总结一下|话又说回来/g, "both"],
  ["升华 / 抒情收尾", /比什么都|人间值得|温柔以待|其实挺好|这大概就是|或许这就是|这才是|值得被|何其幸|幸甚至哉|最动人的/g, "prose"],
  ["情绪直给（该换成动作）", /心里一暖|心中一暖|心头一暖|心中一紧|心头一紧|怒火中烧|五味杂陈|百感交集|不禁|忍不住|莫名地|不由得/g, "prose"],
  ["AI 套话", /承载着|见证了|勾勒出|交织着|诠释|赋予|彰显|泛起|时代底色|画卷|在这个[^，。]{0,10}的时代/g, "prose"],
  ["对偶 / 排比拼接", /不是[^。！？，；]{1,14}而是|不仅[^。！？，；]{1,14}还|既[^。！？，；]{1,14}又|一边[^。！？，；]{1,14}一边/g, "prose"],
  // ── 乙篇（非虚构）──
  ["职场黑话（不承载信息）", /赋能|抓手|闭环|打通|拉通|对齐|颗粒度|生态位|全链路|方法论|打法|势能|心智|沉淀|反哺|顶层设计|护城河|组合拳|破局|蓄力|协同/g, "biz"],
  ["口号 / 升华收尾", /未来可期|再上新台阶|迈上新台阶|行稳致远|携手|共同成长|让我们一起|开启新篇章|贡献力量|意义深远|新的征程/g, "biz"],
  // ⚠️ 别写成 /随着[^，。]{0,15}的发展/ —— 中文最常见的写法是「随着业务的**快速**发展」，
  // 中间插了形容词就永远不命中。自检样本专门盯这条（2026-10-16 抓到过这个假阴性）。
  ["铺垫开场（可直接给结论）", /随着[^，。]{1,20}(发展|推进|不断|变化|深入|普及)|在(当今|当前|如今)[^，。]{0,12}(环境|背景|形势|时代|市场)下|近年来|一直以来/g, "biz"],
  ["没有量纲的评价", /显著提升|大幅提升|明显提升|大幅优化|效果良好|成效显著|卓有成效|稳步提升|持续向好|极大/g, "biz"],
  ["空话（说了等于没说）", /保驾护航|提质增效|降本增效|持续发力|精准发力|补短板|强弱项|双向奔赴|奠定了坚实基础|坚实基础|再创佳绩/g, "biz"],
  ["综上所述 / 众所周知", /综上所述|综上|众所周知|不难看出|总的来说|由此可见/g, "biz"],
  // 产品介绍 / 简历 / 汇报里最常见的自我表扬。实测（2026-10-16）：给 28 条技能简介体检时，
  // 词表只抓到 6 处，最后是「句长均值 48.2 字、40/62 句超 40 字」这组客观数把模板腔抓出来的。
  ["卖点堆砌 / 自我表扬", /大师|专家级|专家|极致|高颜值|一键|神器|利器|天花板|领先|深耕/g, "biz"],
];

// ── 软指标：只报数，不下结论（历史文/网文里它们可能是正常写法）────
const SOFT = [
  ["比喻词", /仿佛|宛如|好似|犹如|恍若|像是|似乎/g],
  ["时间副词", /片刻后|不久后|随后|紧接着|与此同时|少顷|须臾|半晌|良久|不多时/g],
  ["转折 / 判断虚词", /其实|毕竟|或许|大概|显然|无疑|的确|终究/g],
];

const JUDGE_HEAD = /^(其实|总之|毕竟|要知道|所谓|可以说|这正是|这就是|毫无疑问|显然|或许|因此|所以|说到底|综上)/;
const BULLET = /^\s*(一是|二是|三是|四是|五是|首先|其次|再次|最后|第[一二三四五六七八九十]+[，、.]|\d+[.、)]|[（(]\d+[）)]|[-•·*])/;
const HEADING = /^\s*(#{1,6}\s|\*\*.+\*\*\s*$)/;

// ── 输入 ──────────────────────────────────────────────────────
function lastBlock(raw) {
  const lines = raw.replace(/\r/g, "").split("\n");
  const hits = [];
  lines.forEach((l, i) => {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s*$/.test(l)) hits.push(i);
  });
  if (!hits.length) return raw;
  const out = [];
  for (let i = hits[hits.length - 1] + 1; i < lines.length; i++) {
    if (/^-{10,}\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

function clean(raw) {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s*$/.test(l))
    .filter((l) => !/^\d+字\s/.test(l.trim()))
    .filter((l) => !/^-{10,}\s*$/.test(l))
    .join("\n");
}

function load() {
  if (filePath) {
    let raw = fs.readFileSync(filePath, "utf8");
    if (flags.has("--last-block")) raw = lastBlock(raw);
    return { text: clean(raw), name: filePath };
  }
  return { text: clean(fs.readFileSync(0, "utf8")), name: "⟨stdin⟩" };
}

// ── 统计 ──────────────────────────────────────────────────────
const len = (s) => s.replace(/[\s　]/g, "").length;
const num = (x) => (Math.round(x * 10) / 10).toString();
const cv = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!m) return 0;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  return (sd / m) * 100;
};
const grams = (s, n = 4) => {
  const t = s.replace(/[\s　，。、；：！？“”（）]/g, "");
  const out = new Set();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
};

function run(text) {
  const paragraphs = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const sentences = text
    .split(/(?<=[。！？!?…])/)
    .map((s) => s.trim())
    .filter((s) => len(s) > 0);
  const lens = sentences.map(len).sort((a, b) => a - b);
  const total = len(text);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const sd = lens.length
    ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length)
    : 0;
  const dialogue = text.match(/“[^”]{1,600}”/g) || [];
  const dialogueChars = dialogue.reduce((a, s) => a + len(s), 0);

  const active = STRONG.filter(([, , m]) => MODE === "both" || m === MODE);
  const strongHits = [];
  for (const [label, re] of active) {
    const found = text.match(re) || [];
    if (found.length) strongHits.push([label, found]);
  }
  const softHits = SOFT.map(([label, re]) => [label, (text.match(re) || []).length]);

  const longSents = [...sentences].sort((a, b) => len(b) - len(a)).slice(0, 3);
  const judgeHead = paragraphs.filter((p) => {
    const first = (p.split(/(?<=[。！？!?…])/)[0] || "").trim();
    return JUDGE_HEAD.test(first);
  });

  // 分点条目的长度齐平度（AI 的第一指纹）：条目越齐，越像机器排版
  const bullets = paragraphs.filter((p) => BULLET.test(p) && len(p) > 3);
  const bulletLens = bullets.map(len);
  const bulletCV = cv(bulletLens);

  // 小标题：md 标题、加粗独行，或短到不像句子的独行
  const headings = paragraphs.filter(
    (p, i) => HEADING.test(p) || (i > 0 && len(p) <= 14 && !/[。！？；]/.test(p) && !BULLET.test(p))
  );

  // 首尾呼应（AI 爱把开头复读一遍）
  let overlap = 0;
  if (paragraphs.length >= 2) {
    const a = grams(paragraphs[0]);
    const b = grams(paragraphs[paragraphs.length - 1]);
    for (const g of a) if (b.has(g)) overlap++;
  }

  const flat = sentences.join("");
  const arabic = (flat.match(/[0-9０-９]/g) || []).length;
  // 中文数字：只能粗略报数（"一/十"会当虚词用），别当结论
  const cnNum = (flat.match(/[一二三四五六七八九十百千万]/g) || []).length;
  const units = (flat.match(/[里骑匹名员封道柄座盏贯缗石斤步寸年月日]/g) || []).length;
  const lastSent = sentences[sentences.length - 1] || "";
  const tailStrong = active
    .filter(([, re]) => (lastSent.match(re) || []).length)
    .map(([l]) => l);

  return {
    total, paragraphs, sentences, lens, mean, sd, dialogue, dialogueChars,
    strongHits, softHits, longSents, judgeHead, lastSent, tailStrong,
    arabic, cnNum, units, bullets, bulletLens, bulletCV, headings, overlap,
  };
}

// ── 输出 ──────────────────────────────────────────────────────
function report(name, r) {
  const L = [];
  L.push(`══ 去 AI 味体检（mode=${MODE}）══ ${name}`);
  L.push(`规模    ${r.total} 字（不含空白）｜${r.paragraphs.length} 段｜${r.sentences.length} 句`);
  if (r.total < 300) L.push("⚠️  样本不到 300 字：句长与占比数不可信，只看强指纹。");
  L.push(
    `句长    均值 ${num(r.mean)}｜标准差 ${num(r.sd)}｜最长 ${r.lens.length ? r.lens[r.lens.length - 1] : 0}` +
      `｜≥40 字长句 ${r.lens.filter((n) => n >= 40).length} 句`
  );
  L.push(
    `对话    ${r.dialogue.length} 处｜占全文字数 ${num((r.dialogueChars / Math.max(r.total, 1)) * 100)}%`
  );
  if (r.bullets.length) {
    const warn = r.bullets.length >= 3 && r.bulletCV < 15 ? "  ⚠️ 疑似齐平（<15%）" : "";
    L.push(
      `分点    ${r.bullets.length} 条｜长度 ${r.bulletLens.join("/")}｜变异系数 ${num(r.bulletCV)}%${warn}`
    );
  }
  if (r.headings.length) L.push(`小标题  ${r.headings.length} 个`);
  L.push("");

  if (r.strongHits.length) {
    L.push("【强指纹 · 报警】命中的逐条回看原文");
    for (const [label, found] of r.strongHits) {
      const uniq = [...new Set(found)];
      L.push(`  ✗ ${label}｜${found.length} 次：${uniq.slice(0, 8).join(" / ")}`);
    }
  } else {
    L.push("【强指纹 · 报警】无命中 —— 注意：这只是没撞上词表，不代表没 AI 味。");
  }
  L.push("");

  L.push("【客观数 · 只报数，不下结论】");
  L.push(`  比喻词 ${r.softHits[0][1]}｜时间副词 ${r.softHits[1][1]}｜判断虚词 ${r.softHits[2][1]}`);
  L.push(`  阿拉伯数字 ${r.arabic}｜中文数字（粗略，"一/十"含虚用）${r.cnNum}｜单位/时间词 ${r.units}`);
  if (r.overlap >= 2) L.push(`  ⚠️ 首尾呼应：末段与首段重合 ${r.overlap} 个四字片段（AI 爱复读开头）`);
  if (r.judgeHead.length) {
    L.push(`  ⚠️ ${r.judgeHead.length} 段的开头是判断/总结句（叙事要求段首落在物件或动作上）：`);
    r.judgeHead.slice(0, 3).forEach((p) => L.push(`     · ${p.slice(0, 44)}`));
  }
  if (r.longSents.length) {
    L.push("  最长三句（AI 长句常出在这里）：");
    r.longSents.forEach((s) => L.push(`     ${len(s)} 字 · ${s.slice(0, 40)}…`));
  }
  if (r.tailStrong.length) {
    L.push(`  ⚠️ 末句疑似升华 / 喊口号：${r.tailStrong.join("、")}`);
    L.push(`     末句：${r.lastSent.slice(0, 60)}`);
  }
  L.push("");
  L.push("结论：脚本只负责别让明显的漏过去。判据是人回头看原文（黑名单证明不了内容正确）。");
  return L.join("\n");
}

// ── 主流程 ────────────────────────────────────────────────────
if (flags.has("--selftest")) {
  let bad = 0;
  for (const [m, s] of Object.entries(SAMPLES)) {
    const rr = run(s);
    console.log(report(`⟨自检样本·${m}⟩`, rr));
    const total = rr.strongHits.reduce((a, [, f]) => a + f.length, 0);
    const cats = rr.strongHits.map(([l]) => l);
    // 回归项：biz 样本必须命中「铺垫开场」——那条正则最容易写成假阴性（见上面注释）
    const regression = m !== "biz" || cats.some((c) => c.startsWith("铺垫开场"));
    const ok = rr.strongHits.length >= 2 && total >= 8 && regression;
    console.log(
      ok
        ? `✅ ${m} 样本命中（${rr.strongHits.length} 类 / ${total} 次）\n`
        : `❌ ${m} 样本漏了（${rr.strongHits.length} 类 / ${total} 次${regression ? "" : "，铺垫开场没命中"}）—— 是脚本坏了，不是稿子干净了\n`
    );
    if (!ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}

const { text, name } = load();
const r = run(text);
console.log(report(name, r));

if (flags.has("--gate") && r.strongHits.length) {
  console.error("\n[gate] 命中强指纹 —— 请先回看原文再决定是否放行。");
  process.exit(3);
}
