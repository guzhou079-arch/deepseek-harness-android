#!/usr/bin/env node
/**
 * check-payload-version-coherence.js —— 门禁：payload 里的内核包必须是**同一世代**
 * ============================================================================
 * 为什么必须有它（2026-11-06 真实事故，v1.48 / code 296 已发布）：
 *
 *   build-overlay 是个**长期存在的整文件副本目录**，每个文件都是当年那次改动的
 *   整份拷贝。0.2.1-rc.5 → 0.2.2-rc.1 换内核那天，只有"当天被手改到"的几个文件
 *   被刷新（旁边留 .bak-0.2.1rc5-20261106），**其余 32 个文件原地没动**：
 *
 *     overlay 文件 mtime        世代            进包后
 *     dsh-app-boot/lib/index.js          2026-10-17  0.2.1(.up/cand)  → 204,609B（新的是 227,619B）
 *     dsh-host-webserver/lib/index.js    2026-11-02  0.2.1-rc.5       → 21,586B （新的是 26,764B）
 *     dsh-llm-deepseek/lib/index.js      2026-11-02  .up/cand         → 121,769B（新的是 128,090B）
 *     dsh-web-frontend/dist/index.html   2026-10-30  0.2.1            → 引用 index-BXV-oxvX.js（包里根本没有）
 *     …共 32 个
 *
 *   而 `selfbuild.sh patch` 只做一件事：**按路径整文件覆盖**，没有任何版本/来源校验
 *   （selfbuild.js payload-patch：overlay 有的路径直接替换，没有的追加）。于是这些
 *   旧世代文件被原样盖进全新的 0.2.2-rc.1 payload，发出去的新装用户：
 *
 *     · 旧 dsh-host-webserver → 已认证请求回 400 → Chromium: net::ERR_HTTP_RESPONSE_CODE_FAILURE
 *     · 旧 dist/index.html  → 引用不存在的 bundle → 白屏
 *
 * 已有的 checks.manifest / payload-check 为什么没拦住：
 *   它按「路径 | md5 | 关键字」校的是我们自己点名的补丁，**内核包文件一条都没进清单**
 *   → 内核包整体换世代对它完全不可见。所以这里换判据：
 *   不猜清单，直接问"这一份，跟哪个世代的字节一样？"
 *
 * 判据（只会误报"本机补丁"，不会漏报旧世代）：
 *   ① frontend-refs    dist/index.html 里引用的 ./assets/* 与 /mobile.* 必须真在包里
 *                      → 白屏那一类坏包，零依赖、不靠参考树就能抓
 *   ② version-line     内核包版本属于 dsh 那条线（major.minor 相同）的，必须**全等于**
 *                      dsh/package.json 的版本 → 混世代（0.2.1-rc.x 混进 0.2.2-rc.1）
 *   ③ old-generation   与 --ref（干净参考树）字节不同、且与任一 --old（旧世代树）字节
 *                      相同的条目 = 旧世代残留，硬失败（这是本事故的指纹，零误报）
 *   ④ overlay-stale    --overlay 预检：build-overlay 里同样判据命中就报，
 *                      把旧文件挡在"进包之前"，而不是发出去了才发现
 *
 * ③④ 的前提是基线存在：没有干净参考树，就分不清"旧世代"和"本机补丁"；没有旧世代
 * 树，就没有"旧世代字节"可比。这两棵树曾经是写死的路径，树被清掉之后这道闸照样打
 * ✓ —— 判据的作用对象没了，出口还是绿的。那比报红更坏，因为红的会被人查。
 * 所以基线缺一个 = 无法判定（默认 exit 2），不许拿"没报违规"顶"没有残留"。
 * 同理"树在"也不够：得真有内核文件可比 —— 空包、拿错的 APK 都能打开，会让判据空转
 * （一条没比、却因为"参考树里没有"全跳过），所以两棵树都先量一遍再开比。
 *
 * 用法：
 *   node check-payload-version-coherence.js --payload <payload.zip|payload目录> \
 *        --ref <干净树> [--old <旧世代树>]... [--overlay <build-overlay>] \
 *        [--expect-version 0.2.2-rc.1] [--no-kernel-baseline] [--json <报告>] [--self-test]
 *
 *   例（本机实测命令）：
 *     node check-payload-version-coherence.js \
 *       --payload selfbuild/work/payload-new.zip \
 *       --ref /data/user/0/com.deepseek.harness/files/payload \
 *       --old kernels/0.2.1-rc.5.disabled --old kernels/0.2.1-rc.2.disabled3 \
 *       --overlay selfbuild/build-overlay --expect-version 0.2.2-rc.1
 *
 * 结论只有三种，别混：
 *   ① 世代一致   参考树与至少一棵旧世代树都用上了、逐条比完零残留 → exit 0
 *   ② 无法判定   基线缺失（--ref/--old 没给或用不了）→ 默认 exit 2；
 *                只有显式给了 --no-kernel-baseline 才允许 exit 0 并打降级横幅
 *   ③ 有违规     exit 1（红优先；基线缺失时也照样红）
 *
 * 退出码：0 = 真比过且过（或显式降级）；1 = 有违规；2 = 输入不全，世代比对没跑
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readZip, readEntry, writeZip, crc32 } = require(path.join(__dirname, '..', 'lib', 'ziptool.js'));

// 内核包（含 dsh 自己 + dsh 内嵌的那层 node_modules）在 payload 里的路径形状
const KERNEL_RE = /^dshroot\/lib\/node_modules\/@deepseek-ai\/(?:dsh\/node_modules\/@deepseek-ai\/)?([^/@]+)\/(.+)$/;
const KERNEL_JSON = 'dshroot/lib/node_modules/@deepseek-ai/dsh/package.json';
// 只校**自家 scope 的包**：dsh/node_modules 下还躺着 pako(0.2.9)、powershell-utils(0.2.1)
// 这类第三方，它们的 0.2.x 跟内核半点关系都没有 —— 所以要显式认出两个层级，
// 不能用"@deepseek-ai/ 后面跟一段就算"的宽松写法（那样 dsh/ 会把整个子树吞进来）。
const PKG_TOP_RE = /^dshroot\/lib\/node_modules\/@deepseek-ai\/([^/]+)\/package\.json$/;
const PKG_NESTED_RE = /^dshroot\/lib\/node_modules\/@deepseek-ai\/dsh\/node_modules\/@deepseek-ai\/([^/]+)\/package\.json$/;
const isOwnPkg = (n) => PKG_TOP_RE.test(n) || PKG_NESTED_RE.test(n);

const USAGE = `用法：
  node check-payload-version-coherence.js --payload <payload.zip|目录> [选项]

必填：
  --payload <p>       要检查的 payload（zip 或已解开的 dshroot 树所在目录）
  --ref <dir|zip>     干净参考树 —— 判据的一半；必须真有内核文件（空包/拿错的 APK = 输入错）

推荐：
  --old <dir>         旧世代树，可重复 —— 判据的另一半（如 kernels/0.2.1-rc.5.disabled）
  --overlay <dir>     预检 build-overlay，进包前抓旧文件
  --expect-version v  声明本次内核版本，不一致即失败

其它：
  --allow <a,b>       允许与参考树不同的路径（本机补丁），支持尾部 * ；默认只警告不当违规
  --no-kernel-baseline  显式接受"本轮没有旧世代基线"：降级运行、打横幅、绝不说"一致"
  --json <file>       输出机器可读报告
  --self-test         跑内置合成用例（基线缺失 / 逃生口 / overlay 各形态），不读写真实包
  -h, --help          显示本帮助

退出码：
  0  真比过且通过（或给了 --no-kernel-baseline 的显式降级）
  1  有违规（红优先；基线缺失时也照样红）
  2  输入不全：--ref / --old 缺失或用不了，世代比对没跑，结论只能是"无法判定"
`;

// ── payload 读取抽象：zip 与目录两种都支持，crc 一律按需算、缓存 ──────────
function openPayload(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    // 目录模式：既接受 payload 根（含 dshroot/），也接受 dshroot 本身
    const root = fs.existsSync(path.join(p, 'dshroot')) ? p : path.join(p, '..');
    const files = new Map();
    (function walk(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(fp);
        else files.set(path.relative(root, fp).split(path.sep).join('/'), fp);
      }
    })(path.join(root, 'dshroot'));
    return {
      kind: 'dir',
      names: [...files.keys()],
      stat(name) {
        const fp = files.get(name);
        if (!fp) return null;
        const s = fs.statSync(fp);
        return { size: s.size, get crc() { return crc32(fs.readFileSync(fp)); }, file: fp };
      },
      read(name) { const fp = files.get(name); return fp ? fs.readFileSync(fp) : null; },
      close() {},
    };
  }
  const entries = readZip(p, { load: false });
  const map = new Map(entries.map((e) => [e.name, e]));
  return {
    kind: 'zip',
    names: entries.map((e) => e.name),
    stat(name) { const e = map.get(name); return e ? { size: e.usize, crc: e.crc, entry: e } : null; },
    read(name) { const e = map.get(name); return e ? readEntry(p, e) : null; },
    close() {},
  };
}

// 参考树/旧世代树都是磁盘目录；crc 按需算（fnv 不做，直接 crc32，与 zip 中央目录同源）
// 参考树可以是目录，也可以是 payload.zip —— 后者才是真正干净的基准：
// 运行树会被冷启动重铺、也会被人手工 patch 过，拿它当基准等于用动过的尺子量。
let refTree = null;

const crcCache = new Map();
function diskStat(dir, name, hint) {
  const fp = path.join(dir, name);
  let st;
  try { st = fs.statSync(fp); } catch { return null; }
  if (!st.isFile()) return null;
  // 先比大小：不一样就不算 crc（7MB 的 excel、1.5MB 的壁纸不该为此读一遍）
  if (hint && hint.size !== st.size) return { size: st.size, crc: null };
  const key = fp + ':' + st.size + ':' + st.mtimeMs;
  let crc = crcCache.get(key);
  if (crc === undefined) {
    crc = crc32(fs.readFileSync(fp));
    crcCache.set(key, crc);
  }
  return { size: st.size, crc };
}
// 大小先卡（快），再比 crc；任一侧 crc 为 null（大小已不同，省了计算）直接判不同
function same(a, b) {
  if (!a || !b || a.size !== b.size) return false;
  if (a.crc === null || b.crc === null) return false;
  return a.crc === b.crc;
}

function allowMatcher(list) {
  const pats = (list || []).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
  return (name) => pats.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p || name.startsWith(p.endsWith('/') ? p : p + '/')));
}

// ── 检查 ①：前端 index.html 引用的资源必须真在包里 ────────────────────────
function checkFrontendRefs(payload, out) {
  const idx = payload.names.find((n) => /(^|\/)dsh-web-frontend\/dist\/index\.html$/.test(n));
  if (!idx) { out.warnings.push('包里没有 dsh-web-frontend/dist/index.html，跳过前端引用检查'); return; }
  const html = payload.read(idx).toString('utf8');
  const base = idx.slice(0, idx.lastIndexOf('/') + 1);
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)="\.\/([^"?#]+)"/g)) refs.add(base + m[1]);
  for (const m of html.matchAll(/(?:src|href)="\/(mobile\.[a-z]+)(?:\?[^"]*)?"/g)) refs.add(base + m[1]);
  if (!refs.size) out.warnings.push(`${idx} 里没解析出任何本地资源引用（模板变了？请人工确认）`);
  for (const ref of refs) {
    if (payload.stat(ref)) continue;
    out.violations.push({
      check: 'frontend-refs',
      path: ref,
      detail: `${idx} 引用了 ${path.posix.basename(ref)}，包里没有这个文件 → 浏览器 404 / 白屏`,
    });
  }
}

// ── 检查 ⑤：css / html 里写死的本地静态资源必须真在包里 ────────────────────
// 由来（2026-11-07）：fixed6 那个 repack 包把 dsh-bg.css 换成了自用版（引用 /dsh-bg-user.png），
// 但 repack 不走 make-dist，壁纸 png 早被 dist 化步骤移出去了 → 引用悬空。本机运行树里还留着那张图，
// 所以看着没事；新装/冷启动就是 404，背景直接空掉。这类"本机能看、新装就坏"只靠人眼是会漏的。
const ASSET_HARD_RE = /\.(png|jpe?g|webp|gif|svg)$/i;
const ASSET_SOFT_RE = /\.(ico|woff2?|ttf|otf|mp[34]|webm)$/i;

function checkLocalAssetRefs(payload, out) {
  const files = payload.names.filter((n) => /dsh-web-frontend\/dist\/[^/]+\.(css|html)$/.test(n));
  if (!files.length) { out.warnings.push('包里没有 dsh-web-frontend/dist/*.css，跳过本地静态资源引用检查'); return; }
  const baseNames = new Set(payload.names.map((n) => path.posix.basename(n)));
  let checked = 0;
  for (const f of files) {
    // 注释里的示例引用不算（dsh-bg.css 头部注释就写着 url("/mybg.jpg") 教人怎么换图）
    const text = payload.read(f).toString('utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    const refs = new Set();
    for (const m of text.matchAll(/url\(\s*["']?\/([^"')\s?#]+)/g)) refs.add(m[1]);
    for (const m of text.matchAll(/(?:src|href)="\/([^"?#]+)"/g)) refs.add(m[1]);
    for (const r of refs) {
      const hard = ASSET_HARD_RE.test(r);
      if (!hard && !ASSET_SOFT_RE.test(r)) continue;
      checked++;
      const base = path.posix.basename(r);
      if (baseNames.has(base)) continue;
      const detail = `${f.split('/').pop()} 里写死引用了 /${r}，但整个 payload 里没有 ${base}`
        + (hard ? ' → 新装/冷启动 404，背景或图标直接空掉（本机运行树里还留着这个文件，所以看不出来）'
                : ' → 可能 404（字体/图标），确认一下是不是 web server 另有来源');
      if (hard) out.violations.push({ check: 'local-asset-refs', path: f, detail });
      else out.warnings.push(detail);
    }
  }
  out.assetRefCount = checked;
  if (!checked) out.warnings.push('dist 的 css/html 里没解析出写死的本地静态资源引用（模板变了？）');
}

// ── 检查 ②：内核包家族版本必须一条线 ─────────────────────────────────────
function checkVersionLine(payload, expectVersion, out) {
  const kj = payload.read(KERNEL_JSON);
  if (!kj) { out.violations.push({ check: 'version-line', path: KERNEL_JSON, detail: 'payload 里没有内核 package.json，路径结构变了？' }); return; }
  let kernelVersion;
  try { kernelVersion = JSON.parse(kj.toString('utf8')).version; } catch { kernelVersion = null; }
  if (!kernelVersion) { out.violations.push({ check: 'version-line', path: KERNEL_JSON, detail: '内核 package.json 没有 version 字段' }); return; }
  out.kernelVersion = kernelVersion;
  if (expectVersion && kernelVersion !== expectVersion) {
    out.violations.push({
      check: 'version-line',
      path: KERNEL_JSON,
      detail: `内核版本 ${kernelVersion} ≠ 声明的 ${expectVersion}（包与发布意图分叉）`,
    });
  }
  const line = kernelVersion.split('.').slice(0, 2).join('.') + '.'; // 只盯内核这条线（0.2.x）
  const fam = [];
  for (const n of payload.names) {
    if (!isOwnPkg(n)) continue;
    const pkg = n.replace(/^.*@deepseek-ai\/(?:dsh\/node_modules\/@deepseek-ai\/)?/, '').replace(/\/package\.json$/, '');
    let v;
    try { v = JSON.parse(payload.read(n).toString('utf8')).version; } catch { v = null; }
    if (!v || !v.startsWith(line)) continue; // 第三方（cordis 4.x）与我们自己的 0.1.x 插件不在同一条线
    fam.push({ pkg, v, n });
    if (v !== kernelVersion) {
      out.violations.push({
        check: 'version-line',
        path: n,
        detail: `${pkg} 版本 ${v}，内核是 ${kernelVersion} → 混世代（旧包被整文件覆盖进来）`,
      });
    }
  }
  out.familyCount = fam.length;
  if (fam.length < 50) out.warnings.push(`内核家族只认出 ${fam.length} 个包，数量偏少，请确认路径结构没变`);
}

// ── 检查 ③：旧世代残留（与干净参考树不同、且与旧世代树相同）──────────────
function checkOldGeneration(payload, opts, out) {
  if (!out.baseline.ran) {
    out.warnings.push('世代比对未运行（基线不可用）—— 本轮没有"与旧世代相同"这条判据，没报违规 ≠ 没有残留');
    return;
  }
  const allow = allowMatcher(opts.allow);
  let compared = 0, absent = 0, matched = 0;
  for (const n of payload.names) {
    if (!KERNEL_RE.test(n)) continue;
    if (allow(n)) { out.allowed.push(n); continue; }
    const mine = payload.stat(n);
    const refSt = refTree ? refTree.stat(n) : diskStat(opts.ref, n, mine);
    if (!refSt) { absent++; out.warnings.push(`参考树里没有 ${n}（新增文件，未参与世代比对）`); continue; }
    if (same(mine, refSt)) { matched++; continue; }
    compared++;
    const hits = opts.old.map((d) => ({ d, st: diskStat(d, n, mine) })).filter((x) => same(mine, x.st));
    if (hits.length) {
      out.violations.push({
        check: 'old-generation',
        path: n,
        detail: `${mine.size}B 与参考树（${refSt.size}B）不同，却与旧世代树一致：${hits.map((h) => path.basename(h.d)).join(', ')}`,
      });
    } else {
      out.warnings.push(`${n} 与参考树不同（${mine.size}B vs ${refSt.size}B），但不是已知旧世代 → 当作本机补丁；建议用 --allow 显式声明`);
    }
  }
  out.comparedCount = compared;
  out.refAbsentCount = absent;
  // 参考树和本包得是同一支的近邻，覆盖率才是判据能不能成立的前提：空包、拿错的 APK、
  // 只剩内核 package.json 的薄包，都会让"参考树里没有"吞掉几乎所有条目 —— 一条没比，
  // 下面那句"零差异"就是在替一个没运行的判据背书。缺口占一半以上就降成无法判定。
  const total = matched + compared + absent;
  if (absent > 0 && (matched + compared) < total / 2) {
    const msg = `参考树只盖住本包 ${matched + compared}/${total} 个内核文件（缺失 ${absent} 条）`
      + ' → 没有可比对象，世代比对等于没运行；--ref 是不是拿错文件了？';
    (opts.noKernelBaseline ? out.warnings : out.inputErrors).push(msg);
  }
}

// ── 检查 ④：build-overlay 预检（把旧文件挡在进包之前）────────────────────
function walkDir(dir, root = dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(fp, root, acc);
    else acc.push(path.relative(root, fp).split(path.sep).join('/'));
  }
  return acc;
}
function checkOverlay(opts, out) {
  if (!opts.overlay || !fs.existsSync(opts.overlay)) return; // 不在的情况 checkInputs 已提示
  const names = walkDir(opts.overlay);
  const baseline = out.baseline.ran;
  let stale = 0;
  for (const n of names) {
    if (!KERNEL_RE.test(n)) continue;
    // .bak / .orig 不该躺在出包输入里（说明这个文件被手工兜过）。overlay-skip.js 会在
    // 打包时按 *.bak-* / *.orig 挡掉、进不了 payload —— 但留着它，下一个入口未必这么挡。
    if (/\.(bak|orig)([.-]|$)/i.test(n)) {
      stale++;
      out.warnings.push(`overlay 里有开发备份 ${n}（lib/overlay-skip.js 的 *.bak-* / *.orig 规则会把它挡在包外，进不了 payload；strip-dist-payload 只是第三道网，从 overlay 里清掉才干净）`);
      continue;
    }
    // 没有基线就只查污染，不说"通过" —— 说通过等于替一个没运行过的判据背书
    if (!baseline) continue;
    const mine = diskStat(opts.overlay, n);
    const refSt = refTree ? refTree.stat(n) : diskStat(opts.ref, n, mine);
    if (refSt && same(mine, refSt)) continue;
    const hits = opts.old.map((d) => ({ d, st: diskStat(d, n, mine) })).filter((x) => same(mine, x.st));
    if (hits.length) {
      stale++;
      out.violations.push({
        check: 'overlay-stale',
        path: n,
        detail: `overlay 里这份是旧世代（${hits.map((h) => path.basename(h.d)).join(', ')}）；一旦出包就会整文件覆盖进 payload`,
      });
    }
  }
  if (!baseline) out.warnings.push(`overlay 预检未能比对世代（本轮无基线）：${names.length} 个文件只查了 .bak/.orig 这类污染`);
  else if (!stale) out.notes.push(`overlay 预检通过：${names.length} 个文件里没有旧世代残留`);
}

// ── 输入自检：基线是判据的一部分，缺了就是"无法判定" ──────────────────────
// 这道闸的判据是"与干净树不同、又与旧树字节相同"，两棵树都是判据本身，不是可选装饰。
// 历史教训：缺了只 console 吼一声、出口照样打 ✓ —— 保护看着在，其实一个字节都没比。
// 现在缺基线 = 无法判定（exit 2）；要放行必须显式 --no-kernel-baseline，那种跑法
// 绝不出现"✓ 世代一致"。另外"旧世代树存在"也不够：目录里得真有内核包文件，
// 空目录当年就是靠一句"路径存在"混过去的。
function oldTreeStatus(dir) {
  let st;
  try { st = fs.statSync(dir); } catch { return { ok: false, why: '路径不存在' }; }
  if (!st.isDirectory()) return { ok: false, why: '不是目录' };
  let kernel = 0;
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, ent.name);
      if (ent.isDirectory()) walk(fp);
      else if (KERNEL_RE.test(path.relative(dir, fp).split(path.sep).join('/'))) kernel++;
    }
  })(dir);
  if (!kernel) return { ok: false, why: '目录里没有任何内核包文件（空树，或布局不是 dshroot/…）' };
  return { ok: true, kernel };
}

// 参考树和旧世代树是同一条判据的两半，量纲得一样：能打开 ≠ 里面有东西可比。
// 一个合法但零条目的 zip、或者把 APK 当 payload.zip 递进来（外层是 zip，里面没有
// dshroot/ 前缀），都能顺利打开，然后每个内核文件都"参考树里没有" → 一条没比 → ✓。
// 所以这里先量一遍：有没有内核文件、内核 package.json 读不读得到。
function refTreeStatus(dir, tree) {
  if (!tree) return { ok: false, why: '打不开' };
  let names;
  try { names = tree.names; } catch { return { ok: false, why: '读不出条目列表' }; }
  const why = [];
  const kernelFiles = names.filter((n) => KERNEL_RE.test(n)).length;
  if (!kernelFiles) why.push(`里面没有任何内核包文件（${names.length} 条条目，布局不是 dshroot/… 或拿错了文件）`);
  if (!names.includes(KERNEL_JSON)) why.push(`里面没有内核 package.json（${KERNEL_JSON}）`);
  else {
    let v = null;
    try { v = JSON.parse(tree.read(KERNEL_JSON).toString('utf8')).version; } catch (e) { why.push(`内核 package.json 读不出来（${e.message}）`); }
    if (v === null && !why.length) why.push('内核 package.json 没有 version 字段');
  }
  if (why.length) return { ok: false, why: why.join('；') };
  return { ok: true, files: kernelFiles };
}

function checkInputs(opts, out) {
  // 显式降级时把输入问题降为提示，结论落到"无法判定但被放行"
  const soft = (msg) => (opts.noKernelBaseline ? out.warnings : out.inputErrors).push(msg);
  if (!opts.ref) soft('没给 --ref 干净参考树 → 分不清"旧世代"和"本机补丁"，世代比对无法运行');
  else if (!out.baseline.ref) soft(`--ref 用不了（${opts.ref}${out.baseline.refWhy ? '：' + out.baseline.refWhy : ''}）→ 世代比对无法运行`);
  if (!opts.old.length) soft('没给 --old 旧世代树 → 手里没有"旧世代字节"，世代比对无法运行');
  else for (const o of opts.old) {
    const s = oldTreeStatus(o);
    if (s.ok) out.baseline.oldTrees.push({ dir: o, files: s.kernel });
    else soft(`--old 不能参与比对（${o}：${s.why}）`);
  }
  if (opts.overlay && !fs.existsSync(opts.overlay)) out.warnings.push(`--overlay 不存在（${opts.overlay}）→ 跳过源头预检`);
  out.baseline.ran = Boolean(out.baseline.ref && out.baseline.oldTrees.length);
  if (!out.baseline.ran && !opts.noKernelBaseline) {
    out.inputErrors.push('世代比对没有基线：本轮只核了前端引用 / 本地静态资源 / 内核家族版本号，'
      + '旧内核整文件被覆盖进来这一档不受任何保护');
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
function runChecks(opts) {
  const out = { violations: [], warnings: [], allowed: [], notes: [], inputErrors: [], kernelVersion: null };
  // 参考树先打开：它打不开就是基线不存在，checkInputs 据此判"无法判定"
  out.baseline = { ran: false, ref: false, refWhy: null, oldTrees: [] };
  refTree = null;
  if (opts.ref) {
    try {
      refTree = openPayload(opts.ref);
      const st = refTreeStatus(opts.ref, refTree);
      if (st.ok) {
        out.baseline.ref = true;
        out.baseline.refFiles = st.files;
      } else {
        out.baseline.refWhy = st.why;
        refTree = null; // 不可用的参考树不能留着当基准
      }
    } catch (e) {
      out.baseline.refWhy = e.message;
    }
  }
  checkInputs(opts, out);
  let payload;
  try {
    payload = openPayload(opts.payload);
  } catch (e) {
    out.violations.push({ check: 'io', path: opts.payload, detail: `打不开 payload：${e.message}` });
    out.fatal = true;
    return out;
  }
  try {
    checkFrontendRefs(payload, out);
  checkLocalAssetRefs(payload, out);
    checkVersionLine(payload, opts.expectVersion, out);
    // 参考树自己的内核版本也要对得上，否则"与干净树不同"这个判据会整体偏掉
    // refTreeStatus 已经验过内核 package.json 读得出来，这里直接取版本；再读失败就是真异常，别吞
    if (out.baseline.ref) {
      const rv = JSON.parse(refTree.read(KERNEL_JSON).toString('utf8')).version;
      if (out.kernelVersion && rv !== out.kernelVersion) {
        out.warnings.push(`参考树内核版本 ${rv} ≠ 本包 ${out.kernelVersion} → 世代比对基准过期，old-generation 结果只作参考`);
      }
    }
    checkOldGeneration(payload, opts, out);
  } finally {
    payload.close();
  }
  checkOverlay(opts, out);
  return out;
}

function report(out, opts) {
  const L = [];
  const base = out.baseline || { ran: false, oldTrees: [] };
  const inputErrs = out.inputErrors || [];
  if (out.kernelVersion) L.push(`内核版本：${out.kernelVersion}${opts.expectVersion ? `（声明 ${opts.expectVersion}）` : ''}`);
  if (typeof out.familyCount === 'number') L.push(`内核家族包：${out.familyCount} 个`);
  if (base.ran) {
    L.push(`世代基线：参考树 + ${base.oldTrees.length} 棵旧世代树（${base.oldTrees.map((t) => path.basename(t.dir) + ':' + t.files).join(', ')}）`);
    L.push(`与参考树逐条比对：${out.comparedCount ?? 0} 条不同；参考树缺失 ${out.refAbsentCount ?? 0} 条`);
  } else {
    L.push('世代基线：无 —— 参考树 / 旧世代树缺一即没有判据');
  }
  for (const n of out.notes) L.push('  · ' + n);
  for (const w of out.warnings) L.push('  ! ' + w);
  if (out.allowed.length) L.push(`  · --allow 放行 ${out.allowed.length} 条本机补丁`);
  if (out.violations.length) {
    L.push('');
    for (const v of out.violations) L.push(`✗ [${v.check}] ${v.path}\n    ${v.detail}`);
    L.push('');
    L.push(`✗ 不通过：${out.violations.length} 条违规 —— 别签名、别上传，先逐条查清。`);
    L.push('  （旧世代整文件覆盖会让新装用户撞 400/白屏；这条链在 v1.48/code296 已经真出过事）');
    if (inputErrs.length) {
      L.push('');
      for (const e of inputErrs) L.push(`✗ [input] ${e}`);
      L.push('  （这些违规是在没有世代基线的状态下判出来的：清完违规也得先补基线，不能就此签名）');
    }
  } else if (inputErrs.length) {
    // 判据的作用对象没了：不许出现"一致"，只能说"无法判定"
    L.push('');
    for (const e of inputErrs) L.push(`✗ [input] ${e}`);
    L.push('');
    L.push('✗ 无法判定：世代比对没有运行 —— 这道闸本轮等于不存在，不许拿它当通过。');
    L.push('  补回基线（--ref + 至少一棵 --old）才会恢复；确认这轮不补，就显式加 --no-kernel-baseline 降级跑。');
  } else if (!base.ran) {
    // 走到这里只可能是显式 --no-kernel-baseline：横幅要让人绕不过去
    L.push('');
    L.push('════════════════════════════════════════════════════════════');
    L.push(' ⚠ 降级运行：本轮没有旧世代基线（--no-kernel-baseline 显式放行）');
    L.push(' 「旧内核整文件覆盖 → 已认证请求 400 / 前端白屏」那道保护【没有运行】。');
    L.push(' 本包是否含旧世代文件：无法判定 —— 不是"没有"，是这轮不查。');
    L.push(' 已核的只有：前端引用、本地静态资源、内核家族版本号。');
    L.push('════════════════════════════════════════════════════════════');
    // 结论放在最后两行是有意的：出包链用 `tail -2` 收日志，关键结论必须落在尾巴上
    L.push(' ⚠ 降级：旧世代保护【没有运行】—— 本包是否含旧世代文件：无法判定');
    L.push(' 补回基线：上一代内核 tar 解到 kernels/<版本>.disabled/dshroot，再去掉 --no-kernel-baseline');
  } else if (out.comparedCount) {
    // 没有违规 ≠ 一切都对：与参考树不同的那几处必须让人自己认
    // （参考树本身也可能脏："本机运行树"不等于"上游原版"）。
    L.push('');
    L.push('✓ 世代一致：没有已知旧世代残留，前端引用齐全。');
    L.push(`  但本次与参考树不同 ${out.comparedCount} 处（上面逐条列了，含 ${out.warnings.length} 条提示）——`);
    L.push('  这些是"不是旧版"而不是"一定是你想要的本机补丁"，签名前请自己过一遍这份清单。');
  } else {
    L.push('✓ 世代一致：没有已知旧世代残留，前端引用齐全（与参考树零差异）。');
  }
  return L.join('\n');
}

// ── 自检：合成用例，不碰真实包 ────────────────────────────────────────────
// 这一批用例的重点不是"好包过、坏包红"，而是"判据本身没了会怎样"：
// 基线缺失、基线是空目录、只有 overlay 没有旧树 —— 这三种形态以前全打 ✓。
// 只把提示改回 warning 而不动出口，自检必须能抓住。
function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coherence-'));
  const K = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
  const KJSON = 'dshroot/lib/node_modules/@deepseek-ai/dsh/package.json';
  const OK_HTML = '<script type="module" src="./assets/index-AAA.js"></script>\n<link rel="stylesheet" href="/mobile.css?v=1">';
  const build = (tag, { pkgVersions, html }) => {
    const entries = [
      { name: KJSON, data: JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }) },
      { name: K + 'dsh-web-frontend/dist/index.html', data: html },
      { name: K + 'dsh-web-frontend/dist/mobile.css', data: 'body{}' },
      { name: K + 'dsh-web-frontend/dist/assets/index-AAA.js', data: 'console.log(1)' },
    ];
    for (const [pkg, v] of Object.entries(pkgVersions)) {
      entries.push({ name: K + pkg + '/package.json', data: JSON.stringify({ name: pkg, version: v }) });
    }
    const z = path.join(tmp, tag + '.zip');
    writeZip(entries, z);
    return z;
  };
  // 好包：版本一条线 + 引用齐全
  const good = build('good', { pkgVersions: { 'dsh-host-webserver': '0.2.2-rc.1', 'dsh-app-boot': '0.2.2-rc.1' }, html: OK_HTML });
  // 坏包 A：混世代（0.2.1 残留）
  const mixed = build('mixed', { pkgVersions: { 'dsh-host-webserver': '0.2.1-rc.5' }, html: OK_HTML });
  // 坏包 B：index.html 引用不存在的 bundle（白屏）
  const brokenHtml = build('brokenhtml', { pkgVersions: { 'dsh-host-webserver': '0.2.2-rc.1' }, html: '<script src="./assets/index-GONE.js"></script><link href="/mobile.css">' });

  // 旧世代残留：参考树放本代字节、旧树放上一代字节，payload 里躺的却是旧字节
  const refDir = path.join(tmp, 'ref'), oldDir = path.join(tmp, 'old');
  const emptyOld = path.join(tmp, 'old-empty'), missingOld = path.join(tmp, 'old-gone');
  const rel = K + 'dsh-host-webserver/lib/index.js';
  for (const [d, body] of [[refDir, 'NEW-0.2.2'], [oldDir, 'OLD-0.2.1']]) {
    fs.mkdirSync(path.join(d, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), body + '\n');
  }
  fs.mkdirSync(emptyOld, { recursive: true });
  fs.mkdirSync(path.join(refDir, path.dirname(KJSON)), { recursive: true });
  fs.writeFileSync(path.join(refDir, KJSON), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }));
  // 参考树本身得是"真有内核文件、和好包同代"的树，否则测的不是判据而是空转
  for (const e of readZip(good, { load: false })) {
    const dst = path.join(refDir, e.name);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, readEntry(good, e));
  }
  const stale = path.join(tmp, 'stale.zip');
  writeZip([
    { name: KJSON, data: JSON.stringify({ version: '0.2.2-rc.1' }) },
    { name: K + 'dsh-web-frontend/dist/index.html', data: OK_HTML },
    { name: K + 'dsh-web-frontend/dist/mobile.css', data: 'body{}' },
    { name: K + 'dsh-web-frontend/dist/assets/index-AAA.js', data: 'x' },
    { name: rel, data: 'OLD-0.2.1\n' },
  ], stale);
  // overlay 里躺着一份旧世代文件：还没进包，但一打包就会被整文件盖进去（事故的源头形态）
  const ovl = path.join(tmp, 'overlay-old');
  fs.mkdirSync(path.join(ovl, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(ovl, rel), 'OLD-0.2.1\n');

  // 参考树在名字上、其实什么都没得比：空 zip / 只有内核 package.json 的薄包
  const emptyRef = path.join(tmp, 'ref-empty.zip');
  writeZip([], emptyRef);
  const thinRef = path.join(tmp, 'ref-thin');
  fs.mkdirSync(path.join(thinRef, path.dirname(KJSON)), { recursive: true });
  fs.writeFileSync(path.join(thinRef, KJSON), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }));

  const none = { payload: null, ref: null, old: [], overlay: null, allow: [], expectVersion: null, noKernelBaseline: false };
  const cases = [
    ['好包 + 有基线', { ...none, payload: good, ref: refDir, old: [oldDir] }, 0, ['✓ 世代一致'], []],
    ['好包但没有基线', { ...none, payload: good }, 2, ['无法判定'], ['✓ 世代一致']],
    ['混世代', { ...none, payload: mixed }, 1, [], []],
    ['引用缺失(白屏)', { ...none, payload: brokenHtml }, 1, [], []],
    ['旧世代残留（旧树在）', { ...none, payload: stale, ref: refDir, old: [oldDir] }, 1, ['[old-generation]'], []],
    ['旧世代残留 + 旧树路径不存在', { ...none, payload: stale, ref: refDir, old: [missingOld] }, 2, ['无法判定'], ['✓ 世代一致']],
    ['旧世代残留 + 旧树是空目录', { ...none, payload: stale, ref: refDir, old: [emptyOld] }, 2, ['无法判定'], ['✓ 世代一致']],
    ['空 zip 当 --ref', { ...none, payload: stale, ref: emptyRef, old: [oldDir] }, 2, ['无法判定'], ['✓ 世代一致']],
    ['--ref 只有内核 package.json', { ...none, payload: stale, ref: thinRef, old: [oldDir] }, 2, ['无法判定'], ['✓ 世代一致']],
    ['逃生口 + 旧树不存在', { ...none, payload: stale, ref: refDir, old: [missingOld], noKernelBaseline: true }, 0, ['没有运行'], ['✓ 世代一致']],
    ['只有 --overlay 没有 --old', { ...none, payload: good, ref: refDir, overlay: ovl }, 2, ['预检未能比对世代'], ['✓ 世代一致', '预检通过']],
    ['overlay 里躺着旧世代 + 有基线', { ...none, payload: good, ref: refDir, old: [oldDir], overlay: ovl }, 1, ['[overlay-stale]'], []],
  ];

  let bad = 0;
  const verdict = (r) => (r.violations.length ? 1 : (r.inputErrors.length ? 2 : 0));
  for (const [label, o, expect, must, mustNot] of cases) {
    const res = runChecks(o);
    const text = report(res, o);
    const got = verdict(res);
    const miss = must.filter((x) => !text.includes(x));
    const seen = mustNot.filter((x) => text.includes(x));
    const ok = got === expect && !miss.length && !seen.length;
    if (!ok) bad++;
    console.log(`${ok ? '  ✓' : '  ✗'} 自检 ${label}：期望退出 ${expect}，实际 ${got}`
      + (miss.length ? `；该有而没输出：${miss.join(' / ')}` : '')
      + (seen.length ? `；不该出现却出现：${seen.join(' / ')}` : '')
      + (ok ? '' : '\n' + text));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (bad) { console.error(`✗ 自检失败 ${bad} 条`); return 2; }
  console.log(`✓ 自检通过（${cases.length} 个合成用例）`);
  return 0;
}

// ── 入口 ──────────────────────────────────────────────────────────────────
function main(argv) {
  const opts = { payload: null, ref: null, old: [], overlay: null, expectVersion: null, allow: [], json: null, selfTest: false,
    noKernelBaseline: process.env.DSH_NO_KERNEL_BASELINE === '1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) { console.error(`✗ ${a} 缺少参数`); process.exit(2); } return v; };
    switch (a) {
      case '--payload': opts.payload = val(); break;
      case '--ref': opts.ref = val(); break;
      case '--old': opts.old.push(val()); break;
      case '--overlay': opts.overlay = val(); break;
      case '--expect-version': opts.expectVersion = val(); break;
      case '--allow': opts.allow.push(val()); break;
      case '--json': opts.json = val(); break;
      case '--self-test': opts.selfTest = true; break;
      case '--no-kernel-baseline': opts.noKernelBaseline = true; break;
      case '-h': case '--help': console.log(USAGE); return 0;
      default: console.error(`✗ 未知参数 ${a}\n\n${USAGE}`); return 2;
    }
  }
  if (opts.selfTest) return selfTest();
  if (!opts.payload) { console.error(`✗ 缺 --payload\n\n${USAGE}`); return 2; }
  const out = runChecks(opts);
  console.log(report(out, opts));
  if (opts.json) {
    const verdict = out.violations.length ? 1 : (out.inputErrors.length ? 2 : 0);
    fs.writeFileSync(opts.json, JSON.stringify({ payload: opts.payload, ref: opts.ref, old: opts.old, overlay: opts.overlay, verdict, ...out }, null, 2));
    console.log(`  报告：${opts.json}`);
  }
  if (out.violations.length) return 1;
  if (out.inputErrors.length) return 2;
  return 0;
}

process.exit(main(process.argv.slice(2)));
