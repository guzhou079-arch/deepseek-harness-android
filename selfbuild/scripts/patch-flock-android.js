// rc.2 补丁：给 @deepseek-ai/node-addon-system 的 flock 加 Android 回退
//
// 病灶（rc.2 新引入的阻断级问题）：
//   node-addon-system/lib/flock.js:loadBinding()
//     if (platform !== 'linux' && platform !== 'darwin') throw ERR_FLOCK_UNSUPPORTED_PLATFORM
//   官方只发布 linux/darwin 预编译包，android-arm64 被写死拒绝。而 rc.2 的
//   dsh-session-persistence-jsonl 会话写锁正是 import { tryLockExclusive } from
//   "@deepseek-ai/node-addon-system/flock" → 拿不到锁 → **新建/恢复会话全挂**。
//
// 回退实现（纯 JS，语义对齐 flock）：
//   · 非阻塞独占锁：lockfile 用 O_CREAT|O_EXCL 抢占；抢不到回调 11(EAGAIN)
//   · ⚠ 回调的是【正】errno：调用方做 getSystemErrorName(-errno)。
//     本机实测 getSystemErrorName(11) 抛 ERR_OUT_OF_RANGE、getSystemErrorName(-11)=EAGAIN，
//     所以必须回正数 11/5，让调用方取负后才能查到名字。
//   · 「关闭 fd 即释放」的判据：同一个 fd 号再次来抢同一把锁 ⇒ 旧持有者必然已关闭
//     （本进程内同一 fd 号不可能并存）→ 释放后重抢。
//     不能只靠 fstatSync 探测：fd 号在 close 后会被立刻复用，会误判成"还开着"。
//   · 陈旧锁清理：lockfile 记 pid，pid 不存在或超过 15 分钟未更新 → 抢占。
//
// 用法：
//   node patch-flock-android.js                                  # 从装机副本取源
//   DSH_KERNEL_DIR=<内核@deepseek-ai目录> node patch-flock-android.js   # 对新内核重打
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const N = process.env.DSH_KERNEL_DIR || '/data/user/0/com.deepseek.harness/files/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const R = process.env.DSH_PROJECT || path.join(__dirname, '../..')
const SB = path.join(R, 'selfbuild')
const OVL = path.join(R, 'v118/dsh-patches/overlay')
const REL = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const REL2 = 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const PKG = 'node-addon-system'
const FILE = 'lib/flock.js'
const MARKER = 'createAndroidBinding'
const LIVE = `${N}/${PKG}/${FILE}`

const ANDROID_IMPL = [
  '',
  '/** 本进程内持有的锁：lockPath -> { fd, target }。 */',
  'const androidHeld = new Map();',
  '/** fd 是否仍打开且仍指向同一文件（readlink 比 fstat 可靠：fd 号会被复用）。 */',
  'function androidFdLive(fd, target) {',
  '    try { return readlinkSync(`/proc/self/fd/${fd}`) === target; } catch { return false; }',
  '}',
  '/** 释放：删记录 + 删 lockfile（lockfile 可能已被别人抢走）。 */',
  'function androidRelease(lockPath) {',
  '    androidHeld.delete(lockPath);',
  '    try { unlinkSync(lockPath); } catch { /* 已被别人拿走 */ }',
  '}',
  '/** 陈旧锁：pid 已不存在，或 lockfile 超过 15 分钟没更新。 */',
  'function androidLockStale(lockPath) {',
  '    try {',
  "        const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);",
  '        if (Number.isInteger(pid) && pid > 0) {',
  "            try { process.kill(pid, 0); } catch (error) { if (error && error.code === 'ESRCH') return true; }",
  '        }',
  '        return Date.now() - statSync(lockPath).mtimeMs > 15 * 60 * 1000;',
  '    } catch { return true; }',
  '}',
  '/**',
  ' * Android 回退 binding：接口与原生 binding 一致 —— tryLock(fd, resolve)。',
  ' * 回调【正】errno：0=成功、11=EAGAIN、5=EIO（调用方会取负再查名字）。',
  ' */',
  'function createAndroidBinding() {',
  '    return {',
  '        tryLock(fd, resolve) {',
  '            let target, lockPath;',
  '            try {',
  '                target = readlinkSync(`/proc/self/fd/${fd}`);',
  "                lockPath = target + '.dsh-flock';",
  '            } catch { resolve(5); return; }',
  '            const rec = androidHeld.get(lockPath);',
  '            if (rec !== undefined) {',
  '                if (rec.fd === fd || !androidFdLive(rec.fd, rec.target)) androidRelease(lockPath);',
  '                else { resolve(11); return; }',
  '            }',
  '            for (let attempt = 0; attempt < 2; attempt++) {',
  '                try {',
  "                    const handle = openSync(lockPath, 'wx');",
  '                    try { writeSync(handle, String(process.pid)); } finally { closeSync(handle); }',
  '                    androidHeld.set(lockPath, { fd, target });',
  '                    resolve(0);',
  '                    return;',
  '                } catch (error) {',
  "                    if (error && error.code === 'EEXIST') {",
  '                        if (attempt === 0 && androidLockStale(lockPath)) {',
  '                            try { unlinkSync(lockPath); } catch { /* 已被抢走 → 下轮 EAGAIN */ }',
  '                            continue;',
  '                        }',
  '                        resolve(11);',
  '                        return;',
  '                    }',
  '                    resolve(5);',
  '                    return;',
  '                }',
  '            }',
  '            resolve(11);',
  '        },',
  '    };',
  '}',
].join('\n')

const HUNKS = [
  {
    name: '补 node:fs 导入',
    from: "import { getSystemErrorName } from 'node:util';",
    to: [
      "import { getSystemErrorName } from 'node:util';",
      '// dsh-android-patch：Android flock 回退所需（见文件末尾 createAndroidBinding）',
      "import { closeSync, openSync, readFileSync, readlinkSync, statSync, unlinkSync, writeSync } from 'node:fs';",
    ].join('\n'),
  },
  {
    name: 'android 走回退而不是抛 ERR_FLOCK_UNSUPPORTED_PLATFORM',
    from: [
      '    const { platform, arch } = process;',
      "    if (platform !== 'linux' && platform !== 'darwin') {",
    ].join('\n'),
    to: [
      '    const { platform, arch } = process;',
      '    // dsh-android-patch：Android 内核就是 Linux，但没有原生 addon（本项目 payload',
      '    // 不带 .node/.so），官方也没发 android 预编译包 → 上游这里直接判死刑，',
      '    // 后果是 dsh-session-persistence-jsonl 的会话写锁拿不到（新建/恢复会话全挂）。',
      "    if (platform === 'android') {",
      '        binding = createAndroidBinding();',
      '        return binding;',
      '    }',
      "    if (platform !== 'linux' && platform !== 'darwin') {",
    ].join('\n'),
  },
  {
    name: '在 loadBinding 之后插入回退实现',
    from: [
      "    binding = require(join(dirname(manifest), 'bin', filename));",
      '    return binding;',
      '}',
    ].join('\n'),
    to: [
      "    binding = require(join(dirname(manifest), 'bin', filename));",
      '    return binding;',
      '}',
      ANDROID_IMPL,
    ].join('\n'),
  },
]

/** 真解析校验：ESM 文件，node --check 会假通过，必须真 import 一次。 */
function syntaxCheck(src) {
  const tmp = path.join(SB, 'work', `${PKG}-flock-check.mjs`)
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, src)
  const r = cp.spawnSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify('file://' + tmp)}).catch(e => { if (e instanceof SyntaxError) { console.error('SYNTAX:' + e.message); process.exit(7) } })`],
    { encoding: 'utf8', timeout: 30000 })
  const out = (r.stdout || '') + (r.stderr || '')
  return out.includes('SYNTAX:') ? out.split('SYNTAX:')[1].split('\n')[0] : null
}

const argv = process.argv.slice(2)
const fi = argv.indexOf('--from')
const srcPath = fi >= 0 ? argv[fi + 1] : LIVE

let s = fs.readFileSync(srcPath, 'utf8')
const liveSrc = fs.existsSync(LIVE) ? fs.readFileSync(LIVE, 'utf8') : null
const liveAlreadyPatched = liveSrc !== null && liveSrc.includes(MARKER)

if (s.includes(MARKER)) {
  console.log('  ✓ 源已是打过补丁的状态（幂等直通）')
} else {
  for (const h of HUNKS) {
    const n = s.split(h.from).length - 1
    if (n !== 1) {
      console.error(`  ✗ [${h.name}] 期望 1 处锚点，实际 ${n} 处 → 中止（上游可能变了，需人工看 diff）`)
      process.exit(1)
    }
    s = s.replace(h.from, h.to)
  }
  const err = syntaxCheck(s)
  if (err) { console.error('  ✗ 语法错误: ' + err); process.exit(1) }
  console.log(`  ✓ ${PKG}/${FILE}: ${HUNKS.length} 处 hunk 已套用（真解析校验通过）`)
}

// 装机副本若尚未打过本补丁，就没有"逐字节对照物"，跳过比对（新增补丁，不是重现）
if (liveSrc !== null && srcPath !== LIVE && liveAlreadyPatched) {
  const same = liveSrc === s
  console.log(same ? '  ✅ 与装机副本逐字节一致' : '  ⚠ 与装机副本不一致')
  if (!same) { console.error('  ✗ 拒绝写出（避免用错误的变换覆盖正确副本）'); process.exit(2) }
}

for (const dst of [`${SB}/build-overlay/${REL}/${PKG}/${FILE}`, `${OVL}/${REL2}/${PKG}/${FILE}`]) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, s)
}
console.log('  → 写出 build-overlay + overlay 两份')
