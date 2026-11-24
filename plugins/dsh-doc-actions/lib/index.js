/**
 * dsh-doc-actions —— Node 半边：把页面上的「打开 / 文件夹 / 分享」转给 App 壳的 /open 桥。
 *
 * 为什么不在浏览器里直接打 127.0.0.1:3081：本地桥自 v1.55 起统一校验 X-DSH-Token，
 * 而这个密钥只存在于 App 进程（prefs）与引擎 env（APP_LOCAL_TOKEN），页面拿不到 ——
 * 插件直连只会被 401 挡成「连不上 App 桥」，按钮点了没反应。所以改由引擎侧代发：
 * 页面同源 POST /doc-actions/open → 这里带上密钥转给壳 → 壳用系统应用打开。
 *
 * 浏览器半边 lib/client.js 由 dsh-client-modules 读取并下发给页面；本文件只负责
 * 一条路由。密钥拿不到（非 Android 壳、或老壳没有 /open）时如实回错误，不假装成功。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'


/** Cordis 插件名。 */
export const name = 'dsh-doc-actions'

/** 不依赖任何 Cordis 服务（webServer 用 ctx.inject 懒取，缺了就不挂路由）。 */
export const inject = []

/** 页面同源调用的前缀。 */
const PREFIX = '/doc-actions'

/** App 壳的文件动作桥（MainActivity 的 handleOpenRequest）。 */
const BRIDGE_PORT = Number(process.env.DSH_OPEN_BRIDGE_PORT || 3081)
const BRIDGE_HOST = '127.0.0.1'
const BRIDGE_PATH = '/open'

/** 壳只认这三个动作；其余一律拒在引擎侧，别让页面乱试。 */
const ACTIONS = new Set(['view', 'reveal', 'share'])

/** App 私有工作区（引擎 env 的 HOME 就是它，换壳/换克隆会变，别硬编码死）。 */
const FILES_ROOT = process.env.HOME || '/data/user/0/com.deepseek.harness/files'

/**
 * 允许做文件动作的根。页面给的是绝对路径（文档预览器给的 props.absolutePath），
 * 所以不能要求相对路径；但也不能什么绝对路径都往壳里递 —— 只认用户可见存储
 * （/sdcard 在 Android 上是指向 /storage/emulated/0 的符号链接，比对时两种写法都算）
 * 和 App 自己的私有工作区。要收紧就用 DSH_DOC_ACTIONS_ROOTS（冒号分隔）整组替换。
 */
const DEFAULT_ROOTS = ['/sdcard', FILES_ROOT]

/**
 * 根内也要挡掉的子树：引擎本体、会话记录、记忆库是引擎内部数据，不是「用户文件」，
 * 不该有「打开 / 分享」的入口。$F 整体保留（App 自己产出的东西还要能打开），
 * 只排这几块；记忆库真身在 /sdcard/DeepSeekHarness/memory，一起排。
 */
const DENY_SUBTREES = [
  path.join(FILES_ROOT, 'payload'),
  path.join(FILES_ROOT, 'sessions'),
  path.join(FILES_ROOT, 'memory'),
  path.join(FILES_ROOT, '.claude'),
  path.join(FILES_ROOT, 'life.db'),
  '/sdcard/DeepSeekHarness/memory',
]

/**
 * $F 顶层的会话转写文件（session-<uuid>.jsonl）：会不断新增，没法逐个列进常量，
 * 按文件名认；只认 $F 顶层，不为此逐层翻目录。
 */
const SESSION_FILE_RE = /^session-[0-9a-f-]{8,}\.jsonl$/i

const uniq = (list) => Array.from(new Set(list))

function configuredRoots() {
  const fromEnv = String(process.env.DSH_DOC_ACTIONS_ROOTS || '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean)
  return fromEnv.length > 0 ? fromEnv : DEFAULT_ROOTS
}

/**
 * Android 上 /data/user/0/<pkg> 与 /data/data/<pkg> 是同一个目录的两种写法，
 * 按前缀推导别名（不写死包名，换包名也成立）：两边互相补一份。
 */
const DATA_ALIASES = [
  [/^\/data\/user\/0(\/.*)?$/, '/data/data'],
  [/^\/data\/data(\/.*)?$/, '/data/user/0'],
]

function aliasForms(target) {
  const out = [target]
  for (const [pattern, base] of DATA_ALIASES) {
    const matched = pattern.exec(target)
    if (matched) out.push(base + (matched[1] || ''))
  }
  return out
}

/**
 * 同一棵树的写法：词法形式（原样 resolve，可能是软链如 /sdcard）、realpath，
 * 以及上面的 /data/user/0 ↔ /data/data 别名。
 * 少了词法那份，页面递 /sdcard/... 会被 realpath 根（/storage/emulated/0）判成越界；
 * 少了 realpath 那份，递 /storage/emulated/0/... 又会被词法根判出去；别名那份同理。全都算。
 */
function bothForms(target) {
  const out = []
  for (const form of aliasForms(path.resolve(target))) {
    out.push(form)
    try {
      out.push(fs.realpathSync(form))
    } catch {
      /* 不存在就只剩词法形式 */
    }
  }
  return out
}

/** 白名单根的真实路径；解析失败的根直接丢掉，不留没规范化的写法。 */
export function allowedRoots() {
  const out = []
  for (const root of configuredRoots()) {
    try {
      out.push(fs.realpathSync(root))
    } catch {
      /* 根不存在就当它不存在 */
    }
  }
  return uniq(out)
}

/** 词法比对用的根：原样 + realpath 都要算（见 bothForms 的理由）。 */
function lexicalRoots() {
  const out = []
  for (const root of configuredRoots()) out.push(...bothForms(root))
  return uniq(out)
}

/** 禁止交给壳的子树（原样 + realpath 两种写法，防软链绕进来）。 */
export function deniedSubtrees() {
  const out = []
  for (const tree of DENY_SUBTREES) out.push(...bothForms(tree))
  return uniq(out)
}

function within(candidate, trees) {
  return trees.some((tree) => {
    // 根是 / 时 tree + path.sep 会拼成 //，永远匹配不上 —— 尾部分隔符已经有了就别再补
    const prefix = tree.endsWith(path.sep) ? tree : tree + path.sep
    return candidate === tree || candidate.startsWith(prefix)
  })
}

/** 禁区判断：前缀树 + $F 顶层的会话转写文件名。 */
export function isDenied(candidate) {
  if (within(candidate, deniedSubtrees())) return true
  if (!SESSION_FILE_RE.test(path.basename(candidate))) return false
  const dir = path.dirname(candidate)
  return bothForms(FILES_ROOT).includes(dir)
}

/** 越界与禁区的答复文案统一：不告诉页面到底是被白名单挡的还是被 denylist 挡的。 */
const OUT_OF_ROOTS = '路径不在允许的目录内'

/**
 * 校验一个路径能不能交给壳：返回 { ok: true, path: 真实路径 } 或 { ok: false, status, error }。
 * 拒绝之后调用方不许再拿原始字符串去用 —— 校验的意义就在这。
 *
 * 两段检查各管一段，顺序不能换：
 *   ① 词法（path.resolve，不碰文件系统）：越界/禁区立刻 400。
 *      先 realpath 再判根会先 stat，于是「越界但不存在 → 404、越界但存在 → 400」，
 *      任意页面都能拿这两种答复当存在性探针用。词法这一段就是来堵它的。
 *   ② realpath 之后再判一次：词法过关不代表真实落点还在根内（软链逃逸）。
 */
export function guardPath(input, roots) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, status: 400, error: '缺少绝对路径' }
  }
  const raw = input.trim()
  if (!path.isAbsolute(raw)) return { ok: false, status: 400, error: '缺少绝对路径' }

  const realRoots = roots === undefined ? uniq(allowedRoots().flatMap(aliasForms)) : uniq(roots.flatMap(aliasForms))
  const lexRoots = roots === undefined ? lexicalRoots() : uniq(roots.flatMap(bothForms))

  // ① 词法阶段：只做字符串比对，不做任何文件系统探测
  const lexical = path.resolve(raw)
  if (!within(lexical, lexRoots) || isDenied(lexical)) {
    return { ok: false, status: 400, error: OUT_OF_ROOTS + ': ' + raw }
  }

  // ② 真实路径阶段
  let real
  try {
    real = fs.realpathSync(lexical)
  } catch (error) {
    // 真不存在是 404；解析不了（EACCES 等）是 400 —— 别把「读不了」说成「不存在」
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { ok: false, status: 404, error: '文件不存在: ' + raw }
    }
    return { ok: false, status: 400, error: '路径无法解析: ' + raw }
  }
  if (!within(real, realRoots) || isDenied(real)) {
    return { ok: false, status: 400, error: OUT_OF_ROOTS + ': ' + raw }
  }
  return { ok: true, path: real }
}

/** 一次转发最多读这么多 body：路径 + 动作，正常不到 1KB。 */
const MAX_BODY = 8 * 1024

/** 桥超时。壳要拉起系统应用，给得比一般请求宽一点。 */
const BRIDGE_TIMEOUT_MS = 8000

/** 本机桥共享密钥：App 经 env 注入给引擎。 */
function bridgeToken() {
  return String(process.env.APP_LOCAL_TOKEN || process.env.DSH_LOCAL_TOKEN || '').trim()
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * POST 一次 /open。
 * @param {{path: string, action: string}} payload 页面传来的文件与动作。
 * @param {string} token 本机桥密钥；空串表示拿不到（直接回错误，别白跑一趟）。
 * @param {{port?: number, host?: string}} [opts] 测试用的覆盖项。
 * @returns {Promise<{ok: boolean, error?: string}>} 壳的判定，或本地失败原因。
 */
export function forwardOpen(payload, token, opts) {
  const port = (opts && opts.port) || BRIDGE_PORT
  const host = (opts && opts.host) || BRIDGE_HOST
  if (token === '') {
    return Promise.resolve({ ok: false, error: '引擎没有拿到本机桥密钥（APP_LOCAL_TOKEN），打不开 App 桥' })
  }
  const body = JSON.stringify({ path: payload.path, action: payload.action })
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = http.request(
      {
        host,
        port,
        path: BRIDGE_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-dsh-token': token,
        },
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => {
          let data = null
          try {
            data = JSON.parse(text)
          } catch {
            /* 非 JSON 一律按"桥答得不对"处理 */
          }
          if (data !== null && typeof data === 'object') {
            finish(data.ok === true ? { ok: true } : { ok: false, error: String(data.error || 'App 桥拒绝了这次打开') })
            return
          }
          finish({ ok: false, error: 'App 桥返回了无法解析的内容（HTTP ' + response.statusCode + '）' })
        })
      },
    )
    request.setTimeout(BRIDGE_TIMEOUT_MS, () => {
      request.destroy()
      finish({ ok: false, error: 'App 桥超时未应答' })
    })
    request.on('error', (error) => {
      finish({ ok: false, error: '连不上 App 桥（' + (error && error.message ? error.message : String(error)) + '）' })
    })
    request.end(body)
  })
}

/** 读完 body（有限长度），给路由用。 */
function readBody(req) {
  return new Promise((resolve) => {
    let text = ''
    let over = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (over) return
      text += chunk
      if (text.length > MAX_BODY) {
        over = true
        resolve('')
      }
    })
    req.on('end', () => {
      if (!over) resolve(text)
    })
    req.on('error', () => resolve(''))
  })
}

async function handleOpen(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只支持 POST' })
    return
  }
  const raw = await readBody(req)
  let input = null
  try {
    input = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { ok: false, error: '请求体不是 JSON' })
    return
  }
  const rawPath = input && typeof input.path === 'string' ? input.path.trim() : ''
  const action = input && typeof input.action === 'string' ? input.action.trim() : 'view'
  const verdict = guardPath(rawPath)
  if (verdict.ok !== true) {
    sendJson(res, verdict.status, { ok: false, error: verdict.error })
    return
  }
  if (!ACTIONS.has(action)) {
    sendJson(res, 400, { ok: false, error: '不认识的动作: ' + action })
    return
  }
  const result = await forwardOpen({ path: verdict.path, action }, bridgeToken())
  sendJson(res, 200, result)
}

/** 只放行同源页面来的 POST：与自建页面路由同一套 connection 判据。 */
function admitted(ctx, req, res) {
  const conn = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (conn === undefined || typeof conn.admit !== 'function') return true
  const verdict = conn.admit(req)
  if (verdict !== undefined && verdict.rejection !== undefined) {
    res.writeHead(verdict.rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(verdict.rejection === 401 ? 'dsh web authentication required.\n' : undefined)
    return false
  }
  return true
}

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: PREFIX,
          handler: (req, res) => {
            if (!admitted(webCtx, req, res)) return
            handleOpen(req, res).catch((error) => {
              try {
                sendJson(res, 500, { ok: false, error: '文档动作转发失败: ' + String((error && error.message) || error) })
              } catch {
                /* 头已发 */
              }
            })
          },
        }),
      'doc-actions: ' + PREFIX + ' 路由',
    )
  })
}
