#!/system/bin/sh
# ============================================================================
# 隔离实例验证「控制台搬网页」插件：dsh-android-console
#
#   sh scripts/check-console-plugin-isolated.sh
#
# 验什么（全部实测，不看推断）：
#   ① 引擎能起（无 Failed plugins / startup failed）
#   ② 插件进了客户端名册（/plugins/events 的模块图里有 dsh-android-console）
#   ③ 它的 client.js 真的能取到（HTTP 200，正文里有我们的 section id）
#   ④ 正文里保留了 require('@deepseek-ai/dsh-client-ui-primitives')（靠共享模块表解析）
#
# 退出码 0 = 通过。
# ============================================================================
set -u
F=/data/user/0/com.deepseek.harness/files
NODE=$F/payload/runtime/bin/node
CURL=$F/payload/runtime/bin/curl
LIVE=$F/payload/dshroot
ISO=$F/tmp/console-plugin-check
PORT=3098
LOG=$ISO/engine.log

# ⚠️ 本脚本里那几次 `node -e`（从 SSE 里抽我们那条 url）**必须**带 runtime 的 lib 路径，
#    否则报 "library libcares.so not found" 直接起不来；而它的 stderr 被 2>/dev/null 吞掉，
#    表现就是"模块图里没取到 url"——2026-10-15 查了半天，根因在这里（脚本自己从没通过）。
export LD_LIBRARY_PATH="$F/payload/runtime/lib"
export TMPDIR="$F/tmp"
"$NODE" -e 'process.exit(0)' 2>/dev/null || { echo "✗ node 起不来（缺 LD_LIBRARY_PATH？），本门禁的 url 抽取会静默失效，先修环境"; exit 2; }

rm -rf "$ISO"; mkdir -p "$ISO"
echo "== 复制隔离 DSH_HOME（含本次要验的插件）=="
cp -a "$F/payload/dshhome" "$ISO/dshhome" 2>/dev/null || { echo "✗ 复制 dshhome 失败"; exit 2; }
[ -d "$ISO/dshhome/profiles/web/node_modules/dsh-android-console" ] || { echo "✗ 隔离 DSH_HOME 里没有插件目录"; exit 2; }
# 可选：把**改完还没进包**的 client.js 先塞进隔离实例验一遍 —— 装机前就能知道
# "插件还加不加载得起来"（槽位名写错、注册参数不对，都会让整块设置页崩掉）。
#   PLUGIN_SRC_CLIENT=/sdcard/.../plugins/dsh-android-console/lib/client.js \
#     sh scripts/check-console-plugin-isolated.sh
if [ -n "${PLUGIN_SRC_CLIENT:-}" ]; then
  [ -f "$PLUGIN_SRC_CLIENT" ] || { echo "✗ PLUGIN_SRC_CLIENT 不存在：$PLUGIN_SRC_CLIENT"; exit 2; }
  cp "$PLUGIN_SRC_CLIENT" "$ISO/dshhome/profiles/web/node_modules/dsh-android-console/lib/client.js" \
    || { echo "✗ 覆盖隔离实例里的 client.js 失败"; exit 2; }
  echo "  · 已用待验版本覆盖：$PLUGIN_SRC_CLIENT（$(md5sum "$PLUGIN_SRC_CLIENT" | cut -c1-8)）"
fi

echo "== 启动隔离引擎（端口 $PORT）=="
env -i \
  HOME="$F" \
  DSH_HOME="$ISO/dshhome" \
  TMPDIR="$F/tmp" \
  PATH="$F/payload/bin:$F/payload/runtime/bin:/system/bin:/system/xbin" \
  LD_LIBRARY_PATH="$F/payload/runtime/lib" \
  OPENSSL_CONF="$F/payload/runtime/etc/openssl.cfg" \
  SSL_CERT_FILE="$F/payload/runtime/etc/cacert.pem" \
  "$NODE" --expose-internals "$LIVE/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" \
    web --host 127.0.0.1 --port $PORT --no-open >"$LOG" 2>&1 &
PID=$!
echo "  pid=$PID，等 25 秒…"
sleep 25

FAIL=0
if rg -q "Failed plugins|startup failed|did not activate" "$LOG" 2>/dev/null; then
  echo "  ❌ 引擎启动失败："
  rg -n -A4 "Failed plugins|startup failed|did not activate" "$LOG" | head -20
  FAIL=1
else
  echo "  ✅ 没有 Failed plugins / startup failed"
fi

# 插件自己的报错（加载期）
if rg -q "android-console.*(failed|error|cannot)" "$LOG" 2>/dev/null; then
  echo "  ⚠️  日志里提到 android-console 的失败字样，人工看一眼："
  rg -n "android-console" "$LOG" | head -10
fi

CODE=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null)
case "$CODE" in 401|200|403) echo "  ✅ 端口有响应（HTTP $CODE）" ;; *) echo "  ❌ 端口无响应（$CODE）"; FAIL=1 ;; esac

TOKEN=$(rg -o 'token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2)
if [ -z "$TOKEN" ]; then
  echo "  ❌ 日志里没取到 token，后面的正路验证做不了"
  FAIL=1
else
  CJ=$ISO/cookies.txt; rm -f "$CJ"
  "$CURL" -s -o /dev/null -c "$CJ" --max-time 8 "http://127.0.0.1:$PORT/?token=$TOKEN" 2>/dev/null
  EV=$("$CURL" -s -b "$CJ" --max-time 8 "http://127.0.0.1:$PORT/plugins/events" 2>/dev/null)
  if [ -z "$EV" ]; then
    echo "  ❌ /plugins/events 取不到正文"
    FAIL=1
  else
    if printf '%s' "$EV" | rg -q "dsh-android-console"; then
      echo "  ✅ 客户端名册里有 dsh-android-console"
    else
      echo "  ❌ 客户端名册里没有 dsh-android-console（插件没进模块图）"
      printf '%s' "$EV" | rg -o 'plugins/\?\?[^"]+' | head -3
      FAIL=1
    fi
    # 从 SSE 的 graph 里按 id 精确取**我们那一条**的 url —— 别拿"第一个组合包"充数
    # （组合包是按批次的，第一个包里没有我们的代码，曾经因此误判成"正文里没有"）。
    URL=$(printf '%s' "$EV" | sed -n 's/^data: //p' | "$NODE" -e '
      let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
        for(const line of s.split("\n")){
          if(!line.trim())continue;
          let o;try{o=JSON.parse(line)}catch(e){continue}
          if(o.type!=="graph")continue;
          for(const e of o.graph.entries||[]){if(e.id==="dsh-android-console"){console.log(e.url);return}}
        }
      });' 2>/dev/null)
    if [ -n "$URL" ]; then
      BODY=$("$CURL" -s -b "$CJ" --max-time 20 "http://127.0.0.1:$PORT/$URL" 2>/dev/null)
      BC=$("$CURL" -s -o /dev/null -w '%{http_code}' -b "$CJ" --max-time 20 "http://127.0.0.1:$PORT/$URL" 2>/dev/null)
      echo "  · 组合包 HTTP $BC，$(( ${#BODY} )) 字节"
      if [ "$BC" = "200" ]; then echo "  ✅ client.js 可取"; else echo "  ❌ client.js HTTP $BC"; FAIL=1; fi
      if printf '%s' "$BODY" | rg -q "android-console"; then
        echo "  ✅ 正文里有 section id android-console"
      else
        echo "  ❌ 正文里没有 android-console（不是我们的包？）"; FAIL=1
      fi
      if printf '%s' "$BODY" | rg -q "dsh-client-ui-primitives"; then
        echo "  ✅ 正文里保留了 primitives 的 require（靠共享模块表解析）"
      else
        echo "  ⚠️  正文里没看到 primitives 的 require（可能被压缩/改写）"
      fi
      # 分享到货横幅：只有**真进包**才有意义 —— 源码里改了、包里没带，正是 2026-10-15
      # 「分享卡片只在聊天框、停在设置页就看不见」那类事故的翻版。
      if printf '%s' "$BODY" | rg -q "android-share-notice"; then
        echo "  ✅ 正文里有分享到货横幅（shell.overlay / android-share-notice）"
      else
        echo "  ❌ 正文里没有 android-share-notice（分享到货提示没进包）"; FAIL=1
      fi
    else
      echo "  ❌ 模块图里没取到 dsh-android-console 的 url"
      FAIL=1
    fi
  fi
fi

echo "== 收尾：杀掉隔离实例 =="
kill $PID 2>/dev/null; sleep 2; kill -9 $PID 2>/dev/null

if [ $FAIL = 0 ]; then echo "✅ 控制台插件隔离预检通过"; else echo "⛔ 控制台插件隔离预检失败"; fi
exit $FAIL
