#!/system/bin/sh
# Build one explicitly selected dist artifact. Compilation is a prior step.
# Required: DSH_DIST_VERSION=<name> DSH_DIST_CODE=<1..2147483647>
# Preview without building: append --print-plan. Historical versioned scripts remain unchanged.
set -eu
F=/data/user/0/com.deepseek.harness/files
R="${DSH_PROJECT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SB="$R/selfbuild"; OVL="$SB/build-overlay"
DIST="$OVL/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist"
NODE="$F/payload/runtime/bin/node"
RUN="$F/work/linux/run.sh"
export LD_LIBRARY_PATH="$F/payload/runtime/lib:${LD_LIBRARY_PATH:-}"
export DSH_PROJECT="$R"
V="${DSH_DIST_VERSION:-}"; C="${DSH_DIST_CODE:-}"
case "$V" in ''|*[!0-9.]*|.*|*.|*..*) echo '✗ DSH_DIST_VERSION must contain digits/dots and no empty segment'; exit 2 ;; esac
case "$C" in ''|*[!0-9]*|0*) echo '✗ DSH_DIST_CODE must be a canonical integer in 1..2147483647'; exit 2 ;; esac
[ "$C" -ge 1 ] && [ "$C" -le 2147483647 ] || { echo '✗ DSH_DIST_CODE out of range'; exit 2; }
if [ "${1:-}" = "--print-plan" ]; then
  printf 'version=%s\ncode=%s\noutput=DeepSeekHarness-v%s-code%s-<timestamp>-<pid>-dist.apk\n' "$V" "$C" "$V" "$C"
  exit 0
fi
BASE="$SB/work/base-current-175.apk"
[ -f "$BASE" ] || { echo '✗ Missing base-current-175.apk'; exit 1; }
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
if [ -f "$DIST/dsh-bg-user.png" ]; then
  [ "$(realpath "$DIST/dsh-bg-user.png")" = "$(realpath "$DIST")/dsh-bg-user.png" ] || exit 1
  mv "$DIST/dsh-bg-user.png" "$BK/dsh-bg-user.png"
fi
# 随包内置插件在 profiles 的落地（v1.38 起必须随包：冷启动 FORCE_OVERWRITE 要有源，
# 否则"插件改了不生效"的老毛病在发行包里依旧存在）。只允许内置插件目录，
# 防止把开发机上的用户插件 .pnpm / 个人状态打进发行包 —— 多一个条目就失败退出。
PROF_MOD="$OVL/dshhome/profiles/web/node_modules"
if [ -d "$PROF_MOD" ]; then
  PROF_ALLOW="dsh-android-console dsh-plugin-auto-summary-policy dsh-plugin-session-rewind dsh-plugin-turn-notify dsh-session-delete dsh-codex-power-slider dsh-doc-media dsh-doc-actions dsh-smart-search dsh-plugin-roundtable dsh-ppt fflate @deepseek-ai @office-kit"
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
sed -i 's#url("/dsh-bg-user.png?v=1")#url("/dsh-bg.svg?v=1")#' "$DIST/dsh-bg.css"
sed -i 's#\(--dsh-user-bg-scrim-top-light:\) *rgba([^)]*)#\1 rgba(247, 249, 253, 0.70)#' "$DIST/dsh-bg.css"
sed -i 's#\(--dsh-user-bg-scrim-bottom-light:\) *rgba([^)]*)#\1 rgba(247, 249, 253, 0.82)#' "$DIST/dsh-bg.css"
sed -i 's#\(--dsh-user-bg-scrim-top-dark:\) *rgba([^)]*)#\1 rgba(4, 8, 16, 0.18)#' "$DIST/dsh-bg.css"
sed -i 's#\(--dsh-user-bg-scrim-bottom-dark:\) *rgba([^)]*)#\1 rgba(4, 8, 16, 0.36)#' "$DIST/dsh-bg.css"
"$NODE" -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");if(!/--dsh-user-bg-image:\s*url\("\/dsh-bg\.svg\?v=1"\)/.test(s)||!/--dsh-user-bg-scrim-top-dark:\s*rgba\(4, 8, 16, 0\.18\)/.test(s))process.exit(1)' "$DIST/dsh-bg.css"
cd "$SB"
runlog sh "$SB/selfbuild.sh" payload
runlog sh "$SB/selfbuild.sh" patch
runlog "$NODE" "$SB/scripts/strip-dist-payload.js" "$SB/work/payload-new.zip"
runlog "$NODE" "$SB/scripts/slim-dist-payload.js" "$SB/work/payload-new.zip"
runlog "$NODE" "$RECEIPTS" payload-check --payload "$SB/work/payload-new.zip" --checks "$SB/checks.manifest" --dist yes
runlog sh "$SB/selfbuild.sh" pack --dex "$DEX" --asset "$R/v118/android-app/splash/boot.html:assets/boot.html"
runlog sh "$SB/selfbuild.sh" mark
runlog "$NODE" "$SB/scripts/set-apk-version.js" "$SB/work/unsigned.apk" "$SB/work/unsigned-v.apk" --name "$V" --code "$C" --share-target com.deepseek.harness.MainActivity
OUT="$SB/out/DeepSeekHarness-v$V-code$C-$(date +%Y%m%d-%H%M%S)-$$-dist.apk"
[ ! -e "$OUT" ] || exit 1
if ! sh "$RUN" java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool sign \
  --ks /keys/dist.keystore --ks-pass "pass:$PASS" --key-pass "pass:$PASS" --ks-key-alias distkey \
  --out "$OUT" "$SB/work/unsigned-v.apk" > "$SB/work/dist-sign.log" 2>&1; then
  echo '✗ Signature creation failed'; tail -20 "$SB/work/dist-sign.log"; exit 1
fi
SIGNATURE="$OUT.signature.log"
if ! sh "$RUN" java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool verify --verbose --print-certs "$OUT" > "$SIGNATURE" 2>&1; then
  echo '✗ Signature verification failed'; tail -20 "$SIGNATURE"; exit 1
fi
# Scan before restoration: only distributable overlay entries contribute to content scope.
REPORT="$OUT.privacy-report.json"
runlog "$PY" "$SB/scripts/scan-dist-privacy.py" --apk "$OUT" --overlay "$OVL" --wallpaper "$R/bg-patch/dsh-bg-user.png" --report "$REPORT"
runlog "$NODE" "$RECEIPTS" evidence --kind privacy --apk "$OUT" --report "$REPORT" --out "$OUT.privacy.json"
restore_dist
# 门禁咬住刚签名的最终 OUT；版本声明也随调用传入，防止文件名、清单和发布意图分叉。
# runlog 原样返回非零，set -e 会在 artifact 收据之前中止；发布端没有可上传的通过凭据。
runlog env DSH_EXPECT_VERSION="$V" DSH_EXPECT_CODE="$C" sh "$SB/scripts/gate.sh" "$OUT"
ARTIFACT="${DSH_ARTIFACT_RECEIPT:-$SB/out/release-v$V-code$C.json}"
runlog "$NODE" "$RECEIPTS" artifact --apk "$OUT" --compile "$COMPILE" --payload "$SB/work/payload-new.zip" --checks "$SB/checks.manifest" --signature "$SIGNATURE" --assets "$SB/work/packed-assets.json" --out "$ARTIFACT"
echo "✓ Exact artifact: $OUT"
echo "✓ Artifact receipt: $ARTIFACT"
