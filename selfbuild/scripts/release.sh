#!/system/bin/sh
# Release one explicitly selected version. No push/install; local gates stop at review.
# Required: DSH_DIST_VERSION / DSH_DIST_CODE; baseline/publish also need --tag vPrevious.
set -eu
R="${DSH_PROJECT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SB="$R/selfbuild"
F=/data/user/0/com.deepseek.harness/files
NODE="$F/payload/runtime/bin/node"
export LD_LIBRARY_PATH="$F/payload/runtime/lib:${LD_LIBRARY_PATH:-}"
export DSH_PROJECT="$R"
BASE="$SB/work/base-current-175.apk"
DEX="$SB/work/appbuild/out/classes.dex"
COMPILE="$SB/work/appbuild/out/compile-receipt.json"
ARTIFACT=""
BASELINE=""
CLONE="${DSH_VERIFY_DIR:-$F/_verify}/ws-GitHub"
V="${DSH_DIST_VERSION:-}"; C="${DSH_DIST_CODE:-}"
CMD="${1:-}"; [ $# -eq 0 ] || shift
GO=0; WRITE=0; TITLE=""; TAG="${DSH_PREVIOUS_TAG:-}"; PREVIOUS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=1; shift ;;
    --write) WRITE=1; shift ;;
    --title) [ $# -ge 2 ] || exit 64; TITLE="$2"; shift 2 ;;
    --tag) [ $# -ge 2 ] || exit 64; TAG="$2"; shift 2 ;;
    --baseline-apk) [ $# -ge 2 ] || exit 64; PREVIOUS="$2"; shift 2 ;;
    --artifact) [ $# -ge 2 ] || exit 64; ARTIFACT="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 64 ;;
  esac
done
[ -n "$TITLE" ] || TITLE="v$V"
[ -n "$ARTIFACT" ] || ARTIFACT="$SB/out/release-v$V-code$C.json"
BASELINE="$SB/out/baseline-${TAG:-unselected}.json"
die() { echo "✗ $1" >&2; exit 1; }
target() {
  case "$V" in ''|*[!0-9.]*|.*|*.|*..*) die 'DSH_DIST_VERSION must contain digits/dots and no empty segment' ;; esac
  case "$C" in ''|*[!0-9]*|0*) die 'DSH_DIST_CODE must be a canonical integer in 1..2147483647' ;; esac
  [ "$C" -le 2147483647 ] || die 'DSH_DIST_CODE out of range'
  export DSH_DIST_VERSION="$V" DSH_DIST_CODE="$C"
}
previous() {
  case "$TAG" in v[0-9]*.[0-9]*) ;; *) die 'Set --tag (or DSH_PREVIOUS_TAG) to the previous published vX.Y[.Z]' ;; esac
  [ "$TAG" != "v$V" ] || die 'Baseline tag must differ from the candidate version'
}
preflight() {
  target
  [ -f "$BASE" ] || die 'Missing base-current-175.apk'
  [ -z "${DSH_BASE:-}" ] || [ "$(realpath "$DSH_BASE")" = "$(realpath "$BASE")" ] || die 'Only base-current-175.apk is allowed'
  "$NODE" "$SB/scripts/release-receipts.mjs" compile-check --receipt "$COMPILE" --dex "$DEX"
  echo '✓ Compilation input hashes and DEX match; source/clone equality and DEX strings are not compilation evidence.'
}
baseline() {
  previous
  if [ -n "$PREVIOUS" ]; then
    "$NODE" "$SB/scripts/release-checks.mjs" baseline --tag "$TAG" --clone "$CLONE" --apk "$PREVIOUS" --receipt "$BASELINE"
  else
    "$NODE" "$SB/scripts/release-checks.mjs" baseline --tag "$TAG" --clone "$CLONE" --receipt "$BASELINE"
  fi
}
build() {
  preflight
  DSH_BASE="$BASE" DSH_ARTIFACT_RECEIPT="$ARTIFACT" sh "$SB/scripts/make-dist-apk.sh"
  "$NODE" "$SB/scripts/release-receipts.mjs" artifact-check --receipt "$ARTIFACT"
  "$NODE" "$SB/scripts/release-receipts.mjs" artifact-path --receipt "$ARTIFACT"
}
sync_sources() {
  if [ "$WRITE" -eq 1 ]; then
    "$NODE" "$SB/scripts/release-sync.mjs" --clone "$CLONE" --write
    echo 'Stage the selected files, run check-repo-hygiene.sh --staged, commit, then push source yourself before tag.'
  else "$NODE" "$SB/scripts/release-sync.mjs" --clone "$CLONE" --diff
  fi
}
gate() {
  APK=$("$NODE" "$SB/scripts/release-receipts.mjs" artifact-path --receipt "$ARTIFACT")
  "$NODE" "$SB/scripts/release-receipts.mjs" gate --receipt "$ARTIFACT" --baseline "$BASELINE" --baselineTag "$TAG" --privacy "$APK.privacy.json" --isolated "$APK.isolated.json"
}
case "$CMD" in
  preflight) preflight ;;
  baseline) baseline ;;
  build) build ;;
  sync) sync_sources ;;
  isolate)
    target
    APK=$("$NODE" "$SB/scripts/release-receipts.mjs" artifact-path --receipt "$ARTIFACT")
    "$NODE" "$SB/scripts/release-receipts.mjs" artifact-check --receipt "$ARTIFACT"
    sh "$SB/scripts/verify-dist-isolated.sh" "$APK"
    "$NODE" "$SB/scripts/release-receipts.mjs" evidence --kind isolated --apk "$APK" --report "$APK.isolated-report.json" --out "$APK.isolated.json"
    ;;
  verify) target; gate ;;
  publish)
    target; baseline; gate
    if [ "$GO" -eq 1 ]; then
      "$NODE" "$SB/scripts/release-publish.mjs" --artifact "$ARTIFACT" --baseline "$BASELINE" --baseline-tag "$TAG" --clone "$CLONE" --title "$TITLE" --go
    else "$NODE" "$SB/scripts/release-publish.mjs" --artifact "$ARTIFACT" --baseline "$BASELINE" --baseline-tag "$TAG" --clone "$CLONE" --title "$TITLE"
    fi
    ;;
  stats) "$NODE" "$SB/scripts/gh-stats.mjs" ;;
  all)
    [ "$WRITE" -eq 0 ] || die 'Use sync --write separately after reviewing direction'
    preflight
    baseline
    build
    sync_sources
    APK=$("$NODE" "$SB/scripts/release-receipts.mjs" artifact-path --receipt "$ARTIFACT")
    sh "$SB/scripts/verify-dist-isolated.sh" "$APK"
    "$NODE" "$SB/scripts/release-receipts.mjs" evidence --kind isolated --apk "$APK" --report "$APK.isolated-report.json" --out "$APK.isolated.json"
    gate
    echo 'All local gates passed. No source push, publication or installation was performed.'
    ;;
  *) echo 'Usage: DSH_DIST_VERSION=X.Y DSH_DIST_CODE=N sh release.sh preflight|build|sync|isolate|stats; baseline/verify/publish/all also need --tag vPrevious'; exit 64 ;;
esac
