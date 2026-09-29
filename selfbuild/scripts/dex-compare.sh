#!/system/bin/sh
# dex-compare.sh —— 比较两个 dex（或 APK 内 dex 条目），判定是否同源 / 需要回填
#
# 用法:
#   sh selfbuild/scripts/dex-compare.sh <specA> <specB> [--json] [--max-list N] [--max-other N] [--ref a|b|auto]
#   sh selfbuild/scripts/dex-compare.sh <apk>            # 自测：APK 的 classes.dex vs assets/rish_shizuku.dex
#   sh selfbuild/scripts/dex-compare.sh <file.dex>       # 自测：自己 vs 自己（应报「疑似同源」）
#
# spec 形式: foo.dex | foo.apk（默认 classes.dex）| foo.apk!assets/xxx.dex
# 约定: 默认把文件名像 base-v1.2* / installed 的一方当作「装机参考」；B 独有 = 装机有而重编缺 = 回填点。
# 环境变量: DEX_NODE=node 路径；DEX_STRICT=1 时结论为 DIFFERS 则以 exit 4 结束（方便自动化）。
set -u

SELF="$0"
case "$SELF" in
  /*) : ;;
  *) SELF="$(pwd)/$SELF" ;;
esac
DIR="${SELF%/*}"
LIB="$DIR/../lib/dexinfo.js"

NODE="${DEX_NODE:-/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node}"
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "ERROR: 找不到可执行的 node（可用 DEX_NODE 指定）" >&2
  exit 3
fi
if [ ! -f "$LIB" ]; then
  echo "ERROR: 找不到 $LIB" >&2
  exit 3
fi

usage() {
  cat >&2 <<'EOF'
用法:
  sh dex-compare.sh <specA> <specB> [--json] [--max-list N] [--max-other N] [--ref a|b|auto]
  sh dex-compare.sh <apk>       # 自测: classes.dex vs assets/rish_shizuku.dex
  sh dex-compare.sh <file.dex>  # 自测: 自身 vs 自身
spec: foo.dex | foo.apk | foo.apk!assets/xxx.dex
EOF
}

if [ "$#" -eq 0 ]; then usage; exit 2; fi
case "$1" in -h|--help) usage; exit 0 ;; esac

if [ "$#" -eq 1 ]; then
  case "$1" in
    *.apk|*.apk!*|*.zip|*.xapk|*.apks)
      set -- "$1" "$1!assets/rish_shizuku.dex"
      echo "[dex-compare] 自测模式: classes.dex vs assets/rish_shizuku.dex"
      ;;
    *)
      set -- "$1" "$1"
      echo "[dex-compare] 自测模式: 同一 dex 自身对比（应输出 SAME_SOURCE）"
      ;;
  esac
fi

OUT="$("$NODE" "$LIB" --compare "$@" 2>&1)"
RC=$?
printf '%s\n' "$OUT"
if [ "$RC" -ne 0 ]; then exit "$RC"; fi

if [ "${DEX_STRICT:-0}" = "1" ]; then
  case "$OUT" in
    *"code=DIFFERS"*) exit 4 ;;
  esac
fi
exit 0
