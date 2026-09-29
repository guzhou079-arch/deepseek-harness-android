#!/system/bin/sh
# ============================================================================
# 装机前强制预检：在**隔离实例**里启动引擎，确认它真的能起来
#
#   sh preflight-isolated.sh                 # 用 build-overlay 里的补丁预演
#   sh preflight-isolated.sh --live          # 只跑当前装机副本（不套补丁）
#
# 为什么需要它：2026-09-29 的 v1.28 事故里，我改的两个 required 内核插件
# （dsh-client-modules / dsh-client-hmr）让引擎 `startup failed: 1 required plugin
# did not activate`，App 每 20s 重试一次连撞 34 次，最后只能卸载重装。
# 那次如果先跑这个脚本，5 分钟就能发现。
#
# 原理：独立 DSH_HOME + 独立端口 + 独立 TMPDIR；把 build-overlay 的补丁**临时**套到
# 装机副本上（这些文件本来就会被 APK payload 覆盖，所以套上去是等价预演），
# 启动引擎，检查是否出现 `Failed plugins` / `startup failed`，然后杀掉实例。
#
# 退出码 0 = 可以装机；非 0 = 禁止装机。
# ============================================================================
F=/data/user/0/com.deepseek.harness/files
SB=/storage/emulated/0/Download/Operit/dsh_own_app/selfbuild
NODE=$F/payload/runtime/bin/node
CURL=$F/payload/runtime/bin/curl
LIVE=$F/payload/dshroot
ISO=$F/tmp/preflight
PORT=3097
REL=dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
APPLY=1
[ "$1" = "--live" ] && APPLY=0
# --lan：额外验证"局域网模式"（引擎绑 :: + trusted-host），不装机也能验
LAN=0
for a in "$@"; do [ "$a" = "--lan" ] && LAN=1; done
HOST_ARGS="--host 127.0.0.1"
LAN_OPTIN=""
LANIP=""
if [ $LAN = 1 ]; then
  LANIP=$("$NODE" -e 'const os=require("os");for(const k of Object.keys(os.networkInterfaces()))for(const a of os.networkInterfaces()[k]||[])if(a.family==="IPv4"&&!a.internal){console.log(a.address);process.exit(0)}' 2>/dev/null)
  HOST_ARGS="--host 0.0.0.0 --trusted-host $LANIP"
  LAN_OPTIN=1
  echo "== 局域网模式：绑定 0.0.0.0（需 DSH_ALLOW_LAN=1），trusted-host=$LANIP =="
fi

rm -rf "$ISO"; mkdir -p "$ISO"
echo "== 复制隔离 DSH_HOME（不动真实会话）=="
cp -a "$F/payload/dshhome" "$ISO/dshhome" 2>/dev/null || { echo "✗ 复制 dshhome 失败"; exit 2; }

if [ $APPLY = 1 ]; then
  echo "== 把 build-overlay 的补丁临时套到装机副本（等价预演）=="
  echo "  （原文件备份在 $ISO/backup，测完自动还原）"
  find "$SB/build-overlay" -type f | while read -r f; do
    rel=${f#$SB/build-overlay/}          # build-overlay 里是 payload 相对路径（dshroot/…）
    mkdir -p "$ISO/backup/$(dirname "$rel")"
    cp "$F/payload/$rel" "$ISO/backup/$rel" 2>/dev/null   # 备份原文件
    cp "$f" "$F/payload/$rel" && echo "  套用 $rel"
  done
fi

echo "== 启动隔离引擎（端口 $PORT）=="
LOG=$ISO/engine.log
env -i \
  HOME="$F" \
  DSH_HOME="$ISO/dshhome" \
  TMPDIR="$F/tmp" \
  PATH="$F/payload/bin:$F/payload/runtime/bin:/system/bin:/system/xbin" \
  LD_LIBRARY_PATH="$F/payload/runtime/lib" \
  OPENSSL_CONF="$F/payload/runtime/etc/openssl.cfg" \
  SSL_CERT_FILE="$F/payload/runtime/etc/cacert.pem" \
  ${LAN_OPTIN:+DSH_ALLOW_LAN=1} \
  "$NODE" --expose-internals "$LIVE/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" \
    web $HOST_ARGS --port $PORT --no-open >"$LOG" 2>&1 &
PID=$!
echo "  pid=$PID，等 25 秒…"
sleep 25

FAIL=0
if rg -q "Failed plugins|startup failed|did not activate" "$LOG" 2>/dev/null; then
  echo "  ❌ 引擎启动失败："
  rg -n -A4 "Failed plugins|startup failed|did not activate" "$LOG" | head -20
  FAIL=1
else
  echo "  ✅ 日志里没有 Failed plugins / startup failed"
fi
CODE=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null)
case "$CODE" in
  401|200|403) echo "  ✅ 端口有响应（HTTP $CODE）" ;;
  *) echo "  ❌ 端口无响应（$CODE）"; FAIL=1 ;;
esac
# 客户端模块路由必须存在（v1.28 就是把它弄没了）
BUNDLE=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/plugins/events" 2>/dev/null)
case "$BUNDLE" in
  200|401|403) echo "  ✅ /plugins/events 有响应（HTTP $BUNDLE）" ;;
  *) echo "  ❌ /plugins/events 无响应（$BUNDLE）—— 客户端模块路由可疑"; FAIL=1 ;;
esac

# ── 若带了 /plugins 门禁补丁：验证门禁**真的生效**、且 connection 真的懒取到了 ──
if [ -f "$SB/build-overlay/$REL/dsh-client-modules/lib/index.js" ] || [ -f "$SB/build-overlay/$REL/dsh-client-hmr/lib/index.js" ]; then
  echo "== 门禁补丁专项验证 =="
  if rg -q "connection service unavailable" "$LOG" 2>/dev/null; then
    echo "  ❌ 日志出现 'connection service unavailable'：懒取失败 → 门禁等于没打"
    FAIL=1
  else
    echo "  ✅ 没有 'connection service unavailable'（conn 拿得到）"
  fi
  TOKEN=$(rg -o 'token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2)
  CJ=$ISO/cookies.txt; rm -f "$CJ"
  NOC=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/plugins/events" 2>/dev/null)
  [ "$NOC" = "401" ] && echo "  ✅ /plugins/events 无 cookie → 401" || { echo "  ❌ /plugins/events 无 cookie → $NOC（期望 401）"; FAIL=1; }
  UC=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/dsh-update-check/status" 2>/dev/null)
  [ "$UC" = "401" ] && echo "  ✅ /dsh-update-check/status 无 cookie → 401" || { echo "  ❌ /dsh-update-check/status 无 cookie → $UC（期望 401）"; FAIL=1; }
  if [ -n "$TOKEN" ]; then
    "$CURL" -s -o /dev/null -c "$CJ" --max-time 6 "http://127.0.0.1:$PORT/?token=$TOKEN" 2>/dev/null
    WITH=$("$CURL" -s -o /dev/null -b "$CJ" -w '%{http_code}' --max-time 6 "http://127.0.0.1:$PORT/plugins/events" 2>/dev/null)
    [ "$WITH" = "200" ] && echo "  ✅ /plugins/events 带 cookie → 200（正路仍通）" || { echo "  ❌ 带 cookie → $WITH（期望 200）"; FAIL=1; }
    UCW=$("$CURL" -s -o /dev/null -b "$CJ" -w '%{http_code}' --max-time 6 "http://127.0.0.1:$PORT/dsh-update-check/status" 2>/dev/null)
    [ "$UCW" = "200" ] && echo "  ✅ /dsh-update-check/status 带 cookie → 200" || { echo "  ❌ update-check 带 cookie → $UCW（期望 200）"; FAIL=1; }
    URL=$("$CURL" -s -b "$CJ" --max-time 5 "http://127.0.0.1:$PORT/plugins/events" 2>/dev/null | rg -o 'plugins/\?\?[^"]*client\.js[^"]*' | head -1)
    if [ -n "$URL" ]; then
      BN=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/$URL" 2>/dev/null)
      [ "$BN" = "401" ] && echo "  ✅ /plugins/<id>/client.js 无 cookie → 401" || { echo "  ❌ client.js 无 cookie → $BN（期望 401）"; FAIL=1; }
    else
      echo "  ⚠️  从模块图里没取到 client.js URL，跳过该项"
    fi
  else
    echo "  ⚠️  日志里没取到 token，跳过正向验证"
  fi
fi

# ── 局域网模式专项（--lan）────────────────────────────────────────────
if [ $LAN = 1 ] && [ -n "$LANIP" ]; then
  echo "== 局域网可达性 =="
  L1=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$LANIP:$PORT/" 2>/dev/null)
  case "$L1" in
    401|403) echo "  ✅ 经局域网 IP($LANIP) → $L1（可达，且要求鉴权）" ;;
    000)     echo "  ❌ 经局域网 IP 不可达（绑定没生效？）"; FAIL=1 ;;
    *)       echo "  ⚠️ 经局域网 IP → $L1" ;;
  esac
  L2=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$LANIP:$PORT/plugins/events" 2>/dev/null)
  [ "$L2" = "401" ] && echo "  ✅ 局域网 IP 打 /plugins/events 无 cookie → 401" || { echo "  ❌ 局域网 IP /plugins/events → $L2（期望 401）"; FAIL=1; }
  L3=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$LANIP:$PORT/dsh-bg-user.png" 2>/dev/null)
  [ "$L3" = "401" ] && echo "  ✅ 局域网 IP 打静态资产无 cookie → 401" || { echo "  ❌ 局域网 IP /dsh-bg-user.png → $L3（期望 401）"; FAIL=1; }
  # App 自己的 WebView 走 127.0.0.1 —— 绑 :: 时必须仍然可达，否则界面会挂
  R4=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null)
  case "$R4" in
    401|403|200) echo "  ✅ 绑 :: 后回环仍可达（WebView 不受影响，HTTP $R4）" ;;
    *) echo "  ❌ 绑 :: 后回环不可达（HTTP $R4）→ 界面会挂，禁止这么绑"; FAIL=1 ;;
  esac
fi

echo "== 收尾：杀掉隔离实例 =="
kill $PID 2>/dev/null; sleep 2; kill -9 $PID 2>/dev/null

# 还原被预演覆盖的文件 —— 这些包不一定在白名单里，套坏了下次启动不会自动恢复！
if [ $APPLY = 1 ] && [ -d "$ISO/backup" ]; then
  echo "== 还原装机副本（预演只留结论，不留改动）=="
  find "$ISO/backup" -type f | sed "s#^$ISO/backup/##" | while read -r rel; do
    cp "$ISO/backup/$rel" "$F/payload/$rel" && echo "  还原 $rel"
  done
fi

if [ $FAIL = 0 ]; then echo "✅ 预检通过：可以装机"; else echo "⛔ 预检失败：禁止装机（先修好再谈）"; fi
exit $FAIL
