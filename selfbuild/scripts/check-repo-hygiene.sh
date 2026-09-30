#!/system/bin/sh
# ============================================================================
# 仓库门禁 —— 公开仓库入库前的最后一道关
#
# 【由来】2026-09-30 发现公开仓库里躺着 whale-shota 的插画
#         （来源不明、含他人商标，其 NOTICE 自己写着「不得随本包分发」），
#         外加 5 个 MainActivity 备份文件（.bak-* / .pre-lan）。
#         根因不是谁疏忽，是**整目录搬运、没有门禁**。
#         这个脚本就是那道门禁。
#
# 【用法】
#   sh selfbuild/scripts/check-repo-hygiene.sh            # 检查已跟踪的全部文件
#   sh selfbuild/scripts/check-repo-hygiene.sh --staged   # 只检查暂存区（pre-commit 用）
#
# 【退出码】0 = 通过；1 = 发现问题（pre-commit 时会拒绝这次提交）
#
# 【安装成 pre-commit 钩子】
#   sh selfbuild/scripts/check-repo-hygiene.sh --install-hook
#
# 【白名单】仓库根目录的 .repo-hygiene-allow
#          —— 允许入库的二进制/图片必须逐行列出（默认只有自绘 SVG）
# ============================================================================

set -u

MODE="${1:-}"

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "✗ 不在 git 仓库里"; exit 1; }
cd "$ROOT" || exit 1

# ---------------------------------------------------------------- 安装钩子
if [ "$MODE" = "--install-hook" ]; then
  H="$ROOT/.git/hooks/pre-commit"
  cat > "$H" <<'HOOK'
#!/bin/sh
# 由 check-repo-hygiene.sh --install-hook 生成
exec sh "$(git rev-parse --show-toplevel)/selfbuild/scripts/check-repo-hygiene.sh" --staged
HOOK
  chmod +x "$H"
  echo "✓ 已安装 pre-commit 钩子：$H"
  exit 0
fi

# ---------------------------------------------------------------- 取文件列表
if [ "$MODE" = "--staged" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null)
  WHAT="暂存区"
else
  FILES=$(git ls-files)
  WHAT="已跟踪文件"
fi
[ -z "$FILES" ] && { echo "✓ 没有要检查的文件"; exit 0; }

PROBLEMS=""
add() { PROBLEMS="${PROBLEMS}  ✗ $1
"; }

hits() { printf '%s\n' "$FILES" | grep -E "$1" 2>/dev/null; }

# ---------------------------------------------------------------- 1. 可分发边界
# 这些路径下的东西**按素材自己的 NOTICE 就不得分发**，任何一次都不许进仓库。
FORBIDDEN='^plugins/whale-shota/assets/|^plugins/whale-shota/preview/|^plugins/whale-shota/archive-2\.5d/layers/'
H=$(hits "$FORBIDDEN")
[ -n "$H" ] && add "不可分发的素材（见 plugins/whale-shota/NOTICE）：
$(printf '%s\n' "$H" | sed 's/^/      /')"

# ---------------------------------------------------------------- 1b. 个人数据
# 记忆库、会话导出、凭据等**个人内容** —— 永远不进公开仓库。
# （记忆系统真相源在 /sdcard/DeepSeekHarness/memory/，本来就在项目外；
#   这条防的是"整目录搬运"把外部数据一起拖进来 —— 2026-09-30 的教训。）
PERSONAL='(^|/)DeepSeekHarness/|(^|/)memory/(entries|lessons|handoff|archive|log)/|tombstone[.]jsonl$'
H=$(hits "$PERSONAL")
[ -n "$H" ] && add "个人数据（记忆库/会话/凭据），不进公开仓库：
$(printf '%s\n' "$H" | sed 's/^/      /')"

# ---------------------------------------------------------------- 2. 密钥/证书
H=$(hits '\.(keystore|jks|p12|pfx|pem|key)$|(^|/)id_(rsa|ed25519|ecdsa)|(^|/)\.credentials')
[ -n "$H" ] && add "密钥/证书绝不能入库：
$(printf '%s\n' "$H" | sed 's/^/      /')"

# ---------------------------------------------------------------- 3. 备份垃圾
H=$(hits '\.(bak|orig|rej|swp|tmp)$|\.bak-|\.pre-|~$')
[ -n "$H" ] && add "备份/临时文件（历史都在 git 里，别塞进仓库）：
$(printf '%s\n' "$H" | sed 's/^/      /')"

# ---------------------------------------------------------------- 4. 二进制/图片白名单
ALLOW="$ROOT/.repo-hygiene-allow"
ALLOWPAT=""
if [ -f "$ALLOW" ]; then
  ALLOWPAT=$(grep -vE '^\s*(#|$)' "$ALLOW" 2>/dev/null | tr '\n' '|' | sed 's/|$//')
fi
BIN=$(hits '\.(png|jpe?g|webp|gif|bmp|ico|tiff?|mp3|mp4|ogg|wav|flac|zip|apk|aar|jar|so|dylib|ttf|otf|woff2?)$')
if [ -n "$BIN" ]; then
  if [ -n "$ALLOWPAT" ]; then
    BAD=$(printf '%s\n' "$BIN" | grep -vE "^($ALLOWPAT)$" 2>/dev/null)
  else
    BAD="$BIN"
  fi
  [ -n "$BAD" ] && add "二进制/图片未在白名单（要入库请写进 .repo-hygiene-allow）：
$(printf '%s\n' "$BAD" | sed 's/^/      /')"
fi

# ---------------------------------------------------------------- 5. 大文件
BIG=""
for f in $FILES; do
  [ -f "$f" ] || continue
  SZ=$(wc -c < "$f" 2>/dev/null || echo 0)
  [ "$SZ" -gt 524288 ] && BIG="$BIG      $f ($((SZ / 1024))KB)
"
done
[ -n "$BIG" ] && add "单文件超 512KB（确有必要就调高本脚本阈值）：
$BIG"

# ---------------------------------------------------------------- 6. 秘密扫一遍
H=$(hits '\.(js|json|yml|yaml|sh|java|md|txt|properties|xml)$')
if [ -n "$H" ]; then
  LEAK=$(printf '%s\n' "$H" | while read -r f; do
    [ -f "$f" ] || continue
    grep -lE 'ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY|access_token=[A-Za-z0-9]{20,}' "$f" 2>/dev/null
  done)
  [ -n "$LEAK" ] && add "疑似凭据/令牌：
$(printf '%s\n' "$LEAK" | sed 's/^/      /')"
fi

# ---------------------------------------------------------------- 结论
if [ -n "$PROBLEMS" ]; then
  echo "✗ 仓库门禁未通过（检查范围：$WHAT）"
  printf '%s' "$PROBLEMS"
  echo ""
  echo "  确认某项确实该入库 → 加进 .repo-hygiene-allow 或调整本脚本。"
  exit 1
fi
echo "✓ 仓库门禁通过（检查范围：$WHAT）"
exit 0
