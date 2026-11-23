#!/system/bin/sh
# ============================================================================
# 装机前强制预检：在**隔离实例**里启动引擎，确认它真的能起来
#
#   sh preflight-isolated.sh                 # 用 build-overlay 里的补丁预演
#   sh preflight-isolated.sh --live          # 只跑当前装机副本（不套补丁）
#   sh preflight-isolated.sh --cleanup-only  # 只清旧副本，不复制、不起引擎
#
# 为什么需要它：2026-09-29 的 v1.28 事故里，我改的两个 required 内核插件
# （dsh-client-modules / dsh-client-hmr）让引擎 `startup failed: 1 required plugin
# did not activate`，App 每 20s 重试一次连撞 34 次，最后只能卸载重装。
# 那次如果先跑这个脚本，5 分钟就能发现。
#
# 原理：把 payload 复制成一份隔离副本（dshroot 全量 + dshhome 去大件），把 build-overlay
# 的补丁套在**副本**上，用独立 DSH_HOME + 独立端口 + 独立 TMPDIR 启动引擎，检查是否出现
# `Failed plugins` / `startup failed`，然后杀掉实例、删掉副本。
#
# 铁律：本脚本对运行树（$F/payload）只读，一个字节都不写。曾经它靠「套到运行树、测完还原」
# 实现预演，2026-11-19 命令中途被打断、还原段没跑到，App 直接整屏空白 —— 见
# lesson-preflight-must-not-touch-live-tree。
#
# 退出码 0 = 可以装机；非 0 = 禁止装机。
# ============================================================================
# 下面两个环境覆写口只为验证「清理逻辑」本身（造个小假目录跑，不必真拷 dshroot），
# 正常跑别设：DSH_FILES_DIR 换掉 $F，ISO_DIR 换掉隔离目录。守卫见 iso_guard。
F=${DSH_FILES_DIR:-/data/user/0/com.deepseek.harness/files}
R="${DSH_PROJECT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SB="$R/selfbuild"
NODE=$F/.bin/node
CURL=$F/payload/runtime/bin/curl
ISO=${ISO_DIR:-$F/tmp/preflight}
PORT=3097
CLEANUP_ONLY=0
for a in "$@"; do [ "$a" = "--cleanup-only" ] && CLEANUP_ONLY=1; done

# ── 收尾：杀实例 + 删副本（trap 必须装在第一个复制动作之前）────────────────
# 为什么提前：早期退出路径（node 起不来 / LAN 门禁探针失败 / 复制失败 / profile 对齐失败）
# 各自 exit 2/3，而复制出来的是一份 dshroot 量级副本。trap 装晚了，这些路径上副本没人收，
# 就留在 $F/tmp 里躺着。现在 trap 在**任何**删除/复制动作之前装好，所有退出路径都收。
# 为什么 rm -rf 前要过 iso_guard：删的是拼出来的路径、$F 还能被环境覆写，一旦拼错
# 就对着真载荷下手 —— 副本删了能重造，payload 删了要重新解包出包。三条判断都极便宜。
iso_guard() {
  [ -n "${ISO:-}" ] || { echo "  ⛔ 拒绝清理：ISO 为空"; return 1; }
  case "$ISO" in
    /*/preflight) ;;
    *) echo "  ⛔ 拒绝清理：'${ISO}' 不是以 preflight 结尾的绝对路径"; return 1 ;;
  esac
  if [ "$ISO" = "$F/payload" ] || [ "$ISO" = "$F" ]; then
    echo "  ⛔ 拒绝清理：'$ISO' 指向载荷 / 文件根本身，不是我们造的副本"; return 1
  fi
  return 0
}
# 信号只负责把退出码改成 128+n，真正的杀进程 + 清理统一走 EXIT，避免跑两遍。
PID=""
cleanup_iso() {
  _st=$?
  if [ -n "${PID:-}" ]; then
    kill "$PID" 2>/dev/null && sleep 2
    kill -9 "$PID" 2>/dev/null
    echo "== 收尾：已杀掉隔离实例 pid=$PID =="
  fi
  if [ ! -e "${ISO:-}" ]; then
    [ "$CLEANUP_ONLY" = 1 ] && echo "  没有隔离副本要清（$ISO 不存在）"
    exit "$_st"
  fi
  _sz=$(du -sh "$ISO" 2>/dev/null | cut -f1)
  if [ "${KEEP:-0}" = 1 ]; then
    echo "== 保留隔离副本（KEEP=1）：$ISO（${_sz:-大小未知}）=="
    echo "   看完自己 rm -rf 掉；下次正常跑本脚本时也会先清再复制。"
    exit "$_st"
  fi
  if ! iso_guard; then
    echo "   副本没删，还在：$ISO（先查路径，别硬删）"
    [ "$_st" -eq 0 ] && exit 2
    exit "$_st"
  fi
  rm -rf "$ISO"
  if [ -e "$ISO" ]; then
    echo "  ⚠️ 没删干净，还在：$ISO"
    [ "$_st" -eq 0 ] && exit 2
    exit "$_st"
  fi
  echo "  已清理隔离副本（${_sz:-大小未知}）：$ISO"
  if [ "$_st" -ne 0 ]; then
    echo "  · 副本已清理；要排查请带 KEEP=1 重跑，否则现场留不住"
  fi
  exit "$_st"
}
trap 'cleanup_iso' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── 只清理模式：不复制、不起引擎（给自测和不带真副本的收尾用）──────────────
if [ "$CLEANUP_ONLY" = 1 ]; then
  echo "== 只跑收尾清理（--cleanup-only：不复制、不起引擎）=="
  exit 0
fi

# ── 自证 node 能起来 ──────────────────────────────────────────────────
# 自己导出库路径 + 自证在跑是必须的：靠调用方 export 的话，忘了就 `CANNOT LINK … libcares.so
# not found`（看着像引擎/包坏了，其实是门禁没起来）；`$NODE -e` 若被 2>/dev/null 吞掉还会
# 静默空转，门禁等于没跑。
# 这段在 trap 之后：node 起不来也是早期 exit 2，同样要能收掉半份副本。
export LD_LIBRARY_PATH="$F/payload/runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
"$NODE" -e 'process.exit(0)' 2>/dev/null || { echo "✗ node 起不来（缺 LD_LIBRARY_PATH？）"; exit 2; }

# 无参数时它默认就跑完整演练。先说明要花多久、会占什么 —— 否则看着像卡死在「搭隔离副本」。
if [ $# -eq 0 ]; then
  echo "== 开始跑完整隔离演练（约 3-5 分钟，会解一份 dshroot 副本）=="
fi
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

# ── 2026-10-17 事后补：LAN 开关的两道闸必须双向可控 ──────────────────
# rc2 在 dsh-host-webserver 的 Config 层加了第二道 wildcard 拒绝，LAN 补丁只覆盖了
# startup.js 的第一道 → 用户一开 LAN，引擎必死；而当时的门禁只跑默认 127.0.0.1，
# 全绿也照样起不来（lesson-preflight-must-run-the-user-action）。探针 1 秒，双向断言。
LAN_CAND="$R/v118/dsh-patches/overlay/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js"
[ $APPLY = 0 ] && LAN_CAND="$F/payload/$REL/dsh-host-webserver/lib/index.js"
DSH_LAN_CANDIDATE="$LAN_CAND" "$NODE" "$SB/scripts/check-lan-gate.mjs" || { echo "✗ LAN 门禁探针失败 → 禁止装机"; exit 3; }

# ── 只在副本上试，运行树一个字节都不碰 ────────────────────────────────────
# 以前这段是把 overlay 直接盖到 $F/payload —— 也就是 App 正在读的那棵运行树，
# 靠「测完自动还原」收场。两个假设都不成立：命令会被打断（还原段没跑到，树停在
# 半新半旧），页面也在同时读这些文件（当场整屏空白）。运行中的树不能当草稿纸。
iso_guard || { echo "✗ 隔离目录不安全，拒绝动手（见上面那条）"; exit 2; }
rm -rf "$ISO"; mkdir -p "$ISO"
echo "== 搭隔离副本（运行树只读，不写入）=="
cp -a "$F/payload/dshroot" "$ISO/dshroot" || { echo "✗ 复制 dshroot 失败"; exit 2; }
mkdir -p "$ISO/dshhome"
# dshhome 有 4.7G，其中附件 3.0G / 会话 727M / 缓存 628M，预检用不到，跳过
for d in "$F/payload/dshhome"/*; do
  base=${d##*/}
  case "$base" in
    attachments|sessions|cache|crew|office-kit|logs|tmp|storages) continue ;;
    *.bak*|*.prev) continue ;;
  esac
  cp -a "$d" "$ISO/dshhome/" 2>/dev/null || echo "  ⚠️ 跳过 $base"
done
echo "  副本体积 $(du -sk "$ISO" 2>/dev/null | cut -f1) KB"

if [ $APPLY = 1 ]; then
  echo "== 把 build-overlay 的补丁套到副本上（等价预演）=="
  find "$SB/build-overlay" -type f | while read -r f; do
    rel=${f#$SB/build-overlay/}          # build-overlay 里是 payload 相对路径（dshroot/…）
    mkdir -p "$ISO/$(dirname "$rel")"
    cp "$f" "$ISO/$rel" && echo "  套用 $rel"
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
  "$NODE" --expose-internals "$ISO/dshroot/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" \
    web $HOST_ARGS --port $PORT --no-open >"$LOG" 2>&1 &
PID=$!
# 收尾 trap 已在上面的 cleanup_iso 处装好（早于任何复制动作），这里不再重复挂。
echo "  pid=$PID，等 25 秒…"
sleep 25

FAIL=0
if rg -q "Failed plugins|startup failed" "$LOG" 2>/dev/null; then
  echo "  ❌ 引擎启动失败（致命）："
  rg -n -A4 "Failed plugins|startup failed" "$LOG" | head -20
  FAIL=1
else
  echo "  ✅ 日志里没有 Failed plugins / startup failed"
fi

# 「N entry did not activate」本身不是启动失败：可选条目导入失败只出 warning，引擎照跑。
# 判据不能是「有还是没有」——当前装机副本自己就带着一条从未清掉的死引用（指向一个不存在
# 的包），按「有没有」判，会把一份与线上健康实例等价的包判成「禁止装机」，等于判据坏了。
# 真正的判据是「有没有比当前健康实例**多**」：以线上运行日志为基线做集合差，只有新增的
# 导入失败才拦。这样 09-29 那类「必需插件没激活」（走 startup failed）依然拦得住。
rg -o "([A-Za-z0-9_@/.+-]+) \(([^)]+)\): failed to import" -r '$2' "$LOG" 2>/dev/null | sort -u > "$ISO/warn-new.txt"
if [ -s "$ISO/warn-new.txt" ]; then
  if [ -f "$F/dsh-web.log" ]; then
    rg -o "([A-Za-z0-9_@/.+-]+) \(([^)]+)\): failed to import" -r '$2' "$F/dsh-web.log" 2>/dev/null | sort -u > "$ISO/warn-base.txt"
    NEWW=$(grep -Fxv -f "$ISO/warn-base.txt" "$ISO/warn-new.txt" 2>/dev/null)
    if [ -n "$NEWW" ]; then
      echo "  ❌ 出现当前装机实例没有的插件导入失败："
      echo "$NEWW" | sed 's/^/     /'
      FAIL=1
    else
      echo "  ✅ 插件导入失败与当前装机实例一致（基线内，非新增）："
      sed 's/^/     · /' "$ISO/warn-new.txt" | head -5
    fi
  else
    echo "  ❌ 有插件导入失败，且找不到线上日志做基线（$F/dsh-web.log）"
    sed 's/^/     · /' "$ISO/warn-new.txt" | head -5
    FAIL=1
  fi
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

# 预演只留结论：副本整个删掉。没有「改了一半要还原」这回事，也就不存在还原失败。
# 杀实例 + 删副本都由上面的 EXIT trap（cleanup_iso）统一做，所有退出路径共用一段逻辑。
cp "$LOG" "$F/tmp/preflight-last.log" 2>/dev/null

if [ $FAIL = 0 ]; then echo "✅ 预检通过：可以装机"; else echo "⛔ 预检失败：禁止装机（先修好再谈）"; fi
exit $FAIL
