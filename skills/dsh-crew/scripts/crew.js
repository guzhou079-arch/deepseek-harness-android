#!/usr/bin/env node
// crew —— 班组成员名册：给每个成员一份岗位卡、一份自己的长期记忆、一份自己的节奏
//
// 为什么要有这个工具：
//   DSH 的 teammate 能同时在线、互相发消息，但它冷下来就忘了自己是谁。
//   grokbot 那套的核心是把「人」落在盘上：一个目录 = 一个同事。
//   这套东西不依赖任何插件，成员和主会话都能读写，跨会话、跨重启都还在。
//
// 存放位置：$DSH_HOME/crew/<名字>/
//   profile.json   名册信息（岗位、模型档、建档时间）
//   role.md        岗位卡（六要素，手写的部分）
//   memory.md      它的长期记忆（追加式，一条一条带日期）
//   routines.md    它自己的节奏（什么时候该动）
//
// 用法速查：crew help
const fs = require('node:fs');
const path = require('node:path');

const DSH_HOME = process.env.DSH_HOME || '/data/user/0/com.deepseek.harness/files/payload/dshhome';
const ROOT = process.env.DSH_CREW_DIR || path.join(DSH_HOME, 'crew');
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const BOARD_FILE = path.join(ROOT, 'board.json');
// 自主阶梯：派活时把档位写进 prompt，别靠默契
const GEARS = {
  investigation: '调查（只回报，什么都不改）',
  draft: '起草（出方案/diff，等人点头）——默认',
  auto: '自动驾驶（实现 + 自验，绿了就交）',
  full: '全自动（计划、实现、验证、交付）——只给一次性可丢弃的活',
};

// 岗位标签：任务和成员用同一套词，板上才能自动配对（pull / pool）
const JOBS = {
  frontend: '前端（界面/样式/交互）',
  backend: '后端（服务/内核/脚本/数据）',
  research: '查资料（外部资料、原文、归档）',
  verify: '验证（按验收标准独立复测）',
  audit: '审计（安全/权限/边界/红线）',
  write: '写作（对外表达、文档、文案）',
  build: '出包（构建/gate/隔离演练）',
  ops: '运维（环境、守护、备份）',
};
function parseJobs(csv, who) {
  const list = String(csv || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const j of list) if (!JOBS[j]) die(`${who}的岗位标签不认识：${j}（可选：${Object.keys(JOBS).join(' / ')}）`);
  return list;
}
function jobLabel(j) { return JOBS[j] ? JOBS[j] : (j || '通用'); }

// 被 head / less 截断时安静退出，别甩一屏 EPIPE
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

function die(msg) { console.error('crew: ' + msg); process.exit(1); }
function out(s) { process.stdout.write(s + '\n'); }
function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function dirOf(name) { return path.join(ROOT, name); }
function fileOf(name, f) { return path.join(dirOf(name), f); }
function exists(name) { return fs.existsSync(dirOf(name)); }
function needName(name) {
  if (!name) die('要给个名字（小写字母开头，只能有 a-z 0-9 _ -）');
  if (!NAME_RE.test(name)) die(`名字不合规：${name}`);
  if (!exists(name)) die(`没这个成员：${name}（先 crew new ${name} --role "..."）`);
  return name;
}
function read(name, f, dflt) {
  try { return fs.readFileSync(fileOf(name, f), 'utf8'); } catch (_) { return dflt; }
}
function profileOf(name) {
  try { return JSON.parse(read(name, 'profile.json', '{}')); } catch (_) { return {}; }
}
function writeProfile(name, p) {
  p.updatedAt = now();
  fs.writeFileSync(fileOf(name, 'profile.json'), JSON.stringify(p, null, 2) + '\n');
}
function members() {
  if (!fs.existsSync(ROOT)) return [];
  return fs.readdirSync(ROOT).filter((n) => NAME_RE.test(n) && fs.existsSync(fileOf(n, 'profile.json'))).sort();
}

// —— 记忆块解析：memory.md 以 "## 日期 · 类型 · tags:x" 分隔 ——————————
function blocks(text) {
  if (!text) return [];
  const raw = text.split(/^## /m).filter((s) => s.trim());
  // 文件头那一段（"# 名字 的记忆"）不是记忆，别让它混进检索
  return raw.filter((s) => !s.startsWith('# ')).map((s) => {
    const nl = s.indexOf('\n');
    const head = nl < 0 ? s.trim() : s.slice(0, nl).trim();
    const body = nl < 0 ? '' : s.slice(nl + 1).trim();
    return { head, body };
  });
}
function recentBlocks(name, n) {
  const all = blocks(read(name, 'memory.md', ''));
  return all.slice(Math.max(0, all.length - n));
}
function fmtTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 成员交在 out/ 里的产出，新→旧；brief 用它回答「上次干到哪」
function outFiles(name, limit) {
  const d = path.join(dirOf(name), 'out');
  let names;
  try { names = fs.readdirSync(d); } catch (_) { return []; }
  return names.filter((f) => !f.startsWith('.')).map((f) => {
    const p = path.join(d, f);
    let st;
    let first = '';
    try { st = fs.statSync(p); } catch (_) { return null; }
    try { first = fs.readFileSync(p, 'utf8').split('\n').find((l) => l.trim()) || ''; } catch (_) {}
    return { f, mtime: st.mtime, size: st.size, first: first.trim().slice(0, 80) };
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}
function ensureDirs(name) {
  fs.mkdirSync(path.join(dirOf(name), 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(dirOf(name), 'out'), { recursive: true });
}

// —— 盘上任务板：成员冷着、跨重启也能接的活，不用等人转述 ————————
// 为什么不用运行时任务板：teammate 下线就查不到了；这张板子是文件，谁都能读。
function loadBoard() {
  if (!fs.existsSync(BOARD_FILE)) return { seq: 0, tasks: [] };
  const raw = fs.readFileSync(BOARD_FILE, 'utf8');
  let b;
  try {
    b = JSON.parse(raw);
  } catch (e) {
    // 板子坏了就当空板，下一次写会把它整份盖掉——这是永久丢数据，必须停下
    const bad = BOARD_FILE + '.bad-' + Date.now();
    try { fs.copyFileSync(BOARD_FILE, bad); } catch (_) {}
    die(`board.json 解析不了（已另存 ${path.basename(bad)}）：${e.message}\n先看一眼修好，别让它被覆盖`);
  }
  if (!b || typeof b !== 'object' || !Array.isArray(b.tasks)) {
    die('board.json 格式不对（没有 tasks 数组）。已停下，不会覆盖它；先手工看一眼');
  }
  return { seq: Number(b.seq) || 0, tasks: b.tasks };
}
function saveBoard(b) {
  fs.mkdirSync(ROOT, { recursive: true });
  // 随机名 + wx：两个进程同时写不会互相踩，也不会跟着别人布好的 symlink 写到外面
  const tmp = `${BOARD_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeSync(fd, JSON.stringify(b, null, 2) + '\n'); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, BOARD_FILE); // 先写临时文件再改名，断电不会留半张板子
}
// 板子是唯一真相，两个成员同时认领时必须串行，否则后写的会盖掉先写的（丢更新）
const LOCK_FILE = BOARD_FILE + '.lock';
let heldLock = null;
// die() 走 process.exit 会跳过 finally，这里兜底清锁（只清自己持有的）
process.on('exit', () => { if (heldLock) { try { fs.unlinkSync(heldLock); } catch (_) {} } });
function withBoardLock(fn) {
  fs.mkdirSync(ROOT, { recursive: true });
  const start = Date.now();
  let fd = -1;
  while (fd < 0) {
    try { fd = fs.openSync(LOCK_FILE, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try { stale = Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 5000; } catch (_) { continue; }
      if (stale || Date.now() - start > 4000) { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} continue; }
      const t = Date.now(); while (Date.now() - t < 25); // 忙等 25ms 再抢
    }
  }
  heldLock = LOCK_FILE;
  try { return fn(); } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
    heldLock = null;
  }
}
function findTask(b, id) {
  const t = id ? b.tasks.find((x) => x.id === id) : null;
  if (!t) die(`任务板上没有 ${id || '(没给 id)'}`);
  return t;
}
function oneLine(x, n) {
  // 任何要写进记忆/prompt 的外部文本，先压成一行、去掉行首 #，否则能伪造「## 日期 · lesson」块
  return String(x == null ? '' : x).replace(/\r\n|\r|\n/g, ' ⏎ ').replace(/^#+\s*/, '').slice(0, n || 200);
}
function afterTask(t, name) {
  // 认领时顺手把活记进它自己的记忆，冷启动的 brief 也能看到
  if (!name) return;
  try {
    const head = `## ${now()} · task · tags:board`;
    fs.appendFileSync(fileOf(name, 'memory.md'), `${head}\n认领 ${t.id}「${oneLine(t.title)}」\n\n`);
    const p = profileOf(name); p.lastMemoryAt = now(); writeProfile(name, p);
  } catch (_) {}
}

// —— 命令：new ——————————————————————————————————————————————
function cmdNew(argv) {
  const name = argv[0];
  if (!name) die('crew new <名字> --role "一句话职责" [--model <档>]');
  if (!NAME_RE.test(name)) die(`名字不合规：${name}`);
  if (exists(name)) die(`已经有了：${name}`);
  const role = flag(argv, '--role') || '';
  const model = flag(argv, '--model') || 'ds';
  const tags = parseJobs(flag(argv, '--tags'), name);
  fs.mkdirSync(dirOf(name), { recursive: true });
  fs.mkdirSync(path.join(dirOf(name), 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(dirOf(name), 'out'), { recursive: true });
  writeProfile(name, { name, role, model, tags, createdAt: now(), status: 'idle' });
  const card = `# ${name} · 岗位卡

> 六要素。填的越具体，它越不会跑偏。空白的地方它就会自己发挥。

## 一、它管什么（只管这一件）
${role || '（待补：一句话说清它的独家职责）'}

## 二、它能碰什么
- 工具：
- 数据源：
- 不能碰：

## 三、怎么算干好（不是干什么，是怎么干）
- 

## 四、什么要你签字
- 

## 五、真相在哪个文件
- 

## 六、什么时候该动
- 
`;
  fs.writeFileSync(fileOf(name, 'role.md'), card);
  fs.writeFileSync(fileOf(name, 'memory.md'), `# ${name} 的记忆\n\n`);
  fs.writeFileSync(fileOf(name, 'routines.md'), `# ${name} 的节奏\n\n`);
  out(`建好了 ${name}（模型档 ${model}${tags.length ? ' · 能接：' + tags.map(jobLabel).join(' / ') : ' · 没挂岗位标签'}）`);
  out(`岗位卡：${fileOf(name, 'role.md')}`);
  out(`交接：${dirOf(name)}/inbox（线索）、${dirOf(name)}/out（产出）`);
  out('下一步：把岗位卡填了，再 crew brief ' + name + ' 看它会拿到什么');
}

// —— 命令：list / show / status ——————————————————————————————
function cmdList() {
  const ms = members();
  if (!ms.length) return out('名册还是空的。crew new <名字> --role "..."');
  out('名字\t模型档\t状态\t岗位');
  for (const n of ms) {
    const p = profileOf(n);
    const mem = blocks(read(n, 'memory.md', '')).length;
    out(`${n}\t${p.model || '-'}\t${p.status || '-'}\t${(p.role || '-').slice(0, 40)}  [记忆 ${mem} 条]`);
  }
}
function cmdShow(name) {
  needName(name);
  const p = profileOf(name);
  out(read(name, 'role.md', '(没有岗位卡)'));
  const mem = recentBlocks(name, 8);
  out('\n—— 最近记忆 ——');
  if (!mem.length) out('（空）');
  for (const b of mem) out(`· ${b.head}\n  ${b.body.split('\n').join('\n  ')}`);
  const rt = read(name, 'routines.md', '').split('\n').filter((l) => l.trim().startsWith('-'));
  out('\n—— 节奏 ——');
  out(rt.length ? rt.join('\n') : '（没设）');
  out(`\n档案：${dirOf(name)}`);
}
function cmdStatus() {
  const ms = members();
  out(`名册目录：${ROOT}`);
  out(`成员 ${ms.length} 个`);
  for (const n of ms) {
    const p = profileOf(n);
    const mem = blocks(read(n, 'memory.md', '')).length;
    const rt = read(n, 'routines.md', '').split('\n').filter((l) => l.trim().startsWith('-')).length;
    const outs = outFiles(n, 999).length;
    out(`  ${n}（${p.model || '?'}）记忆 ${mem} · 产出 ${outs} · 节奏 ${rt} · 岗位：${(p.role || '未填').slice(0, 30)}`);
  }
}

// —— 命令：remember / recall / forget ————————————————————————
function cmdRemember(argv) {
  const name = needName(argv[0]);
  const kind = flag(argv, '--kind') || 'note';
  const tags = flag(argv, '--tags') || '';
  let text = stripFlags(argv).slice(1).join(' ').trim();
  if (!text) {
    // 允许从 stdin 灌（长内容走管道，别在命令行里拼引号）
    try { text = fs.readFileSync(0, 'utf8').trim(); } catch (_) { text = ''; }
  }
  if (!text) die('要记点什么：crew remember <名字> "内容"（或从 stdin 灌）');
  const head = `## ${now()} · ${kind}${tags ? ' · tags:' + tags : ''}`;
  fs.appendFileSync(fileOf(name, 'memory.md'), `${head}\n${text}\n\n`);
  const p = profileOf(name); p.lastMemoryAt = now(); writeProfile(name, p);
  out(`记住了 → ${name}（${kind}，${text.length} 字）`);
}
function cmdRecall(argv) {
  const name = needName(argv[0]);
  const q = stripFlags(argv).slice(1).join(' ').trim();
  const all = blocks(read(name, 'memory.md', ''));
  if (!all.length) return out(`${name} 还没有记忆`);
  let hits = all;
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    hits = all.filter((b) => terms.some((t) => (b.head + '\n' + b.body).includes(t)));
  }
  out(`—— ${name} 的记忆${q ? '（匹配 ' + q + '）' : '（全部）'}：${hits.length} 条 ——`);
  for (const b of hits.slice(-30)) out(`· ${b.head}\n  ${b.body.split('\n').join('\n  ')}`);
}
function cmdForget(argv) {
  const name = needName(argv[0]);
  const n = Number(flag(argv, '--last') || 1);
  if (!Number.isInteger(n) || n < 1) die(`--last 要给正整数，拿到的是 ${flag(argv, '--last')}`);
  const all = blocks(read(name, 'memory.md', ''));
  if (!all.length) return out('没有可删的');
  const kept = all.slice(0, Math.max(0, all.length - n));
  const text = `# ${name} 的记忆\n\n` + kept.map((b) => `## ${b.head}\n${b.body}\n\n`).join('');
  fs.writeFileSync(fileOf(name, 'memory.md'), text);
  out(`删掉了最后 ${all.length - kept.length} 条，剩 ${kept.length} 条`);
}

// —— 命令：routine ——————————————————————————————————————————
function cmdRoutine(argv) {
  const name = needName(argv[0]);
  const add = flag(argv, '--add');
  const rm = flag(argv, '--rm');
  const file = fileOf(name, 'routines.md');
  let lines = read(name, 'routines.md', `# ${name} 的节奏\n\n`).split('\n');
  if (add) {
    lines.push(`- [${add.split('|')[0].trim()}] ${add.split('|').slice(1).join('|').trim() || add}`);
    fs.writeFileSync(file, lines.join('\n').replace(/\n+$/, '\n'));
    return out(`加了一条节奏：${add}`);
  }
  if (rm) {
    const idx = Number(rm) - 1;
    const items = lines.map((l, i) => ({ l, i })).filter((o) => o.l.trim().startsWith('-'));
    if (!items[idx]) die('没有这一条');
    lines.splice(items[idx].i, 1);
    fs.writeFileSync(file, lines.join('\n'));
    return out('删掉了');
  }
  const rt = lines.filter((l) => l.trim().startsWith('-'));
  if (!rt.length) return out(`${name} 还没设节奏。加一条：crew routine ${name} --add "每天 09:00|读一遍昨天的 out/ 并汇报"`);
  out(`—— ${name} 的节奏 ——`);
  rt.forEach((l, i) => out(`${i + 1}. ${l.replace(/^-\s*/, '')}`));
}

// —— 命令：brief —— 生成派活时用的 prompt ————————————————————
// 拆成两半：buildBrief 出文本，cmdBrief 只负责打印；pull 也复用它。
function buildBrief(name, opts) {
  opts = opts || {};
  ensureDirs(name);
  const maxChars = Number(opts.max || 6000);
  if (!Number.isFinite(maxChars) || maxChars < 200) die(`--max 要给个数字（至少 200），拿到的是 ${opts.max}`);
  const task = String(opts.task || '').replace(/^##/gm, '\\##');
  const accept = String(opts.accept || '').replace(/^##/gm, '\\##');
  const taskId = opts.taskId || '';
  if (taskId && !/^t\d+$/.test(taskId)) die(`任务 id 长这样：t001（拿到的是 ${taskId}）`);
  const gear = opts.gear || '';
  const p = profileOf(name);
  const card = read(name, 'role.md', '(没有岗位卡)').trim();
  const mem = recentBlocks(name, 30);
  const L = [];
  const say = (x) => L.push(x === undefined ? '' : x);
  let memText = '';
  for (let i = mem.length - 1; i >= 0; i--) {
    const chunk = `· ${mem[i].head}\n  ${mem[i].body}\n`;
    if (memText.length + chunk.length > maxChars) break;
    memText = chunk + memText;
  }
  const rt = read(name, 'routines.md', '').split('\n').filter((l) => l.trim().startsWith('-')).join('\n');
  const outs = outFiles(name, 5);

  say(`你是 ${name}，一个带名字的同事，不是通用助手。你的职责是「${p.role || '见岗位卡'}」。`);
  say();
  say('## 你的岗位卡');
  say(card);
  say();
  say('## 你还记得的事（越靠后越近）');
  say(memText.trim() || '（还没有记忆，这是你第一次上手）');
  if (outs.length) {
    say();
    say('## 你上次留下的产出（最近 5 份，在 out/ 里）');
    for (const o of outs) say(`· ${fmtTime(o.mtime)}  out/${o.f}  (${o.size}B)${o.first ? '\n  ' + o.first : ''}`);
  }
  if (rt) { say(); say('## 你的节奏'); say(rt); }
  say();
  say('## 这次的活');
  say(task || '（没说，先读岗位卡和真相文件，再问清楚要做什么）');
  if (gear) {
    say();
    say('## 这趟的档位：' + (GEARS[gear] || gear));
    if (gear === 'investigation') say('只查、只回报，什么都别改。查完把结论发回来。');
    else if (gear === 'draft') say('出方案或 diff，等人点头再动手。别自己合。');
    else if (gear === 'auto') say('自己实现、自己验，绿了再交；验证方法和输出写进报告。');
    else if (gear === 'full') say('计划、实现、验证一条龙。产物要能被丢弃，别碰不可逆的东西。');
  }
  if (accept) {
    say();
    say('## 怎么算完（验收标准，逐条对上）');
    say(accept);
  }
  say();
  say('## 交接位置与规矩');
  say(`- 你的档案：${dirOf(name)}`);
  say(`- 线索放 inbox/：${dirOf(name)}/inbox`);
  say(`- 产出写 out/：${dirOf(name)}/out/<任务名>.md（第一行写结论）`);
  if (Array.isArray(p.tags) && p.tags.length) say(`- 你的岗位标签：${p.tags.join(' / ')} —— 板上只领这几类活，别抢别人的`);
  if (taskId) {
    if (opts.preClaimed) say(`- 任务板：这趟的卡 ${taskId} 已经替你认领了；写完 out/ 收口（node ${path.join(__dirname, 'crew.js')} task done ${taskId} --out <路径>）`);
    else say(`- 任务板：先认领（node ${path.join(__dirname, 'crew.js')} task claim ${taskId} ${name}）；写完 out/ 再收口（task done ${taskId} --out <路径>）`);
  }
  say('- 这一轮把活干完再停：读材料 → 写 out/ → 收口 → 再 pull 下一张；不要只认领就结束');
  say(`- 收口后还能接活就再领：node ${path.join(__dirname, 'crew.js')} pull ${name}；没活就停，别硬找`);
  say('- 报告只写三样：结论 / 证据（文件路径行号或命令输出）/ 没做完的部分');
  say('- 你自己的记忆自己写：结论定了就跑 `node ' + path.join(__dirname, 'crew.js') + ' remember ' + name + ' "..."`');
  say('- 拿不准要不要动手，先问；别猜，也别自己加戏');
  say('- 你的同胞在别的会话里，要说话走团队消息，别假设它们看得见你的上下文');
  return L.join('\n');
}
function cmdBrief(argv) {
  const name = needName(argv[0]);
  let task = flag(argv, '--task') || '';
  const tf = flag(argv, '--task-file');
  if (tf) { try { task = fs.readFileSync(tf, 'utf8').trim(); } catch (_) { die('读不到 ' + tf); } }
  const gear = flag(argv, '--gear') || '';
  if (gear && !GEARS[gear]) die(`档位只有：${Object.keys(GEARS).join(' / ')}`);
  out(buildBrief(name, {
    task,
    accept: flag(argv, '--accept') || '',
    taskId: flag(argv, '--task-id') || '',
    gear,
    max: flag(argv, '--max') || '6000',
  }));
}

// —— 命令：task —— 盘上任务板 ———————————————————————————
function cmdTask(argv) { return withBoardLock(() => cmdTaskInner(argv)); }
function cmdTaskInner(argv) {
  const sub = argv[0] || 'list';
  const b = loadBoard();

  if (sub === 'add') {
    const title = oneLine(stripFlags(argv).slice(1).join(' ').trim(), 160);
    if (!title) die('crew task add "标题" [--gear draft] [--accept "验收标准"] [--owner 名字]');
    const gear = flag(argv, '--gear') || 'draft';
    if (!GEARS[gear]) die(`档位只有：${Object.keys(GEARS).join(' / ')}`);
    const owner = flag(argv, '--owner') || '';
    if (owner) needName(owner);
    const role = flag(argv, '--role') || '';
    if (role && !JOBS[role]) die(`岗位只有：${Object.keys(JOBS).join(' / ')}`);
    b.seq += 1;
    const id = 't' + String(b.seq).padStart(3, '0');
    const t = {
      id, title, gear, role,
      accept: flag(argv, '--accept') || '',
      owner: owner || '',
      status: owner ? 'doing' : 'open',
      out: '', note: '',
      created: now(), updated: now(),
    };
    b.tasks.push(t);
    saveBoard(b);
    out(`开了一张：${id}  ${title}`);
    out(`档位：${GEARS[gear]}${role ? ' · 岗位：' + jobLabel(role) : ' · 岗位：通用'}${owner ? ' · 负责人：' + owner : ' · 还没人认领'}`);
    if (t.accept) out(`验收：${t.accept}`);
    out(`派活：crew brief ${owner || '<成员>'} --task-id ${id} --task "具体要它做什么"`);
    return;
  }

  if (sub === 'list') {
    const st = flag(argv, '--status');
    const rows = b.tasks.filter((t) => !st || t.status === st);
    if (!rows.length) return out(b.tasks.length ? `没有 ${st} 状态的任务` : '任务板是空的。开一张：crew task add "标题"');
    out('id\t状态\t档位\t岗位\t负责人\t标题');
    for (const t of rows) out(`${t.id}\t${t.status}\t${t.gear}\t${t.role || '通用'}\t${t.owner || '-'}\t${t.title}`);
    const open = b.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length;
    out(`\n共 ${b.tasks.length} 张，未收口 ${open} 张`);
    return;
  }

  if (sub === 'show') {
    const t = findTask(b, argv[1]);
    out(`# ${t.id}  ${t.title}`);
    out(`状态：${t.status} · 档位：${GEARS[t.gear] || t.gear} · 岗位：${jobLabel(t.role)} · 负责人：${t.owner || '未认领'}`);
    if (t.accept) out(`验收：${t.accept}`);
    if (t.out) out(`产出：${t.out}`);
    if (t.note) out(`备注：${t.note}`);
    out(`建 ${t.created} · 改 ${t.updated}`);
    return;
  }

  if (sub === 'claim') {
    const t = findTask(b, argv[1]);
    const who = needName(argv[2]);
    if (t.status === 'done' || t.status === 'cancelled') die(`${t.id} 已经${t.status === 'done' ? '收口' : '作废'}了`);
    if (t.owner && t.owner !== who) die(`${t.id} 已经在 ${t.owner} 手上，别抢`);
    t.owner = who;
    t.status = 'doing';
    t.updated = now();
    saveBoard(b);
    afterTask(t, who);
    out(`${who} 认领了 ${t.id} ${t.title}`);
    return;
  }

  if (sub === 'done') {
    const t = findTask(b, argv[1]);
    t.status = 'done';
    t.out = flag(argv, '--out') || t.out;
    t.note = flag(argv, '--note') || t.note;
    t.updated = now();
    saveBoard(b);
    out(`${t.id} 收口${t.out ? '：' + t.out : '（没写产出路径）'}`);
    return;
  }

  if (sub === 'drop') {
    const t = findTask(b, argv[1]);
    t.status = 'cancelled';
    t.updated = now();
    saveBoard(b);
    out(`${t.id} 作废`);
    return;
  }

  die('crew task add|list|show|claim|done|drop');
}

// —— 命令：due —— 把 routine 变成今天挂在板上的活 ————————————
// 节奏写在 routines.md 里只是文本；due 负责把它翻成任务卡，冷成员回来一眼看到该干什么。
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function routineItems(name) {
  const lines = read(name, 'routines.md', '').split('\n');
  const items = [];
  for (const line of lines) {
    const m = line.match(/^-\s*\[(每天|每周([日一二三四五六]))\s+([0-2]\d:[0-5]\d)\]\s*(.+)$/);
    if (m) items.push({ every: m[1] === '每天', weekday: m[2] || '', time: m[3], desc: m[4].trim() });
  }
  return items;
}
function cmdDue(argv) { return withBoardLock(() => cmdDueInner(argv)); }
function cmdDueInner(argv) {
  const dateStr = flag(argv, '--date') || ymd(new Date());
  const today = new Date(dateStr + 'T00:00:00');
  if (isNaN(today.getTime())) die('日期要写成 YYYY-MM-DD');
  const b = loadBoard();
  const opened = [];
  for (const name of members()) {
    for (const it of routineItems(name)) {
      if (!it.every && WEEKDAYS[today.getDay()] !== it.weekday) continue;
      const title = `${name} · routine：${it.desc}`;
      const already = b.tasks.some((t) => t.title === title && (t.created || '').slice(0, 10) === dateStr);
      if (already) continue;
      b.seq += 1;
      const id = 't' + String(b.seq).padStart(3, '0');
      b.tasks.push({
        id, title, gear: 'draft',
        accept: `按 ${name}/routines.md 执行；没有新内容就写「无更新 ${dateStr}」并收口`,
        owner: '', status: 'open', out: '', note: `routine ${it.time}`,
        created: now(), updated: now(),
      });
      opened.push({ id, name, time: it.time, desc: it.desc });
    }
  }
  if (opened.length) saveBoard(b);
  out(`—— ${dateStr}（周${WEEKDAYS[today.getDay()]}）该动：${opened.length} 条 ——`);
  if (!opened.length) {
    out('名册里今天没有排到节奏，也没有新开的卡。');
    return;
  }
  for (const o of opened) out(`  ${o.id}  ${o.name}  ${o.time}  ${o.desc}`);
  out('');
  out('派活：crew brief <名字> --task "..." --gear draft --task-id <id>');
  out('收口：crew task done <id> --out <产出路径>');
}

// —— 命令：hand / inbox —— 文件交接，不靠对聊 ————————————
function slug(s) {
  return (s || 'note').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'note';
}
function cmdHand(argv) {
  const name = needName(argv[0]);
  const from = flag(argv, '--from') || 'lead';
  let text = stripFlags(argv).slice(1).join(' ').trim();
  if (!text) {
    try { text = fs.readFileSync(0, 'utf8').trim(); } catch (_) { text = ''; }
  }
  if (!text) die('要交什么：crew hand <名字> "线索"（或从 stdin 灌）');
  ensureDirs(name);
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const f = `${stamp}-${slug(text.split('\n')[0])}.md`;
  fs.writeFileSync(path.join(dirOf(name), 'inbox', f), `# 线索 ${now()} · 来自 ${from}\n\n${text}\n`);
  out(`交到 ${name}/inbox/${f}`);
  out(`提醒：${name} 冷着不会自己发现，派活时 brief 会带上；或 send_message 叫它看 inbox`);
}
function cmdInbox(argv) {
  const name = needName(argv[0]);
  ensureDirs(name);
  const dir = path.join(dirOf(name), 'inbox');
  const want = argv[1];
  if (want) {
    if (path.basename(want) !== want || want === '.' || want === '..') die(`只给文件名，不带路径：${want}`);
    const p = path.join(dir, want);
    if (!fs.existsSync(p)) die('inbox 里没这个文件：' + want);
    return out(fs.readFileSync(p, 'utf8'));
  }
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { files = []; }
  files = files.filter((f) => !f.startsWith('.')).map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return { f, mtime: st.mtime, size: st.size };
  }).sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return out(`${name} 的 inbox 是空的`);
  out(`—— ${name} 的 inbox（${files.length} 条）——`);
  for (const x of files) out(`· ${fmtTime(x.mtime)}  ${x.f}  (${x.size}B)`);
  out(`看内容：crew inbox ${name} <文件名>`);
}

// —— 命令：check —— 岗位卡六要素的机械检查 ————————————————
const CARD_SECTIONS = [
  ['一', '它管什么'],
  ['二', '它能碰什么'],
  ['三', '怎么算干好'],
  ['四', '什么要你签字'],
  ['五', '真相在哪个文件'],
  ['六', '什么时候该动'],
];
function cardSections(text) {
  const parts = (text || '').split(/^## /m).slice(1);
  const map = new Map();
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    const body = nl < 0 ? '' : part.slice(nl + 1);
    const m = head.match(/^(一|二|三|四|五|六)、/);
    if (m) map.set(m[1], body);
  }
  return map;
}
function sectionFilled(body) {
  if (!body) return false;
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  // 只填了「- 工具：」这种空壳，不算填
  const real = lines.filter((l) => {
    if (/^（待补/.test(l)) return false;
    if (/^[-*]$/.test(l)) return false; // 裸的「-」就是没填
    const m = l.match(/^[-*]\s*[^：:]+[：:]\s*(.*)$/);
    if (m) return m[1].trim().length > 0;
    return true;
  });
  return real.length > 0;
}
function cmdCheck(argv) {
  const names = argv.length ? [needName(argv[0])] : members();
  if (!names.length) return out('名册是空的。crew new <名字> --role "..."');
  let bad = 0;
  for (const n of names) {
    const p = profileOf(n);
    const secs = cardSections(read(n, 'role.md', ''));
    const holes = CARD_SECTIONS.filter(([k]) => !sectionFilled(secs.get(k))).map(([k, label]) => `${k}、${label}`);
    const rt = read(n, 'routines.md', '').split('\n').filter((l) => l.trim().startsWith('-')).length;
    const outs = outFiles(n, 999).length;
    const mem = blocks(read(n, 'memory.md', '')).length;
    const ok = !!p.role && !holes.length;
    if (!ok) bad += 1;
    out(`${ok ? '✅' : '⚠️'} ${n}（${p.model || '?'}）记忆 ${mem} · 产出 ${outs} · 节奏 ${rt}`);
    if (!p.role) out('   · 缺一句话职责（profile.role）——名册上认不出它是谁');
    if (holes.length) out(`   · 岗位卡还空着：${holes.join(' / ')}`);
  }
  if (bad) out(`\n${bad}/${names.length} 个没填满。卡空着，它就只能自己发挥。`);
  else out('\n岗位卡都填满了。');
}

// —— 命令：pool / pull —— 拉取式派活：我往板上放卡，成员自己领 ————
// 为什么不是一个个派：派活的成本在 lead 身上；板上放着，谁空谁领，lead 只看产物。
function boardOpen(b) { return b.tasks.filter((t) => t.status === 'open' && !t.owner); }
function pickFor(p, b) {
  const tags = Array.isArray(p.tags) ? p.tags : [];
  const open = boardOpen(b);
  const mine = open.filter((t) => t.role && tags.includes(t.role)); // 先干自己岗位的
  if (mine.length) return mine[0];
  return open.find((t) => !t.role) || null; // 再干通用活；别的岗位的活不碰
}
function assignAll(b) {
  const taken = new Set();
  const pairs = [];
  for (const n of members()) {
    const p = profileOf(n);
    const tags = Array.isArray(p.tags) ? p.tags : [];
    const free = boardOpen(b).filter((t) => !taken.has(t.id));
    const mine = free.find((t) => t.role && tags.includes(t.role));
    const any = free.find((t) => !t.role);
    const t = mine || any;
    if (t) { taken.add(t.id); pairs.push([n, t]); }
  }
  return pairs;
}
function cmdShift() {
  const b = loadBoard();
  const open = boardOpen(b);
  if (!open.length) return out('板上没有可领的活。先上卡：crew task add "标题" --role backend --gear auto --accept "验收"');
  out(`—— 本轮可领 ${open.length} 张 ——`);
  for (const t of open) out(`  ${t.id}\t${t.role || '通用'}\t${t.title}`);
  const pairs = assignAll(b);
  out('');
  out(`—— 起 ${pairs.length} 个会话（一人一张，不抢）——`);
  for (const [n, t] of pairs) out(`  ${n.padEnd(8)} → node tools/crew.js pull ${n}   # 会领到 ${t.id}`);
  const idle = members().filter((n) => !pairs.some(([x]) => x === n));
  out('');
  if (idle.length) out(`空着不动：${idle.join(' / ')}（没活就别起，别硬塞）`);
  out('每个成员一个独立会话，prompt 就一句：跑上面那条命令，领到活照 prompt 干，干完再领，没活就停。');
}
function cmdPool(argv) {
  const role = flag(argv, '--role') || '';
  if (role && !JOBS[role]) die(`岗位只有：${Object.keys(JOBS).join(' / ')}`);
  const b = loadBoard();
  let rows = boardOpen(b);
  if (role) rows = rows.filter((t) => t.role === role || !t.role);
  if (!rows.length) return out('板上没有可领的活。');
  out('id\t档位\t岗位\t标题');
  for (const t of rows) out(`${t.id}\t${t.gear}\t${t.role || '通用'}\t${t.title}`);
  out(`\n可领 ${rows.length} 张。谁空谁领：crew pull <名>`);
}
function cmdPull(argv) { return withBoardLock(() => cmdPullInner(argv)); }
function cmdPullInner(argv) {
  const name = needName(argv[0]);
  const p = profileOf(name);
  const b = loadBoard();
  const t = pickFor(p, b);
  if (!t) {
    out(`板上没有 ${name} 能接的活。` + (Array.isArray(p.tags) && p.tags.length ? `（它只管：${p.tags.map(jobLabel).join(' / ')}）` : ''));
    out('别硬找活干，这一轮就停，等下一张卡。');
    return;
  }
  t.owner = name;
  t.status = 'doing';
  t.updated = now();
  saveBoard(b);
  afterTask(t, name);
  out(`—— 已领到 ${t.id}：${t.title}（${GEARS[t.gear] || t.gear}）——`);
  out('');
  out(buildBrief(name, {
    task: t.title + (t.note ? `\n（备注：${t.note}）` : ''),
    accept: t.accept,
    taskId: t.id,
    gear: t.gear,
    preClaimed: true,
  }));
}

// —— 命令：team —— 一张表看清班子：谁、能接什么、手上几件 ——————————
function cmdTeam() {
  const b = loadBoard();
  const rows = members();
  if (!rows.length) return out('名册是空的。crew new <名字> --role "..." --tags backend');
  out('名字\t模型\t能接的岗位\t手上\t节奏\t记忆');
  for (const n of rows) {
    const p = profileOf(n);
    const doing = b.tasks.filter((t) => t.owner === n && t.status === 'doing').map((t) => t.id).join(',') || '-';
    const tags = Array.isArray(p.tags) && p.tags.length ? p.tags.join(',') : '通用';
    out(`${n}\t${p.model || '?'}\t${tags}\t${doing}\t${routineItems(n).length}\t${blocks(read(n, 'memory.md', '')).length}`);
  }
  const open = boardOpen(b);
  out(`\n板上可领 ${open.length} 张${open.length ? '：' + open.map((t) => `${t.id}(${t.role || '通用'})`).join(' ') : ''}`);
  out('开工一轮：每个成员起一个独立会话，跑 crew pull <名>；领到就干，干完再领。');
}

// —— 命令：out —— 看成员交了什么 ————————————————————————————
function cmdOut(name) {
  needName(name);
  ensureDirs(name);
  const files = outFiles(name, 50);
  if (!files.length) return out(`${name} 的 out/ 还是空的`);
  out(`—— ${name} 的产出（${dirOf(name)}/out）——`);
  for (const x of files) out(`· ${fmtTime(x.mtime)}  ${x.f}  (${x.size}B)${x.first ? '\n  ' + x.first : ''}`);
}

// —— 小工具 ————————————————————————————————————————————
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
}
function stripFlags(argv) {
  const out2 = [];
  const withVal = new Set(['--role', '--model', '--kind', '--tags', '--last', '--add', '--rm', '--task', '--task-file', '--max', '--accept', '--task-id', '--gear', '--owner', '--out', '--note', '--from', '--status', '--date']);
  for (let i = 0; i < argv.length; i++) {
    if (withVal.has(argv[i])) { i++; continue; }
    out2.push(argv[i]);
  }
  return out2;
}

function help() {
  out(`crew —— 班组成员名册

  crew new <名字> --role "一句话职责" [--model <档>] [--tags backend,build]
                                                       建档（生成岗位卡骨架）
  crew list                                            谁在册、记忆几条
  crew show <名字>                                     看它的岗位卡 + 最近记忆 + 节奏
  crew status                                          名册总览
  crew remember <名字> "内容" [--kind fact|lesson|decision] [--tags a,b]
  crew recall <名字> [关键词]                           翻它的记忆
  crew forget <名字> --last <n>                         删最后 n 条（它有权忘）
  crew out <名字>                                       看它 out/ 里最近交了什么
  crew team                                             一张表：谁在册、能接什么活、手上几件
  crew pool [--role backend]                            板上还没人领的活
  crew pull <名字>                                      按岗位标签从板上领一张活（认领 + 出 prompt 一体）
  crew shift                                            本轮开工清单：谁领哪张、起几个会话（一人一张不抢）
     成员开工只跑这一条：领到就干，干完再领，没活就停
  crew routine <名字> --add "每天 09:00|做什么"         加一条节奏
  crew routine <名字> --rm <n>                          删第 n 条
  crew brief <名字> [--task "..."] [--max 6000]         生成派活用 prompt
     可选：--gear investigation|draft|auto|full   把自主档位写进 prompt
           --task-id t001 --accept "逐条验收标准"
  crew task add "标题" [--role backend] [--gear draft] [--accept "..."] [--owner 名字]
  crew task list [--status open|doing|done]                盘上任务板（成员冷着也能接）
  crew task show|claim|done|drop <id> [--out 路径] [--note "..."]
  crew hand <名字> "线索" [--from 谁]                      往 inbox 交一条线索（stdin 也行）
  crew inbox <名字> [文件名]                               看 inbox；给文件名就看内容
  crew check [名字]                                        机械校验岗位卡六要素
  crew due [--date YYYY-MM-DD]                             把 routine 翻成今天的任务卡（重复的不开）

  存放：${ROOT}/<名字>/{profile.json,role.md,memory.md,routines.md}`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
switch (cmd) {
  case 'new': cmdNew(rest); break;
  case 'list': cmdList(); break;
  case 'show': cmdShow(rest[0]); break;
  case 'status': cmdStatus(); break;
  case 'remember': cmdRemember(rest); break;
  case 'recall': cmdRecall(rest); break;
  case 'forget': cmdForget(rest); break;
  case 'routine': cmdRoutine(rest); break;
  case 'brief': cmdBrief(rest); break;
  case 'out': cmdOut(rest[0]); break;
  case 'task': cmdTask(rest); break;
  case 'hand': cmdHand(rest); break;
  case 'inbox': cmdInbox(rest); break;
  case 'check': cmdCheck(rest); break;
  case 'due': cmdDue(rest); break;
  case 'pool': cmdPool(rest); break;
  case 'pull': cmdPull(rest); break;
  case 'shift': cmdShift(); break;
  case 'team': cmdTeam(); break;
  case 'help': case '--help': case '-h': case undefined: help(); break;
  default: die(`不认识的命令：${cmd}（crew help）`);
}
