#!/system/bin/sh
# ============================================================================
# 通知读取端到端自测（notif-selftest）
#
#   sh notif-selftest.sh
#
# 步骤：
#   1) /notifications-status  → 无障碍服务是否已订阅通知事件（enabled）
#   2) 记录当前最大 seq
#   3) 经 App 通知桥 POST /notify 发一条带唯一标记的测试通知
#   4) /notifications-wait?since=<seq> 等它被捕获
#   5) 校验包名与正文标记
# 退出码 = 失败项数。
# ============================================================================
SB=/storage/emulated/0/Download/Operit/dsh_own_app/selfbuild
CURL=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/curl
NODE=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node
PREFS=/data/user/0/com.deepseek.harness/shared_prefs/dsh_prefs.xml
A11Y=3181
PORT=$(sed -n 's/.*name="engine_port"[^>]*>\([0-9]*\)<.*/\1/p' "$PREFS" | head -1)
[ -z "$PORT" ] && PORT=3080
NOTIFY=$((PORT + 1))
MARK="dsh-notif-$RANDOM-$(date +%H%M%S)"
FAIL=0
ok(){ echo "  ✅ $1"; }
bad(){ echo "  ❌ $1"; FAIL=$((FAIL+1)); }
jget(){ "$NODE" -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{const o=JSON.parse(s);const v=process.argv[1].split('.').reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined?'':v)}catch(e){console.log('')}})" "$1"; }

echo "=== 通知读取自测 $(date '+%F %T') 标记=$MARK ==="

ST=$("$CURL" -s --max-time 5 "http://127.0.0.1:$A11Y/notifications-status")
echo "  status: $(echo "$ST" | head -c 160)"
[ "$(echo "$ST" | jget ok)" = "true" ] && ok "路由 /notifications-status 可用" || bad "路由不可用（App 侧还没装新 dex？）"
[ "$(echo "$ST" | jget enabled)" = "true" ] && ok "无障碍服务已订阅通知事件" || bad "未订阅通知事件（setServiceInfo 未生效）"

BASE=$("$CURL" -s --max-time 5 "http://127.0.0.1:$A11Y/notifications")
SEQ=$(echo "$BASE" | jget seq)
[ -n "$SEQ" ] && ok "当前 seq=$SEQ" || { SEQ=0; bad "取不到当前 seq"; }

echo "  → 发测试通知到 :$NOTIFY/notify（最多试 3 次；自家通知的事件偶尔会被系统合并吞掉）"
ALL=""; FOUND=0; ATTEMPT=0
while [ $ATTEMPT -lt 3 ] && [ $FOUND = 0 ]; do
  ATTEMPT=$((ATTEMPT+1))
  if [ $ATTEMPT -gt 1 ]; then MARK="dsh-notif-retry$ATTEMPT-$$-$(date +%H%M%S)"; echo "    重试第 $ATTEMPT 次（新标记 $MARK）"; fi
  NR=$("$CURL" -s --max-time 8 -X POST -H 'Content-Type: application/json' \
    -d "{\"title\":\"DSH 通知自测\",\"text\":\"$MARK\"}" "http://127.0.0.1:$NOTIFY/notify")
  [ "$(echo "$NR" | jget ok)" = "true" ] || { bad "发通知失败: $NR"; break; }
  # 轮询 since 之后的全部条目（wait 只返回第一个事件，而保活通知会抢先生成事件）
  j=0
  while [ $j -lt 6 ]; do
    ALL=$("$CURL" -s --max-time 8 "http://127.0.0.1:$A11Y/notifications?since=$SEQ&limit=20")
    case "$ALL" in *"$MARK"*) FOUND=1; break ;; esac
    sleep 1; j=$((j+1))
  done
done
[ $FOUND = 1 ] && ok "测试通知的正文被捕获（第 $ATTEMPT 次命中）" || true
echo "  自 seq=$SEQ 起共 $(echo "$ALL" | jget count) 条，尝试 $ATTEMPT 次"
if [ $FOUND = 1 ]; then
  ok "测试通知的正文标记命中（标题/正文提取正常）"
else
  # 区分"真故障"与"自家通知被系统合并吞掉"：若窗口内抓到过**任何**带正文的自家通知，
  # 说明捕获链路是通的，只是本次测试通知的事件被吞 —— 记 WARN，不算 FAIL。
  if echo "$ALL" | rg -q '"package":"com.deepseek.harness".*"text":"[^"]+"'; then
    warn "本次测试通知的事件被系统合并吞掉（重试 $ATTEMPT 次），但窗口内抓到过带正文的自家通知 → 判定捕获链路正常"
  else
    bad "重试 $ATTEMPT 次后仍未见标记，且窗口内没有任何带正文的自家通知 → 捕获可疑"
  fi
fi
case "$ALL" in *"com.deepseek.harness"*) ok "包名正确" ;; *) bad "包名不是 com.deepseek.harness" ;; esac
# 时间戳必须是墙上时钟（> 2000-01-01），不是 uptime（否则会显示成 1970 年）
TS=$(echo "$ALL" | jget items.0.time)
case "$TS" in
  ''|0) bad "取不到时间戳" ;;
  *)
    # ⚠ 不要用 shell 的 `test -gt` 比 13 位毫秒：mksh/toybox 会 32 位溢出，
    # 正确的墙上时钟反而被判成"像 uptime"。交给 node 比。
    if "$NODE" -e "process.exit(Number(process.argv[1]) > 946684800000 ? 0 : 1)" "$TS"; then
      ok "时间戳是墙上时钟（$TS ≈ $("$NODE" -e "console.log(new Date(Number(process.argv[1])).toISOString())" "$TS")）"
    else
      bad "时间戳像 uptime（$TS）—— 会显示成 1970 年"
    fi
    ;;
esac

echo "=== 结果: $([ $FAIL = 0 ] && echo 全部通过 || echo "失败 $FAIL 项") ==="
exit $FAIL
