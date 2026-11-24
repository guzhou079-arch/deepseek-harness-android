// 离线验证任意 APK 的 payload 是否"能开机 + 补丁在位"——用于**回滚包**与候选包装机前的体检。
// 不装、不重启，纯读文件。
//
//   node verify-apk-payload.js <apk>                # 严格：结构 + 清单全都要对（验候选包）
//   node verify-apk-payload.js <apk> --inventory    # 体检：只判结构；清单只列出"这个包带了什么"
//                                                   #   ← 验**回滚包**用这个：旧包没有新补丁是正常的
//   node verify-apk-payload.js <apk> --keep-user-bg # 验**自用包**：机主壁纸本来就随包走，
//                                                   #   别拿"壁纸该剔除"去判它
//
// 检查两类：
//   A. 结构（能不能开机）：REVISION、bin.js、六个自定义插件目录
//   B. 补丁（能力在不在）：checks.manifest 的 md5 + 关键字
//
// 关于「本包无此文件」：
//   过去这一句只是累加一个数字，退出码根本不看它。于是从包里抽掉一整条补丁，
//   absent 会涨，结论仍是 ✅ 可用 —— 数了不算，等于没看见。
//   但缺席有时是合法的：发行包必须剔除机主壁纸。所以不能一刀切要求全在。
//   判据改成：允许缺席的路径由 scripts/manifest-dist-absent-baseline.json 逐条点名，
//   严格模式下缺席集合必须落在名册里（漏一条 = 红），名册里的反倒还在（该剔没剔 = 红），
//   名册还必须与清单里 policy=local 的集合逐条相等（改 policy 自动换豁免 = 红）。
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { readZip } = require('../lib/ziptool.js');
const SB = path.resolve(__dirname, '..');
const N = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

const apk = process.argv[2];
const inventory = process.argv.includes('--inventory');
// 自用包（DSH_DIST=0）里机主壁纸是**必须随包**的：那一版 strip 走的是 keepUserBg，
// 名册里那两条就不该缺席。用一个开关切换判据方向，而不是让人去改名册本身 ——
// 改名册等于把「发行包必须剔除」这个事实从台账里抹掉，下一版发行包就没人拦了。
const keepUserBg = process.argv.includes('--keep-user-bg');
if (!apk || !fs.existsSync(apk)) { console.error('用法: node verify-apk-payload.js <apk> [--inventory] [--keep-user-bg]'); process.exit(2); }

// 连 zip 目录都读不出来 = 判不了（给的文件不是 APK），不是「这个包不可用」。
// 缺 payload.zip 是另一回事（下面那行维持 2：结构判据没有对象）——两者都归 2，但说法不同。
let outer;
try {
  outer = readZip(apk);
} catch (e) {
  console.error('✗ 打不开这个文件（不是 zip）：' + String((e && e.message) || e));
  console.error('  返回 2 = 无法判定，不是包不合规 —— 先确认给的是不是 APK。');
  process.exit(2);
}
const pz = outer.find((e) => e.name === 'assets/payload.zip');
if (!pz) { console.error('✗ APK 里没有 assets/payload.zip'); process.exit(2); }
const tmp = '/data/user/0/com.deepseek.harness/files/tmp/verify-payload.zip';
const raw = pz.method === 0 ? pz.raw : zlib.inflateRawSync(pz.raw);
fs.writeFileSync(tmp, raw);
const inner = new Map(readZip(tmp).map((e) => [e.name, e]));
try { fs.unlinkSync(tmp); } catch (e) {}   // 内层已读进内存：别把 130MB 临时文件留在 tmp 里
const bytes = (e) => (e.method === 0 ? e.raw : zlib.inflateRawSync(e.raw));

console.log(`APK: ${path.basename(apk)}  (payload ${(raw.length / 1048576).toFixed(1)}MB, ${inner.size} 条目)`);
const rev = inner.get('dshroot/REVISION');
if (rev) console.log(`REVISION: ${bytes(rev).toString('utf8').trim()}`);

// A. 结构
console.log('— 结构（能不能开机）—');
let structFail = 0;
const need = [
  ['dshroot/REVISION', 'payload 版本标记'],
  ['dshroot/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', '引擎入口'],
  [`${N}/dsh-tool-shizuku/lib/index.js`, '插件 shizuku'],
  [`${N}/dsh-tool-android/lib/index.js`, '插件 android'],
  [`${N}/dsh-tool-accessibility/lib/index.js`, '插件 accessibility'],
  [`${N}/dsh-tool-vscreen/lib/index.js`, '插件 vscreen'],
  [`${N}/dsh-tool-nfc/lib/index.js`, '插件 nfc'],
  [`${N}/dsh-client-modules/lib/index.js`, '客户端模块注册器'],
  [`${N}/dsh-client-hmr/lib/index.js`, 'HMR'],
];
for (const [p, label] of need) {
  if (inner.has(p)) console.log(`  ✅ ${label}`);
  else { console.log(`  ❌ 缺 ${label}（${p}）`); structFail++; }
}

// B. 补丁清单
console.log('— 补丁清单（能力在不在）—');
// 清单路径留一个测试口子：缺席对账要能在自测里造「漏登记」「该剔没剔」这类夹具，
// 而造一份真 APK 动辄 100MB。与同族的 assert-manifest-* 用同一个变量名，口径一致。
const manifestPath = path.resolve(process.env.DSH_MANIFEST_PATH || path.join(SB, 'checks.manifest'));
let man;
try {
  man = fs.readFileSync(manifestPath, 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
} catch (e) {
  console.error(`✗ 读不了清单 ${manifestPath} → 判不了（返回 2，不是包不合规）`);
  process.exit(2);
}
let hit = 0, miss = 0, older = 0;
const absentPaths = new Set();     // 缺席的路径（去重：同一路径可能有多行，各守一个关键字）
const presentPaths = new Set();
for (const line of man) {
  const [p, want, kw] = line.split('|');
  const short = p.replace(N + '/', '').replace('/lib/index.js', '');
  const e = inner.get(p);
  if (!e) { absentPaths.add(p); continue; }
  presentPaths.add(p);
  const buf = bytes(e);
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const kwOk = !kw || kw === '-' || buf.includes(kw);
  if (md5 === want && kwOk) { hit++; }
  else if (inventory) { older++; console.log(`  ↺ ${short}（本包是旧版/未打此补丁）`); }
  else { miss++; console.log(`  ❌ ${short}\n     md5=${md5} 期望=${want}${kwOk ? '' : `  关键字缺失: ${kw}`}`); }
}
for (const p of absentPaths) console.log(`  ␀ 本包无此文件: ${p.replace(N + '/', '')}`);
console.log(`  → 补丁命中 ${hit} / 旧版或未打 ${older} / 本包无 ${absentPaths.size} 个路径（清单 ${man.length} 行）`
  + (miss ? ` / ❌不一致 ${miss}` : ''));

// C. 缺席对账（只在严格模式判；体检模式本来就允许旧包缺补丁）
//    结构件由 A 段判：那里缺席就是红，不必在名册里再算一次。
const structPaths = new Set(need.map(([p]) => p));
let gateFail = 0;
let ledgerNote = '';
if (!inventory) {
  const ledgerPath = path.resolve(
    process.env.DSH_MANIFEST_DIST_ABSENT_BASELINE_PATH || path.join(SB, 'scripts', 'manifest-dist-absent-baseline.json'));
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (e) {
    console.error(`✗ 读不了缺席名册 ${ledgerPath} → 判不了「哪些允许不在」（返回 2，不是包不合规）`);
    process.exit(2);
  }
  const bad = [];
  if (!Array.isArray(ledger.entries)) bad.push('缺 entries 数组');
  if (typeof ledger._count !== 'number' || !Number.isInteger(ledger._count)) bad.push('缺整数 _count');
  const paths = [];
  for (const it of Array.isArray(ledger.entries) ? ledger.entries : []) {
    if (!it || typeof it.path !== 'string' || !it.path) { bad.push('有条目缺 path'); continue; }
    if (typeof it.why !== 'string' || !it.why.trim()) bad.push(`${it.path}: 缺 why（登记不等于豁免，得写清凭什么不在）`);
    if (paths.includes(it.path)) bad.push(`${it.path}: 重复登记`);
    paths.push(it.path);
  }
  if (typeof ledger._count === 'number' && ledger._count !== paths.length) {
    bad.push(`_count 写 ${ledger._count}，实际 ${paths.length} 条 —— 两个数字必须同时改，改数字才有痕迹`);
  }
  if (bad.length) {
    console.error(`✗ 缺席名册自身不合法（${bad.length} 处）→ 判不了（返回 2）：\n    ${bad.join('\n    ')}`);
    process.exit(2);
  }
  // 名册必须与清单里 policy=local 的集合逐条相等：把一条 policy=all 改成 local
  // 就自动获得缺席许可，那等于给了一条不点名的静默通道。
  //
  // 对不上时退 2 而不是 1：这是**判据自己打架**，不是包的问题。名册说「允许不在」、
  // 清单说「必须有」（或反过来），两边都按自己的说法判，正确的包也会被判死。
  // 判据不可用时不许给结论 —— 红和绿都可能是假的。
  const localPaths = new Set(man.map((l) => l.split('|')).filter((c) => (c[3] || '').trim() === 'local').map((c) => c[0].trim()));
  const ledgerSet = new Set(paths);
  const notLocal = paths.filter((p) => !localPaths.has(p));
  const localNotLedger = [...localPaths].filter((p) => !ledgerSet.has(p));
  if (notLocal.length || localNotLedger.length) {
    console.error(`✗ 名册与清单的 policy=local 集合对不上 → 判不了（返回 2，不是包不合规）：`);
    for (const p of notLocal) console.error(`    · 名册登记了但清单不是 local（清单说必须有，名册说允许不在）: ${p}`);
    for (const p of localNotLedger) console.error(`    · 清单标了 local 但名册没登记（正确的包也会被当成漏登记）: ${p}`);
    process.exit(2);
  }
  // 结构件不参与缺席对账（A 段已判）
  const abs = [...absentPaths].filter((p) => !structPaths.has(p));
  const unregistered = abs.filter((p) => !ledgerSet.has(p));
  const stillThere = keepUserBg ? [] : paths.filter((p) => presentPaths.has(p));
  const missingForSelf = keepUserBg ? paths.filter((p) => !presentPaths.has(p)) : [];
  console.log(`— 缺席对账（${keepUserBg ? '自用包：壁纸必须随包' : '发行包：壁纸必须剔除'}）—`);
  console.log(`  ℹ 名册登记 ${paths.length} 条；本包有 ${abs.length} 条清单路径不在包里`);
  if (unregistered.length) {
    gateFail++;
    console.error(`  ✗ ${unregistered.length} 条缺席没有登记 —— 这几条是能力丢了，不是「允许不在」：`);
    for (const p of unregistered) console.error(`      · ${p}`);
  }
  if (stillThere.length) {
    gateFail++;
    console.error(`  ✗ ${stillThere.length} 条登记为「发行包必须剔除」却还在包里 —— 该剔的没剔：`);
    for (const p of stillThere) console.error(`      · ${p}`);
  }
  if (missingForSelf.length) {
    gateFail++;
    console.error(`  ✗ ${missingForSelf.length} 条在自用包里本该随包，却不在：`);
    for (const p of missingForSelf) console.error(`      · ${p}`);
  }
  if (!unregistered.length && !stillThere.length && !missingForSelf.length) {
    console.log(`  ✓ 缺席 ${abs.length} 条全部落在名册内，名册里的也都在该在的位置`);
  }
  ledgerNote = `，缺席对账 ${gateFail ? '不通过' : '通过'}`;
} else {
  ledgerNote = '  [体检模式：旧版条目与缺席都不算失败]';
}

const ok = structFail === 0 && miss === 0 && gateFail === 0;
console.log(`  结果: ${ok ? '✅ 可用' : '❌ 不可用'}（结构问题 ${structFail}，补丁不一致 ${miss}${gateFail ? `，缺席对账问题 ${gateFail}` : ''}）`
  + (inventory ? ledgerNote : ''));
process.exit(ok ? 0 : 1);
