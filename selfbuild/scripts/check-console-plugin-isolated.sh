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
#
# 收尾清理：本脚本每跑一次都要 cp -a 一份完整 dshhome，实测 5.3G。从前收尾只杀进程、
# 不删副本，这 5.3G 就一直躺在 $F/tmp 里等下次跑它才被覆盖；而它不归 gate 调、纯手工
# 按需跑，能躺好几天没人管。现在所有退出路径（成功 / 失败 / 早期 exit 2 / 被 kill）都由
# trap 兜底清理；KEEP=1（或 --keep）保留副本并打印路径与大小，退出码不受影响；失败时
# 默认仍清理，但会提示「要排查请带 KEEP=1 重跑」，不让清理把现场连根抹掉。
# ============================================================================
set -u
# 下面两个环境覆写口只为验证「清理逻辑」本身（造个小假目录跑，不必真拷 5.3G），
# 正常跑别设：DSH_FILES_DIR 换掉 $F，ISO_DIR 换掉隔离目录。守卫见 iso_guard。
F=${DSH_FILES_DIR:-/data/user/0/com.deepseek.harness/files}
NODE=$F/.bin/node
CURL=$F/payload/runtime/bin/curl
LIVE=$F/payload/dshroot
ISO=${ISO_DIR:-$F/tmp/console-plugin-check}
PORT=3098
LOG=$ISO/engine.log
KEEP=${KEEP:-0}
CLEANUP_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --cleanup-only) CLEANUP_ONLY=1 ;;
    -h|--help) sed -n '3,20p' "$0"; exit 0 ;;
    *) echo "✗ 未知参数：$1（本脚本只认 --keep / --cleanup-only）"; exit 2 ;;
  esac
  shift
done

# ── rm -rf 的保险丝 + 收尾清理在 scripts/lib/iso-cleanup.sh ─────────────────
# 抽出去的理由：本脚本是全工程唯一敢 rm -rf 一个 5.3G 副本的闸，三条守卫必须逐条被
# 自测咬住；而「ISO 为空」那条在正常流程里走不到（ISO 总有默认值，空路径也会先被
# 「副本不存在」拦掉），只有直接调函数才验得到。自测 source 同一个库，验的就是这里
# 真正会跑的那份代码。
LIB="$(dirname "$0")/lib/iso-cleanup.sh"
[ -f "$LIB" ] || { echo "✗ 缺少清理库：$LIB（守卫与清理逻辑不在，不敢往下走）"; exit 2; }
. "$LIB" || { echo "✗ 清理库读不进来：$LIB"; exit 2; }

# trap 必须在任何复制动作之前装：早期 exit 2（node 起不来 / 复制失败 / 插件目录不存在 /
# PLUGIN_SRC_CLIENT 不存在 / 覆盖失败）全都要清，只在文件末尾写一行 rm -rf 会把这些全漏掉。
# 信号只负责把退出码改成 128+n，真正的杀进程 + 清理统一走 EXIT，避免跑两遍。
PID=""
trap 'cleanup_iso' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$CLEANUP_ONLY" = 1 ]; then
  echo "== 只跑收尾清理（--cleanup-only：不复制、不起引擎）=="
  exit 0
fi

# ⚠️ 本脚本里那几次 `node -e`（从 SSE 里抽我们那条 url）**必须**带 runtime 的 lib 路径，
#    否则报 "library libcares.so not found" 直接起不来；而它的 stderr 被 2>/dev/null 吞掉，
#    表现就是"模块图里没取到 url"——2026-10-15 查了半天，根因在这里（脚本自己从没通过）。
export LD_LIBRARY_PATH="$F/payload/runtime/lib"
export TMPDIR="$F/tmp"
"$NODE" -e 'process.exit(0)' 2>/dev/null || { echo "✗ node 起不来（缺 LD_LIBRARY_PATH？），本门禁的 url 抽取会静默失效，先修环境"; exit 2; }

iso_guard || { echo "✗ 隔离目录不安全，拒绝动手（见上面那条）"; exit 2; }
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
# 等 token 出现再往下走，别死等固定秒数：profile 里挂了 jadx 等 MCP server 时，
# 它启动会把 INFO 日志灌进同一份 $LOG，引擎的 token 行会被推到 25 秒之后
# （2026-10-19 这样假红过一次：端口都通了、token 还没打出来）。
# 轮询上限 90 秒，超时照旧按"没 token"判红 —— 不掩盖真失败。
echo "  pid=$PID，等引擎打出 token（最多 90 秒）…"
I=0
while [ $I -lt 90 ]; do
  rg -q 'token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null && break
  sleep 2; I=$((I+2))
done
echo "  等了 ${I}s"

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
      # ⚠️ 正文必须**落盘再检**：373KB 的组合包先塞进 shell 变量、再 `printf '%s' "$BODY" |`
      #    会直接 "Argument list too long"（ARG_MAX），于是下面三条断言全部假红 ——
      #    2026-10-19 出 1.40.3 时栽过：包是好的，门禁自己判失败。
      BODYF=$ISO/composed-client.js
      BC=$("$CURL" -s -o "$BODYF" -w '%{http_code}' -b "$CJ" --max-time 20 "http://127.0.0.1:$PORT/$URL" 2>/dev/null)
      BSZ=$(wc -c < "$BODYF" 2>/dev/null | tr -d ' ')
      echo "  · 组合包 HTTP $BC，${BSZ:-0} 字节"
      if [ "$BC" = "200" ]; then echo "  ✅ client.js 可取"; else echo "  ❌ client.js HTTP $BC"; FAIL=1; fi
      if rg -q "android-console" "$BODYF"; then
        echo "  ✅ 正文里有 section id android-console"
      else
        echo "  ❌ 正文里没有 android-console（不是我们的包？）"; FAIL=1
      fi
      if rg -q "dsh-client-ui-primitives" "$BODYF"; then
        echo "  ✅ 正文里保留了 primitives 的 require（靠共享模块表解析）"
      else
        echo "  ⚠️  正文里没看到 primitives 的 require（可能被压缩/改写）"
      fi
      # 分享到货横幅：只有**真进包**才有意义 —— 源码里改了、包里没带，正是 2026-10-15
      # 「分享卡片只在聊天框、停在设置页就看不见」那类事故的翻版。
      if rg -q "android-share-notice" "$BODYF"; then
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

# 收尾（杀进程 + 删 5.3G 副本）都在 EXIT trap 里，所有退出路径共用一份逻辑。
if [ $FAIL = 0 ]; then echo "✅ 控制台插件隔离预检通过"; else echo "⛔ 控制台插件隔离预检失败"; fi
exit $FAIL
