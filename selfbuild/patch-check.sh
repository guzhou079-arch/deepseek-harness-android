#!/system/bin/sh
# ============================================================================
# 补丁完整性校验（patch-check）
#
#   sh patch-check.sh              # 校验「装机副本」（默认）
#   sh patch-check.sh --apk <apk>  # 校验某个 APK 内的 payload.zip（装机前预检）
#   sh patch-check.sh --regen      # 故意升级补丁/换内核后，重建 md5 基线
#
# 为什么需要它：v1.18~v1.20 换官方基线重建时，dsh-tool-android 的
# App 内嵌桥补丁被悄悄丢掉（装机副本退回 rish 通道），事后才发现。
# 这个脚本让这类「补丁漂移」在 30 秒内暴露。
#
# 为什么先查条目数：下面那条逐条校验，分母就是清单自己 —— 问的是
# 「清单里这几条对不对」，没人问「清单本身还剩几条」。从 checks.manifest
# 删掉一条，逐条校验照样 66→65 全绿，少掉的那条补丁语义从此没有任何闸在管。
# 所以先把清单跟一份独立账本对一遍，条目少了就当场红，别让它走到逐条校验。
# ============================================================================
R="${DSH_PROJECT:-$(cd "$(dirname "$0")/.." && pwd)}"
SB="$R/selfbuild"
NODE=/data/user/0/com.deepseek.harness/files/.bin/node
TARGET=${DSH_PAYLOAD:-/data/user/0/com.deepseek.harness/files/payload}
MANIFEST=$SB/checks.manifest

case "$1" in
  --regen)
    "$NODE" "$SB/lib/gen-manifest.js" "$TARGET" "$MANIFEST"
    ;;
  --entries)
    # 只查条目账本，不碰载荷 —— 改了清单想先确认自己没删错东西时用。
    "$NODE" "$SB/scripts/assert-manifest-entries-intact.js"
    ;;
  --apk)
    APK="$2"
    [ -f "$APK" ] || { echo "✗ 找不到 APK: $APK"; exit 2; }
    "$NODE" "$SB/scripts/assert-manifest-entries-intact.js" || exit $?
    TMP=$SB/work/payload-check-$$.zip
    "$NODE" "$SB/lib/selfbuild.js" payload-extract "$APK" "$TMP" >/dev/null || exit 2
    # 发行包（*-dist.apk）里 policy=local 的文件（如个人壁纸 dsh-bg-user.png）是被
    # strip-dist-payload.js 主动剔除的 → 检查发行包时必须加 --dist，否则会报假失败。
    DIST=""
    case "$APK" in *-dist.apk) DIST="--dist" ;; esac
    "$NODE" "$SB/lib/selfbuild.js" check "$TMP" "$MANIFEST" $DIST --overlay "$SB/build-overlay"
    RC=$?
    rm -f "$TMP"
    exit $RC
    ;;
  *)
    "$NODE" "$SB/scripts/assert-manifest-entries-intact.js" || exit $?
    "$NODE" "$SB/lib/selfbuild.js" check "$TARGET" "$MANIFEST" --overlay "$SB/build-overlay"
    ;;
esac
