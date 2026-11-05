#!/usr/bin/env node
// weekly —— 给 quill 的周报初稿：只收痕迹，不写结论
//
// 为什么要有这个：
//   周报最烦的不是写，是「这周到底干了什么」想不起来。痕迹本来就在盘上
//   （流水、交接、任务板），这一步只是把它们按天摊开，结论留给写的人。
//   参考了 playbooks 的「周报 routine」配方：从痕迹出初稿，每条带来源，人改十分钟就能发。
//
// 用法：
//   node tools/weekly.js                    # 本周，写到 crew/quill/out/weekly-<今天>.md
//   node tools/weekly.js --week 2026-11-02  # 指定周一
//   node tools/weekly.js --out /tmp/x.md --stdout
const fs = require('node:fs');
const path = require('node:path');

const DSH_HOME = process.env.DSH_HOME || '/data/user/0/com.deepseek.harness/files/payload/dshhome';
const MEM_DIR = process.env.DSH_MEM_DIR || '/sdcard/DeepSeekHarness/memory';
const CREW_ROOT = process.env.DSH_CREW_DIR || path.join(DSH_HOME, 'crew');
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function die(msg) { console.error('weekly: ' + msg); process.exit(1); }
// 被 head / less 截断时安静退出，别甩一屏 EPIPE（实测踩过）
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
}
function p2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
function ym(d) { return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`; }
function hhmm(d) { return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }

// 流水一行：- **2026-11-05T01:21:27.186Z** 正文
const LOG_LINE = /^- \*\*(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):\d{2}\.\d+Z\*\*\s*(.+)$/;

function collectLog(from, to) {
  const entries = [];
  const months = new Set();
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) months.add(ym(d));
  for (const m of months) {
    const f = path.join(MEM_DIR, 'log', m + '.md');
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) {
      const hit = line.match(LOG_LINE);
      if (!hit) continue;
      const at = new Date(`${hit[1]}T${hit[2]}:${hit[3]}:00Z`); // 流水存 UTC，按本机时区还原
      if (at < from || at > to) continue;
      entries.push({ at, text: hit[4].trim(), src: `memory/log/${m}.md` });
    }
  }
  return entries.sort((a, b) => a.at - b.at);
}

function collectHandoffs(from, to) {
  const dir = path.join(MEM_DIR, 'handoff');
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const f of names) {
    const hit = f.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})-(.+)\.md$/);
    if (!hit) continue;
    const at = new Date(`${hit[1]}T${hit[2]}:${hit[3]}:${hit[4]}Z`); // 文件名也是 UTC
    if (at < from || at > to) continue;
    out.push({ at, title: hit[5] });
  }
  return out.sort((a, b) => a.at - b.at);
}

function collectBoard() {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(CREW_ROOT, 'board.json'), 'utf8'));
    return (b.tasks || []).filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  } catch (_) { return []; }
}

function buildWeekday(from) {
  const monday = new Date(from);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}

function main() {
  const argv = process.argv.slice(2);
  const weekArg = flag(argv, '--week');
  let monday;
  if (weekArg) {
    const d = new Date(weekArg + 'T00:00:00');
    if (isNaN(d.getTime())) die('--week 要写成 YYYY-MM-DD');
    monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 归到那一周的周一
  } else {
    const now = new Date();
    monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  }
  const { sunday } = buildWeekday(monday);
  const logs = collectLog(monday, sunday).filter((e) => e.at <= new Date());
  const hands = collectHandoffs(monday, sunday).filter((e) => e.at <= new Date());
  const board = collectBoard();

  const byDay = new Map();
  for (const e of logs) {
    const k = ymd(e.at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }

  const lines = [];
  lines.push(`# 周报初稿 ${ymd(monday)} ~ ${ymd(sunday)}`);
  lines.push('');
  lines.push(`生成：${ymd(new Date())} ${hhmm(new Date())} · 流水 ${logs.length} 条 · 交接 ${hands.length} 份 · 未收口 ${board.length} 张`);
  lines.push('');
  lines.push('## 一、按天流水（只收痕迹，结论留给写的人）');
  if (!byDay.size) {
    lines.push('');
    lines.push('（这一周流水是空的）');
  }
  for (const [day, items] of [...byDay.entries()].sort()) {
    const d = new Date(day + 'T00:00:00');
    lines.push('');
    lines.push(`### ${day.slice(5)} 周${WEEKDAYS[d.getDay()]}（${items.length} 条）`);
    for (const e of items) {
      const text = e.text.length > 260 ? e.text.slice(0, 260) + '…' : e.text;
      lines.push(`- ${hhmm(e.at)}  ${text}`);
    }
  }
  lines.push('');
  lines.push(`## 二、本周交接（${hands.length} 份）`);
  if (!hands.length) lines.push('', '（无）');
  for (const h of hands) lines.push(`- ${ymd(h.at)} ${hhmm(h.at)}  ${h.title}`);
  lines.push('');
  lines.push(`## 三、任务板未收口（${board.length} 张）`);
  if (!board.length) lines.push('', '（无）');
  for (const t of board) lines.push(`- ${t.id}  ${t.status}  ${t.owner || '-'}  ${t.title}`);
  lines.push('');
  lines.push('## 四、给写稿人的要求');
  lines.push('');
  lines.push('- 第一行就是结论：这周最值得说的一件事');
  lines.push('- 每条都带来源（文件路径或任务号），不凭印象编');
  lines.push('- 对外版删掉内部过程：不提调试、哈希、我的名字、内部路径');
  lines.push('- 拿不准的标「待核」，数字一个都不要猜');
  lines.push('');

  const body = lines.join('\n');
  if (argv.includes('--stdout')) return process.stdout.write(body); // 只看不落盘
  const outPath = flag(argv, '--out') || path.join(CREW_ROOT, 'quill', 'inbox', `weekly-${ymd(new Date())}.md`); // 初稿是线索，进 inbox；out/ 留给 quill 的定稿
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);
  process.stdout.write(`✓ 周报初稿 ${logs.length} 条流水 → ${outPath}\n`);
}

main();
