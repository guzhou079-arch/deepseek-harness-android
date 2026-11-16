// dsh-multi-edit —— 事务性多文件编辑引擎
//
// 一次调用提交一批操作：定位 → 冲突检查 → 内存应用 → 校验 → 落盘或整体回滚。
// 不靠盲替换：每个操作必须唯一命中，可带上下文守卫；同一文件多处编辑按区间排布并查重叠；
// 全部文件校验通过才写盘，任一处失败整批回滚，原文件留在事务目录里可随时还原。
//
// 定位用轻量词法扫描（跳过字符串/注释/模板串）做括号配对，按符号名取整块，
// 这比行号锚点稳：文件里插入几行不会把定位带偏。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile, writeFile, mkdir, readdir, rm, copyFile, stat } from 'node:fs/promises';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const name = 'multi-edit';
export const inject = ['tools'];

const HOME = process.env.DSH_HOME || '/data/user/0/com.deepseek.harness/files/payload/dshhome';
const STORE = process.env.DSH_MULTI_EDIT_HOME || path.join(path.dirname(path.dirname(HOME)), 'multi-edit');
const TXN_DIR = path.join(STORE, 'txn');
const MAX_FILES = 400;
const LOG = path.join(STORE, 'multi-edit.log');
// 启动探针：引擎装配时留一行，出问题时能分清「插件没加载」和「工具被收窄掉」
const probe = (m) => { try { mkdirSync(STORE, { recursive: true }); appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\n'); } catch { /* 写不了日志不影响工具 */ } };
const MAX_BYTES = 8 * 1024 * 1024;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const clip = (s, n = 90) => (s.length > n ? s.slice(0, n) + '…' : s);
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ---------- 轻量词法：认出字符串/注释/模板串，别把里面的括号当代码 ----------
function skipNoise(text, i) {
  const c = text[i];
  if (c === '/' && text[i + 1] === '/') {
    const e = text.indexOf('\n', i);
    return e < 0 ? text.length : e;
  }
  if (c === '/' && text[i + 1] === '*') {
    const e = text.indexOf('*/', i + 2);
    return e < 0 ? text.length : e + 2;
  }
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === c) return j + 1;
      j += 1;
    }
    return text.length;
  }
  return -1;
}

// 从 open 位置找配对的收括号；找不到返回 -1
function matchPair(text, start) {
  const open = text[start];
  const close = { '{': '}', '(': ')', '[': ']' }[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const skip = skipNoise(text, i);
    if (skip > i) { i = skip - 1; continue; }
    const c = text[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 括号/引号是否平衡：写盘前最后一道粗筛，挡掉明显改坏的语法
function balanced(text) {
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const skip = skipNoise(text, i);
    if (skip > i) { i = skip - 1; continue; }
    const c = text[i];
    if (c === '{' || c === '(' || c === '[') stack.push(c);
    else if (c === '}' || c === ')' || c === ']') {
      const want = { '}': '{', ')': '(', ']': '[' }[c];
      if (stack.pop() !== want) return false;
    }
  }
  return stack.length === 0;
}

// ---------- 定位 ----------
function allIndexes(hay, needle) {
  const out = [];
  if (!needle) return out;
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0) break;
    out.push(at);
    i = at + needle.length;
  }
  return out;
}

// 按符号名取整块（声明 → 配对收括号 → 吞掉尾随分号）
function symbolBlocks(text, symbol) {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pats = [
    new RegExp(`(?:^|\\n)([ \\t]*)(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${esc}\\s*\\(`, 'g'),
    new RegExp(`(?:^|\\n)([ \\t]*)(?:export\\s+)?(?:default\\s+)?class\\s+${esc}\\b`, 'g'),
    new RegExp(`(?:^|\\n)([ \\t]*)(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*=`, 'g'),
    new RegExp(`(?:^|\\n)([ \\t]*)(?:export\\s+)?(?:interface|type|enum)\\s+${esc}\\b`, 'g'),
  ];
  const starts = [];
  for (const re of pats) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) starts.push(m.index + (m[0].startsWith('\n') ? 1 : 0));
  }
  const uniq = [...new Set(starts)].sort((a, b) => a - b);
  return uniq.map((start) => {
    let i = start;
    let brace = -1;
    while (i < text.length) {
      const skip = skipNoise(text, i);
      if (skip > i) { i = skip; continue; }
      const c = text[i];
      if (c === '{') { brace = i; break; }
      if (c === ';') break;
      i += 1;
    }
    if (brace >= 0) {
      const end = matchPair(text, brace);
      if (end > 0) {
        let e = end + 1;
        while (e < text.length && /[ \t;]/.test(text[e])) e += 1;
        return { start, end: e };
      }
    }
    const semi = text.indexOf(';', start);
    return { start, end: semi < 0 ? text.length : semi + 1 };
  });
}

// 定位一个操作命中的区间；命中不唯一或越界都直接报错，不做猜测
function locate(text, op, existed) {
  const kind = op.kind;
  if (kind === 'write') {
    if (op.create_only && existed) throw new Error('文件已存在，create_only 要求新建');
    return { start: 0, end: text.length };
  }
  if (kind === 'json') return { start: 0, end: text.length };

  if (kind === 'symbol') {
    const blocks = symbolBlocks(text, op.symbol);
    if (blocks.length !== 1) {
      throw new Error(`符号 ${op.symbol} 命中 ${blocks.length} 处（要求恰好 1 处）`);
    }
    return blocks[0];
  }

  const needle = op.old;
  if (typeof needle !== 'string' || needle.length === 0) throw new Error('old 不能为空');
  let hits = allIndexes(text, needle).map((at) => ({ start: at, end: at + needle.length }));

  // 上下文守卫：缩小到真正想改的那一处
  if (op.context_before) hits = hits.filter((h) => text.slice(0, h.start).endsWith(op.context_before));
  if (op.context_after) hits = hits.filter((h) => text.slice(h.end).startsWith(op.context_after));

  const want = Number.isSafeInteger(op.count) && op.count > 0 ? op.count : 1;
  if (hits.length !== want) {
    const extra = op.context_before || op.context_after ? '（已套上下文守卫）' : '，可加 context_before / context_after 收窄';
    throw new Error(`命中 ${hits.length} 处，要求 ${want} 处${extra}：${clip(oneLine(needle))}`);
  }
  return want === 1 ? hits[0] : hits;
}

// ---------- 单文件应用 ----------
// 同一文件的所有编辑基于原文定位，按区间从后往前落，避免偏移漂移；重叠直接判冲突
function applyRename(text, op) {
  if (typeof op.from !== 'string' || !op.from) throw new Error('rename 需要 from');
  const esc = op.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${esc}\\b`, 'g');
  const n = (text.match(re) || []).length;
  if (!n) throw new Error(`rename: 文件里没有 ${op.from}`);
  return text.replace(re, String(op.to ?? ''));
}

function applyToText(text, ops, existed) {
  const renames = ops.filter((o) => o.kind === 'rename');
  let base = text;
  for (const r of renames) base = applyRename(base, r);
  const edits = [];
  for (const op of ops) {
    if (op.kind === 'rename') continue;
    const loc = locate(base, op, existed);
    const list = Array.isArray(loc) ? loc : [loc];
    for (const seg of list) {
      let next;
      if (op.kind === 'write') next = op.content ?? '';
      else if (op.kind === 'delete') next = '';
      else if (op.kind === 'insert') next = op.where === 'after' ? base.slice(seg.start, seg.end) + (op.text ?? '') : (op.text ?? '') + base.slice(seg.start, seg.end);
      else if (op.kind === 'json') next = jsonEdit(text.slice(seg.start, seg.end), op);
      else next = op.new ?? '';
      edits.push({ start: seg.start, end: seg.end, text: next, op });
    }
  }
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < edits.length; i += 1) {
    if (edits[i].start < edits[i - 1].end) {
      throw new Error(`区间重叠：${clip(oneLine(edits[i - 1].op.old || edits[i - 1].op.symbol || edits[i - 1].op.kind))} 与 ${clip(oneLine(edits[i].op.old || edits[i].op.symbol || edits[i].op.kind))}`);
    }
  }
  let out = base;
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const e = edits[i];
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

// JSON 路径编辑：真解析再回写，不用正则碰结构；缩进沿用原文件的
function jsonEdit(raw, op) {
  const data = JSON.parse(raw);
  const segs = String(op.path || '').split('.').filter(Boolean);
  if (!segs.length) throw new Error('json 操作需要 path，如 a.b[0].c');
  const keys = segs.map((s) => {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(s);
    if (!m) throw new Error(`path 段看不懂：${s}`);
    return { key: m[1], idx: (m[2].match(/\d+/g) || []).map(Number) };
  });
  setPath(data, keys, op.value, op.remove);
  const indent = (/\n([ \t]+)"/.exec(raw) || [, '  '])[1].slice(0, 10);
  return JSON.stringify(data, null, indent) + (raw.endsWith('\n') ? '\n' : '');
}

function setPath(root, keys, value, remove) {
  let node = root;
  for (let i = 0; i < keys.length; i += 1) {
    const { key, idx } = keys[i];
    const last = i === keys.length - 1;
    if (key) {
      if (last && !idx.length) {
        if (remove) delete node[key];
        else node[key] = value;
        return;
      }
      if (node[key] === undefined || node[key] === null) node[key] = idx.length ? [] : {};
      node = node[key];
    }
    for (let k = 0; k < idx.length; k += 1) {
      const at = idx[k];
      const end = k === idx.length - 1 && last;
      if (end) {
        if (remove) node.splice(at, 1);
        else node[at] = value;
        return;
      }
      if (node[at] === undefined || node[at] === null) node[at] = {};
      node = node[at];
    }
  }
  if (remove) throw new Error('json 删除需要完整路径');
}

// ---------- 校验 ----------
function verify(file, before, after) {
  const ext = path.extname(file).toLowerCase();
  if (after.trim().length === 0) return '改完是空文件';
  if (ext === '.json') {
    try { JSON.parse(after); } catch (e) { return `JSON 解析失败：${e.message}`; }
    return null;
  }
  if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext)) {
    if (!balanced(after)) return '括号/引号不平衡';
    const b = before.split('\n').length;
    const a = after.split('\n').length;
    if (b > 40 && a < b * 0.35) return `行数从 ${b} 掉到 ${a}，疑似整段被吞`;
    return null;
  }
  if (after.length > 0 && before.length > 0 && after.length < before.length * 0.2) return '内容骤减，疑似误删';
  return null;
}

// ---------- 事务 ----------
async function ensureStore() {
  await mkdir(TXN_DIR, { recursive: true });
}

async function readText(file) {
  const st = await stat(file);
  if (!st.isFile()) throw new Error('不是普通文件');
  if (st.size > MAX_BYTES) throw new Error(`文件 ${(st.size / 1048576).toFixed(1)}MB 超过 ${MAX_BYTES / 1048576}MB 上限`);
  return readFile(file, 'utf8');
}

async function rollback(txnId) {
  const dir = path.join(TXN_DIR, txnId);
  const man = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const restored = [];
  const conflicts = [];
  for (const f of man.files) {
    if (!f.existed) {
      if (existsSync(f.path)) { await rm(f.path, { force: true }); restored.push(`${f.path}（删除新建文件）`); }
      continue;
    }
    const bak = path.join(dir, 'backup', f.backup);
    const cur = existsSync(f.path) ? await readFile(f.path, 'utf8') : null;
    if (cur !== null && sha256(cur) !== f.sha_after) {
      conflicts.push(`${f.path}（事务后被改过）`);
      continue;
    }
    await writeFile(f.path, await readFile(bak, 'utf8'), 'utf8');
    restored.push(f.path);
  }
  return { restored, conflicts, dir };
}

// ---------- 工具 ----------
export function apply(ctx) {
  probe('apply-start');
  ctx.tools.register(defineTool({
    name: 'multi_edit',
    description: '事务性多文件编辑引擎。一次提交一批操作，全部成功才落盘，任一处失败整批回滚，原文件留在事务目录可还原。'
      + '适合跨几十上百个文件的协同改动（重命名符号、批量加字段、统一改接口）。'
      + '\n每个 op 的 kind 取值：'
      + '\n replace —— 按 old 精确替换成 new（old 必须唯一命中，可加 context_before/context_after 收窄）'
      + '\n insert —— 在 old 命中处插入 text，where=before|after（默认 before）'
      + '\n delete —— 删掉 old（可配 count 删多处）'
      + '\n write —— 整文件写 content；create_only=true 时文件已存在就报错'
      + '\n symbol —— 按符号名取整块替换成 new（function/class/const/interface 都认，比按行号稳）'
      + '\n json —— 结构化改 JSON：path 形如 a.b[0].c，配 value 或 remove=true'
      + '\n rename —— 把 from 全词替换成 to，配 files 数组；跨文件改名会顺带查引用残留'
      + '\n常用参数：ops 必填；dry_run=true 只检查不写盘；undo=<事务ID> 整批还原。'
      + '\n返回里会给每个文件的改动行号、冲突和校验结果。',
    parameters: {
      ops: {
        type: 'array',
        description: '操作列表，每项至少含 file（绝对路径）和 kind，其余字段按 kind 给',
        items: { type: 'object', additionalProperties: true },
      },
      dry_run: { type: 'boolean', description: '只做定位与校验，不写盘' },
      undo: { type: 'string', description: '事务 ID：把这批改动整体还原' },
      label: { type: 'string', description: '给这批改动起个名，便于事后在审计记录里认出来' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args) {
      if (typeof args.undo === 'string' && args.undo.trim()) {
        const { restored, conflicts, dir } = await rollback(args.undo.trim());
        const lines = [`回滚 ${args.undo.trim()}（${dir}）`];
        if (restored.length) lines.push(`已还原 ${restored.length} 个文件：`, ...restored.map((r) => '  - ' + r));
        if (conflicts.length) lines.push(`拒绝还原 ${conflicts.length} 个（事务之后又被改过，怕覆盖新改动）：`, ...conflicts.map((r) => '  ! ' + r));
        if (!restored.length && !conflicts.length) lines.push('这个事务没有记录可还原的文件。');
        return { text: lines.join('\n') };
      }

      const ops = Array.isArray(args.ops) ? args.ops : [];
      if (!ops.length) return { text: '没有给 ops，什么也没做。' };
      const byFile = new Map();
      for (const op of ops) {
        if (!op || typeof op.file !== 'string' || !path.isAbsolute(op.file)) {
          return { text: `op 缺 file 或不是绝对路径：${JSON.stringify(op).slice(0, 120)}` };
        }
        if (!op.kind) return { text: `op 缺 kind：${op.file}` };
        if (!byFile.has(op.file)) byFile.set(op.file, []);
        byFile.get(op.file).push(op);
      }
      if (byFile.size > MAX_FILES) return { text: `一次最多 ${MAX_FILES} 个文件，这次 ${byFile.size} 个。分批提交。` };

      // 读原文（并发 IO），不存在的文件只有 write/rename 能新建
      const files = [...byFile.keys()];
      const before = new Map();
      const existed = new Set();
      const readErrors = [];
      await Promise.all(files.map(async (f) => {
        try { before.set(f, await readText(f)); existed.add(f); } catch (e) {
          if (e.code === 'ENOENT') {
            const ops0 = byFile.get(f);
            if (ops0.every((o) => o.kind === 'write' || o.kind === 'rename')) before.set(f, '');
            else readErrors.push(`${f}：文件不存在`);
          } else readErrors.push(`${f}：${e.message}`);
        }
      }));
      if (readErrors.length) return { text: '读文件就失败了，一个字都没改：\n' + readErrors.map((e) => '  ! ' + e).join('\n') };

      // 逐文件应用 + 校验
      const after = new Map();
      const problems = [];
      for (const f of files) {
        try {
          const next = applyToText(before.get(f), byFile.get(f), existed.has(f));
          const bad = verify(f, before.get(f), next);
          if (bad) problems.push(`${f}：${bad}`);
          after.set(f, next);
        } catch (e) { problems.push(`${f}：${e.message}`); }
      }
      if (problems.length) {
        return { text: `定位或校验没过，整批没有落盘：\n${problems.map((p) => '  ! ' + p).join('\n')}` };
      }

      // 跨文件改名后查残留：同目录里没被这次改到的文件如果还提到旧名，提醒补上
      const renameWarn = [];
      const renames = ops.filter((o) => o.kind === 'rename' && typeof o.from === 'string' && o.from);
      if (renames.length) {
        const escRe = (x) => new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        const probes = renames.map((r) => ({ from: r.from, re: escRe(r.from) }));
        const touched = new Set(files);
        const seen = new Set();
        for (const dir of [...new Set(files.map((f) => path.dirname(f)))]) {
          let entries = [];
          try { entries = await readdir(dir); } catch { continue; }
          for (const entry of entries.slice(0, 300)) {
            if (!/\.(mjs|cjs|js|jsx|ts|tsx)$/.test(entry)) continue;
            const p = path.join(dir, entry);
            if (touched.has(p) || seen.has(p)) continue;
            seen.add(p);
            let txt = '';
            try { txt = await readFile(p, 'utf8'); } catch { continue; }
            for (const probe of probes) if (probe.re.test(txt)) renameWarn.push(`${p} 还提到 ${probe.from}`);
          }
        }
      }

      const changed = files.filter((f) => after.get(f) !== before.get(f));
      const diffLines = (a, b) => {
        const al = a.split('\n'), bl = b.split('\n');
        let i = 0;
        while (i < al.length && i < bl.length && al[i] === bl[i]) i += 1;
        let j = 0;
        while (j < al.length - i && j < bl.length - i && al[al.length - 1 - j] === bl[bl.length - 1 - j]) j += 1;
        return { start: i + 1, removed: al.length - i - j, added: bl.length - i - j };
      };

      if (args.dry_run) {
        const lines = [`演练：${changed.length}/${files.length} 个文件会变，没写盘。`];
        for (const f of changed) {
          const d = diffLines(before.get(f), after.get(f));
          lines.push(`  ~ ${f}  第 ${d.start} 行起 -${d.removed}/+${d.added}`);
        }
        if (renameWarn.length) lines.push('引用提醒：', ...renameWarn.map((r) => '  ? ' + r));
        return { text: lines.join('\n') };
      }
      if (!changed.length) return { text: '操作都定位到了，但内容没变（new 和 old 一样），没写盘。' };

      // 落盘：先备份再写，任何一步失败立刻按备份还原
      await ensureStore();
      const txnId = `${stamp()}-${randomBytes(3).toString('hex')}`;
      const dir = path.join(TXN_DIR, txnId);
      await mkdir(path.join(dir, 'backup'), { recursive: true });
      const manifest = { id: txnId, at: new Date().toISOString(), label: oneLine(args.label) || '', status: 'writing', files: [] };
      let idx = 0;
      const written = [];
      try {
        for (const f of changed) {
          const bak = `${String(idx).padStart(3, '0')}.bak`;
          const existed = before.get(f).length > 0 || existsSync(f);
          if (existed) await writeFile(path.join(dir, 'backup', bak), before.get(f), 'utf8');
          manifest.files.push({ path: f, existed, backup: bak, sha_before: sha256(before.get(f)), sha_after: sha256(after.get(f)) });
          idx += 1;
        }
        for (const f of changed) {
          await mkdir(path.dirname(f), { recursive: true });
          await writeFile(f, after.get(f), 'utf8');
          written.push(f);
        }
        manifest.status = 'committed';
      } catch (e) {
        manifest.status = 'failed';
        await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8').catch(() => {});
        const undo = [];
        for (const f of written) {
          const rec = manifest.files.find((x) => x.path === f);
          try {
            if (rec && rec.existed) await copyFile(path.join(dir, 'backup', rec.backup), f);
            else await rm(f, { force: true });
            undo.push(f);
          } catch { /* 单文件还原失败继续下一个 */ }
        }
        return { text: `写盘中途失败：${e.message}\n已还原 ${undo.length} 个文件。事务目录：${dir}` };
      }
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const lines = [`事务 ${txnId} 已提交：${changed.length} 个文件，${ops.length} 个操作。`];
      if (manifest.label) lines.push(`名称：${manifest.label}`);
      for (const f of changed) {
        const d = diffLines(before.get(f), after.get(f));
        lines.push(`  ~ ${f}  第 ${d.start} 行起 -${d.removed}/+${d.added}`);
      }
      const skipped = files.filter((f) => !changed.includes(f));
      if (skipped.length) lines.push(`未变：${skipped.length} 个文件（内容与操作结果一致）`);
      if (renameWarn.length) lines.push('引用提醒：', ...renameWarn.map((r) => '  ? ' + r));
      lines.push(`要撤销就说 undo=${txnId}`);
      return { text: lines.join('\n') };
    },
  }));
  probe('tool registered');
}
