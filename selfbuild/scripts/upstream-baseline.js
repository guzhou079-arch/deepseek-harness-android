#!/usr/bin/env node
/**
 * upstream-baseline.js —— 内核「改上游」补丁的漂移基线工具
 *
 * 解决的问题：我们有一批补丁是**整文件覆盖上游文件**。内核升级后，无法判断
 * 「上游到底改没改这个文件」——因为手上只有我们改过的副本，源码树也没有 .git。
 *
 * 做法：从 npm 官方包下载**原版文件**存成基线。升级时再下新版原版，两边一 diff
 * 就知道官方改了哪些行、我们的补丁要不要 rebase。
 *
 *   node upstream-baseline.js build            # 为当前内核版本建基线
 *   node upstream-baseline.js check <version>  # 用新版原版做漂移对比（升级前跑）
 *   node upstream-baseline.js list             # 列出基线内容
 *
 * 基线存在 selfbuild/upstream-baseline/v<kernelVersion>/ 下，按 payload 相对路径镜像。
 * 自研包（官方没有）与项目自有资产（官方没有该文件）会被标记为「无需基线」，不是错误。
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const R = process.env.DSH_PROJECT || path.join(__dirname, '../..')
const SB = path.join(R, 'selfbuild')
const PAYLOAD = '/data/user/0/com.deepseek.harness/files/payload'
const MANIFEST = path.join(SB, 'checks.manifest')
const BASELINE_ROOT = path.join(SB, 'upstream-baseline')
const REGISTRY = 'https://registry.npmjs.org'

/** payload 相对路径里的内核包前缀 */
const PREFIX = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'

function kernelVersion() {
  const p = path.join(PAYLOAD, 'dshroot/lib/node_modules/@deepseek-ai/dsh/package.json')
  return JSON.parse(fs.readFileSync(p, 'utf8')).version
}

/** 从清单取「改上游」的条目（关键字是哨兵 `-` 的不算补丁） */
function patchedEntries() {
  return fs.readFileSync(MANIFEST, 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('|'))
    .filter(r => r[2] && r[2] !== '-')
    .map(r => r[0])
    .filter(p => p.startsWith(PREFIX))
}

/** payload 相对路径 → { pkg, rel } */
function splitPkg(payloadPath) {
  const rest = payloadPath.slice(PREFIX.length)
  const i = rest.indexOf('/')
  return i < 0 ? null : { pkg: '@deepseek-ai/' + rest.slice(0, i), rel: rest.slice(i + 1) }
}

async function fetchTarball(pkg, version) {
  const meta = await fetch(`${REGISTRY}/${encodeURIComponent(pkg).replace('%40', '@')}/${version}`)
  if (!meta.ok) throw new Error(`registry ${meta.status}`)
  const j = await meta.json()
  const url = j?.dist?.tarball
  if (!url) throw new Error('no dist.tarball')
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
  return buf
}

function extractMember(tgzBuf, member) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-'))
  const f = path.join(tmp, 'p.tgz')
  fs.writeFileSync(f, tgzBuf)
  try {
    // tar 里成员前缀是 package/
    execFileSync('tar', ['xzf', f, '-C', tmp, `package/${member}`], { stdio: 'pipe' })
    return fs.readFileSync(path.join(tmp, 'package', member))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function md5(bufOrPath) {
  const c = require('node:crypto')
  const b = Buffer.isBuffer(bufOrPath) ? bufOrPath : fs.readFileSync(bufOrPath)
  return c.createHash('md5').update(b).digest('hex')
}

async function build() {
  const ver = kernelVersion()
  const out = path.join(BASELINE_ROOT, `v${ver}`)
  fs.mkdirSync(out, { recursive: true })
  const entries = patchedEntries()
  console.log(`内核版本 ${ver}，需要建基线的「改上游」条目 ${entries.length} 个\n`)

  const index = { kernelVersion: ver, createdAt: new Date().toISOString(), files: [] }
  let ok = 0, skipped = 0
  for (const p of entries) {
    const s = splitPkg(p)
    if (!s) { skipped++; index.files.push({ path: p, status: 'skip', reason: '路径不含包名' }); continue }
    process.stdout.write(`  ${s.pkg.replace('@deepseek-ai/', '')}/${s.rel} … `)
    try {
      const tgz = await fetchTarball(s.pkg, ver)
      const buf = extractMember(tgz, s.rel)
      const dst = path.join(out, p)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.writeFileSync(dst, buf)
      const patched = path.join(PAYLOAD, p)
      const same = fs.existsSync(patched) && md5(patched) === md5(buf)
      index.files.push({
        path: p, package: s.pkg, rel: s.rel, md5Upstream: md5(buf),
        md5Live: fs.existsSync(patched) ? md5(patched) : null,
        liveEqualsUpstream: same, status: 'ok',
      })
      ok++
      console.log(same ? '原版（本机未改？）' : `已存基线  md5=${md5(buf).slice(0, 12)}`)
    } catch (e) {
      skipped++
      const selfAuthored = !/registry 404/.test(String(e.message))
      index.files.push({ path: p, package: s.pkg, rel: s.rel, status: 'skip', reason: String(e.message).slice(0, 80) })
      console.log(`跳过（${selfAuthored ? String(e.message).slice(0, 40) : '官方无此包/文件'}）`)
    }
  }
  const idx = path.join(out, 'index.json')
  fs.writeFileSync(idx, JSON.stringify(index, null, 2) + '\n')
  console.log(`\n基线: ${out}`)
  console.log(`  成功 ${ok} 个 / 跳过 ${skipped} 个（跳过=自研包或项目自有资产，正常）`)
  console.log(`  索引: ${idx}`)
}

async function check(newVer) {
  const cur = kernelVersion()
  const dir = path.join(BASELINE_ROOT, `v${cur}`)
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
  const oks = idx.files.filter(f => f.status === 'ok')
  console.log(`基线内核 ${cur}  →  对比目标 ${newVer}\n`)
  const rows = []
  for (const f of oks) {
    try {
      const buf = extractMember(await fetchTarball(f.package, newVer), f.rel)
      const nb = path.join(os.tmpdir(), 'new-' + md5(buf).slice(0, 8))
      fs.writeFileSync(nb, buf)
      const old = path.join(dir, f.path)
      let diffLines = 0
      try {
        const d = execFileSync('diff', ['-u', old, nb], { encoding: 'utf8' })
        diffLines = 0
      } catch (e) {
        diffLines = (e.stdout || '').split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length
      }
      rows.push({ pkg: f.package.replace('@deepseek-ai/', ''), rel: f.rel, diffLines, newFile: nb })
      fs.rmSync(nb, { force: true })
    } catch (e) {
      rows.push({ pkg: f.package.replace('@deepseek-ai/', ''), rel: f.rel, diffLines: -1, err: String(e.message).slice(0, 40) })
    }
  }
  rows.sort((a, b) => b.diffLines - a.diffLines)
  console.log('上游改动量（行）  → 越大越需要人工 rebase：\n')
  for (const r of rows) {
    const tag = r.diffLines < 0 ? `取不到（${r.err}）` : r.diffLines === 0 ? '上游未改 → 补丁可直接套用' : `上游改了 ${r.diffLines} 行 → **需人工 rebase**`
    console.log(`  ${String(r.diffLines).padStart(5)}  ${r.pkg}/${r.rel}   ${tag}`)
  }
  const need = rows.filter(r => r.diffLines > 0).length
  console.log(`\n结论：${need} 个文件需要人工 rebase，其余可直接重新套用补丁。`)
}

function list() {
  if (!fs.existsSync(BASELINE_ROOT)) { console.log('还没有基线，先跑 build'); return }
  for (const v of fs.readdirSync(BASELINE_ROOT)) {
    const idx = path.join(BASELINE_ROOT, v, 'index.json')
    if (!fs.existsSync(idx)) continue
    const j = JSON.parse(fs.readFileSync(idx, 'utf8'))
    console.log(`${v}  内核 ${j.kernelVersion}  建于 ${j.createdAt}`)
    for (const f of j.files) {
      console.log(`  ${f.status === 'ok' ? '✅' : '○'} ${f.path.replace(PREFIX, '')}${f.status === 'ok' && f.liveEqualsUpstream ? '   （本机与官方一致）' : ''}`)
    }
  }
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'build') build().catch(e => { console.error(e); process.exit(1) })
else if (cmd === 'check') {
  if (!arg) { console.error('用法: upstream-baseline.js check <新版本>'); process.exit(2) }
  check(arg).catch(e => { console.error(e); process.exit(1) })
} else if (cmd === 'list') list()
else { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).join('\n').replace(/^ \*ap?/gm, '')) }
