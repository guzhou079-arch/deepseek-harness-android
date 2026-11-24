#!/usr/bin/env node
/**
 * assert-no-path-passthrough.js —— 门禁：外部输入不许直通系统调用
 * ============================================================================
 * 判什么
 * ------
 * 「外部输入直通系统调用」这一类雷。形状（可判定版）：
 *
 *   一个**跨权限边界**进来的字符串（HTTP body / query / params / 本机桥 / MCP 参数）。
 *   argv、环境变量、本机配置文件不算：它们和调用方同权限，读个路径是本职，不是洞。
 *   被传进下面任一类「系统调用」，而从输入点到调用点之间**没有同时具备**：
 *     (a) 字符集或归一化约束（命名白名单正则 / realpath / 净化）
 *     (b) 根前缀约束（约束到一个已知根，失败即拒）
 *
 * 系统调用（sink）三类：
 *   1. fs 家族：readFile/writeFile/stat/open/createReadStream/unlink/rm/mkdir/readdir…
 *   2. 进程家族：exec/execSync/spawn/spawnSync/execFile/fork
 *   3. 本机桥梁：向 127.0.0.1 / localhost 的 http.request，以及把外部串写进这种请求的 end()/write()
 *      第三类容易被漏：它自己不碰 fs，但它把路径交给同一台机器上、有 fs 权限的另一半。
 *
 * 只判**路径实参**，不判数据实参：
 *   writeFile(path, data) 只关心 path；`typeof b.x === 'string'` 里的 data 与路径直通无关。
 *   不分这一层，告警会淹掉真雷（writeFile(LOG_PATH, line) 会被误报成路径直通）。
 *
 * 什么不算雷（必须能排除，否则全红）
 * ---------------------------------
 *   1. OOXML 包内 part name：`rel.target.startsWith("/")` 判的是 zip 里的 part 名，
 *      后面也不进 fs。这类落进「只有形状判据、没有系统调用」。
 *   2. 前端「这串像不像路径」：浏览器半边没有 fs，判断只影响渲染。同样落进上一档。
 *   3. 已经过 (a)+(b) 的：命名白名单正则 + 拼在固定根下、realpath 后比前缀、
 *      resolve 后比相对路径、白名单映射 —— 算已拦。
 *
 * 只有 `startsWith("/")` 的**不算已拦** —— 它只证明「像绝对路径」，正是 doc-actions 那条的形状。
 *
 * 三档，不许合并
 * --------------
 *   雷（存量待清 / 新增违规） · 不是雷 · 判不了
 * 「判不了」单列且默认让闸变红（未登记时），因为静默放过比误报坏得多。
 *
 * 两档雷，判据不同
 * ----------------
 *   【存量待清】登记在 path-passthrough-baseline.json 里的既有雷：照报、给清法，但不算失败。
 *               它是待办清单，不是欠账合法化 —— 条目不再复现会被报成 stale，逼着删。
 *   【新增违规】baseline 之外的雷：直接 exit 1。这一档才是这道闸存在的理由。
 *
 * 能收能退
 * --------
 *   存量待清清零后，用 --strict 让这道闸连存量也不许有；baseline 空了就是纯防新增。
 *   整道闸可以退役的条件写在 path-passthrough-baseline.json 的 meta.retireWhen 里，
 *   README 里同步一份：路径不再以原始字符串跨进程边界（改传句柄/ID），这道闸就没有对象了。
 *
 * 用法
 * ----
 *   node assert-no-path-passthrough.js <root...> [--json] [--json-detail] [--strict] [--include-fixtures] [--list-notleak]
 *
 * 退出码
 * ------
 *   0  没有新增违规，也没有未登记的「判不了」（存量待清不阻塞）
 *   1  有新增违规，或有未登记的「判不了」
 *   2  判据自身跑不动（读不到文件、分析器崩了、baseline 坏了）—— 这类失败绝不能被当成「通过」
 *   3  --strict 下有存量待清
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const EXIT_OK = 0
const EXIT_VIOLATION = 1
const EXIT_BROKEN = 2
const EXIT_STALE = 3

const SCRIPT_DIR = __dirname
const BASELINE_FILE = path.join(SCRIPT_DIR, 'path-passthrough-baseline.json')

// 夹具目录默认不扫：夹具里故意写着必须变红的样例，扫进来就永远红。
// 只排除这一个确切前缀，且把排除数量打进报告，避免这条豁免变成暗门。
const FIXTURE_PREFIX = path.join('tools', 'test', 'fixtures')

// ---------------------------------------------------------------------------
// 词法：剥注释但保留偏移（行号不能漂）
// ---------------------------------------------------------------------------

function blankComments(src) {
  const out = src.split('')
  let i = 0
  let state = 'code'
  let quote = ''
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
      if (c === '/' && n === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
      if (c === '"' || c === "'" || c === '`') { state = 'string'; quote = c; i += 1; continue }
      i += 1
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; i += 1; continue }
      out[i] = ' '
      i += 1
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'code'; i += 2; continue }
      if (c !== '\n') out[i] = ' '
      i += 1
      continue
    }
    if (c === '\\') { i += 2; continue }
    if (c === quote) { state = 'code'; i += 1; continue }
    i += 1
  }
  return out.join('')
}

function lineOf(src, offset) {
  let line = 1
  for (let i = 0; i < offset && i < src.length; i += 1) if (src[i] === '\n') line += 1
  return line
}

function matchBrace(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function matchParen(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// 函数边界
// ---------------------------------------------------------------------------

const NOT_FN = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'with', 'typeof'])

function splitParams(s) {
  return s
    .split(',')
    .map((p) => p.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').trim())
    .filter(Boolean)
}

function collectFunctions(text) {
  const fns = []
  const seen = new Set()
  const push = (name, params, start, bodyStart, bodyEnd) => {
    const key = start + ':' + bodyStart
    if (seen.has(key)) return
    seen.add(key)
    fns.push({ name: name || '(anonymous)', params, start, bodyStart, bodyEnd })
  }

  const reDecl = /function\s*\*?\s*([A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*\{/g
  let m
  while ((m = reDecl.exec(text))) {
    const bodyStart = m.index + m[0].length - 1
    const bodyEnd = matchBrace(text, bodyStart)
    if (bodyEnd > 0) push(m[1], splitParams(m[2]), m.index, bodyStart, bodyEnd)
  }
  const reArrow = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/g
  while ((m = reArrow.exec(text))) {
    const bodyStart = m.index + m[0].length - 1
    const bodyEnd = matchBrace(text, bodyStart)
    if (bodyEnd > 0) push(m[1], splitParams(m[2]), m.index, bodyStart, bodyEnd)
  }
  const reArrowExpr = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*(?!\{)/g
  while ((m = reArrowExpr.exec(text))) {
    const end = text.indexOf('\n', m.index + m[0].length)
    push(m[1], splitParams(m[2]), m.index, m.index, end > 0 ? end : text.length)
  }
  const reMethod = /(?:^|\n)([ \t]*)(?:async\s+)?([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{/g
  while ((m = reMethod.exec(text))) {
    const name = m[2]
    if (NOT_FN.has(name)) continue
    const bodyStart = m.index + m[0].length - 1
    const bodyEnd = matchBrace(text, bodyStart)
    if (bodyEnd > 0) push(name, splitParams(m[3]), m.index, bodyStart, bodyEnd)
  }
  fns.sort((a, b) => a.start - b.start)
  return fns
}

function enclosing(fns, offset) {
  let best = null
  for (const f of fns) {
    if (offset >= f.start && offset <= f.bodyEnd) {
      if (!best || f.bodyEnd - f.bodyStart < best.bodyEnd - best.bodyStart) best = f
    }
  }
  return best
}

function splitTopArgs(text, open, close) {
  const parts = []
  let depth = 0
  let start = open + 1
  let quote = ''
  for (let i = open + 1; i < close; i += 1) {
    const c = text[i]
    if (quote) {
      if (c === '\\') { i += 1; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start, close))
  return parts.map((s) => s.trim()).filter((s) => s.length > 0)
}

function isCallbackArg(s) {
  return /^(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/.test(s)
}

// ---------------------------------------------------------------------------
// 外部输入源
// ---------------------------------------------------------------------------

const SOURCE_RES = [
  /\breq(?:uest)?\.(?:body|query|params|url|rawBody|headers)\b/,
  /\breq(?:uest)?\.(?:body|query|params)\s*\[/,
  /\bsearchParams\b/,
  /\b(?:input|payload|body|params|args|toolArgs|tool_input|options)\.(?:path|file|filePath|dir|target|saveAs)\b/,
  /\bmcp\.?[A-Za-z]*\.?arguments\b/,
]

function hasSource(expr) {
  return SOURCE_RES.some((re) => re.test(expr))
}

// 请求派生：函数体里读了 req/request/socket 的数据，它的返回值就当外部派生看待。
// 这是过近似，但方向是「宁可报浑」—— 漏了才是坏的。
function collectRequestDerived(text, fns) {
  const derived = new Set()
  for (const f of fns) {
    const body = text.slice(f.bodyStart, f.bodyEnd)
    const readsReq = /\breq(?:uest)?\b\s*[.)\]]|\.on\(\s*['"]data['"]\s*\)/.test(body)
    const paramsAreReq = f.params.some((p) => /^req/i.test(p))
    if (readsReq || paramsAreReq) derived.add(f.name)
  }
  return derived
}

// ---------------------------------------------------------------------------
// 污染：只认「这个表达式的值可能是什么」，不做「提到即污染」
// ---------------------------------------------------------------------------

const TRANSFORM_HEAD = /^(?:String|Number|Buffer\.from|JSON\.stringify|encodeURIComponent|decodeURIComponent|(?:path\.)?(?:join|resolve|normalize|dirname|basename|relative|toNamespacedPath)|[A-Za-z0-9_$.]+\.(?:trim|trimStart|trimEnd|slice|substring|substr|replace|replaceAll|split|join|toLowerCase|toUpperCase|toString|concat|map))\s*\(/

// 「提到就算」的宽口径，只给子进程那种整段透传的 sink 用：
// 前面允许是点号，`...args` 这种 spread 也算提到，否则会从缝里漏过去。
function stripStringLiterals(expr) {
  return expr
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
}

function idsMentioned(expr, taint) {
  const ids = []
  const bare = stripStringLiterals(expr)
  for (const name of taint) {
    if (new RegExp('(?:^|[^A-Za-z0-9_$])' + escapeRe(name) + '(?![A-Za-z0-9_$])').test(bare)) ids.push(name)
  }
  return ids
}

function valueTaint(expr, taint, derived, depth = 0) {
  const src = String(expr || '').trim()
  if (src === '' || depth > 3) return { tainted: false, ids: [], why: '' }

  if (hasSource(src)) {
    const hit = (src.match(/[A-Za-z]+\.(?:path|file|dir|target|saveAs)/) || [''])[0]
    return { tainted: true, ids: ['source:' + (hit || 'request')], why: 'source:' + (hit || 'request') }
  }

  for (const name of derived) {
    if (new RegExp('(?:^|[^A-Za-z0-9_$.])' + escapeRe(name) + '\\s*\\(').test(src)) {
      return { tainted: true, ids: ['call:' + name + '()'], why: 'call:' + name }
    }
  }

  const ids = []
  for (const name of taint) {
    const re = escapeRe(name)
    const direct = new RegExp('^' + re + '(?![A-Za-z0-9_$])')
    const composed = [
      new RegExp('\\+\\s*[^,;]*\\b' + re + '(?![A-Za-z0-9_$])'), // 拼接
      new RegExp('\\$\\{[^}]*\\b' + re + '(?![A-Za-z0-9_$])'), // 模板串
      new RegExp('path\\.\\w+\\s*\\([^;]*\\b' + re + '(?![A-Za-z0-9_$])'), // path.join(根, x)
      new RegExp('(?:^|[{,])\\s*' + re + '\\s*(?:[,}]|$)'), // 对象简写 { path }
      new RegExp('\\[\\s*' + re + '\\s*[,]'), // 数组实参 [p, ...]
    ]
    if (direct.test(src) || composed.some((r) => r.test(src))) ids.push(name)
  }
  if (ids.length) return { tainted: true, ids, why: 'var:' + ids[0] }

  // 变换外壳：String(b.title)、JSON.stringify({path: p}) —— 拆开再看一层
  if (TRANSFORM_HEAD.test(src)) {
    const open = src.indexOf('(')
    const close = matchParen(src, open)
    if (close > 0) {
      const inner = valueTaint(src.slice(open + 1, close), taint, derived, depth + 1)
      if (inner.tainted) return inner
    }
  }
  // 三元/或表达式：任意分支污染就是污染
  const branch = /(?:\?\s*|:\s*|(?<![|&])\|\|\s*|&&\s*)([A-Za-z0-9_$][A-Za-z0-9_$.]*)/g
  let bm
  while ((bm = branch.exec(src))) {
    if (taint.has(bm[1])) return { tainted: true, ids: [bm[1]], why: 'var:' + bm[1] }
  }
  return { tainted: false, ids: [], why: '' }
}

// ---------------------------------------------------------------------------
// 校验：哪些能算「拦住了」
// ---------------------------------------------------------------------------

const ANTI_GUARDS = [
  { re: /\.startsWith\s*\(\s*['"`]\s*\/\s*['"`]\s*\)/, why: 'startsWith("/")' },
  { re: /\.startsWith\s*\(\s*path\.sep\s*\)/, why: 'startsWith(path.sep)' },
  { re: /typeof\s+[A-Za-z0-9_$.]+\s*===\s*['"]string['"]/, why: 'typeof string' },
  { re: /\.length\s*[><=]/, why: 'length check' },
]

// 只针对「像不像绝对路径」的判据。这类判据本身挡不住穿越，命中它的地方要单独数出来
// （office-kit 的 part name 就长这样），但那不是雷 —— 得能看见它们被分到另一档。
const PATH_SHAPE_GUARDS = [
  { re: /\.startsWith\s*\(\s*['"`]\s*\/\s*['"`]\s*\)/, why: 'startsWith("/")' },
  { re: /\.startsWith\s*\(\s*path\.sep\s*\)/, why: 'startsWith(path.sep)' },
  { re: /\.startsWith\s*\(\s*['"`]\s*[A-Za-z]:[\\/]/, why: 'startsWith(盘符)' },
  { re: /\bpath\.isAbsolute\s*\(/, why: 'path.isAbsolute' },
  { re: /\bisAbsolutePath\b/, why: 'isAbsolutePath' },
]

const REAL_GUARDS = [
  { re: /\brealpath(?:Sync)?\s*\(/, why: 'realpath' },
  { re: /\bpath\.relative\s*\(/, why: 'path.relative' },
  { re: /\bresolve\s*\([^)]*\)\s*[;)]{0,2}[\s\S]{0,200}?\.startsWith\s*\(/, why: 'resolve+startsWith' },
  { re: /\.startsWith\s*\(\s*(?!['"`]\s*\/\s*['"`])[A-Za-z_$][A-Za-z0-9_$.]*\s*\)/, why: 'startsWith(根常量)' },
  { re: /\b(?:ALLOW|ALLOWED|ROOTS?|BASES?|SANDBOX|PREFIX)[A-Z0-9_]*\s*\.\s*(?:has|includes|some)\s*\(/, why: '白名单集合' },
  { re: /\bpath\.isAbsolute\s*\([^)]*\)\s*&&/, why: 'isAbsolute &&' },
]

// 命名白名单正则：不看写法，直接拿它本身去试穿越串。
// 判据是「这个正则挡不挡得住 `..` / `../x` / 绝对路径」，不是「它长得像不像白名单」——
// 像 /^[A-Za-z0-9._-]+\.dshbackup$/ 这种首字符允许点号、但强制后缀的，其实是安全的。
const TRAVERSAL_PAYLOADS = ['..', '.', '../x', 'a/../../etc/passwd', '/etc/passwd', '/', '..\\x', 'a\\..\\..\\x', '%2e%2e%2f']

function regexConstRejectsTraversal(text, name) {
  const m = new RegExp('(?:const|let|var)\\s+' + escapeRe(name) + '\\s*=\\s*/((?:[^/\\\\]|\\\\.)+)/([a-z]*)').exec(text)
  if (!m) return false
  let re
  try {
    re = new RegExp(m[1], m[2].replace(/[gy]/g, ''))
  } catch {
    return false
  }
  return TRAVERSAL_PAYLOADS.every((payload) => !re.test(payload))
}

function namedRegexGuarding(text, window, id) {
  const re = /\b([A-Z][A-Z0-9_]{1,})\s*\.\s*test\s*\(\s*([A-Za-z0-9_$]+)/g
  let m
  while ((m = re.exec(window))) {
    if (m[2] === id && regexConstRejectsTraversal(text, m[1])) return m[1]
  }
  // 反向：正则在前，值在后（比如 if (!SNAPSHOT_FILE.test(name)) return）
  const re2 = /\b([A-Z][A-Z0-9_]{1,})\s*\.\s*test\s*\(\s*/g
  while ((m = re2.exec(window))) {
    if (regexConstRejectsTraversal(text, m[1]) && new RegExp('(?:^|[^A-Za-z0-9_$.])' + escapeRe(id) + '(?![A-Za-z0-9_$])').test(window)) return m[1]
  }
  return null
}

function sanitizedBefore(expr, id) {
  return new RegExp(escapeRe(id) + '\\s*\\.\\s*replace\\s*\\(\\s*/\\[\\^').test(expr) ||
    new RegExp('\\.\\s*replace\\s*\\(\\s*/\\[\\^[^\\]]*\\][^)]*\\)\\s*;?\\s*(?:const|let|var)\\s+' + escapeRe(id)).test(expr)
}

// 拼在固定根下：path.join(SKILLS, x) / path.resolve(HOME, y)
function joinUnderConstRoot(expr) {
  return /\bpath\.(?:join|resolve)\s*\(\s*(?:[A-Z][A-Z0-9_]{1,}|HOME|ROOT|__dirname|APP_DIR)\s*,/.test(expr) ||
    /\bpath\.(?:join|resolve)\s*\(\s*[A-Za-z0-9_$]+\s*,\s*[^,)]+,\s*['"][^'"]*['"]\s*\)/.test(expr) === false
}

function guardVerdict(text, window) {
  for (const g of REAL_GUARDS) if (g.re.test(window)) return { result: 'guarded', why: g.why }
  return { result: 'unguarded', why: '' }
}

function antiGuardReason(window) {
  for (const g of ANTI_GUARDS) if (g.re.test(window)) return g.why
  return null
}

// ---------------------------------------------------------------------------
// 系统调用
// ---------------------------------------------------------------------------

const FS_READ = ['readFile', 'readFileSync', 'createReadStream', 'opendir', 'opendirSync', 'readdir', 'readdirSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'open', 'openSync', 'realpath', 'realpathSync', 'existsSync']
const FS_WRITE = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']
const FS_BOTH = ['copyFile', 'copyFileSync', 'rename', 'renameSync', 'link', 'symlink']
const FS_OTHER = ['unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync', 'chmod', 'chmodSync', 'truncate', 'utimes', 'utimesSync']
const FS_METHODS = FS_READ.concat(FS_WRITE, FS_BOTH, FS_OTHER)
const EXEC_FNS = ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']

// 每个 sink 只看「路径实参」：writeFile 的第二个参数是数据，不是路径。
function pathArgIndexes(name) {
  if (FS_BOTH.includes(name)) return [0, 1]
  if (FS_WRITE.includes(name)) return [0]
  if (FS_OTHER.includes(name) || FS_READ.includes(name)) return [0]
  if (EXEC_FNS.includes(name)) return [0, 1]
  if (name === 'request.end' || name === 'request.write') return [0]
  if (name === 'http.request') return [0]
  return [0]
}

const SINK_RE = new RegExp(
  '(?:\\.|\\b(?:fs|fsp|fsPromises|promises|nodeFs)\\s*\\.\\s*)(' +
    FS_METHODS.join('|') +
    ')\\s*\\(|\\b(' +
    EXEC_FNS.join('|') +
    ')\\s*\\(|\\bhttp\\.request\\s*\\(|\\b(?:request|req|clientReq|proxyReq|outReq)\\s*\\.\\s*(end|write)\\s*\\(',
  'g'
)

function collectSinks(text) {
  const sinks = []
  SINK_RE.lastIndex = 0
  let m
  while ((m = SINK_RE.exec(text))) {
    const method = m[1] || m[2]
    const name = method || (m[0].includes('http.request') ? 'http.request' : 'request.' + m[3])

    // 正则的 .exec() / .test() 不是进程执行
    const before = text.slice(Math.max(0, m.index - 1), m.index)
    if (method === 'exec' && (before === '/' || /[_A-Z]RE$/.test(text.slice(Math.max(0, m.index - 40), m.index).trim()))) continue
    if (method === 'exec' && /\.\s*$/.test(text.slice(m.index - 2, m.index)) && /(?:RegExp|regex|re|RE)\s*$/.test(text.slice(Math.max(0, m.index - 40), m.index).replace(/\s+\.\s*$/, ''))) continue

    const open = text.indexOf('(', m.index + m[0].length - 1)
    if (open < 0) continue
    const close = matchParen(text, open)
    if (close < 0) continue
    const parts = splitTopArgs(text, open, close).filter((a) => !isCallbackArg(a))
    if (parts.length === 0) continue
    sinks.push({ name, index: m.index, parts, open, close })
  }
  return sinks
}

const BRIDGE_RE = /127\.0\.0\.1|localhost|0\.0\.0\.0|::1/

// ---------------------------------------------------------------------------
// 单文件分析
// ---------------------------------------------------------------------------

const PATHISH = /(?:[Pp]ath|[Ff]ilename|[Ff]ileName|[Dd]ir|[Dd]irectory|[Tt]arget|[Ss]rc|[Dd]est|[Dd]estination|[Ss]ave[Aa]s|[Ff]ile)/

function collectCallSites(text, fns) {
  const sites = []
  for (const f of fns) {
    if (!/^[A-Za-z0-9_$]+$/.test(f.name)) continue
    const re = new RegExp('(?:^|[^A-Za-z0-9_$.])' + escapeRe(f.name) + '\\s*\\(', 'g')
    let m
    while ((m = re.exec(text))) {
      const open = text.indexOf('(', m.index + m[0].length - 1)
      if (open < 0) continue
      if (open > f.bodyStart && open < f.bodyEnd) continue
      const close = matchParen(text, open)
      if (close < 0) continue
      sites.push({ callee: f, index: m.index, open, close, args: splitTopArgs(text, open, close).filter((a) => !isCallbackArg(a)) })
    }
  }
  return sites
}

function analyzeFile(file, src) {
  const text = blankComments(src)
  const findings = []
  const fns = collectFunctions(text)
  const derived = collectRequestDerived(text, fns)
  const sinks = collectSinks(text)
  const callSites = collectCallSites(text, fns)

  const isBridgeFile = BRIDGE_RE.test(text) && /http\.request\s*\(/.test(text)
  const entryish = /\bregister\s*\(|\bhandler\b|\bcreateServer\b|\bwebServer\b|\buse\s*\(\s*['"]\/|\broute\b|\bforward|\bopen\s*\(/.test(text)

  // 每个作用域：tainted（值来自外部）/ confined（来自外部但已被字符集+根约束住）
  const scope = new Map()
  for (const f of fns) scope.set(f, { tainted: new Set(), confined: new Set(), origins: new Map() })
  const moduleScope = { tainted: new Set(), confined: new Set(), origins: new Map() }
  const scopeOf = (fn) => (fn ? scope.get(fn) : moduleScope)

  function bodyOf(f) {
    if (!f) return text
    return text.slice(f.bodyStart, f.bodyEnd)
  }

  // 赋值传播：只在同一函数体内推进；跨函数交给调用点一跳
  function propagateIn(f) {
    const st = scopeOf(f)
    const body = bodyOf(f)
    const windowAll = f ? text.slice(f.bodyStart, f.bodyEnd) : text
    let changed = false

    const assign = /(?:const|let|var)?\s*([A-Za-z0-9_$]+)\s*=(?!=)\s*([^\n;]+)/g
    let a
    while ((a = assign.exec(body))) {
      const name = a[1]
      const rhs = a[2]
      if (st.tainted.has(name) || st.confined.has(name)) continue
      const v = valueTaint(rhs, st.tainted, derived)
      if (!v.tainted) continue
      const before = windowAll.slice(0, assign.lastIndex - a[0].length)
      const ids = v.ids.filter((x) => !x.startsWith('call:'))
      const allConfined = ids.length > 0 && ids.every((id) => {
        if (st.confined.has(id)) return true
        if (namedRegexGuarding(text, before, id)) return true
        if (sanitizedBefore(rhs, id)) return true
        return false
      })
      if (allConfined && joinUnderConstRoot(rhs)) {
        st.confined.add(name)
        st.origins.set(name, '派生自受约束的 ' + ids.join(',') + '，拼在固定根下')
      } else if (allConfined) {
        st.confined.add(name)
        st.origins.set(name, '字符集约束后的 ' + ids.join(','))
      } else {
        st.tainted.add(name)
        st.origins.set(name, 'var:' + (ids[0] || v.why))
      }
      changed = true
    }

    const destr = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([^\n;]+)/g
    while ((a = destr.exec(body))) {
      const names = a[1].split(',').map((x) => x.trim().split(':').pop().trim()).filter(Boolean)
      const v = valueTaint(a[2], st.tainted, derived)
      if (!v.tainted) continue
      for (const n of names) {
        if (st.tainted.has(n) || st.confined.has(n)) continue
        st.tainted.add(n)
        st.origins.set(n, 'var:' + (v.ids[0] || v.why))
        changed = true
      }
    }
    return changed
  }

  function propagateCalls() {
    let changed = false
    for (const site of callSites) {
      const caller = enclosing(fns, site.index)
      const callerScope = scopeOf(caller)
      site.args.forEach((arg, i) => {
        const callee = site.callee
        const param = callee.params[i]
        if (!param || callee === caller) return
        const target = scopeOf(callee)
        if (target.tainted.has(param) || target.confined.has(param)) return
        const v = valueTaint(arg, callerScope.tainted, derived)
        const confinedIds = [...callerScope.confined]
        const argIsConfined = v.tainted && v.ids.every((id) => confinedIds.includes(id) || callerScope.confined.has(id))
        if (v.tainted && !argIsConfined) {
          const callerWindow = caller ? text.slice(caller.bodyStart, site.index) : text.slice(0, site.index)
          const ids = v.ids.filter((x) => !x.startsWith('call:'))
          const guardedByRegex = ids.length > 0 && ids.every((id) => namedRegexGuarding(text, callerWindow, id) || sanitizedBefore(arg, id))
          if (guardedByRegex) {
            target.confined.add(param)
            target.origins.set(param, '调用点已做字符集约束')
          } else {
            target.tainted.add(param)
            target.origins.set(param, 'var:' + (ids[0] || v.why) + (caller ? '（经 ' + caller.name + ' 调用点）' : '（经模块顶层传入）'))
          }
          changed = true
        } else if (v.tainted && argIsConfined) {
          target.confined.add(param)
          target.origins.set(param, '调用点传入的值已受约束')
          changed = true
        }
      })
    }
    return changed
  }

  propagateIn(null)
  for (let round = 0; round < 6; round += 1) {
    let changed = propagateCalls()
    for (const f of fns) if (propagateIn(f)) changed = true
    if (!changed) break
  }

  function resolveParamAtCallSites(fn, param) {
    const sites = callSites.filter((s) => s.callee === fn)
    if (sites.length === 0) return { resolved: false, why: '文件内没有调用点（跨模块入口）' }
    const idx = fn.params.indexOf(param)
    if (idx < 0) return { resolved: false, why: '形参位置不明' }
    let dynamic = false
    for (const s of sites) {
      const arg = s.args[idx]
      if (arg === undefined) continue
      const caller = enclosing(fns, s.index)
      const v = valueTaint(arg, scopeOf(caller).tainted, derived)
      if (v.tainted) return { resolved: false, why: '有调用点喂了外部输入' }
      if (PATHISH.test(arg) && !/^['"`]/.test(arg) && !/^[A-Za-z0-9_$]+$/.test(arg)) dynamic = true
    }
    if (dynamic) return { resolved: false, why: '有调用点实参是动态表达式' }
    return { resolved: true, why: '调用点实参全是常量或内部值（' + sites.length + ' 处）' }
  }

  // 只有形状判据、没有系统调用的地方（office-kit 的 part name、前端「像不像路径」）
  const shapeOnly = []

  for (const sink of sinks) {
    if ((sink.name === 'request.end' || sink.name === 'request.write' || sink.name === 'http.request') && !isBridgeFile) continue

    const fn = enclosing(fns, sink.index)
    const st = scopeOf(fn)
    const idxs = pathArgIndexes(sink.name)
    const pathArgsText = idxs.map((i) => sink.parts[i]).filter((x) => x !== undefined)
    if (pathArgsText.length === 0) continue
    const joined = pathArgsText.join(' , ')
    const line = lineOf(src, sink.index)
    const ctx = {
      file,
      line,
      sink: sink.name,
      func: fn ? fn.name : '(top-level)',
      args: joined.replace(/\s+/g, ' ').slice(0, 120),
    }

    const v = valueTaint(joined, st.tainted, derived)
    if (!v.tainted) {
      // 追不到来源，但是「像路径的形参」且这文件是入口形态 → 判不了，不许写成不是雷
      const idm = /(?:^|[^A-Za-z0-9_$.])([A-Za-z0-9_$]+)(?![A-Za-z0-9_$])/.exec(joined)
      const id = idm && idm[1]
      if (id && PATHISH.test(id) && fn && fn.params.includes(id) && entryish) {
        const r = resolveParamAtCallSites(fn, id)
        if (r.resolved) {
          findings.push({ ...ctx, kind: 'not-leak', reason: '调用点喂的不是外部输入：' + r.why })
        } else {
          findings.push({ ...ctx, kind: 'undecidable', reason: '形参 <' + id + '> ' + r.why + '，不能当成不是雷' })
        }
        continue
      }
      findings.push({ ...ctx, kind: 'not-leak', reason: '路径实参不来自外部输入' })
      continue
    }

    // 子进程那类 sink 要看整段命令行：路径可能藏在数组里或 spread 进来。
    // 但只凭「外部串进了 argv」还不能定罪 —— 子进程拿它当文本还是当路径，这个文件看不到，
    // 所以不是路径形状的落「判不了」，不许静默算过。
    if (EXEC_FNS.includes(sink.name)) {
      const waved = idsMentioned(joined, st.tainted)
      const pathish = waved.some((id) => PATHISH.test(id))
      if (!pathish) {
        const ids = idsMentioned(joined, st.tainted)
        const cmd = (sink.parts[0] || '').trim()
        const literalCmd = /^['"`][^'"`]*['"`]$/.test(cmd)
        const shellLike = /^['"`](?:\/bin\/)?(?:sh|bash|zsh|fish|cmd|powershell|pwsh)['"`]$/.test(cmd)
        if (ids.length > 0 && literalCmd && !shellLike) {
          // 命令本身是写死的（git / node / rm 这种），透传的只是文本 token：
          // 不进 shell 解释，也不当路径用，就不是这一类雷。
          findings.push({ ...ctx, kind: 'not-leak', reason: '子进程命令是字面量，透传的 ' + ids.slice(0, 4).join(',') + ' 是文本参数、不是路径' })
          continue
        }
        if (ids.length > 0 && entryish) {
          findings.push({
            ...ctx,
            kind: 'undecidable',
            reason: '外部输入整段进了子进程命令行（' + ids.slice(0, 4).join(',') + '），参数名看不出是路径；子进程怎么用这些 token，本文件追不到',
          })
          continue
        }
      }
    }

    const realIds = v.ids.filter((x) => !x.startsWith('call:'))
    const allConfined = realIds.length > 0 && realIds.every((id) => st.confined.has(id) || /派生|约束/.test(st.origins.get(id) || ''))
    if (allConfined) {
      findings.push({ ...ctx, kind: 'not-leak', reason: '已拦：值受字符集/根约束（' + realIds.map((id) => st.origins.get(id) || id).join('；') + '）' })
      continue
    }

    const window = text.slice(fn ? fn.bodyStart : Math.max(0, sink.index - 4000), sink.index)
    const regexHit = realIds.map((id) => namedRegexGuarding(text, window, id)).find(Boolean)
    if (regexHit) {
      findings.push({
        ...ctx,
        kind: 'not-leak',
        reason: '已拦：命名白名单正则 ' + regexHit + ' 限住字符集' + (joinUnderConstRoot(joined) ? '，再拼在固定根下' : ''),
        taint: v.why,
      })
      continue
    }
    const g = guardVerdict(text, window)
    if (g.result === 'guarded') {
      findings.push({ ...ctx, kind: 'not-leak', reason: '已拦：' + g.why, taint: v.why })
      continue
    }
    const anti = antiGuardReason(window)
    findings.push({
      ...ctx,
      kind: 'leak',
      reason: '外部输入（' + (st.origins.get(realIds[0]) || v.why) + '）直通 ' + sink.name + '，' + (anti ? anti + ' 只证明形状、不算校验' : '输入点与调用点之间没有 realpath/根前缀校验'),
      taint: st.origins.get(realIds[0]) || v.why,
    })
  }

  // 全文里的「形状判据」单独数出来：这些不是雷，但要能看见它们确实被区分了
  const sinkWindows = []
  for (const sink of sinks) {
    const fn = enclosing(fns, sink.index)
    sinkWindows.push([fn ? fn.bodyStart : sink.index, sink.index])
  }
  const scan = new RegExp(PATH_SHAPE_GUARDS.map((g) => g.re.source).join('|'), 'g')
  let am
  while ((am = scan.exec(text))) {
    const inSink = sinkWindows.some(([s, e]) => am.index >= s && am.index <= e)
    if (inSink) continue
    const hit = PATH_SHAPE_GUARDS.find((g) => g.re.test(am[0]))
    shapeOnly.push({ file, line: lineOf(src, am.index), pattern: hit ? hit.why : '形状判据' })
  }

  return { findings, shapeOnly }
}

// ---------------------------------------------------------------------------
// 扫树
// ---------------------------------------------------------------------------

const SKIP_DIR_NAMES = new Set(['.git', '.cache', 'backups'])
const SKIP_DIR_PREFIX = ['web.skel-bak', 'web.userlayer', '.npm']

function walk(root) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      throw new Error('读不到目录：' + dir + '（' + e.message + '）')
    }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue
        if (SKIP_DIR_PREFIX.some((x) => e.name.startsWith(x))) continue
        stack.push(p)
        continue
      }
      if (!/\.(js|mjs|cjs)$/.test(e.name)) continue
      out.push(p)
    }
  }
  return out
}

function isVendorish(p) {
  // node_modules 里只留第一方包（dsh-*、@deepseek-ai/dsh-*、@office-kit/*）。
  // office-kit 必须留着：它是这一轮判据的负样本，得真的被判成「不是雷」，不能靠不扫它蒙混。
  const norm = p.split(path.sep).join('/')
  const re = /node_modules\/(@[^/]+\/[^/]+|[^/@][^/]*)\//g
  let m
  while ((m = re.exec(norm))) {
    const pkg = m[1]
    if (/^dsh-/.test(pkg)) continue
    if (/^@deepseek-ai\/dsh-/.test(pkg)) continue
    if (/^@office-kit\//.test(pkg)) continue
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return { existingLeaks: [], undecidedReviewed: [], meta: {} }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  } catch (e) {
    console.error('✗ baseline 读不了：' + BASELINE_FILE + '（' + e.message + '）')
    process.exit(EXIT_BROKEN)
  }
  return {
    existingLeaks: Array.isArray(raw.existingLeaks) ? raw.existingLeaks : [],
    undecidedReviewed: Array.isArray(raw.undecidedReviewed) ? raw.undecidedReviewed : [],
    meta: raw.meta || {},
  }
}

// 稳定身份：包名 + 包内相对路径 + sink 名（不带行号，行号会漂）
function packageKeyOf(file) {
  const norm = file.split(path.sep).join('/')
  let m = /node_modules\/(@[^/]+\/[^/]+)\/(.*)$/.exec(norm)
  if (m) return m[1] + '/' + m[2]
  m = /node_modules\/([^/@][^/]*)\/(.*)$/.exec(norm)
  if (m) return m[1] + '/' + m[2]
  m = /\/plugins\/([^/]+)\/(.*)$/.exec(norm)
  if (m) return m[1] + '/' + m[2]
  return norm.split('/').slice(-2).join('/')
}

function keyOf(f) {
  return packageKeyOf(f.file) + '::' + f.func + '::' + f.sink
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(argv) {
  const jsonOut = argv.includes('--json')
  const strict = argv.includes('--strict')
  const includeFixtures = argv.includes('--include-fixtures')
  const listNotLeak = argv.includes('--list-notleak')
  const jsonDetail = argv.includes('--json-detail')
  const roots = argv.filter((a) => !a.startsWith('--'))

  if (roots.length === 0) {
    console.error('✗ 至少给一个扫描根目录')
    process.exit(EXIT_BROKEN)
  }

  const all = []
  const allShapeOnly = []
  const excludedFixtures = []
  let fileCount = 0
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      console.error('✗ 扫描根不存在：' + root)
      process.exit(EXIT_BROKEN)
    }
    for (const f of walk(root)) {
      const abs = path.resolve(f)
      if (!includeFixtures && abs.split(path.sep).join('/').includes('/' + FIXTURE_PREFIX.split(path.sep).join('/') + '/')) {
        excludedFixtures.push(abs)
        continue
      }
      if (isVendorish(abs)) continue
      let src
      try {
        src = fs.readFileSync(abs, 'utf8')
      } catch (e) {
        console.error('✗ 读不到文件：' + abs + '（' + e.message + '）')
        process.exit(EXIT_BROKEN)
      }
      fileCount += 1
      let res
      try {
        res = analyzeFile(abs, src)
      } catch (e) {
        // 分析器自己崩了绝不能被当成「干净」
        console.error('✗ 分析失败（判据失效，不是通过）：' + abs + '（' + e.message + '）')
        process.exit(EXIT_BROKEN)
      }
      all.push(...res.findings)
      allShapeOnly.push(...res.shapeOnly)
    }
  }

  const baseline = loadBaseline()
  const baseKeys = new Map(baseline.existingLeaks.map((e) => [e.key, e]))
  const undecidedKeys = new Map(baseline.undecidedReviewed.map((e) => [e.key, e]))

  const leaks = all.filter((f) => f.kind === 'leak')
  const undecided = all.filter((f) => f.kind === 'undecidable')
  const notLeak = all.filter((f) => f.kind === 'not-leak')

  const legacy = []
  const fresh = []
  const byKey = new Map()
  for (const f of leaks) {
    const k = keyOf(f)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(f)
  }
  for (const [k, group] of byKey) {
    const base = baseKeys.get(k)
    const allowed = base ? base.count || 1 : 0
    const sorted = group.slice().sort((a, b) => a.line - b.line)
    sorted.forEach((f, i) => {
      if (i < allowed) legacy.push({ ...f, key: k, remedy: base && base.remedy })
      else fresh.push({ ...f, key: k })
    })
  }

  const undecidedByKey = new Map()
  for (const f of undecided) {
    const k = keyOf(f)
    if (!undecidedByKey.has(k)) undecidedByKey.set(k, [])
    undecidedByKey.get(k).push(f)
  }
  const unreviewedUndecided = []
  const reviewedUndecided = []
  for (const [k, group] of undecidedByKey) {
    const base = undecidedKeys.get(k)
    const allowed = base ? base.count || 1 : 0
    group.slice().sort((a, b) => a.line - b.line).forEach((f, i) => {
      if (i < allowed) reviewedUndecided.push({ ...f, key: k })
      else unreviewedUndecided.push({ ...f, key: k })
    })
  }

  // 存量条目里，落空的才算失效；条数变少但还在的，只是少了一条，不整条删
  const stale = baseline.existingLeaks.filter((e) => !byKey.has(e.key))
  const shrunk = baseline.existingLeaks.filter((e) => byKey.has(e.key) && byKey.get(e.key).length < (e.count || 1))
  const staleUndecided = baseline.undecidedReviewed.filter((e) => !undecidedByKey.has(e.key))

  const notLeakByReason = new Map()
  for (const f of notLeak) {
    const bucket = f.reason.startsWith('已拦')
      ? '已拦（有真校验）'
      : f.reason.startsWith('调用点')
        ? '调用点实参不是外部输入'
        : '路径实参不来自外部输入'
    notLeakByReason.set(bucket, (notLeakByReason.get(bucket) || 0) + 1)
  }

  if (jsonDetail) {
    // 逐条明细：判完之后的分析用这个，不是给闸用的
    console.log(JSON.stringify({
      scannedFiles: fileCount,
      findings: all.map((f) => ({
        file: f.file,
        line: f.line,
        sink: f.sink,
        func: f.func,
        kind: f.kind,
        reason: f.reason,
        taint: f.taint || '',
        args: f.args || '',
        key: keyOf(f),
      })),
      shapeOnly: allShapeOnly,
    }, null, 2))
    process.exit(EXIT_OK)
  }

  if (jsonOut) {
    console.log(JSON.stringify({
      scannedFiles: fileCount,
      excludedFixtures: excludedFixtures.length,
      sinkSites: all.length,
      legacy, fresh, unreviewedUndecided, reviewedUndecided, stale, shrunk, staleUndecided,
      notLeakByReason: Object.fromEntries(notLeakByReason),
      shapeOnly: allShapeOnly.length,
    }, null, 2))
  } else {
    const L = (s = '') => console.log(s)
    const rel = (p) => p.replace(process.cwd() + path.sep, '')
    L('==================================================================')
    L(' 外部输入直通系统调用 · 门禁')
    L(' 扫描根：' + roots.join('  '))
    L(' 扫了 ' + fileCount + ' 个 JS 文件，命中系统调用点 ' + all.length + ' 处')
    L('   其中：雷 ' + leaks.length + '（存量 ' + legacy.length + ' / 新增 ' + fresh.length + '）、判不了 ' + undecided.length + '、不是雷 ' + notLeak.length)
    L(' 另有「只有形状判据、没有系统调用」 ' + allShapeOnly.length + ' 处（office-kit 的 part name、前端像不像路径，都落这档）')
    if (excludedFixtures.length) L(' 跳过夹具 ' + excludedFixtures.length + ' 个文件（tools/test/fixtures）')
    L('==================================================================')

    if (legacy.length) {
      L('')
      L('【存量待清】' + legacy.length + ' 条 —— 现在就在的雷，不算失败，但每条都得能消')
      for (const f of legacy) {
        L('  · ' + rel(f.file) + ':' + f.line + '  [' + f.sink + ']  在 ' + f.func + '() 里')
        L('      路径实参：' + f.args)
        L('      输入来源：' + (f.taint || '?'))
        L('      现在为什么能被利用：' + f.reason)
        L('      清法：' + (f.remedy || '⚠ baseline 里没写清法，补上'))
        L('      怎么验：清完之后这一条会从本清单里消失；若变成「新增违规」说明改出了新的口子')
      }
    }

    if (fresh.length) {
      L('')
      L('【新增违规】' + fresh.length + ' 条 —— 这一类形状不许再进来')
      for (const f of fresh) {
        L('  ✗ ' + rel(f.file) + ':' + f.line + '  [' + f.sink + ']  在 ' + f.func + '() 里')
        L('      路径实参：' + f.args)
        L('      判据：' + f.reason)
        L('      改法：输入点上做字符集白名单 + 拼在固定根下（或 realpath 后比根前缀），再交给系统调用')
      }
    }

    L('')
    if (unreviewedUndecided.length) {
      L('【判不了】' + unreviewedUndecided.length + ' 条未登记 —— 不算过，也不算雷。要么复核后登记，要么改清楚')
      for (const f of unreviewedUndecided) {
        L('  ? ' + rel(f.file) + ':' + f.line + '  [' + f.sink + ']  在 ' + f.func + '() 里')
        L('      路径实参：' + f.args)
        L('      ' + f.reason)
      }
    } else {
      L('【判不了】0 条未登记（已复核 ' + reviewedUndecided.length + ' 条，见 baseline）')
    }

    L('')
    L('【不是雷】' + notLeak.length + ' 条（按理由）')
    for (const [k, v] of notLeakByReason) L('  · ' + k + '：' + v)
    if (listNotLeak) {
      for (const f of notLeak.slice(0, 40)) L('      - ' + rel(f.file) + ':' + f.line + ' [' + f.sink + '] ' + f.reason)
    }

    if (stale.length || staleUndecided.length || shrunk.length) {
      L('')
      L('【baseline 该收了】' + (stale.length + staleUndecided.length + shrunk.length) + ' 条 —— 条目对不上现状，删掉或改 counts，闸才能跟着收')
      for (const e of stale) L('  - ' + e.key + '（存量条目不再复现，删）')
      for (const e of staleUndecided) L('  - ' + e.key + '（判不了条目不再复现，删）')
      for (const e of shrunk) L('  - ' + e.key + '（登记 ' + (e.count || 1) + ' 条，只复现 ' + byKey.get(e.key).length + ' 条，改小 counts）')
    }

    L('')
    L('------------------------------------------------------------------')
    if (fresh.length || unreviewedUndecided.length) {
      L('✗ 失败：新增违规 ' + fresh.length + ' 条，未登记判不了 ' + unreviewedUndecided.length + ' 条')
    } else if (strict && legacy.length) {
      L('✗ strict：还有 ' + legacy.length + ' 条存量待清')
    } else {
      L('✓ 通过：没有新增违规，判不了都在册')
    }
  }

  if (fresh.length || unreviewedUndecided.length) process.exit(EXIT_VIOLATION)
  if (strict && legacy.length) process.exit(EXIT_STALE)
  process.exit(EXIT_OK)
}

main(process.argv.slice(2))
