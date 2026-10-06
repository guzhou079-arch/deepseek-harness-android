#!/system/bin/sh
# ============================================================================
# 出一个**可以发给别人**的干净安装包
#
#   sh make-dist-apk.sh
#
# 与"自己的包"的区别：
#   ① 不含个人壁纸（dsh-web-frontend/dist/dsh-bg-user.png），背景改用自带的通用矢量图；
#   ② 用**独立的发行钥匙**签名（files/keys/dist.keystore），你自己的 pkcs12.keystore 不参与；
#   ③ 出包后自动做隐私扫描（壁纸/密钥/AGENTS/手机号邮箱样式），有命中就报错并停下。
#
# 注意：本包**不要装到你自己机器上**（签名不同，会与现有安装冲突）。
# ============================================================================
set -e
F=/data/user/0/com.deepseek.harness/files
R="${DSH_PROJECT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SB=$R/selfbuild
D=/storage/emulated/0/Download/Operit/dsh-toolchain
REL=dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
DIST=$SB/build-overlay/$REL/dsh-web-frontend/dist
OVL=$SB/build-overlay
KEY=$F/keys/dist.keystore
PASSFILE=$F/keys/dist.keystore.pass
RUN="sh $F/work/linux/run.sh"

# ── 1. 准备发行钥匙（一次生成，之后复用）──────────────────────────────
if [ ! -s "$KEY" ]; then
  echo "== 生成独立发行钥匙 =="
  PASS=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)
  echo "$PASS" > "$PASSFILE"; chmod 600 "$PASSFILE"
  $RUN keytool -genkeypair -v -keystore /keys/dist.keystore -storetype PKCS12 \
    -alias distkey -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=DSH Self-build Distribution, O=Self-build, C=CN" 2>&1 | tail -3
fi
PASS=$(cat "$PASSFILE")
echo "  发行钥匙: $KEY（口令在 $PASSFILE，600 权限）"

# 出包脚本自己负责改 overlay 的 CSS（换 SVG、换发行遮罩值），
# 所以要让 selfbuild.sh **别**把它自动同步回去。
export DSH_SKIP_BG_SYNC=1

# ── 2. 临时改注入集：摘掉个人壁纸 ──────────────────────────────────────
BK=$F/tmp/dist-bk; rm -rf "$BK"; mkdir -p "$BK"

# ⚠️ 2026-09-30 加：还原必须**无论如何都执行**。
#   起因：那天脚本因为 overlay 里缺 dsh-bg.css 在 cp 那步失败，
#   set -e 直接退出 → 第 4 步的还原没跑到 → **overlay 里的个人壁纸被留在备份目录**，
#   注入集处于半个坏状态。加 trap 之后，失败也会还原。
restore_dist() {
  [ -f "$BK/dsh-bg.css" ] && cp "$BK/dsh-bg.css" "$DIST/dsh-bg.css" 2>/dev/null
  [ -f "$BK/dsh-bg-user.png" ] && mv "$BK/dsh-bg-user.png" "$DIST/" 2>/dev/null
  [ -d "$BK/profiles" ] && mv "$BK/profiles" "$OVL/dshhome/" 2>/dev/null
  if [ -d "$BK/dshhome-extra" ]; then mv "$BK/dshhome-extra"/* "$OVL/dshhome/" 2>/dev/null; fi
  rm -rf "$BK" 2>/dev/null
  return 0
}
trap restore_dist EXIT

echo "== 摘掉个人壁纸（临时改动，出包后还原）=="
if [ -f "$DIST/dsh-bg-user.png" ]; then mv "$DIST/dsh-bg-user.png" "$BK/"; echo "  移出 dsh-bg-user.png"; fi
# ⚠️ overlay 里的 dshhome 是**开发者私人 profile 的所在地**（package.json 里带
#   `link:/sdcard/Download/<私人目录>/...`，只在开发机上存在）。发行包应当继承骨架里那份干净的 profile
#   —— 线上 v1.26 / v1.29 就是这么发的。
#
# ⚠️ 2026-10-02 两次修正：
#   ① 以前整目录 `mv "$OVL/dshhome"` —— 那时 dshhome 下只有私人 profile，搬走是对的；
#      但现在 dshhome 下还放着**要随包分发的技能**（dshhome/skills/），整目录搬走
#      = 发行包里静默没有技能。
#   ② 只搬 `profiles` 又是**黑名单思路**：以后谁往 dshhome 下丢一个新目录
#      （笔记 / 草稿 / review.json…）都会静默进包。
#   → 改成**白名单**：dshhome 下只有名单里的目录允许进包，其余一律搬走并打印。
DHOME_ALLOW="skills"
if [ -d "$OVL/dshhome" ]; then
  for p in "$OVL/dshhome"/* "$OVL/dshhome"/.[!.]*; do
    [ -e "$p" ] || continue
    b=$(basename "$p")
    case " $DHOME_ALLOW " in
      *" $b "*) echo "  随包保留 dshhome/$b（$(ls "$p" 2>/dev/null | tr '\n' ' ')）" ;;
      *) mkdir -p "$BK/dshhome-extra"; mv "$p" "$BK/dshhome-extra/"; echo "  ⚠ 移出非白名单 dshhome/$b（不进发行包）" ;;
    esac
  done
fi
# overlay 里必须自带 dsh-bg.css（2026-09-30 起）：以前它从骨架 APK 的 payload 继承，
# 于是「发行版 CSS 指向哪张图」取决于用了哪个骨架 —— 这也正是那次 cp 失败的原因。
[ -f "$DIST/dsh-bg.css" ] || { echo "  ✗ overlay 里没有 dsh-bg.css：$DIST"; echo "     修法：cp bg-patch/dsh-bg.css \"$DIST/\""; exit 1; }
cp "$DIST/dsh-bg.css" "$BK/dsh-bg.css"
# ⚠️ 2026-09-30 修：这里原来写成 `--dsh-user-bg-image: none`，但注释写的是
#   "用自带矢量背景" —— 注释与实现不符。结果是发行版**一张背景图都没有**，
#   只剩那层遮罩，比自带图还黑（用户反馈"屏幕太黑"有一部分就来自它）。
#   现在按注释的本意改成指向自带的 /dsh-bg.svg。
sed -i 's#url("/dsh-bg-user.png?v=1")#url("/dsh-bg.svg?v=1")#' "$DIST/dsh-bg.css"

# 遮罩有**两套四个值**（主题 × 图亮度），发行版要**全部**改掉 ——
# 个人版：浅色 0.55/0.70、深色 0.60/0.76（针对那张亮插画）
# 发行版：浅色 0.70/0.82、深色 0.18/0.36（针对自带的深蓝矢量图，底色 #0a1020）
#
# ⚠️ 用**变量名**当锚点，不要用数值当锚点 —— 0.70 在浅色里出现两次，
#    按数值 sed 会连环误伤（先改一个、下一个 sed 又把它当目标）。
sed -i 's#\(--dsh-user-bg-scrim-top-light:\) *rgba([^)]*)#\1 rgba(247, 249, 253, 0.70)#' "$DIST/dsh-bg.css"
sed -i 's#\(--dsh-user-bg-scrim-bottom-light:\) *rgba([^)]*)#\1 rgba(247, 249, 253, 0.82)#' "$DIST/dsh-bg.css"
sed -i 's#\(--dsh-user-bg-scrim-top-dark:\) *rgba([^)]*)#\1 rgba(4, 8, 16, 0.18)#' "$DIST/dsh-bg.css"
sed -i 's#\(--dsh-user-bg-scrim-bottom-dark:\) *rgba([^)]*)#\1 rgba(4, 8, 16, 0.36)#' "$DIST/dsh-bg.css"
# 深色主题遮罩也要跟着换：个人壁纸偏亮 → 需要 0.60/0.76 压暗；
# 自带 SVG 本身就是深蓝低对比 → 只轻压，否则图形被盖死成纯黑（"图是黑的"）。
sed -i 's#--dsh-user-bg-scrim-top-dark: rgba(4, 8, 16, 0.60)#--dsh-user-bg-scrim-top-dark: rgba(4, 8, 16, 0.18)#' "$DIST/dsh-bg.css"
sed -i 's#--dsh-user-bg-scrim-bottom-dark: rgba(4, 8, 16, 0.76)#--dsh-user-bg-scrim-bottom-dark: rgba(4, 8, 16, 0.36)#' "$DIST/dsh-bg.css"
if rg -q -- 'dsh-user-bg-image: url\("/dsh-bg\.svg\?v=1"\)' "$DIST/dsh-bg.css" \
   && rg -q -- 'dsh-user-bg-scrim-top-dark: rgba\(4, 8, 16, 0\.18\)' "$DIST/dsh-bg.css"; then
  echo "  CSS 已改为：背景=自带矢量图 /dsh-bg.svg，深色遮罩轻压 0.18/0.36"
else
  echo "  ✗ CSS 改写失败"; mv "$BK/"* "$DIST/" 2>/dev/null; exit 1
fi

# ── 3. 出包（复用现有 dex，只换 payload）──────────────────────────────
echo "== 出包 =="
cd "$SB"

# ⚠️ 门禁（2026-10-02 加）：dex 必须比所有 Java 源码**新**。
#   背景：这一步用的是上一次 javac 的产物 work/appbuild/out/classes.dex。
#   如果本轮改了 OverlayService/MainActivity 却没重编，发行包就会**悄悄缺掉本机已测的功能**
#   —— 正是"发行包比本机包少功能"这类事故的入口。宁可在这里失败。
DEX=work/appbuild/out/classes.dex
[ -f "$DEX" ] || { echo "  ✗ 没有 $DEX —— 先跑 selfbuild/scripts/javac-app.sh 编译 App 侧 Java"; exit 1; }
STALE=$(find $R/v118/android-app/src -name '*.java' -newer "$DEX" 2>/dev/null | head -3)
if [ -n "$STALE" ]; then
  echo "  ✗ dex 比 Java 源码旧，先重编（javac-app.sh）再出包："
  echo "$STALE" | sed 's/^/      /'
  exit 1
fi
echo "  ✓ dex 不旧于源码：$(stat -c%s "$DEX") 字节"

sh selfbuild.sh payload >/dev/null 2>&1
sh selfbuild.sh patch 2>&1 | tail -1

# ⚠️ 必须剔除从骨架解出来的个人内容（壁纸/私人路径）——
# 出包脚本只把壁纸从 overlay 挪走，管不到骨架 payload 里已经带进来的那份。
echo "== 剔除发行包里不该有的条目 =="
"$F/payload/runtime/bin/node" scripts/strip-dist-payload.js work/payload-new.zip

# ⚠️ 瘦身（2026-10-02 加）：runtime/lib 下的**重复 .so 副本**换成 LINKS.txt 声明。
#   本机自建链的 payload 里 libicudata 等有 2~3 份逐字节相同的真副本（原始数据多 85MB、
#   落盘多 ~36MB）；App 首次解压时会按 LINKS.txt 自己建硬链接（MainActivity.applyLinks）。
#   已发布的 v1.29 就是这个形状 —— 这一步是"回到已验证的发行形状"，不是新机制。
"$F/payload/runtime/bin/node" scripts/slim-dist-payload.js work/payload-new.zip

sh selfbuild.sh pack --dex "$DEX" 2>&1 | tail -1

# ⚠️ 2026-10-02 加：写 dshroot 标记（内核版本 + 新 revision）。
#   不发新 revision 的话，老用户从上一版升上来时 App 判定"不用同步"，
#   新加的文件只能靠白名单兜底（技能/配置在名单里没问题，但这是运气不是设计）。
#   内核版本从 payload 的 dsh/package.json 读（不变）→ 升级仍走**快速同步**，
#   不会让用户白等一次 2.5 万文件的全量解压。
sh selfbuild.sh mark 2>&1 | tail -1

STAMP=$(date +%Y%m%d-%H%M%S)
OUT=$SB/out/DeepSeekHarness-dist-$STAMP.apk

# ── 3.5 版本号：不设就是骨架的版本，更新检查必然失效 ──────────────────
# ⚠️ 2026-09-30 加。背景：selfbuild 复用骨架 APK，**清单里的 versionName/Code
#   永远是骨架那份**（骨架是 base-v1.20 → 1.20/51）。而 App 的 checkForUpdate 是拿
#   release tag 跟本机 versionName 比 —— 不显式改，别人装上去永远是「已是最新」，
#   收不到任何更新提示。而且 versionCode 低于用户已装的那份时，
#   `pm install -r` 会直接因降级被拒。
#
#   所以：**发布必须带版本号**，且 versionName 要与 release tag 一致。
#     DSH_DIST_VERSION=1.27 DSH_DIST_CODE=59 sh make-dist-apk.sh
#
#   与本地测试包的约定（2026-09-30 定）：
#     · 本地测试包：只 bump versionCode，**不要动 versionName**
#       （以前每出一包就 bump versionName，导致本机 1.65 遥遥领先公开的 1.26，
#         更新检查就没法用了）
#     · 发布包：versionName = 公开版本（= tag），versionCode 在上一版基础上 +1
NODE=$F/payload/runtime/bin/node
UNSIGNED=work/unsigned.apk
if [ -n "${DSH_DIST_VERSION:-}" ]; then
  echo "== 改版本号 → ${DSH_DIST_VERSION}${DSH_DIST_CODE:+ (code $DSH_DIST_CODE)} =="
  if [ -n "${DSH_DIST_CODE:-}" ]; then
    "$NODE" scripts/set-apk-version.js work/unsigned.apk work/unsigned-v.apk \
      --name "$DSH_DIST_VERSION" --code "$DSH_DIST_CODE" 2>&1 | sed 's/^/  /'
  else
    "$NODE" scripts/set-apk-version.js work/unsigned.apk work/unsigned-v.apk \
      --name "$DSH_DIST_VERSION" 2>&1 | sed 's/^/  /'
  fi
  UNSIGNED=work/unsigned-v.apk
else
  echo "⚠️ 没给 DSH_DIST_VERSION —— 版本号会沿用骨架的值："
  "$NODE" scripts/set-apk-version.js work/unsigned.apk --dump 2>&1 | sed 's/^/     /'
  echo "    这样 App 的更新检查会失效（tag 比本机 versionName 小）。"
  echo "    正确用法：DSH_DIST_VERSION=1.27 DSH_DIST_CODE=59 sh make-dist-apk.sh"
fi

$RUN java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool sign \
  --ks /keys/dist.keystore --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --ks-key-alias distkey \
  --out "$OUT" "$UNSIGNED" 2>&1 | tail -2

# ── 4. 还原注入集 ────────────────────────────────────────────────────
echo "== 还原注入集 =="
cp "$BK/dsh-bg.css" "$DIST/dsh-bg.css"
[ -f "$BK/dsh-bg-user.png" ] && mv "$BK/dsh-bg-user.png" "$DIST/" && echo "  个人壁纸已放回（你自己的包不受影响）"
rm -rf "$BK"

# ── 5. 隐私扫描（有命中就判失败）──────────────────────────────────────
# 分三层，避免第三方库的测试数据造成误报：
#   ① 文件名层：整棵 payload 扫"壁纸文件名/密钥/AGENTS/自建脚本"
#   ② 字节层：逐条 md5 比对，确认你的壁纸**没有任何一条**藏在别的文件名下
#   ③ 内容层：只扫**我们自己加进去的文件**（build-overlay 里的那些 + CHANGELOG + 外层 assets）
echo "== 隐私扫描 =="
# python3 的位置换过：2026-09-29 那次数据丢失后 files/bin/ 没了，现在在 payload/bin/。
# 别再写死一个路径 —— 写死的那次让整个出包以 127 收场（其实产物已经出好了）。
PY=""
for c in "$F/payload/bin/python3" "$F/bin/python3"; do
  [ -x "$c" ] && { PY="$c"; break; }
done
[ -z "$PY" ] && command -v python3 >/dev/null 2>&1 && PY=python3
if [ -z "$PY" ]; then
  echo "  ⚠️ 找不到 python3 → 跳过隐私扫描。"
  echo "     跳过不代表干净：装/发之前自己确认包里没有个人内容。产物在 $OUT"
  exit 0
fi
"$PY" - "$OUT" "$F" "$R/bg-patch/dsh-bg-user.png" "$SB/build-overlay" <<'PYEOF'
import zipfile, sys, io, re, os, hashlib
apk, F, png, ovl = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
z = zipfile.ZipFile(apk)
inner = zipfile.ZipFile(io.BytesIO(z.read('assets/payload.zip')))
names = set(inner.namelist())
bad = 0

# ① 文件名层
print("  ① 文件名扫描（整包）")
for label, p in {
  '个人壁纸': r'dsh-bg-user', '私钥/keystore': r'keystore|\.p12$|pkcs12',
  'AGENTS.md 文件': r'AGENTS\.md$', '自建脚本': r'selfbuild/', '提示词/笔记': r'PATCH-NOTES',
  # 2026-10-02 加（个人数据清查）
  '桌宠源图/预览': r'whale-shota', '派生美术': r'archive-2\.5d',
  '源码/文件备份': r'\.(bak|orig|pre-lan)(-[\d.]+)?$', '会话数据': r'session\.v4\.jsonl',
  '登录凭据': r'\.credentials',
}.items():
    hits = [n for n in names if re.search(p, n, re.I)]
    print(f"     {label:<14} {'❌ ' + str(hits[:2]) if hits else '✅ 0'}")
    bad += len(hits)

# ② 字节层：你的壁纸是否以别的名字藏在包里
print("  ② 壁纸字节比对（逐条 md5）")
if os.path.isfile(png):
    want = hashlib.md5(open(png, 'rb').read()).hexdigest()
    hit = [n for n in names if n.endswith(('.png', '.jpg', '.jpeg', '.webp'))
           and hashlib.md5(inner.read(n)).hexdigest() == want]
    print(f"     {'❌ 藏在: ' + str(hit) if hit else '✅ 没有（%s）' % want[:8] + '…'}")
    bad += len(hit)
else:
    print("     （找不到你的壁纸原文件，跳过）")

# ③ 内容层：只扫我们自己加进去的文件（第三方库的测试数据不算我们的问题）
print("  ③ 内容扫描（只扫我们自己的改动）")
mine = []
for root, _, files in os.walk(ovl):
    for f in files:
        mine.append(os.path.join(root, f))
outer = ['assets/mobile.css', 'assets/mobile.js', 'AndroidManifest.xml']
pats = {'手机号': r'1[3-9]\d{9}', '邮箱': r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|cn|net)',
        '游戏/私用包名': r'sgzzlb|aweme\.lite', '绝对私密路径': r'/sdcard/Download/(?!(?:DeepSeekHarness|DSH_Backups|DSH_Knowledge)(?:/|[^\w/]|$))[^\s"\'`<>]+',
        # 开发机路径 / 密钥形态。
        # ⚠️ 素材名（whale-shota/dsh-bg-user）**只做文件名层检查**，不做内容层 ——
        #    文档里解释"为什么不随包分发"、以及静态门禁代码里引用这两条路径，都是正常内容，
        #    内容层扫它们只会误报（实测踩过：CHANGELOG + dsh-host-frontend-static 两处误报）。
        '开发机路径': r'dsh_own_app|fluidcard-mock|/sdcard/Download/(?!(?:DeepSeekHarness|DSH_Backups|DSH_Knowledge)(?:/|[^\w/]|$))[^\s"\'`<>]+',
        '密钥形态': r'\bsk-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_'}
for path in mine + outer:
    if path.startswith(ovl):
        rel = 'dshroot/' + os.path.relpath(path, ovl + '/dshroot') if '/dshroot/' in path else None
        if rel is None or rel not in names:
            # build-overlay 里可能直接在 payload 根下
            rel = os.path.relpath(path, ovl)
            if rel not in names: continue
        try: s = inner.read(rel).decode('utf-8', 'ignore')
        except Exception: continue
        label = rel.replace('dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/', '')
    else:
        try: s = z.read(path).decode('utf-8', 'ignore')
        except Exception: continue
        label = path
    for name, p in pats.items():
        m = re.search(p, s)
        if m:
            print(f"     ⚠ {label}: {name} → 「{m.group()[:40]}」"); bad += 1
# ⚠️ 硬判据：发行包的背景图**必须**是自带矢量图，不能指向个人壁纸。
#    2026-10-01 踩到：selfbuild.sh 的 bg 自动同步把 make-dist-apk.sh 刚改好的 CSS
#    覆盖回个人版 → 打出来的包指向 /dsh-bg-user.png，而壁纸文件已被移走 → 用户那边背景是坏的。
#    当时这段只"报告"没"拦截"，等于门禁形同虚设。
_css2 = inner.read('dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-bg.css').decode('utf-8', 'ignore')
_usg2 = [l.strip() for l in _css2.split('\n') if '--dsh-user-bg-image:' in l]
if not _usg2 or 'dsh-bg.svg' not in _usg2[0]:
    print("     ❌ 背景图不是 /dsh-bg.svg —— 不要分发")
    print("        （多半是 selfbuild.sh 的 bg 自动同步，把 make-dist-apk.sh 改好的 CSS 覆盖回去了）")
    bad += 1
print(f"  结果: {'❌ 有个人内容，不要分发' if bad else '✅ 干净，可以分发'}")

# 附加信息：背景是否已指向通用图
css = inner.read('dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-bg.css').decode('utf-8', 'ignore')
usage = [l.strip() for l in css.split('\n') if '--dsh-user-bg-image:' in l]
print("  背景设置:", usage[0] if usage else '(未找到)')
print("  通用背景图 dsh-bg.svg 在包内:", any(n.endswith('dsh-bg.svg') for n in names))
sys.exit(1 if bad else 0)
PYEOF
SCAN=$?

echo
echo "== 产物 =="
ls -la "$OUT" | awk '{print "  " $NF "  " int($5/1048576) "MB"}'
$RUN java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool verify --print-certs "$OUT" 2>&1 | rg "Signer #1 certificate DN|Signer #1 certificate SHA-256" | sed 's/^/  /'
exit $SCAN
