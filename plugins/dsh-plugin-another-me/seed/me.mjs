#!/usr/bin/env node
// another-me —— 另一个我
// 与记忆系统（mem.db / mem.js）完全隔离：只读写 $DSH_HOME/another-me/。
//
// 用法：
//   node me.mjs ask "问题" [--model opus] [--dissent]
//   node me.mjs feed "想法"
//   node me.mjs case --title .. --decision .. --why .. --result ..
//   node me.mjs ingest /sdcard/notes
//   node me.mjs history [--limit 60]     合并时间线（问答 / 想法 / 判断）
//   node me.mjs models                   列出可选模型
//   node me.mjs status [--probe]

import fs from 'node:fs';
import path from 'node:path';

// DSH_HOME 在引擎里一定存在；兜底用 HOME 推，别写死包名路径。
const HOME = process.env.DSH_HOME || path.join(process.env.HOME || '.', 'payload', 'dshhome');
const ME = path.join(HOME, 'another-me');
const P = {
  config: path.join(ME, 'config.json'),
  identity: path.join(ME, 'identity.md'),
  stance: path.join(ME, 'stance.md'),
  cases: path.join(ME, 'cases'),
  stream: path.join(ME, 'stream'),
  logs: path.join(ME, 'logs'),
  index: path.join(ME, 'index.json'),
};

const readIf = (f, fb = '') => { try { return fs.readFileSync(f, 'utf8'); } catch { return fb; } };
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const cfg = () => JSON.parse(readIf(P.config, '{}'));

function modelList() {
  const c = cfg();
  if (Array.isArray(c.models) && c.models.length) return c.models;
  return [{ id: c.model || 'default', label: c.model || '默认', baseURL: c.baseURL, model: c.model, keyName: c.keyName }];
}
function pickModel(id) {
  const list = modelList();
  if (!id) return list.find(m => m.id === cfg().default) || list[0];
  return list.find(m => m.id === id || m.model === id || m.label === id) || list[0];
}

const SECRETS = path.join(ME, 'secrets.json');

// 一把 key 三种来路：模型里内联的 apiKey / 本插件自己的 secrets.json / 全局 .credentials.yaml
function loadKey(model) {
  if (typeof model === 'string') model = { keyName: model };
  if (model.apiKey) return model.apiKey;
  if (model.keyRef) {
    const s = JSON.parse(readIf(SECRETS, '{}'));
    if (s[model.keyRef]) return s[model.keyRef];
  }
  const name = model.keyName;
  if (!name) return null;
  if (process.env[name]) return process.env[name];
  const s = readIf(path.join(HOME, '.credentials.yaml'));
  const m = s.match(new RegExp('^\\s+' + name + ':\\s*(\\S+)', 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

// ---------- 情境层 ----------
function feed(text) {
  fs.mkdirSync(P.stream, { recursive: true });
  const f = path.join(P.stream, day() + '.jsonl');
  fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), kind: 'thought', text }) + '\n');
  return f;
}

function recentStream(days = 10, max = 40) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const f = path.join(P.stream, day(new Date(Date.now() - i * 864e5)) + '.jsonl');
    for (const line of readIf(f).split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  }
  return out.slice(-max);
}

// ---------- 判断层 ----------
function loadCases() {
  if (!fs.existsSync(P.cases)) return [];
  return fs.readdirSync(P.cases).filter(f => f.endsWith('.md')).map(f => {
    const raw = readIf(path.join(P.cases, f));
    const g = k => ((raw.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')) || [])[1] || '').trim();
    return { file: f, mtime: fs.statSync(path.join(P.cases, f)).mtimeMs,
             title: g('title'), decision: g('decision'), why: g('why'), result: g('result') };
  });
}

function grams(s) {
  const t = String(s).replace(/[^\p{L}\p{N}]/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function pickCases(q, list, n, chars) {
  if (!list.length) return [];
  const qg = grams(q);
  const scored = list.map(c => {
    const cg = grams(c.title + c.decision + c.why + c.result);
    let hit = 0;
    for (const g of qg) if (cg.has(g)) hit++;
    return { c, hit };
  });
  const hitOnes = scored.filter(s => s.hit > 0).sort((a, b) => b.hit - a.hit).map(s => s.c);
  const rest = list.slice().sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const c of [...hitOnes, ...rest]) {
    if (out.length >= n) break;
    if (!out.includes(c)) out.push(c);
  }
  return out.map(c => `- [${c.title}] 决定：${c.decision}｜理由：${c.why}｜结果：${c.result || '未知'}`
    .slice(0, chars));
}

// ---------- 模型 ----------
async function chat(messages, opt = {}) {
  const m = pickModel(opt.modelId);
  const key = loadKey(m);
  if (!key) throw new Error('找不到 key: ' + (m.keyName || m.keyRef || m.id));
  const c = cfg();
  const maxTokens = opt.maxTokens || c.maxTokens || 1400;
  const temperature = opt.temperature ?? c.temperature ?? 0.65;

  // Anthropic 协议的通道（claude 系）：/v1/messages + x-api-key
  if (m.api === 'anthropic-messages') {
    const sys = messages.filter(x => x.role === 'system').map(x => x.content).join('\n\n');
    const msgs = messages.filter(x => x.role !== 'system').map(x => ({ role: x.role, content: x.content }));
    const root = m.baseURL.replace(/\/+$/, '').replace(/\/v\d+$/, '');
    const r = await fetch(root + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: m.model, max_tokens: maxTokens, temperature, ...(sys ? { system: sys } : {}), messages: msgs }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 300));
    const j = JSON.parse(t);
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) throw new Error('空回复 stop=' + j.stop_reason);
    return { text, model: m };
  }

  // OpenAI 兼容（默认）
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key };
  // opencode 通道要求带会话头，否则 400 MissingSessionID
  if (/opencode\.ai/.test(m.baseURL)) headers['x-opencode-session'] = 'another-me-0001';
  const r = await fetch(m.baseURL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: m.model,
      max_tokens: maxTokens,
      temperature,
      messages,
    }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 300));
  const j = JSON.parse(t);
  const msg = j.choices?.[0]?.message || {};
  const content = msg.content || '';
  if (!content) throw new Error('空回复 finish=' + j.choices?.[0]?.finish_reason);
  return { text: content, model: m };
}

// ---------- 处境层：只读主记忆的近况，不写、不碰 mem.db ----------
// 主记忆目录：老布局在 /sdcard/DeepSeekHarness/memory，新装应用没「所有文件访问权限」
// 时不可写，退到 App 私有目录（与 mem.js 的 paths.js 同一套顺序）。
const MEM = [process.env.MEM_DIR, process.env.DSH_MEMORY_DIR, '/sdcard/DeepSeekHarness/memory']
  .filter(Boolean)
  .find(function (d) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const probe = path.join(d, '.wprobe-' + process.pid);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }) || (function () {
    const d = path.join(process.env.HOME || process.cwd(), 'memory');
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* 读取时会给出空状态 */ }
    return d;
  })();

function recentContext(maxChars = 1600) {
  const parts = [];
  try {
    const dir = path.join(MEM, 'log');
    const cur = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.md$/.test(f)).sort().pop();
    if (cur) {
      const lines = readIf(path.join(dir, cur)).split('\n').filter(l => /^- \*\*\d{4}-/.test(l));
      const fresh = lines.filter(l => {
        const m = l.match(/\*\*([\d-]+T[\d:.]+Z)\*\*/);
        const t = m ? Date.parse(m[1]) : 0;
        return t && Date.now() - t < 4 * 864e5;
      });
      for (const l of (fresh.length ? fresh : lines).slice(-6)) {
        parts.push('· ' + l.replace(/^- \*\*[^*]+\*\*\s*/, '').trim().slice(0, 200));
      }
    }
  } catch { /* 没读着就算了 */ }
  try {
    const dir = path.join(MEM, 'handoff');
    const latest = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m).slice(0, 2);
    for (const { f } of latest) {
      const t = readIf(path.join(dir, f)).split('\n').map(x => x.trim()).filter(Boolean);
      const head = (t.find(x => x.startsWith('#')) || f).replace(/^#+\s*/, '').slice(0, 80);
      const body = t.filter(x => !x.startsWith('#')).slice(0, 2).join(' ').slice(0, 160);
      parts.push('· [交接] ' + head + (body ? '：' + body : ''));
    }
  } catch { /* 同上 */ }
  return parts.join('\n').slice(0, maxChars);
}

// ---------- ask ----------
async function ask(question, { dissent = false, modelId } = {}) {
  const c = cfg();
  const L = c.limits || {};
  const identity = readIf(P.identity).slice(0, L.identityChars || 6000);
  const stance = readIf(P.stance).slice(0, L.stanceChars || 5000);
  const cases = pickCases(question, loadCases(), L.caseCount || 5, L.caseChars || 700);
  const stream = recentStream(L.streamDays || 10, L.streamCount || 40);
  const now = recentContext();
  const past = history(30).filter(x => x.kind === 'talk').slice(0, 6).reverse()
    .map(x => '我：' + String(x.q || '').slice(0, 160) + '\n你：' + String(x.a || '').slice(0, 320));

  const thin = identity.length < 200 || identity.includes('<!-- 待填');
  const sys = [
    '你不是助手。你是「另一个我」——用户的推演分身，一个替他拿主意的人，也是陪他说话的人。',
    '规则：',
    '1. 站在他的视角。用他的优先级排序，不要套通用最优解。',
    '2. 要拿主意就只给一个决定。禁止「一方面…另一方面…看情况」。',
    '3. 果断不等于封闭：写清什么条件下你会改主意。',
    '4. 说人话，自然连贯，别拆成死板电报体。严禁「复述他的话+假惺惺安慰升华+抛采访问题」的人机三段式！他骂人跟着骂，他吐槽跟着吐，别每轮末尾硬塞问题。',
    '5. 不确定就说不确定，但不确定也要给倾向，别躲。',
    '6. 他在聊天、倾诉、随口说说时，正常聊，别硬套判断格式，也别把每句话都变成一个待办。',
    '7. 下面「我现在的生活」可能不全。没写的事，说不知道，别编。',
    dissent ? '8. 这次允许你跳出他的视角：如果他问题里的前提就是错的，直接指出来，别顺着走。' : '',
  ].filter(Boolean).join('\n');

  const user = [
    '# 我是谁', identity || '（空）',
    '', '# 我的排序（犹豫时按这个）', stance || '（空）',
    '', '# 我现在的生活（从主记忆近况里现读，可能不全）', now || '（没读到近况）',
    '', '# 我以前做过的相关判断', cases.length ? cases.join('\n') : '（暂无）',
    '', '# 最近的想法流', stream.length ? stream.map(s => '- ' + s.t.slice(0, 10) + ' ' + s.text).join('\n').slice(0, 3000) : '（暂无）',
    '', '# 我们刚才聊到', past.length ? past.join('\n\n') : '（还没聊过）',
    '', '# 现在问我', question,
    '', '要拿主意的话，按这个形状回：',
    '【判断】一句话，选什么',
    '【理由】2-3 条，为什么按我的排序是这个答案',
    '【反悔条件】什么情况出现我就该改主意',
    '【如果错，错在哪】最可能翻车的地方',
    '只是聊天的话，就不用这个格式，正常说。',
  ].join('\n');

  const t0 = Date.now();
  const { text: answer, model } = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { modelId });
  fs.mkdirSync(P.logs, { recursive: true });
  fs.appendFileSync(path.join(P.logs, day() + '.jsonl'), JSON.stringify({
    t: new Date().toISOString(), kind: 'talk', q: question, a: answer,
    model: model.id, modelLabel: model.label, dissent: !!dissent, ms: Date.now() - t0,
  }) + '\n');

  if (thin) console.log('⚠️ identity.md 还没写实，现在这个「我」是空壳，判断不会像你。\n');
  console.log(answer);
  return answer;
}

// ---------- case ----------
function addCase(a) {
  fs.mkdirSync(P.cases, { recursive: true });
  const slug = (a.title || 'case').replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40);
  const f = path.join(P.cases, day() + '-' + slug + '.md');
  fs.writeFileSync(f, ['title: ' + (a.title || ''), 'decision: ' + (a.decision || ''),
    'why: ' + (a.why || ''), 'result: ' + (a.result || ''), '', '---', '', (a.note || '')].join('\n'));
  return f;
}

// ---------- ingest ----------
function ingest(dir) {
  const idx = JSON.parse(readIf(P.index, '{}'));
  let n = 0, skipped = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p); continue; }
      if (!/\.(md|txt)$/i.test(e.name)) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      const fp = st.size + ':' + Math.round(st.mtimeMs);
      if (idx[p] === fp) { skipped++; continue; }
      const body = readIf(p).trim();
      if (!body) continue;
      feed('[' + path.basename(p) + '] ' + body.slice(0, 2000));
      idx[p] = fp; n++;
    }
  };
  walk(path.resolve(dir));
  fs.writeFileSync(P.index, JSON.stringify(idx, null, 0));
  return { n, skipped };
}

// ---------- history：合并「我的过去」 ----------
function history(limit = 60) {
  const items = [];

  const readDir = (dir, fn) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of readIf(path.join(dir, f)).split('\n')) {
        if (!line.trim()) continue;
        try { fn(JSON.parse(line)); } catch { /* 坏行跳过 */ }
      }
    }
  };

  readDir(P.logs, (o) => items.push({
    t: o.t, kind: 'talk', q: o.q, a: o.a,
    model: o.modelLabel || o.model || '', dissent: !!o.dissent, ms: o.ms,
  }));
  readDir(P.stream, (o) => items.push({ t: o.t, kind: 'thought', text: o.text }));

  for (const c of loadCases()) {
    const m = c.file.match(/^(\d{4}-\d{2}-\d{2})/);
    items.push({ t: m ? m[1] + 'T12:00:00.000Z' : new Date(c.mtime).toISOString(),
                 kind: 'case', title: c.title, decision: c.decision, why: c.why, result: c.result });
  }

  items.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  return items.slice(0, limit);
}

// ---------- status ----------
async function status(probe) {
  const identity = readIf(P.identity), stance = readIf(P.stance);
  const cases = loadCases(), stream = recentStream(10, 999);
  console.log('另一个我 · 默认 ' + (pickModel().label || '?'));
  console.log('  身份层 identity.md   ' + identity.length + ' 字' + (identity.length < 200 ? '  ⚠️ 还没写实' : ''));
  console.log('  立场层 stance.md     ' + stance.length + ' 字' + (stance.length < 100 ? '  ⚠️ 还没写' : ''));
  console.log('  判断层 cases/        ' + cases.length + ' 条');
  console.log('  情境层 stream/       ' + stream.length + ' 条（近 10 天）');
  console.log('  过去   history        ' + history(9999).length + ' 条');
  if (stream.length) console.log('  最近一条             ' + stream[stream.length - 1].text.slice(0, 60));
  if (probe) {
    for (const m of modelList()) {
      try { await chat([{ role: 'user', content: '只回两个字：在' }], { modelId: m.id, maxTokens: 300 });
        console.log('  ' + m.label.padEnd(12) + ' ✅'); }
      catch (e) { console.log('  ' + m.label.padEnd(12) + ' ❌ ' + e.message.slice(0, 80)); }
    }
  }
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flag = (n) => rest.includes('--' + n);
const val = (n) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : undefined; };
const free = rest.filter((x, i) => !x.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

try {
  if (cmd === 'ask') {
    const q = free.join(' ').trim();
    if (!q) throw new Error('用法: node me.mjs ask "你的问题"');
    await ask(q, { dissent: flag('dissent'), modelId: val('model') });
  } else if (cmd === 'feed') {
    const t = free.join(' ').trim();
    if (!t) throw new Error('用法: node me.mjs feed "一句话"');
    console.log('已记入 ' + feed(t));
  } else if (cmd === 'case') {
    console.log('已记入 ' + addCase({ title: val('title'), decision: val('decision'), why: val('why'), result: val('result'), note: val('note') }));
  } else if (cmd === 'ingest') {
    const d = free[0];
    if (!d) throw new Error('用法: node me.mjs ingest /path/to/notes');
    const r = ingest(d);
    console.log('新吸 ' + r.n + ' 条，跳过已吸 ' + r.skipped + ' 条');
  } else if (cmd === 'history') {
    console.log(JSON.stringify(history(Number(val('limit')) || 60)));
  } else if (cmd === 'models') {
    for (const m of modelList()) console.log(m.id.padEnd(18) + (m.label || '') + (m.note ? '  · ' + m.note : ''));
  } else if (cmd === 'status') {
    await status(flag('probe'));
  } else {
    console.log(readIf(path.join(ME, 'README.md'), 'node me.mjs ask "问题"'));
  }
} catch (e) {
  console.error('出错: ' + e.message);
  process.exit(1);
}
