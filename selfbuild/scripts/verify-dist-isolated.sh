#!/system/bin/sh
# ============================================================================
# verify-dist-isolated.sh —— 发行包出厂「隔离实例」验证（对着最终 APK，不是对着工作树）
#
#   sh verify-dist-isolated.sh <dist.apk>
#
# 与 preflight-isolated.sh 的分工：
#   · preflight = 装机前，把 overlay 补丁套在**运行副本**上预演（防止装机后引擎起不来）；
#   · 本脚本  = 发版前，把**最终 APK 里的 payload** 解到隔离目录，按 App 的规则还原链接，
#               验证"别人装上去会拿到什么"。
#
# 五道判据：
#   ① payload 里有新技能 / pet.json（随包内容真的进去了）
#   ② **没有**「别名 .so」时，python 原生模块导入失败 —— 证明精简 payload 确实是靠 LINKS.txt；
#   ③ 按 LINKS.txt 建好链接后，同一组导入全部成功 —— 证明 App 的 applyLinks 能救回来；
#   ④ node 侧原生模块正常；
#   ⑤ 隔离引擎能起来（无 Failed plugins / startup failed，端口有响应）。
#
# 退出码 0 = 通过。
# ============================================================================
set -u
F=/data/user/0/com.deepseek.harness/files
R="${DSH_PROJECT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SB="$R/selfbuild"
NODE=$F/payload/runtime/bin/node
CURL=$F/payload/runtime/bin/curl
APK="$1"
PORT=3098
ISO=$F/tmp/distverify
FAIL=0
note() { echo "  $1"; }
bad()  { echo "  ❌ $1"; FAIL=1; }
ok()   { echo "  ✅ $1"; }

[ -n "${APK:-}" ] && [ -f "$APK" ] || { echo "用法：sh verify-dist-isolated.sh <dist.apk>"; exit 2; }
echo "=== 验证 $APK（$(stat -c%s "$APK") 字节）==="

rm -rf "$ISO"; mkdir -p "$ISO"
echo "== 1/5 取出 APK 里的 payload 并解压到隔离目录 =="
"$NODE" "$SB/lib/selfbuild.js" payload-extract "$APK" "$ISO/payload.zip" >/dev/null || exit 2
mkdir -p "$ISO/payload"
cd "$ISO/payload" || exit 2
unzip -qo "$ISO/payload.zip" -d "$ISO/payload" || { echo "✗ 解压失败"; exit 2; }
note "解压完成：$(find "$ISO/payload" -type f | wc -l) 个文件"

echo "== 2/5 随包内容检查 =="
for want in \
  "dshhome/skills/dsh-review/SKILL.md" \
  "dshhome/skills/dsh-review/scripts/review-channels.mjs" \
  "dshhome/skills/dsh-mobile/SKILL.md" \
  "dshhome/skills/doc-tidy/SKILL.md" \
  "pet/pet.json" ; do
  [ -f "$ISO/payload/$want" ] && ok "在包里：$want" || bad "缺少：$want"
done
[ -f "$ISO/payload/dshroot/CHANGELOG.md" ] && ok "在包里：dshroot/CHANGELOG.md" || bad "缺少更新日志"

echo "== 3/5 python 原生模块：建链接前应当失败 =="
PYT='import ssl, sqlite3, zlib, bz2, lzma, hashlib, ctypes; print("py-ok", ssl.OPENSSL_VERSION.split()[1], sqlite3.sqlite_version)'
BEFORE=$(env -i HOME="$F" TMPDIR="$F/tmp" \
  PATH="$ISO/payload/bin:/system/bin" \
  LD_LIBRARY_PATH="$ISO/payload/runtime/lib" \
  "$ISO/payload/bin/python3" -c "$PYT" 2>&1)
echo "$BEFORE" | grep -q "py-ok" \
  && note "（别名 .so 本来就在？→ 这次没有可验证的精简；不判失败）" \
  || ok "建链接前导入失败（意料之中，说明精简确实依赖 LINKS.txt）"

echo "== 4/5 按 LINKS.txt 建链接（等价 App 的 applyLinks）=="
LN=0
while IFS="	" read -r alias target; do
  [ -n "$alias" ] || continue
  case "$alias" in \#*) continue ;; esac
  if [ ! -e "$ISO/payload/runtime/lib/$alias" ] && [ -e "$ISO/payload/runtime/lib/$target" ]; then
    ln -f "$ISO/payload/runtime/lib/$target" "$ISO/payload/runtime/lib/$alias" 2>/dev/null \
      || ln -s "$target" "$ISO/payload/runtime/lib/$alias" 2>/dev/null
    LN=$((LN+1))
  fi
done < "$ISO/payload/runtime/lib/LINKS.txt"
note "建了 $LN 条链接（LINKS.txt 共 $(grep -c . "$ISO/payload/runtime/lib/LINKS.txt") 行）"
AFTER=$(env -i HOME="$F" TMPDIR="$F/tmp" \
  PATH="$ISO/payload/bin:/system/bin" \
  LD_LIBRARY_PATH="$ISO/payload/runtime/lib" \
  "$ISO/payload/bin/python3" -c "$PYT" 2>&1)
echo "$AFTER" | grep -q "py-ok" && ok "建链接后导入成功：$(echo "$AFTER" | tail -1)" \
  || bad "建链接后仍然失败：$(echo "$AFTER" | tail -3)"
NODEOK=$(env -i HOME="$F" TMPDIR="$F/tmp" LD_LIBRARY_PATH="$ISO/payload/runtime/lib" \
  "$ISO/payload/runtime/bin/node" -e 'require("zlib");require("crypto");require("fs");console.log("node-ok")' 2>&1)
echo "$NODEOK" | grep -q node-ok && ok "node 原生模块正常" || bad "node 起不来：$NODEOK"

# ⚠️ 光"文件在包里"不等于"技能能用"。
#    这里**真的跑一次**随包脚本，任何语法/路径错误都会在这里暴露。
#    ⚠️ 位置必须在"建链接"**之后** —— 实测：node 自己就依赖 libz.so.1 这个别名，
#       链接没建之前跑 node 会 CANNOT LINK（这本身也反证了精简确实依赖 LINKS.txt/applyLinks）。
echo "== 4b/5 随包技能脚本真的能跑（必须在建链接之后）=="
# ⚠️ 判据是「脚本跑到了自己的结论」，**不是**「解析出了 provider」：
#    发行包里的 dshhome 是干净种子（不含用户配的 provider）→ 陌生设备首次跑，
#    它**应该**回「配置里还没有 providers 段」。这算通过；SyntaxError / CANNOT LINK 才算失败。
SKILLOUT=$(env -i HOME="$F" TMPDIR="$F/tmp" PATH="$ISO/payload/bin:/system/bin" \
  LD_LIBRARY_PATH="$ISO/payload/runtime/lib" \
  "$ISO/payload/runtime/bin/node" "$ISO/payload/dshhome/skills/dsh-review/scripts/review-channels.mjs" 2>&1)
if echo "$SKILLOUT" | grep -qE "个 provider|还没有 providers 段|没解析出来"; then
  ok "review-channels.mjs 可执行：$(echo "$SKILLOUT" | head -2 | tail -1)"
else
  bad "review-channels.mjs 跑不起来：$(echo "$SKILLOUT" | head -3)"
fi

echo "== 5/5 隔离引擎启动（端口 $PORT，DSH_HOME=$ISO/payload/dshhome）=="
LOG=$ISO/engine.log
env -i \
  HOME="$F" \
  DSH_HOME="$ISO/payload/dshhome" \
  TMPDIR="$F/tmp" \
  PATH="$ISO/payload/bin:$ISO/payload/runtime/bin:/system/bin:/system/xbin" \
  LD_LIBRARY_PATH="$ISO/payload/runtime/lib" \
  OPENSSL_CONF="$ISO/payload/runtime/etc/openssl.cfg" \
  SSL_CERT_FILE="$ISO/payload/runtime/etc/cacert.pem" \
  "$ISO/payload/runtime/bin/node" --expose-internals \
    "$ISO/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" \
    web --host 127.0.0.1 --port $PORT --no-open >"$LOG" 2>&1 &
PID=$!
note "pid=$PID，等 25 秒…"
sleep 25
if grep -qE "Failed plugins|startup failed|did not activate" "$LOG"; then
  bad "引擎启动失败："; grep -nE -A4 "Failed plugins|startup failed|did not activate" "$LOG" | head -20
else
  ok "日志里没有 Failed plugins / startup failed"
fi
CODE=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null)
case "$CODE" in 401|200|403) ok "端口有响应（HTTP $CODE）" ;; *) bad "端口无响应（$CODE）" ;; esac
kill $PID 2>/dev/null; sleep 2; kill -9 $PID 2>/dev/null

echo
[ $FAIL = 0 ] && echo "✅ 发行包隔离验证通过" || echo "⛔ 发行包隔离验证失败"
echo "   （隔离目录保留在 $ISO，排查用；确认后删）"
exit $FAIL
