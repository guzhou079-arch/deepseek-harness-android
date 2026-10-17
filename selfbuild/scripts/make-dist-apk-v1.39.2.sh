#!/system/bin/sh
# 出 v1.39.2 / code 179 发行包：底本是已发布的 v1.39 dist 包，
# 只换 classes.dex（看门狗白屏修复），payload 逐字节沿用（sha256 5b9a324e… 已核对）。
# 骨架 = work/base-current-175.apk（v1.38/176 装机底本），发行钥匙 = keys/dist.keystore。
set -eu
F=/data/user/0/com.deepseek.harness/files
SB="/sdcard/DeepSeekHarness/projects/dsh-android/selfbuild"
R="/sdcard/DeepSeekHarness/projects/dsh-android"
OVL="$SB/build-overlay"
NODE="$F/payload/runtime/bin/node"
RUN="$F/work/linux/run.sh"
PY="$F/payload/bin/python3"
RECEIPTS="$SB/scripts/release-receipts.mjs"
COMPILE="$SB/work/appbuild/out/compile-receipt.json"
BASE="$SB/work/base-current-175.apk"
PAY="$SB/work/payload-from-dist-139.zip"
DEX="$SB/work/appbuild/out/classes.dex"
export LD_LIBRARY_PATH="$F/payload/runtime/lib:${LD_LIBRARY_PATH:-}"

for f in "$BASE" "$PAY" "$DEX" "$COMPILE"; do [ -s "$f" ] || { echo "✗ 缺材料：$f"; exit 1; }; done
PKCS="$F/keys/dist.keystore"; PASSFILE="$F/keys/dist.keystore.pass"
[ -s "$PKCS" ] && [ -s "$PASSFILE" ] || { echo '✗ 缺发行钥匙/passfile'; exit 1; }
IFS= read -r PASS < "$PASSFILE"
[ -n "$PASS" ] || exit 1

step() { log="$SB/work/dist2-step.log"; if "$@" > "$log" 2>&1; then tail -1 "$log"; else echo "✗ 失败：$*"; tail -25 "$log"; exit 1; fi; }

# ① 编译收据要与 dex 对上（源码 → dex 的可复核链）
step "$NODE" "$RECEIPTS" compile-check --receipt "$COMPILE" --dex "$DEX"

# ② 打未签名包：骨架 + 已发布 payload + 新 dex
UNS="$SB/work/dist2-unsigned.apk"
[ ! -e "$UNS" ] || rm -f "$UNS"
step "$NODE" "$SB/lib/selfbuild.js" apk-pack "$BASE" "$PAY" "$UNS" --dex "$DEX"

# ③ 改版本号 1.39.2 / 179
UNSV="$SB/work/dist2-unsigned-v.apk"
[ ! -e "$UNSV" ] || rm -f "$UNSV"
step "$NODE" "$SB/scripts/set-apk-version.js" "$UNS" "$UNSV" --name 1.39.2 --code 179 --share-target com.deepseek.harness.MainActivity

# ④ 发行钥匙签名
OUT="$SB/out/DeepSeekHarness-v1.39.2-code179-$(date +%Y%m%d-%H%M%S)-$$-dist.apk"
step sh "$RUN" java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool sign \
  --ks /keys/dist.keystore --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --ks-key-alias distkey \
  --out "$OUT" "$UNSV"
SIG="$OUT.signature.log"
step sh "$RUN" java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool verify --verbose --print-certs "$OUT"
sh "$RUN" java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool verify --verbose --print-certs "$OUT" > "$SIG" 2>&1

# ⑤ 隐私扫描（只允许可分发条目进内容范围）
REPORT="$OUT.privacy-report.json"
step "$PY" "$SB/scripts/scan-dist-privacy.py" --apk "$OUT" --overlay "$OVL" \
  --wallpaper "$R/bg-patch/dsh-bg-user.png" --report "$REPORT"
step "$NODE" "$RECEIPTS" evidence --kind privacy --apk "$OUT" --report "$REPORT" --out "$OUT.privacy.json"

# ⑥ 产物收据
ARTIFACT="$SB/out/release-v1.39.2-code179.json"
step "$NODE" "$RECEIPTS" artifact --apk "$OUT" --compile "$COMPILE" --payload "$PAY" \
  --checks "$SB/checks.manifest" --signature "$SIG" --out "$ARTIFACT"

echo "ARTIFACT=$OUT"
echo "RECEIPT=$ARTIFACT"
