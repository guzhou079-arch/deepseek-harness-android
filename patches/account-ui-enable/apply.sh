#!/system/bin/sh
# 换内核大版本 / dshroot 重新解压后，用这个脚本重打「启用账户 UI」补丁。
#
# 幂等：目标已打过就跳过改写，但**仍然会把结果同步到交付层**（build-overlay + v118 overlay）。
# 为什么要同步：本补丁是「整文件覆盖」交付。若只改运行副本、不刷新 overlay，
# 下次出包就会把**旧内核版本**的那份文件盖到新内核上，上游改动被静默回退
# （2026-09-29 实测踩到：rc.2 的 showBonusRow 等 26 行改动差点被 rc.1 版盖掉）。
#
# 用法：
#   sh apply.sh                                  # 打运行副本
#   DSH_KERNEL_FILE=<文件> sh apply.sh            # 打指定文件（如 staging 里的新内核）
set -e
TGT="${DSH_KERNEL_FILE:-/data/user/0/com.deepseek.harness/files/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js}"
SB=/storage/emulated/0/Download/Operit/dsh_own_app/selfbuild
OVL=/storage/emulated/0/Download/Operit/dsh_own_app/v118/dsh-patches/overlay
REL=dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js
REL2=lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js

[ -f "$TGT" ] || { echo "✗ 找不到目标文件: $TGT" >&2; exit 1; }

if grep -q 'dsh-android-patch v1' "$TGT" 2>/dev/null; then
  echo "  ✓ 目标已打过补丁，跳过改写（仍会同步 overlay）"
else
  cp "$TGT" "$TGT.bak-$(date +%s)"
  node -e '
const fs=require("fs");const f=process.argv[1];let s=fs.readFileSync(f,"utf8");
const guard="if (!(\"dshDesktop\" in globalThis)) return;";
const n=s.split(guard).length-1;
if(n!==1){console.error("✗ 守卫出现 "+n+" 次，预期 1，放弃");process.exit(1)}
s=s.replace(guard,"/* dsh-android-patch v1 (2026-09-29): 放开桌面独占门禁以启用账户 UI。\n\t\t\t   原为: if (!(\"dshDesktop\" in globalThis)) return;\n\t\t\t   回滚: patches/account-ui-enable/revert.sh */");
fs.writeFileSync(f,s);console.log("  ✓ 已重打补丁");
' "$TGT"
  node --check "$TGT" && echo "  ✓ 语法 OK"
fi

mkdir -p "$(dirname "$SB/$REL")" "$(dirname "$OVL/$REL2")"
cp "$TGT" "$SB/build-overlay/$REL"
cp "$TGT" "$OVL/$REL2"
echo "  ✓ 已同步到 build-overlay + v118 overlay"
echo "刷新页面（或重启 App）即可生效。"
