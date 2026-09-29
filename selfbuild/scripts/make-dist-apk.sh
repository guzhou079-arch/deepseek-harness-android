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
R=/storage/emulated/0/Download/Operit/dsh_own_app
SB=$R/selfbuild
D=/storage/emulated/0/Download/Operit/dsh-toolchain
REL=dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
DIST=$SB/build-overlay/$REL/dsh-web-frontend/dist
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

# ── 2. 临时改注入集：摘掉个人壁纸 ──────────────────────────────────────
BK=$F/tmp/dist-bk; rm -rf "$BK"; mkdir -p "$BK"
echo "== 摘掉个人壁纸（临时改动，出包后还原）=="
if [ -f "$DIST/dsh-bg-user.png" ]; then mv "$DIST/dsh-bg-user.png" "$BK/"; echo "  移出 dsh-bg-user.png"; fi
cp "$DIST/dsh-bg.css" "$BK/dsh-bg.css"
sed -i 's#--dsh-user-bg-image: url("/dsh-bg-user.png?v=1")#--dsh-user-bg-image: none   /* 发行包：不含个人壁纸，用自带矢量背景 */#' "$DIST/dsh-bg.css"
rg -q -- "--dsh-user-bg-image: none" "$DIST/dsh-bg.css" && echo "  CSS 已改为 none" || { echo "  ✗ CSS 改写失败"; mv "$BK/"* "$DIST/" 2>/dev/null; exit 1; }

# ── 3. 出包（复用现有 dex，只换 payload）──────────────────────────────
echo "== 出包 =="
cd "$SB"
sh selfbuild.sh payload >/dev/null 2>&1
sh selfbuild.sh patch 2>&1 | tail -1
sh selfbuild.sh pack --dex work/appbuild/out/classes.dex 2>&1 | tail -1
STAMP=$(date +%Y%m%d-%H%M%S)
OUT=$SB/out/DeepSeekHarness-dist-$STAMP.apk
$RUN java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool sign \
  --ks /keys/dist.keystore --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --ks-key-alias distkey \
  --out "$OUT" work/unsigned.apk 2>&1 | tail -2

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
$F/bin/python3 - "$OUT" "$F" "$R/bg-patch/dsh-bg-user.png" "$SB/build-overlay" <<'PYEOF'
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
        '游戏/私用包名': r'sgzzlb|aweme\.lite', '绝对私密路径': r'/sdcard/Download/Operit'}
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
