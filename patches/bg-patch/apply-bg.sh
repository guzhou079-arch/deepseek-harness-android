#!/system/bin/sh
# ============================================================
# deepdive 背景图补丁 —— 给 Web GUI 换背景图
# ------------------------------------------------------------
# 做两件事：
#   ① 把 dsh-bg.css / dsh-bg.svg 拷进前端 dist；
#   ② 在 @deepseek-ai/dsh-client-ui-open-in-app/lib/client.js 的
#      factory 顶部插入一段「ensure <link id=dsh-user-bg href=/dsh-bg.css>」。
#
# 为什么挂 open-in-app：
#   · 它不在 APK 的 FORCE_OVERWRITE_PREFIXES 白名单里 → App 重启不会被 payload 覆盖；
#   · 它不是 bootstrap 模块（没有 immediately:true）→ client-hmr 能真正热替换，
#     改完文件约 1 秒浏览器就重新执行 factory，背景立刻生效（无需刷新页面）；
#   · 本机（Web profile，没有可解析的桌面 Open In 应用）它不渲染任何 UI，热替换不动界面。
#
# 注：dsh-web-frontend/dist 下的 dsh-bg.css / dsh-bg.svg 同样不在白名单里，
#     App 重启后依然在（只有换内核大版本、dshroot 整体重解压时才会没：
#     那时重新跑一遍本脚本即可，不需要改 APK）。
#
# 用法：
#   sh apply-bg.sh                 # 自动探测 dshroot 位置并打补丁
#   sh apply-bg.sh /path/to/dshroot
#   sh apply-bg.sh --check         # 只检查当前状态，不写
#   sh apply-bg.sh --revert        # 卸载注入（删 link 代码与两个文件）
# ============================================================
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
SNIP="$HERE/.inject-snippet.js"

# ---- 找 dshroot ----
# 判定标准：该树里真的存在前端 dist（否则是残缺/过期的外部副本，打了也没用）。
ok_root() {
  [ -n "$1" ] && [ -d "$1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist" ]
}
find_dshroot() {
  for c in \
      "$1" \
      /data/user/0/com.deepseek.harness/files/payload/dshroot \
      /data/data/com.deepseek.harness/files/payload/dshroot \
      /storage/emulated/0/DeepSeekHarness/dshroot \
      /sdcard/DeepSeekHarness/dshroot \
      /data/data/com.deepseek.harness/files/home/dshroot \
      /data/user/0/com.deepseek.harness/files/home/dshroot ; do
    if ok_root "$c"; then echo "$c"; return 0; fi
  done
  return 1
}

MODE=apply
case "$1" in
  --check)  MODE=check ;;
  --revert) MODE=revert ;;
esac

ROOT="$(find_dshroot "$( [ "$MODE" = apply ] && echo "$1" || echo "" )")" || {
  echo "找不到 dshroot：请把路径作为参数传入（里面应有 lib/node_modules/@deepseek-ai/dsh）" >&2
  exit 1
}
DIST="$ROOT/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist"
TARGET="$ROOT/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js"
echo "dshroot : $ROOT"
echo "dist    : $DIST"
echo "target  : $TARGET"

[ -d "$DIST" ] || { echo "dist 不存在：$DIST" >&2; exit 1; }
[ -f "$TARGET" ] || { echo "目标插件不存在：$TARGET" >&2; exit 1; }

HAS_SNIP=0
grep -q "deepdive 背景图注入" "$TARGET" 2>/dev/null && HAS_SNIP=1

if [ "$MODE" = check ]; then
  echo "css  : $([ -f "$DIST/dsh-bg.css" ] && echo 在 || echo 缺)"
  echo "svg  : $([ -f "$DIST/dsh-bg.svg" ] && echo 在 || echo 缺)"
  echo "png  : $([ -f "$DIST/dsh-bg-user.png" ] && echo 在 || echo 缺)  （用户那张鲸鱼插画；css 里用哪张看图床变量）"
  echo "注入 : $([ "$HAS_SNIP" = 1 ] && echo 在 || echo 缺)"
  exit 0
fi

if [ "$MODE" = revert ]; then
  if [ "$HAS_SNIP" = 1 ]; then
    cp "$TARGET" "$TARGET.dshbg.bak" 2>/dev/null || true
    awk '
      /#region deepdive 背景图注入/ { skip=1 }
      skip && /#endregion/ { skip=0; next }
      !skip { print }
    ' "$TARGET" > "$TARGET.tmp" && mv "$TARGET.tmp" "$TARGET"
    echo "已移除注入代码（原文件备份为 client.js.dshbg.bak）"
  else
    echo "注入代码本来就不在，跳过"
  fi
  rm -f "$DIST/dsh-bg.css" "$DIST/dsh-bg.svg" "$DIST/dsh-bg-user.png"
  echo "已删除 dist/dsh-bg.css、dist/dsh-bg.svg、dist/dsh-bg-user.png"
  exit 0
fi

# ---- 打补丁 ----
cp "$HERE/dsh-bg.css" "$DIST/dsh-bg.css"
cp "$HERE/dsh-bg.svg" "$DIST/dsh-bg.svg"
[ -f "$HERE/dsh-bg-user.png" ] && cp "$HERE/dsh-bg-user.png" "$DIST/dsh-bg-user.png"
echo "已拷入 dsh-bg.css / dsh-bg.svg（以及 dsh-bg-user.png，若在）"

cat > "$SNIP" <<'EOF'
		//#region deepdive 背景图注入（样式表 dsh-bg.css，图片 dsh-bg.svg；不想要就删掉本段）
		(function () {
			try {
				var ID = "dsh-user-bg";
				var old = document.getElementById(ID);
				if (old && old.parentNode) old.parentNode.removeChild(old);
				var link = document.createElement("link");
				link.id = ID;
				link.rel = "stylesheet";
				link.href = "/dsh-bg.css?rev=" + Date.now();
				(document.head || document.documentElement).appendChild(link);
			} catch (e) { /* 背景图失败不影响本插件 */ }
		})();
		//#endregion
EOF

if [ "$HAS_SNIP" = 1 ]; then
  echo "注入代码已在，只更新了两个资源文件"
  rm -f "$SNIP"
  exit 0
fi

cp "$TARGET" "$TARGET.dshbg.bak"
awk -v snip="$SNIP" '
  BEGIN { while ((getline l < snip) > 0) s = s l "\n" }
  { print }
  /id: "@deepseek-ai\/dsh-client-ui-open-in-app"/ { seen = 1 }
  seen && !done && /factory: \(require\) => \{/ { printf "%s", s; done = 1 }
' "$TARGET" > "$TARGET.tmp"

if ! grep -q "deepdive 背景图注入" "$TARGET.tmp"; then
  rm -f "$TARGET.tmp" "$SNIP"
  echo "插入失败：没匹配到 factory 行，client.js 结构变了？请手工检查" >&2
  exit 1
fi
mv "$TARGET.tmp" "$TARGET"
rm -f "$SNIP"
echo "已注入背景图代码（备份 client.js.dshbg.bak）"
echo "== 完成：约 1 秒后网页会自动热替换生效；若没有，重启 App 即可 =="
