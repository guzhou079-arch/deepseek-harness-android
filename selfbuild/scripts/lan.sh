#!/system/bin/sh
# ============================================================================
# 局域网访问 Web GUI 的开关与体检
#
#   sh lan.sh status      # 看状态 + 可用局域网 URL（含令牌）
#   sh lan.sh on          # 打开（改完需重启 App 才生效）
#   sh lan.sh off         # 关闭（同样需重启才真正收回去）
#   sh lan.sh binds       # 核查各端口绑定地址（3080 应可 0.0.0.0；3181/8999/3081 必须 127.0.0.1）
#
# 安全前提（已在 dsh-client-connection 里核实）：3080 的所有 API 都走
# 「Host/Origin 围栏 + 逐进程签名 cookie」，没有 loopback 免检后门 → 无令牌设备只能拿 401/403。
# 但 HTTP 是明文，令牌在 URL 里：不用就关掉，别把 URL 外传。
# ============================================================================
R="${DSH_PROJECT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SB="$R/selfbuild"
CURL=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/curl
NODE=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node
PREFS=/data/user/0/com.deepseek.harness/shared_prefs/dsh_prefs.xml
TOKEN=$(sed -n 's/.*name="local_token"[^>]*>\([^<]*\)<.*/\1/p' "$PREFS" | head -1)
PORT=$(sed -n 's/.*name="engine_port"[^>]*>\([0-9]*\)<.*/\1/p' "$PREFS" | head -1)
[ -z "$PORT" ] && PORT=3080
BRIDGE=$((PORT + 1))

pretty() { "$NODE" -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch(e){console.log(s)}})"; }

case "$1" in
  status)
    "$CURL" -s --max-time 6 "http://127.0.0.1:$BRIDGE/lan" | pretty
    ;;
  on|off)
    [ -n "$TOKEN" ] || { echo "✗ 读不到 local_token"; exit 1; }
    V=false; [ "$1" = "on" ] && V=true
    "$CURL" -s --max-time 8 -X POST -H 'Content-Type: application/json' \
      -d "{\"enabled\":$V,\"token\":\"$TOKEN\"}" "http://127.0.0.1:$BRIDGE/lan" | pretty
    echo "（改完需重启 App 才真正生效）"
    ;;
  binds)
    # /proc/net/tcp 对 App uid 是 Permission denied，ss/netstat 也不可靠 →
    # 改用**连通性探测**：从本机非 loopback IP 连各端口，连得上=绑到所有网卡。
    IPS=$("$NODE" -e 'const os=require("os");const n=os.networkInterfaces();for(const k in n)for(const i of n[k])if(i.family==="IPv4"&&!i.internal)console.log(i.address)')
    [ -n "$IPS" ] || { echo "✗ 找不到非 loopback IPv4（没连 Wi-Fi？）"; exit 1; }
    echo "本机局域网地址: $(echo $IPS | tr '\n' ' ')"
    for p in 3080 3081 3181 8999; do
      case $p in
        3080) NAME="Web GUI（可开）" ;;
        3081) NAME="notify/shell 桥（必须仅本机）" ;;
        3181) NAME="无障碍桥（必须仅本机）" ;;
        8999) NAME="虚拟屏桥（必须仅本机）" ;;
      esac
      REACH=""
      for ip in $IPS; do
        code=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 3 "http://$ip:$p/" 2>/dev/null)
        [ "$code" != "000" ] && REACH="$REACH $ip($code)"
      done
      if [ -n "$REACH" ]; then
        if [ "$p" = "3080" ]; then echo "  ✅ $p $NAME → 可从局域网访问：$REACH（局域网开关已生效）"
        else echo "  ❌ $p $NAME → 竟然可从局域网访问：$REACH（不该！）"; fi
      else
        if [ "$p" = "3080" ]; then echo "  ✅ $p $NAME → 仅本机（默认；要局域网访问请 sh lan.sh on 后重启 App）"
        else echo "  ✅ $p $NAME → 仅本机（正确）"; fi
      fi
    done
    ;;
  *)
    sed -n '2,16p' "$SB/scripts/lan.sh"
    ;;
esac
