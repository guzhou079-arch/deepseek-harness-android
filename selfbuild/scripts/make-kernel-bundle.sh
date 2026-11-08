#!/system/bin/sh
# ============================================================================
# make-kernel-bundle.sh —— 把「一棵 dshroot 树」打成可分发的内核包
#
#   sh make-kernel-bundle.sh --tree <dshroot 目录> [--out <输出目录>]
#                            [--label v1] [--patch-set rc5-main]
#
# 产物（默认落在 selfbuild/out/kernels/）：
#   kernel-<version>-<label>.tar.gz
#   kernel-<version>-<label>.tar.gz.sha256
#   manifest.json
#
# 包内布局：归档根就是树根（`tar -C <tree> .`），解压目标固定为
#   files/kernels/<version>/dshroot/
#
# 为什么不在包内套一层 dshroot/：树名不一定叫 dshroot（stage-kernel 产物叫
#   候选目录/dshroot，但演练树可能叫别的），套一层就得在归档里改名，
#   toybox tar 没有 --transform。约定「解压到 dshroot/ 目录」更简单可靠。
#
# ⚠️ 只读源树，不写回；输出目录由调用方给。
# ⚠️ /sdcard 是 FUSE：tar 从 FUSE 读 2 万+ 文件很慢（实测 265MB≈8 分钟），
#    打包请放后台跑，别在前台等。
# ============================================================================
set -e

R="${DSH_PROJECT:-/sdcard/DeepSeekHarness/projects/dsh-android}"
SB="$R/selfbuild"
NODE=/data/user/0/com.deepseek.harness/files/.bin/node
ENTRY=lib/node_modules/@deepseek-ai/dsh/lib/bin.js
KPJ=lib/node_modules/@deepseek-ai/dsh/package.json

TREE=""
OUT="$SB/out/kernels"
LABEL=v1
PATCH_SET=unknown

while [ $# -gt 0 ]; do
  case "$1" in
    --tree)      TREE="${2:-}"; shift 2 ;;
    --tree=*)    TREE="${1#--tree=}"; shift ;;
    --out)       OUT="${2:-}"; shift 2 ;;
    --out=*)     OUT="${1#--out=}"; shift ;;
    --label)     LABEL="${2:-}"; shift 2 ;;
    --label=*)   LABEL="${1#--label=}"; shift ;;
    --patch-set) PATCH_SET="${2:-}"; shift 2 ;;
    --patch-set=*) PATCH_SET="${1#--patch-set=}"; shift ;;
    -h|--help)   sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TREE" ] || { echo "用法: sh make-kernel-bundle.sh --tree <dshroot 目录>" >&2; exit 2; }
[ -d "$TREE" ] || { echo "✗ 树不存在: $TREE" >&2; exit 1; }
[ -f "$TREE/$ENTRY" ] || { echo "✗ 不是 dshroot 树：缺 $ENTRY" >&2; exit 1; }

# 版本以树里的 package.json 为准（不信任目录名）
VERSION=$("$NODE" -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$TREE/$KPJ")
[ -n "$VERSION" ] || { echo "✗ 读不到内核版本（$KPJ）" >&2; exit 1; }

REVISION=$(cat "$TREE/REVISION" 2>/dev/null | tr -d ' \r\n')
[ -n "$REVISION" ] || REVISION=$(date -u +%Y%m%d%H%M%S)

NAME="kernel-${VERSION}-${LABEL}.tar.gz"
mkdir -p "$OUT"
OUT_TGZ="$OUT/$NAME"

echo "== 内核包打包 =="
echo "   树    : $TREE"
echo "   版本  : $VERSION（revision=$REVISION）"
echo "   输出  : $OUT_TGZ"

# 校验源树自洽：入口 + 内核 package.json 必须存在，否则打出来的包切过去也起不来
[ -f "$TREE/$KPJ" ] || { echo "✗ 缺 $KPJ" >&2; exit 1; }

# 脱敏闸：内核包是整棵树原样打走，源树里若带个人壁纸，会随包分发给所有更新者。
# 发行 APK 那条路有 CSS 替换兜着，内核包这条路没有，必须在这里拦。
USER_BG=$(find "$TREE" -type f -name 'dsh-bg-user*' 2>/dev/null | head -5)
if [ -n "$USER_BG" ]; then
  echo "✗ 源树含个人壁纸，拒绝打包内核：" >&2
  echo "$USER_BG" | sed 's/^/    /' >&2
  echo "  处置：改用干净树（overlay / stage-kernel 产物），或先从树里移除该文件" >&2
  exit 1
fi

echo "== 1) 统计 =="
FILE_COUNT=$(find "$TREE" -type f 2>/dev/null | wc -l | tr -d ' ')
TREE_BYTES=$(du -sk "$TREE" 2>/dev/null | awk '{print $1}')
TREE_BYTES=$((TREE_BYTES * 1024))
echo "   文件 $FILE_COUNT 个，树 $((TREE_BYTES / 1048576))MB"

echo "== 2) 打包（慢，FUSE 读）=="
T0=$(date +%s)
rm -f "$OUT_TGZ"
tar -C "$TREE" -czf "$OUT_TGZ" . || { echo "✗ tar 失败" >&2; rm -f "$OUT_TGZ"; exit 1; }
T1=$(date +%s)
echo "   完成，用时 $((T1 - T0))s，包 $(( $(wc -c < "$OUT_TGZ") / 1048576 ))MB"

echo "== 3) 校验（gzip -t 必须过）=="
gzip -t "$OUT_TGZ" || { echo "✗ gzip CRC 校验失败" >&2; exit 1; }
# 入口文件必须在包里（-t 只验 gzip，不验内容）
tar -tzf "$OUT_TGZ" "./$ENTRY" >/dev/null 2>&1 || tar -tzf "$OUT_TGZ" "$ENTRY" >/dev/null 2>&1 \
  || { echo "✗ 包里没有 $ENTRY" >&2; exit 1; }

echo "== 4) sha256 + manifest =="
SHA=$(sha256sum "$OUT_TGZ" | awk '{print $1}')
echo "$SHA  $NAME" > "$OUT_TGZ.sha256"

# 前端哈希：rc.5 坑（index-*.js/css 名字随版本变），manifest 记下来供门禁比对
IDX_JS=$(ls "$TREE/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets" 2>/dev/null | grep -m1 '^index-.*\.js$' || true)
IDX_CSS=$(ls "$TREE/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets" 2>/dev/null | grep -m1 '^index-.*\.css$' || true)

"$NODE" -e '
const fs = require("fs");
const [out, tgz, name, sha, version, revision, label, patchSet, treeBytes, fileCount, idxJs, idxCss, entry, tree] = process.argv.slice(1);
const selfPkgs = ["dsh-tool-shizuku","dsh-tool-vscreen","dsh-tool-nfc","dsh-tool-android","dsh-tool-accessibility","dsh-update-check"];
const manifest = {
  format: 1,
  kind: "dshroot-kernel",
  version,
  label,
  revision,
  patchSet,
  entry,
  archiveRoot: ".",
  extractTo: "dshroot",
  file: name,
  sha256: sha,
  sizeBytes: fs.statSync(tgz).size,
  treeBytes: Number(treeBytes),
  fileCount: Number(fileCount),
  frontendHash: { indexJs: idxJs || null, indexCss: idxCss || null },
  selfPackages: selfPkgs,
  builtFrom: tree,
  buildAt: new Date().toISOString()
};
fs.writeFileSync(out + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log("   manifest.json 已写，包 sha256=" + sha.slice(0, 16) + "…");
' "$OUT" "$OUT_TGZ" "$NAME" "$SHA" "$VERSION" "$REVISION" "$LABEL" "$PATCH_SET" "$TREE_BYTES" "$FILE_COUNT" "$IDX_JS" "$IDX_CSS" "$ENTRY" "$TREE"

echo "== 完成 =="
ls -l "$OUT_TGZ" "$OUT/manifest.json"
