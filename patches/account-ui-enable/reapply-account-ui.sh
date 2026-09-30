#!/system/bin/sh
# App 每次启动都会用 APK 内 payload 覆盖 dsh-client-ui-settings-account/lib/client.js
# （它在 MainActivity.FORCE_OVERWRITE_PREFIXES 白名单里，见 v118 MainActivity.java:164）。
# 所以「账户 UI + 启动器按钮」这套客户端补丁**重启后必丢**，重启完跑一下本脚本即可。
#   生效方式：刷新页面（客户端 bundle 的 rev 随内容变）。
set -e
R="${DSH_PROJECT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SRC="$R/selfbuild/build-overlay/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js"
DST=/data/user/0/com.deepseek.harness/files/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js
[ -f "$SRC" ] || { echo "✗ 找不到补丁源 $SRC"; exit 1; }
grep -q 'dsh-android-patch v3' "$DST" 2>/dev/null && { echo "✓ 已经打过（v3 在）"; exit 0; }
cp -p "$SRC" "$DST"
echo "✓ 已重打（账户 UI + 主按钮=打开浏览器）；刷新页面生效"
