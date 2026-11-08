#!/system/bin/sh
# Build one explicitly selected dist artifact. Compilation is a prior step.
# Required: DSH_DIST_VERSION=<name> DSH_DIST_CODE=<1..2147483647>
# Preview without building: append --print-plan. Historical versioned scripts remain unchanged.
set -eu
F=/data/user/0/com.deepseek.harness/files
R="${DSH_PROJECT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SB="$R/selfbuild"; OVL="$SB/build-overlay"
DIST="$OVL/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist"
NODE="$F/.bin/node"
RUN="$F/work/linux/run.sh"
export LD_LIBRARY_PATH="$F/payload/runtime/lib:${LD_LIBRARY_PATH:-}"
export DSH_PROJECT="$R"
V="${DSH_DIST_VERSION:-}"; C="${DSH_DIST_CODE:-}"
# 未显式指定时，按 selfbuild/VERSION + 本机已出的同名包取：自用装过的那一版就是对外要发的
# 这一版，同一个号。显式给则照旧校验，写错就停。
if [ -z "$V" ] && [ -z "$C" ]; then
  PLAN=$("$NODE" "$SB/scripts/version-check.js" --current) || exit 1
  V=$(echo "$PLAN" | sed -n 's/^name=//p'); C=$(echo "$PLAN" | sed -n 's/^code=//p')
fi
case "$V" in ''|*[!0-9.]*|.*|*.|*..*) echo '✗ DSH_DIST_VERSION must contain digits/dots and no empty segment'; exit 2 ;; esac
case "$C" in ''|*[!0-9]*|0*) echo '✗ DSH_DIST_CODE must be a canonical integer in 1..2147483647'; exit 2 ;; esac
[ "$C" -ge 1 ] && [ "$C" -le 2147483647 ] || { echo '✗ DSH_DIST_CODE out of range'; exit 2; }
# 发行包不是新版本：名字和号都必须对上「已经自用装过的那一版」，自己编一个号就停。
"$NODE" "$SB/scripts/version-check.js" --dist --name "$V" --code "$C" || exit 1
if [ "${1:-}" = "--print-plan" ]; then
  printf 'version=%s\ncode=%s\noutput=DeepSeekHarness-v%s-code%s-<timestamp>-<pid>-dist.apk\n' "$V" "$C" "$V" "$C"
  exit 0
fi
BASE="${DSH_BASE_APK:-$SB/work/base-current-295.apk}"
[ -f "$BASE" ] || { echo '✗ Missing base-current-295.apk'; exit 1; }
# 底包钉 sha256：`/selfbuild/work/*` 被 .gitignore，这份 162MB 是本机缓存，被清掉或换成
# 另一个同名包时**没有任何告警**；而 295 的产物看起来可能和原来一模一样（current 真补丁
# 早烘进底包了），事后无法从产物反推底包被换过。所以存在性检查之外再验内容。
# 合法换底包：改下面这行默认值，或 DSH_BASE_SHA256=<新值> 覆盖（逃生口）。
BASE_SHA256="${DSH_BASE_SHA256:-edf0043c4b617e67c694b315847929b62f9d708fce7c40f019b53d0e1392854c}"
case "$BASE_SHA256" in
  *[!0-9a-f]*|'') echo '✗ DSH_BASE_SHA256 必须是 64 位小写十六进制'; exit 2 ;;
esac
[ "${#BASE_SHA256}" -eq 64 ] || { echo '✗ DSH_BASE_SHA256 必须是 64 位小写十六进制'; exit 2; }
BASE_ACTUAL_SHA256=$(sha256sum "$BASE" | cut -d' ' -f1)
[ "$BASE_ACTUAL_SHA256" = "$BASE_SHA256" ] || {
  echo "✗ 底包被换过：$BASE"
  echo "  期望 sha256 $BASE_SHA256"
  echo "  实际 sha256 $BASE_ACTUAL_SHA256"
  echo "  合法换底包请改本脚本默认值，或 DSH_BASE_SHA256=<新值> make-dist"
  exit 1
}
[ -z "${DSH_BASE:-}" ] || [ "$(realpath "$DSH_BASE")" = "$(realpath "$BASE")" ] || { echo '✗ Wrong APK base'; exit 1; }
export DSH_BASE="$BASE"
DEX="$SB/work/appbuild/out/classes.dex"
RECEIPTS="$SB/scripts/release-receipts.mjs"
COMPILE="$SB/work/appbuild/out/compile-receipt.json"
"$NODE" "$RECEIPTS" compile-check --receipt "$COMPILE" --dex "$DEX"
mkdir -p "$SB/work" "$SB/out"
KEY="$F/keys/dist.keystore"; PASSFILE="$F/keys/dist.keystore.pass"
[ -s "$KEY" ] && [ -s "$PASSFILE" ] || { echo '✗ Distribution key/passfile must already exist'; exit 1; }
IFS= read -r PASS < "$PASSFILE"
[ -n "$PASS" ] || exit 1
PY=""
for candidate in "$F/payload/bin/python3" "$F/bin/python3"; do [ ! -x "$candidate" ] || { PY="$candidate"; break; }; done
if [ -z "$PY" ]; then PY=$(command -v python3) || { echo '✗ Python required; privacy scan cannot be skipped'; exit 1; }; fi
runlog() {
  log="$SB/work/dist-step.log"
  if "$@" > "$log" 2>&1; then tail -2 "$log"; else echo "✗ Step failed (log $log)"; tail -20 "$log"; exit 1; fi
}
# Per-run backup is never deleted until every moved seed entry has returned.
BK="$SB/work/dist-backup-$$"
[ ! -e "$BK" ] || { echo '✗ Backup path already exists; inspect manually'; exit 1; }
[ "$(realpath -m "$BK")" = "$(realpath "$SB/work")/dist-backup-$$" ] || exit 1
mkdir -p "$BK/dshhome-extra"
restore_dist() {
  result=0
  if [ -f "$BK/dsh-bg.css" ]; then cp "$BK/dsh-bg.css" "$DIST/dsh-bg.css" || result=1; fi
  if [ -f "$BK/dsh-bg-user.png" ]; then
    [ ! -e "$DIST/dsh-bg-user.png" ] && mv "$BK/dsh-bg-user.png" "$DIST/dsh-bg-user.png" || result=1
  fi
  for source in "$BK/dshhome-extra"/* "$BK/dshhome-extra"/.[!.]* "$BK/dshhome-extra"/..?*; do
    [ -e "$source" ] || continue
    name=$(basename "$source"); dest="$OVL/dshhome/$name"
    [ "$(realpath -m "$source")" = "$(realpath "$BK/dshhome-extra")/$name" ] || { result=1; continue; }
    [ ! -e "$dest" ] && mv "$source" "$dest" || result=1
  done
  if [ "$result" -eq 0 ]; then
    [ "$(realpath "$BK")" = "$(realpath "$SB/work")/dist-backup-$$" ] || return 1
    rm -rf "$BK"
  else echo "✗ Restore incomplete; preserved backup at $BK" >&2
  fi
  return "$result"
}
cleanup() { status=$?; trap - EXIT HUP INT TERM; if [ -d "$BK" ]; then restore_dist || status=1; fi; exit "$status"; }
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
export DSH_SKIP_BG_SYNC=1
[ -f "$DIST/dsh-bg.css" ] || { echo '✗ Missing overlay background CSS'; exit 1; }
cp "$DIST/dsh-bg.css" "$BK/dsh-bg.css"
# DSH_KEEP_USER_BG=1：自用装机包保留机主壁纸（dsh-bg-user.png 随包 + CSS 指向它）。
# 默认（发行）仍然脱敏：壁纸挪出 dist、CSS 回落默认 svg。
if [ "${DSH_KEEP_USER_BG:-0}" != "1" ] && [ -f "$DIST/dsh-bg-user.png" ]; then
  [ "$(realpath "$DIST/dsh-bg-user.png")" = "$(realpath "$DIST")/dsh-bg-user.png" ] || exit 1
  mv "$DIST/dsh-bg-user.png" "$BK/dsh-bg-user.png"
fi
# 随包内置插件在 profiles 的落地（v1.38 起必须随包：冷启动 FORCE_OVERWRITE 要有源，
# 否则"插件改了不生效"的老毛病在发行包里依旧存在）。只允许内置插件目录，
# 防止把开发机上的用户插件 .pnpm / 个人状态打进发行包 —— 多一个条目就失败退出。
PROF_MOD="$OVL/dshhome/profiles/web/node_modules"
if [ -d "$PROF_MOD" ]; then
  PROF_ALLOW="dsh-android-console dsh-plugin-auto-summary-policy dsh-plugin-session-rewind dsh-plugin-turn-notify dsh-session-delete dsh-codex-power-slider dsh-doc-media dsh-doc-actions dsh-smart-search dsh-plugin-roundtable dsh-ppt fflate @deepseek-ai @office-kit dsh-memory-ui dsh-user-profile dsh-plugin-another-me dsh-plugin-neuron-hub dsh-tool-gate dsh-plugin-food-card dsh-settings-extensions dsh-self-card"
  for child in "$PROF_MOD"/* "$PROF_MOD"/.[!.]* "$PROF_MOD"/..?*; do
    [ -e "$child" ] || continue
    pname=$(basename "$child")
    case " $PROF_ALLOW " in *" $pname "*) ;; *)
      echo "✗ dshhome/profiles 落地只允许内置插件，多出条目：$pname" >&2; exit 1 ;;
    esac
  done
fi
DHOME_ALLOW="skills cordis.patch.yml profiles"
if [ -d "$OVL/dshhome" ]; then
  for source in "$OVL/dshhome"/* "$OVL/dshhome"/.[!.]* "$OVL/dshhome"/..?*; do
    [ -e "$source" ] || continue
    name=$(basename "$source")
    case " $DHOME_ALLOW " in *" $name "*) ;; *)
      [ "$(realpath "$source")" = "$(realpath "$OVL/dshhome")/$name" ] || exit 1
      mv "$source" "$BK/dshhome-extra/$name"
      ;;
    esac
  done
fi
if [ "${DSH_KEEP_USER_BG:-0}" = "1" ]; then
  sed -i 's#url("/dsh-bg.svg?v=1")#url("/dsh-bg-user.png?v=1")#' "$DIST/dsh-bg.css"
else
  sed -i 's#url("/dsh-bg-user.png?v=1")#url("/dsh-bg.svg?v=1")#' "$DIST/dsh-bg.css"
fi
# 发行版用一组更"透亮"的遮罩值；自用包（DSH_KEEP_USER_BG=1）保留 bg-patch/ 的设计值，
# 否则机主自己的壁纸会被发行调优冲淡 —— 暗色尤其明显（0.68 vs 0.76 是能一眼看出来的差别）。
if [ "${DSH_KEEP_USER_BG:-0}" != "1" ]; then
  sed -i 's#\(--dsh-user-bg-scrim-top-light:\) *rgba([^)]*)#\1 rgba(247, 249, 253, 0.70)#' "$DIST/dsh-bg.css"
  sed -i 's#\(--dsh-user-bg-scrim-bottom-light:\) *rgba([^)]*)#\1 rgba(247, 249, 253, 0.82)#' "$DIST/dsh-bg.css"
  sed -i 's#\(--dsh-user-bg-scrim-top-dark:\) *rgba([^)]*)#\1 rgba(4, 8, 16, 0.55)#' "$DIST/dsh-bg.css"
  sed -i 's#\(--dsh-user-bg-scrim-bottom-dark:\) *rgba([^)]*)#\1 rgba(4, 8, 16, 0.68)#' "$DIST/dsh-bg.css"
fi
if [ "${DSH_KEEP_USER_BG:-0}" = "1" ]; then
  "$NODE" -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");if(!/--dsh-user-bg-image:\s*url\("\/dsh-bg-user\.png\?v=1"\)/.test(s)||!/--dsh-user-bg-scrim-top-dark:\s*rgba\(4, 8, 16, 0\.60\)/.test(s))process.exit(1)' "$DIST/dsh-bg.css"
  [ -f "$DIST/dsh-bg-user.png" ] || { echo '✗ DSH_KEEP_USER_BG=1 但 dist 里没有 dsh-bg-user.png'; exit 1; }
else
  "$NODE" -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");if(!/--dsh-user-bg-image:\s*url\("\/dsh-bg\.svg\?v=1"\)/.test(s)||!/--dsh-user-bg-scrim-top-dark:\s*rgba\(4, 8, 16, 0\.55\)/.test(s))process.exit(1)' "$DIST/dsh-bg.css"
fi
cd "$SB"
runlog sh "$SB/selfbuild.sh" payload
runlog sh "$SB/selfbuild.sh" patch
# 2026-11-08：patch 阶段只做 overlay 整文件覆盖，**从不重放 selfbuild/patches/*.diff**
# （那是 stage-kernel.sh 那条「装内核」链的活）。结果：补丁进了仓库、出包全绿、
# 装上去却没有那个修复。终端 ENOENT、预设报错两条修复就是这么静默丢掉的。
# 这一步把补丁按锚点重放进 payload 的内核树；没匹配上会 exit 1，不会假装成功。
runlog sh "$SB/scripts/apply-patches-to-payload.sh" "$SB/work/payload-new.zip"
# 2026-11-07：入口页缓存戳定点对齐。index.html 是上游文件，按白屏教训不许整文件进
# overlay，进包的一直是底本里那份，而底本的戳是旧的 → 手机端命中浏览器旧 mobile.css
# 缓存，表现为「样式不对」（刚出过白屏，最容易被误判成还没修好）。这里只换 ?v= 后面
# 那段（1 行 1 处），其它字节一个不动；幂等，未命中/命中多处会自报 exit 1。
runlog "$NODE" "$SB/scripts/fix-frontend-cache-token.js" "$SB/work/payload-new.zip"
STRIP_EXTRA=""
[ "${DSH_KEEP_USER_BG:-0}" = "1" ] && STRIP_EXTRA="--keep-user-bg"
runlog "$NODE" "$SB/scripts/strip-dist-payload.js" "$SB/work/payload-new.zip" $STRIP_EXTRA
# 2026-11-06 发行隐私整改：脱敏必须作用在**最终 payload** 上。
# 底包 base-current-175.apk 里躺的是未脱敏的旧插件文案，patch 阶段会把旧版盖回来；
# 反过来设备运行树也会被冷启动 FORCE_OVERWRITE 重铺 —— 两头都不可信，只信这里。
runlog "$NODE" "$SB/scripts/sanitize-dist-payload.js" "$SB/work/payload-new.zip"
# 改完自己判不算数：独立判据必须绿，否则 set -e 直接中止，不会走到签名和 out/。
runlog "$NODE" "$SB/scripts/assert-dist-privacy.js" "$SB/work/payload-new.zip"
# 2026-11-07：称呼类词表卡口（放在 slim 之前 —— slim 只做重复文件去重，不该在它后面才发现问题）。
# assert-dist-privacy 只认四个唤醒词；`哥`-class（哥的/哥定/告诉哥…）既不被 sanitize 修，
# 也不被任何门禁发现，296 就是这么带着 6 处称呼发出去的。裸「哥」放行只按「路径+词」双条件
# （见 scan-names.py 里的 ALLOW 表），不做文件级放行 —— 文件级放行会把夹带一起放过。
runlog "$PY" "$SB/scripts/scan-names.py" "$SB/work/payload-new.zip"
runlog "$NODE" "$SB/scripts/slim-dist-payload.js" "$SB/work/payload-new.zip"
# 2026-11-07：世代卡口（v1.48/code296 事故防复发）。
# 坏包的两条故障链都能在这里被拦下 —— ①前端：dist/index.html 引用的 bundle 必须真在包里
# （旧 index.html 引用 index-BXV-oxvX.js 那套 → 白屏）；②内核：任何 @deepseek-ai 包只要
# "与干净树不同、又与旧世代树(kernels/*.disabled)字节相同"，就判定整文件旧版被覆盖进来
# （旧 dsh-host-webserver 21586B → 已认证请求 400 → ERR_HTTP_RESPONSE_CODE_FAILURE）。
# 参考树/旧树缺失时脚本会大声警告并降级（只跑不需要参考树的那两道），不会静默变绿。
# 参考树取底包里那份 payload，而不是设备运行树：运行树会被冷启动重铺、也会被人手工
# patch 过（照着一个动过的地方判断"这个文件是不是旧的"，判出来的结论不可信）。
REFZIP="$SB/work/payload-ref.zip"
runlog "$PY" -c 'import sys,zipfile,shutil; s=zipfile.ZipFile(sys.argv[1]).open("assets/payload.zip"); f=open(sys.argv[2],"wb"); shutil.copyfileobj(s,f,1<<20); f.close()' "$BASE" "$REFZIP"
runlog "$NODE" "$SB/scripts/check-payload-version-coherence.js" \
  --payload "$SB/work/payload-new.zip" \
  --ref "${DSH_CLEAN_PAYLOAD:-$REFZIP}" \
  --old "${DSH_OLD_K1:-/data/user/0/com.deepseek.harness/files/kernels/0.2.1-rc.5.disabled}" \
  --old "${DSH_OLD_K2:-/data/user/0/com.deepseek.harness/files/kernels/0.2.1-rc.2.disabled3}" \
  --old "${DSH_OLD_K3:-/data/user/0/com.deepseek.harness/files/.up/cand}" \
  --overlay "$OVL"
runlog "$NODE" "$RECEIPTS" payload-check --payload "$SB/work/payload-new.zip" --checks "$SB/checks.manifest" --dist yes
runlog sh "$SB/selfbuild.sh" pack --dex "$DEX" --asset "$R/v118/android-app/splash/boot.html:assets/boot.html" --asset "$R/v118/android-app/splash/fallback.html:assets/fallback.html"
runlog sh "$SB/selfbuild.sh" mark
runlog "$NODE" "$SB/scripts/set-apk-version.js" "$SB/work/unsigned.apk" "$SB/work/unsigned-v.apk" --name "$V" --code "$C" --share-target com.deepseek.harness.MainActivity
# 2026-11-07：隐私/purge 检查前移到签名之前 —— 带 purge 痕迹、带私人称谓的包
# 不该先被签出来再被拦（签了就有产物、就有 .idsig，人一疏忽就发出去了）。
# 这一道是闸门（不写报告），签名之后那道仍然写哈希绑定报告 + evidence 收据，
# 判据是同一个 scan()，不存在「早的这道松一点」。
runlog "$PY" "$SB/scripts/scan-dist-privacy.py" --apk "$SB/work/unsigned-v.apk" --base-apk "$BASE" --overlay "$OVL" --wallpaper "$R/bg-patch/dsh-bg-user.png"
OUT="$SB/out/DeepSeekHarness-v$V-code$C-$(date +%Y%m%d-%H%M%S)-$$-dist.apk"
[ ! -e "$OUT" ] || exit 1
# 2026-11-08：v3 签名在 Android 9(API 28) 上出现过「APK Signature Scheme v3:
# SHA-256 digest of contents did not verify」的装机失败，而同一份内容只签 v2 时
# 解析正常。v2 自 Android 7 起全支持，本包 minSdk=24，不需要 v3 的任何能力，
# 所以默认留 v2；确需 v3 时置 DSH_DIST_V3=1。
V3FLAG="--v3-signing-enabled false"
[ "${DSH_DIST_V3:-0}" = "1" ] && V3FLAG="--v3-signing-enabled true"
if ! sh "$RUN" java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool sign \
  --ks /keys/dist.keystore --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --ks-key-alias distkey \
  $V3FLAG \
  --out "$OUT" "$SB/work/unsigned-v.apk" > "$SB/work/dist-sign.log" 2>&1; then
  echo '✗ Signature creation failed'; tail -20 "$SB/work/dist-sign.log"; exit 1
fi
SIGNATURE="$OUT.signature.log"
if ! sh "$RUN" java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool verify --verbose --print-certs "$OUT" > "$SIGNATURE" 2>&1; then
  echo '✗ Signature verification failed'; tail -20 "$SIGNATURE"; exit 1
fi
# Scan before restoration: only distributable overlay entries contribute to content scope.
REPORT="$OUT.privacy-report.json"
# 2026-11-06：scan-dist-privacy.py 改为必须一起扫底包（静默跳过正是三个包带毒还显示 PASS 的原因）。
runlog "$PY" "$SB/scripts/scan-dist-privacy.py" --apk "$OUT" --base-apk "$BASE" --overlay "$OVL" --wallpaper "$R/bg-patch/dsh-bg-user.png" --report "$REPORT"
# 2026-11-07：evidence 内部也调 apkIdentity 复核包名/版本，和 artifact 一样必须显式带版本；
# 漏了它就退回默认 1.38/70，拿旧版本号去比刚签的包，必然 mismatch（本轮卡在这里）。
runlog env DSH_DIST_VERSION="$V" DSH_DIST_CODE="$C" "$NODE" "$RECEIPTS" evidence --kind privacy --apk "$OUT" --report "$REPORT" --out "$OUT.privacy.json"
restore_dist
# 门禁咬住刚签名的最终 OUT；版本声明也随调用传入，防止文件名、清单和发布意图分叉。
# runlog 原样返回非零，set -e 会在 artifact 收据之前中止；发布端没有可上传的通过凭据。
runlog env DSH_EXPECT_VERSION="$V" DSH_EXPECT_CODE="$C" sh "$SB/scripts/gate.sh" "$OUT"
ARTIFACT="${DSH_ARTIFACT_RECEIPT:-$SB/out/release-v$V-code$C.json}"
# 2026-11-06：这行原来没给版本，release-receipts.mjs 退回默认 1.38/70，与包里的 1.48/285 必然 mismatch。
runlog env DSH_DIST_VERSION="$V" DSH_DIST_CODE="$C" "$NODE" "$RECEIPTS" artifact --apk "$OUT" --compile "$COMPILE" --payload "$SB/work/payload-new.zip" --checks "$SB/checks.manifest" --signature "$SIGNATURE" --assets "$SB/work/packed-assets.json" --out "$ARTIFACT"
echo "✓ Exact artifact: $OUT"
echo "✓ Artifact receipt: $ARTIFACT"
# 2026-11-07：出包成功就自动记账。297 是手工 repack 的、从没进过 out/，任何脚本都推不出它，
# 所以「发过哪个号」只能靠台账；靠人记得就等于没有。这里晚于 artifact 收据 —— 只有真出完包
# 才有资格说自己发过。台账写不进去就整条链路失败：下界废了比少发一个包更糟。
runlog "$NODE" "$SB/scripts/version-check.js" --emit-shipped --name "$V" --code "$C" --note "dist 出货 $(date +%Y%m%d-%H%M%S) $(basename "$OUT")"
