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

R="${DSH_PROJECT:-$(cd "$(dirname "$0")/.." && pwd)}"
SB="$R/selfbuild"
WORK=$SB/work
OUT=$SB/out
NODE=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node
CURL=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/curl
RUN=/data/user/0/com.deepseek.harness/files/work/linux/run.sh
PY=/data/user/0/com.deepseek.harness/files/payload/bin/python3
TC=/data/user/0/com.deepseek.harness/files/toolchain
KEYS=/data/user/0/com.deepseek.harness/files/keys
PAYLOAD_DIR=/data/user/0/com.deepseek.harness/files/payload
BASE=${DSH_BASE:-$WORK/base-current-175.apk}
export LD_LIBRARY_PATH="/data/user/0/com.deepseek.harness/files/payload/runtime/lib:${LD_LIBRARY_PATH:-}"
# 换内核后底本不再是 1.38 的 payload-old.zip；用 DSH_PAY_OLD 指到新内核底本（默认仍是老的）
PAY_OLD=${DSH_PAY_OLD:-$WORK/payload-old.zip}
PAY_NEW=$WORK/payload-new.zip

# ── 背景图 CSS：**唯一源**是 ../bg-patch/dsh-bg.css ──────────────────────
# ⚠️ 但出包实际用的是 build-overlay 里那份**副本**。两份不同步 = 改了源却没生效
#    （2026-10-01 真踩到：源码改好了、v1.29 包里却还是旧遮罩值，白打一版）。
#    这是"本地改动 vs 构建用副本"这一类坑的第三次，所以不再靠人记 ——
#    脚本一启动就同步，之后没有"哪份才算数"的问题。
BG_SRC="$R/bg-patch/dsh-bg.css"
BG_DST="$SB/build-overlay/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-bg.css"
# ⚠️ make-dist-apk.sh 会**先**改 overlay 的 CSS（换 SVG + 换发行遮罩值）**再**调本脚本，
#    所以那条路径下必须跳过自动同步，否则会把它刚改好的覆盖回去 —— 2026-10-01 真踩到，
#    打出来的包背景图变成了个人壁纸（而壁纸文件已被移走 → 用户那边是坏的）。
if [ -z "${DSH_SKIP_BG_SYNC:-}" ] && [ -f "$BG_SRC" ]; then
  mkdir -p "$(dirname "$BG_DST")"
  if ! cmp -s "$BG_SRC" "$BG_DST"; then
    cp "$BG_SRC" "$BG_DST"
    echo "  ↻ 背景 CSS 已从 bg-patch/ 同步到 build-overlay/（原本两份不一致）"
  fi
fi
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

  # ⚠️ 门禁：overlay 里的 open-in-app/lib/client.js 是"上游干净版"，
  #    而背景图靠这个文件里的一段本地注入才会加载。overlay 一覆盖，
  #    注入就没了 → 装上去背景图完全不显示。
  #    2026-10-01 就是这么把已发布的 v1.27 弄坏的（实测 v1.26 有注入、v1.27 = 0）。
  #    这里一应用完 overlay 就验，缺了直接让出包失败。
  "$NODE" "$SB/scripts/check-bg-injection.js"     "$SB/build-overlay/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js"
  ;;
pack)
  # 用法: pack [--dex <classes.dex>] [--asset <本地文件>:<APK 内条目名>]...
  #   --asset：替换独立的 asset（如虚拟屏核心 assets/vscreen_shizuku.jar）。
  #   没有它的话，改这类 asset 的源码再 pack 也进不去包（v143 差点白装）。
  DEX=""; ASSETS=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dex)   DEX="$2"; shift 2 || exit 1;;
      --asset) ASSETS="$ASSETS --asset $2"; shift 2 || exit 1;;
      *) shift;;
    esac
  done
  if [ -f "$PAY_NEW" ]; then PAY=$PAY_NEW; else PAY=-; fi
  [ "$PAY" = "-" ] && [ -z "$DEX" ] && [ -z "$ASSETS" ] && { echo "✗ 既没有 payload-new.zip 也没有 --dex/--asset"; exit 1; }
  [ -n "$DEX" ] && { [ -f "$DEX" ] || { echo "✗ 找不到 dex: $DEX"; exit 1; }; echo "  换 dex: $DEX"; }
  if [ -n "$DEX" ]; then
    "$NODE" "$SB/lib/selfbuild.js" apk-pack "$BASE" "$PAY" "$UNSIGNED" --dex "$DEX" $ASSETS
  else
    "$NODE" "$SB/lib/selfbuild.js" apk-pack "$BASE" "$PAY" "$UNSIGNED" $ASSETS
  fi
  ;;
mark)
  # 问题②的修复：App 只有「内核版本变化或 .complete 缺失」才全量解压；
  # 不写对这两个标记，新内核装上去只会走快速同步 → 树被撕成两半。
  #
  # 2026-10-12：改用 selfbuild.js 的 apk-marks（走 ziptool 原样搬运，只换这两个条目的字节）。
  # 旧实现 `set-apk-markers.py` 用 Python zipfile **整体重写 APK**：
  #   ① 骨架 resources.arsc 的 CRC 与中央目录不符（线上包也如此）→ Python 强校验 CRC 直接抛异常
  #      → 标记一个都没写、退出 1；
  #   ② 整体重写会丢 zipalign 对齐。
  # 而调用处又被 `| tail` 吃掉退出码 ⇒ **长期静默失败**（2026-10-10 查实）。这里显式 `|| exit 1`。
  [ -f "$UNSIGNED" ] || { echo "✗ 先跑 pack"; exit 1; }
  DSH_WORK="$WORK" "$NODE" "$SB/lib/selfbuild.js" apk-marks "$UNSIGNED" "$WORK/unsigned-marked.apk" || exit 1
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
  #      ⚠️ --share-target 不能省：它除了写 launchMode=singleTop，还会补上
  #         SEND / SEND_MULTIPLE 两条分享过滤器（见 lib/android-manifest.js 的
  #         patchManifest + hasShareTarget 回读）。发行流程 make-dist-apk.sh 一直带着它，
  #         而这条装机流程此前漏了 → 自建包里"分享到 DSH"是死的，本地闸门全绿也发现不了
  #         （2026-10-15 查实）。verify 里现在有 check-install-manifest.js 兜底。
  if [ -n "$VC" ]; then
    "$NODE" "$SB/scripts/set-apk-version.js" "$UNSIGNED" "$WORK/unsigned-v.apk" --name "$VN" --code "$VC" --share-target com.deepseek.harness.MainActivity
  else
    "$NODE" "$SB/scripts/set-apk-version.js" "$UNSIGNED" "$WORK/unsigned-v.apk" --name "$VN" --share-target com.deepseek.harness.MainActivity
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
  [ -f "$APK" ] || { echo '✗ 需要明确的已签名 last-apk.txt 产物'; exit 1; }
  echo '— 必须通过真实签名验证 —'
  sh "$RUN" java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool verify --verbose --print-certs "$APK"
  echo '— 包内 payload 必须通过清单 —'
  "$NODE" "$SB/lib/selfbuild.js" payload-extract "$APK" "$WORK/payload-check.zip" >/dev/null
  set +e
  "$NODE" "$SB/lib/selfbuild.js" check "$WORK/payload-check.zip" "$SB/checks.manifest"
  CHK=$?
  set -e
  [ "$(realpath "$WORK/payload-check.zip")" = "$(realpath "$WORK")/payload-check.zip" ] || exit 1
  rm -f "$WORK/payload-check.zip"
  [ "$CHK" -eq 0 ] || exit 1
  echo '— 二进制 manifest 回读 —'
  "$NODE" "$SB/scripts/set-apk-version.js" "$APK" --dump
  # 光 dump 不算闸门：分享过滤器/singleTop/降级 versionCode 都要显式判定（2026-10-15 补）
  MCHK=""
  if [ -f "$BASE" ]; then MCHK="--base $BASE"; fi
  "$NODE" "$SB/scripts/check-install-manifest.js" "$APK" $MCHK
  if [ -f "$WORK/appbuild/out/compile-receipt.json" ]; then
    "$NODE" "$SB/scripts/release-receipts.mjs" compile-check --receipt "$WORK/appbuild/out/compile-receipt.json"
    "$NODE" "$SB/lib/selfbuild.js" dex-extract "$APK" "$WORK/check-classes.dex"
    cmp "$WORK/check-classes.dex" "$WORK/appbuild/out/classes.dex" || { echo '✗ APK dex 与内容哈希编译产物不同'; exit 1; }
  else echo '✗ 无编译输入收据，无法证明源码与 dex 关联'; exit 1
  fi
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
  # 这条路**不传 --dex**：Java 改过时包里还是骨架的旧 dex，verify 的 cmp 必然失败。
  # 故意不改它的语义（免得悄悄把未发布的 Java 带进包），只把坑喊出来。
  echo '⚠️  all 不带 --dex；Java 改过就必须走 pack --dex 序列（见 notes/java-selfbuild-runbook.md）'
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
