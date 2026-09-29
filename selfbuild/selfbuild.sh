#!/system/bin/sh
# ============================================================================
# DSH Android 自构建（selfbuild）—— 改自己，不需要电脑/构建机
#
#   全部零件都在手机上：
#     · proot + Alpine 3.20 + OpenJDK 17   → files/work/linux/run.sh
#     · android.jar / d8.jar / apksigner.jar → files/toolchain/
#     · pkcs12.keystore（v2+v3 签名）        → files/keys/
#     · payload 重打包                       → selfbuild/lib/{ziptool,selfbuild}.js
#
#   最小闭环：复用装机 APK 的骨架（资源/清单/dex 原样搬运），只替换
#   assets/payload.zip 里的引擎侧文件 → 重新签名 → 装机。
#   资源不改 → 不需要 aapt2；payload 是 STORE → 不需要重压缩 2 万个文件。
#
# 用法：
#   sh selfbuild.sh base                 # 取装机 APK 作为骨架（需可读）
#   sh selfbuild.sh payload              # 从骨架导出 assets/payload.zip
#   sh selfbuild.sh patch                # 用 build-overlay/ 覆盖 payload
#   sh selfbuild.sh pack                 # 骨架 + 新 payload → 未签名 APK
#   sh selfbuild.sh mark                 # 写 dshroot 标记（内核版本+revision，触发 App 全量解压）
#   sh selfbuild.sh version 1.21 52     # 改 APK 版本号（更新提示靠它，必须每包递增）
#   sh selfbuild.sh sign                 # apksigner 签名 → out/
#   sh selfbuild.sh verify               # 指纹 + payload 一致性 + patch-check
#   sh selfbuild.sh install              # 经 App 内嵌特权桥 pm install -r
#   sh selfbuild.sh all                  # payload→patch→pack→sign→verify（不装机）
#   sh selfbuild.sh check                # 只跑装机副本的补丁完整性校验
# ============================================================================
set -e

SB=/storage/emulated/0/Download/Operit/dsh_own_app/selfbuild
WORK=$SB/work
OUT=$SB/out
NODE=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node
CURL=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/curl
RUN=/data/user/0/com.deepseek.harness/files/work/linux/run.sh
PY=/data/user/0/com.deepseek.harness/files/payload/bin/python3
TC=/data/user/0/com.deepseek.harness/files/toolchain
KEYS=/data/user/0/com.deepseek.harness/files/keys
PAYLOAD_DIR=/data/user/0/com.deepseek.harness/files/payload
BASE=$WORK/base-v1.20.apk
PAY_OLD=$WORK/payload-old.zip
PAY_NEW=$WORK/payload-new.zip
UNSIGNED=$WORK/unsigned.apk
mkdir -p "$WORK" "$OUT"

CMD="$1"; shift 2>/dev/null || true

case "$CMD" in
base)
  APK=$(pm path com.deepseek.harness 2>/dev/null | sed -n 's/^package://p' | head -1)
  [ -n "$APK" ] || { echo "✗ 取不到装机 APK 路径（需要 Shizuku/root：pm path）"; exit 1; }
  cp "$APK" "$BASE" && chmod 644 "$BASE"
  echo "✓ 骨架 = $BASE ($(stat -c%s "$BASE") 字节)"
  ;;
payload)
  [ -f "$BASE" ] || { echo "✗ 没有骨架，先跑 base（或手动放 $BASE）"; exit 1; }
  "$NODE" "$SB/lib/selfbuild.js" payload-extract "$BASE" "$PAY_OLD"
  ;;
patch)
  [ -f "$PAY_OLD" ] || { echo "✗ 先跑 payload"; exit 1; }
  "$NODE" "$SB/lib/selfbuild.js" payload-patch "$PAY_OLD" "$PAY_NEW" "$SB/build-overlay"
  ;;
pack)
  # 用法: pack [--dex <classes.dex>]     # 没跑 patch 时 payload 保持原样
  DEX=""
  if [ "$1" = "--dex" ]; then DEX="$2"; shift 2 || true; fi
  if [ -f "$PAY_NEW" ]; then PAY=$PAY_NEW; else PAY=-; fi
  [ "$PAY" = "-" ] && [ -z "$DEX" ] && { echo "✗ 既没有 payload-new.zip 也没有 --dex"; exit 1; }
  [ -n "$DEX" ] && { [ -f "$DEX" ] || { echo "✗ 找不到 dex: $DEX"; exit 1; }; echo "  换 dex: $DEX"; }
  if [ -n "$DEX" ]; then
    "$NODE" "$SB/lib/selfbuild.js" apk-pack "$BASE" "$PAY" "$UNSIGNED" --dex "$DEX"
  else
    "$NODE" "$SB/lib/selfbuild.js" apk-pack "$BASE" "$PAY" "$UNSIGNED"
  fi
  ;;
mark)
  # 问题②的修复：App 只有「内核版本变化或 .complete 缺失」才全量解压；
  # 不写对这两个标记，新内核装上去只会走快速同步 → 树被撕成两半。
  [ -f "$UNSIGNED" ] || { echo "✗ 先跑 pack"; exit 1; }
  "$PY" "$SB/scripts/set-apk-markers.py" "$UNSIGNED" "$WORK/unsigned-marked.apk"
  mv "$WORK/unsigned-marked.apk" "$UNSIGNED"
  ;;
version)
  # 改 APK 内 AndroidManifest.xml 的 versionName / versionCode（二进制直接改，不需要 aapt2）
  #
  # 为什么必须有这一步：selfbuild.sh 的骨架复用策略会把清单原样搬走，
  # 于是每个新包的 versionName 都还是骨架的值 → App 的 checkForUpdate
  # （MainActivity:924，拿 GitHub release tag 比本机 versionName）永远认为「已是最新」
  # → 别人收不到更新提示，只能靠人手传包。
  #
  # 用法: sh selfbuild.sh version 1.21 [52]
  [ -f "$UNSIGNED" ] || { echo "✗ 先跑 pack"; exit 1; }
  VN="$1"; VC="$2"
  [ -n "$VN" ] || { echo "✗ 用法: sh selfbuild.sh version <版本号> [versionCode]"; exit 1; }
  if [ -n "$VC" ]; then
    "$NODE" "$SB/scripts/set-apk-version.js" "$UNSIGNED" "$WORK/unsigned-v.apk" --name "$VN" --code "$VC"
  else
    "$NODE" "$SB/scripts/set-apk-version.js" "$UNSIGNED" "$WORK/unsigned-v.apk" --name "$VN"
  fi
  mv "$WORK/unsigned-v.apk" "$UNSIGNED"
  ;;
sign)
  [ -f "$UNSIGNED" ] || { echo "✗ 先跑 pack"; exit 1; }
  TS=$(date +%Y%m%d-%H%M%S)
  APKOUT=$OUT/DeepSeekHarness-selfbuild-$TS.apk
  # proot 里只挂了 /sdcard（=$F 挂 /host、toolchain 挂 /tc、keys 挂 /keys）
  POUT=$(echo "$APKOUT"   | sed 's#^/storage/emulated/0#/sdcard#')
  PIN=$(echo "$UNSIGNED"  | sed 's#^/storage/emulated/0#/sdcard#')
  sh "$RUN" java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool sign \
    --ks /keys/pkcs12.keystore --ks-pass pass:android \
    --ks-key-alias androidkey --key-pass pass:android \
    --out "$POUT" "$PIN"
  echo "✓ 已签名: $APKOUT ($(stat -c%s "$APKOUT") 字节)"
  echo "$APKOUT" > "$WORK/last-apk.txt"
  ;;
verify)
  APK=$(cat "$WORK/last-apk.txt" 2>/dev/null || true)
  [ -f "$APK" ] || APK=$UNSIGNED
  [ -f "$APK" ] || { echo "✗ 没有可校验的 APK"; exit 1; }
  echo "— 签名指纹 —"
  "$NODE" "$SB/lib/apkcert.js" "$APK"
  echo "— 包内 payload 补丁一致性（清单对比） —"
  "$NODE" "$SB/lib/selfbuild.js" payload-extract "$APK" "$WORK/payload-check.zip" >/dev/null
  "$NODE" "$SB/lib/selfbuild.js" check "$WORK/payload-check.zip" "$SB/checks.manifest" || true
  rm -f "$WORK/payload-check.zip"
  echo "— classes.dex 完整性（必须是 App 侧真身，不是空壳） —"
  "$NODE" "$SB/lib/selfbuild.js" dex-extract "$APK" "$WORK/check-classes.dex"
  D=$WORK/check-classes.dex
  for k in MainActivity AccessibilityService VsreenBridgeService ScheduleExecutor NfcStore; do
    if rg -a -q "$k" "$D"; then echo "  ✅ dex 含 $k"; else echo "  ❌ dex 缺 $k"; fi
  done
  echo "  dex 字节数: $(stat -c%s "$D")"
  ;;
check)
  sh "$SB/patch-check.sh"
  ;;
install)
  APK=$(cat "$WORK/last-apk.txt" 2>/dev/null || true)
  [ -f "$APK" ] || { echo "✗ 先 sign"; exit 1; }
  sh "$SB/install-apk.sh" "$APK"
  ;;
all)
  sh "$SB/selfbuild.sh" payload
  sh "$SB/selfbuild.sh" patch
  sh "$SB/selfbuild.sh" pack
  sh "$SB/selfbuild.sh" mark
  sh "$SB/selfbuild.sh" sign
  sh "$SB/selfbuild.sh" verify
  ;;
*)
  sed -n '2,30p' "$SB/selfbuild.sh"
  ;;
esac
