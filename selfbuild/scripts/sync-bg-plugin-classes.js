// 同步背景图插件的「哈希类名」清单（rc.2 事故「问题 4」的工具化修复）
//
// 病灶：上游 CSS Modules 的类名带构建哈希，每换一次内核就可能整批改名
//   rc.1: AppFrame=ZTP-Xa_frame  ConversationRoot=D_tfqW_*
//   rc.2: AppFrame=pI_x6G_frame  ConversationRoot=wSkVaW_*
// 插件里写死选择器 → 升内核后背景图整片失效（症状：主页没壁纸、侧边栏却有）。
//
// 修法：类名集中在插件 client.js 的 @dsh-bg-classes 区块里，由本脚本从**内核树**
// 里读出来**逐代累积**（不清旧名），换内核后跑一次即可。
//
// 用法：
//   node sync-bg-plugin-classes.js                         # 用装机副本（当前内核）
//   DSH_KERNEL_DIR=<内核@deepseek-ai目录> node sync-bg-plugin-classes.js
//   node sync-bg-plugin-classes.js --check                 # 只校验（不写盘）：跑假 DOM 断言 CSS 选择器
const fs = require('fs')
const path = require('path')

const N = process.env.DSH_KERNEL_DIR || '/data/user/0/com.deepseek.harness/files/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const SB = '/storage/emulated/0/Download/Operit/dsh_own_app/selfbuild'
const PLUG = '/storage/emulated/0/Download/Operit/dsh_own_app/plugins/dsh-android-ui/lib/client.js'
const OVL = `${SB}/build-overlay/dshhome/profiles/web/node_modules/dsh-android-ui/lib/client.js`
const BEGIN = '// @dsh-bg-classes:begin'
const END = '// @dsh-bg-classes:end'

/** 从内核树里读出当前这代的 frame / conv 前缀。 */
function readNames(kernelDir) {
  const layout = fs.readFileSync(`${kernelDir}/dsh-client-ui-layout/lib/client.js`, 'utf8')
  const conv = fs.readFileSync(`${kernelDir}/dsh-client-ui-conversation/lib/client.js`, 'utf8')
  const frame = layout.match(/"frame":\s*"([A-Za-z0-9_-]+)"/)
  const root = conv.match(/"root":\s*"([A-Za-z0-9_-]+)_root"/)
  const embedded = conv.match(/"embeddedBody":\s*"([A-Za-z0-9_-]+)_embeddedBody"/)
  if (!frame || !root || !embedded) {
    throw new Error(`类名抓取失败：frame=${!!frame} root=${!!root} embeddedBody=${!!embedded}`)
  }
  if (root[1] !== embedded[1]) throw new Error(`root 与 embeddedBody 前缀不一致：${root[1]} vs ${embedded[1]}`)
  return { frame: frame[1], conv: root[1] }
}

function parseBlock(src) {
  const fi = src.indexOf(BEGIN)
  const ei = src.indexOf(END)
  if (fi < 0 || ei < 0 || ei < fi) throw new Error('找不到 @dsh-bg-classes 区块')
  const block = src.slice(fi, ei)
  const frames = (block.match(/BG_FRAMES\s*=\s*\[([^\]]*)\]/) || [null, ''])[1]
    .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  const convs = (block.match(/BG_CONV_PREFIXES\s*=\s*\[([^\]]*)\]/) || [null, ''])[1]
    .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  return { block, frames, convs, begin: fi, end: ei }
}

/** 最小假 DOM：验证插件真的能注入 style，且 CSS 里两代选择器都在。 */
function simulate(css) {
  const calls = { created: 0, removed: 0 }
  const nodes = []
  const doc = {
    getElementById: (id) => nodes.find((n) => n.id === id) || null,
    createElement: () => { calls.created += 1; return { id: '', textContent: '', parentNode: null } },
    head: {
      appendChild(el) {
        el.parentNode = this
        nodes.push(el)
        this.children = nodes
      },
      removeChild(el) {
        const i = nodes.indexOf(el)
        if (i >= 0) nodes.splice(i, 1)
        el.parentNode = null
      },
    },
    documentElement: { appendChild() {} },
  }
  let dispose = null
  const ctx = { effect: (fn) => { dispose = fn() } }
  let captured = null
  global.window = { __ModuleLoader__: { load: (def) => { captured = def } } }
  global.document = doc
  // 用 vm 执行插件源码（它只依赖 window）
  const vm = require('vm')
  vm.runInThisContext(fs.readFileSync(PLUG, 'utf8'), { filename: PLUG })
  if (!captured) throw new Error('插件没有调用 window.__ModuleLoader__.load')
  const mod = captured.factory((name) => { throw new Error('客户端插件不该 require：' + name) })
  mod.apply(ctx)
  const injected = nodes[nodes.length - 1]
  if (!injected) throw new Error('没注入 style 节点')
  const injectedCss = injected.textContent
  // 回收：disposer 必须把节点摘掉
  if (typeof dispose === 'function') dispose()
  if (nodes.length !== 0) throw new Error('ctx.effect 的回收函数没有移除 style 节点')
  // 幂等：二次激活只能有一个节点
  mod.apply({ effect: (fn) => { fn() } })
  if (nodes.length !== 1) throw new Error('重复激活产生了 ' + nodes.length + ' 个 style 节点（应为 1）')
  return { css: injectedCss, calls }
}

const checkOnly = process.argv.includes('--check')
const names = readNames(N)
console.log(`  内核树: ${N}`)
console.log(`  本代类名: frame=${names.frame}  conv前缀=${names.conv}_*`)

let src = fs.readFileSync(PLUG, 'utf8')
const parsed = parseBlock(src)

const frames = parsed.frames.slice()
const convs = parsed.convs.slice()
const added = []
if (!frames.includes('.' + names.frame)) { frames.push('.' + names.frame); added.push('frame:' + names.frame) }
if (!convs.includes('.' + names.conv)) { convs.push('.' + names.conv); added.push('conv:' + names.conv) }

if (added.length === 0) {
  console.log('  ✓ 类名清单已包含本代（无需改动）')
} else if (checkOnly) {
  console.error('  ✗ --check 模式：清单缺本代类名 → ' + added.join(', '))
  process.exit(1)
} else {
  const block = [
    BEGIN + ' —— 由 selfbuild/scripts/sync-bg-plugin-classes.js 生成（逐代累积），勿手改',
    '    // frame：@deepseek-ai/dsh-client-ui-layout 的 AppFrame.module.css 里的 "frame" 类',
    '    // conv ：@deepseek-ai/dsh-client-ui-conversation 的 ConversationRoot.module.css 前缀',
    '    //        （root / embeddedBody / composerSeat / data-empty-state 全部由它派生）',
    `    var BG_FRAMES = [${frames.map((f) => `'${f}'`).join(', ')}];`,
    `    var BG_CONV_PREFIXES = [${convs.map((c) => `'${c}'`).join(', ')}];`,
    '    ',
  ].join('\n')
  src = src.slice(0, parsed.begin) + block + src.slice(parsed.end)
  fs.writeFileSync(PLUG, src)
  console.log(`  ✓ 已补入 ${added.join(', ')}（现 ${frames.length} 个 frame / ${convs.length} 个 conv 前缀）`)
}

const sim = simulate(fs.readFileSync(PLUG, 'utf8'))
for (const f of frames) {
  if (!sim.css.includes(f)) { console.error(`  ✗ CSS 里缺 frame 选择器 ${f}`); process.exit(1) }
}
for (const c of convs) {
  for (const suffix of ['_root', '_embeddedBody', '_composerSeat']) {
    if (!sim.css.includes(c + suffix)) { console.error(`  ✗ CSS 里缺 ${c}${suffix}`); process.exit(1) }
  }
}
console.log(`  ✓ 假 DOM 注入通过：CSS ${sim.css.length} 字节，含全部 ${frames.length + convs.length * 3} 个必需选择器`)

if (checkOnly) process.exit(0)

for (const dst of [OVL]) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(PLUG, dst)
}
try { delete global.document; delete global.window } catch {}
console.log('  → 已同步到 build-overlay 的插件副本（随包交付）')
