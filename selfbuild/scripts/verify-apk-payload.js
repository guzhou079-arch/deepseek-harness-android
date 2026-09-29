// 离线验证任意 APK 的 payload 是否"能开机 + 补丁在位"——用于**回滚包**与候选包装机前的体检。
// 不装、不重启，纯读文件。
//
//   node verify-apk-payload.js <apk>                # 严格：结构 + 清单全都要对（验候选包）
//   node verify-apk-payload.js <apk> --inventory    # 体检：只判结构；清单只列出"这个包带了什么"
//                                                   #   ← 验**回滚包**用这个：旧包没有新补丁是正常的
//
// 检查两类：
//   A. 结构（能不能开机）：REVISION、bin.js、六个自定义插件目录
//   B. 补丁（能力在不在）：checks.manifest 的 md5 + 关键字
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { readZip } = require('../lib/ziptool.js');
const SB = path.resolve(__dirname, '..');
const N = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

const apk = process.argv[2];
const inventory = process.argv.includes('--inventory');
if (!apk || !fs.existsSync(apk)) { console.error('用法: node verify-apk-payload.js <apk> [--inventory]'); process.exit(2); }

const outer = readZip(apk);
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
const man = fs.readFileSync(path.join(SB, 'checks.manifest'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
let hit = 0, miss = 0, older = 0, absent = 0;
for (const line of man) {
  const [p, want, kw] = line.split('|');
  const short = p.replace(N + '/', '').replace('/lib/index.js', '');
  const e = inner.get(p);
  if (!e) { absent++; console.log(`  ␀ 本包无此文件: ${short}`); continue; }
  const buf = bytes(e);
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const kwOk = !kw || kw === '-' || buf.includes(kw);
  if (md5 === want && kwOk) { hit++; console.log(`  ✅ ${short}`); }
  else if (inventory) { older++; console.log(`  ↺ ${short}（本包是旧版/未打此补丁）`); }
  else { miss++; console.log(`  ❌ ${short}\n     md5=${md5} 期望=${want}${kwOk ? '' : `  关键字缺失: ${kw}`}`); }
}
console.log(`  → 补丁命中 ${hit} / 旧版或未打 ${older} / 本包无 ${absent}${miss ? ` / ❌不一致 ${miss}` : ''}`);

const ok = structFail === 0 && miss === 0;
console.log(`  结果: ${ok ? '✅ 可用' : '❌ 不可用'}（结构问题 ${structFail}，补丁不一致 ${miss}）`
  + (inventory ? '  [体检模式：旧版条目不算失败]' : ''));
process.exit(ok ? 0 : 1);
