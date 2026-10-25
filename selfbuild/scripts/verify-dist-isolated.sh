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
# 判据：
#   ① payload 里有新技能 / pet.json（随包内容真的进去了）
#   ② **没有**「别名 .so」时，python 原生模块导入失败 —— 证明精简 payload 确实是靠 LINKS.txt；
#   ③ 按 LINKS.txt 建好链接后，同一组导入全部成功 —— 证明 App 的 applyLinks 能救回来；
#   ④ node 侧原生模块正常；随包技能脚本真能跑
#   ⑤ 隔离引擎能起来（无 Failed plugins / startup failed，端口有响应）
#   ⑥ 凭 token 真做一次 RPC 往返（session/create）—— 正面证据，不是"日志没报错"
#   ⑦ 内核 package.json 声明的依赖**一个不缺**（declared-but-missing = 0）
#
# 2026-10-15 补第 ⑥⑦ 与结构化报告：
#   以前本脚本只打文字，而 release-receipts 的 gate 要 `$APK.isolated.json`（经 evidence 盖章），
#   于是"隔离证据"这一环**根本没有产出者**，gate 永远过不去（等于没有这道门）。
#   现在本脚本自己写出 `$APK.isolated-report.json`（原始报告），由 release.sh 调
#   `evidence --kind isolated` 盖成 receipt。
#   ⚠️ 诚实边界：隔离引擎的日志实测**只有 1 行**（就是那条带 token 的启动 URL），
#   所以"没有 Failed plugins"是**阴性判据**，本身不能证明插件真的加载了；
#   插件的正面证据取「声明与实物一致（第⑦）+ 引擎 HTTP 层可应答并可执行 RPC（第⑥）」。
#   报告里 method 字段写明了这一点，别把它读成"逐个探过插件的 HTTP 面"。
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
# 2026-10-15：本脚本全靠 $NODE / $CURL 抽 payload 与探活，而它们需要 runtime 的 .so。
# 以前靠**调用方**自己 export；忘了 export 就报 `CANNOT LINK EXECUTABLE … libcares.so not found`，
# 看着像"包有问题"，其实是门禁没跑起来（同类坑已在 check-console-plugin-isolated.sh 修过一次）。
# 这里自给自足 + 自证在跑：node 起不来直接红，绝不静默空转。
export LD_LIBRARY_PATH="$F/payload/runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
"$NODE" -e 'process.exit(0)' 2>/dev/null || { echo "✗ node 起不来（缺 LD_LIBRARY_PATH？）"; exit 2; }
PORT=3098
ISO=$F/tmp/distverify
FAIL=0
PIDOWN_OK=0; RPC_OK=0; NATIVE_OK=0; HOME_ISO_OK=0; PLUGINS_OK=0; SKILL_OK=0
PENDING=0; FILES_N=0; LN=0; CODE=""; AFTER_ONE=""; TOKEN=""
note() { echo "  $1"; }
bad()  { echo "  ❌ $1"; FAIL=1; }
ok()   { echo "  ✅ $1"; }

[ -n "${APK:-}" ] && [ -f "$APK" ] || { echo "用法：sh verify-dist-isolated.sh <dist.apk>"; exit 2; }
APK=$(realpath "$APK") || { echo "✗ 无法解析 APK 绝对路径"; exit 2; }
echo "=== 验证 $APK（$(stat -c%s "$APK") 字节）==="

rm -rf "$ISO"; mkdir -p "$ISO"
echo "== 1/6 取出 APK 里的 payload 并解压到隔离目录 =="
"$NODE" "$SB/lib/selfbuild.js" payload-extract "$APK" "$ISO/payload.zip" >/dev/null || exit 2
mkdir -p "$ISO/payload"
cd "$ISO/payload" || exit 2
unzip -qo "$ISO/payload.zip" -d "$ISO/payload" || { echo "✗ 解压失败"; exit 2; }
FILES_N=$(find "$ISO/payload" -type f | wc -l)
note "解压完成：$FILES_N 个文件"

echo "== 2/6 随包内容检查 =="
for want in \
  "dshhome/skills/dsh-review/SKILL.md" \
  "dshhome/skills/dsh-review/scripts/review-channels.mjs" \
  "dshhome/skills/dsh-mobile/SKILL.md" \
  "dshhome/skills/doc-tidy/SKILL.md" \
  "pet/pet.json" ; do
  [ -f "$ISO/payload/$want" ] && ok "在包里：$want" || bad "缺少：$want"
done
[ -f "$ISO/payload/dshroot/CHANGELOG.md" ] && ok "在包里：dshroot/CHANGELOG.md" || bad "缺少更新日志"
# 三个随包插件 + 控制台插件：故意"点名"检查，少一个就红（不是只看目录里有没有东西）
PLUGDIR="$ISO/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules"
for p in dsh-plugin-session-rewind dsh-plugin-turn-notify dsh-plugin-auto-summary-policy dsh-android-console dsh-smart-search; do
  [ -d "$PLUGDIR/$p" ] && ok "插件在包里：$p" || bad "插件缺失：$p"
done

echo "== 3/6 python 原生模块：建链接前应当失败 =="
PYT='import ssl, sqlite3, zlib, bz2, lzma, hashlib, ctypes; print("py-ok", ssl.OPENSSL_VERSION.split()[1], sqlite3.sqlite_version)'
BEFORE=$(env -i HOME="$F" TMPDIR="$F/tmp" \
  PATH="$ISO/payload/bin:/system/bin" \
  LD_LIBRARY_PATH="$ISO/payload/runtime/lib" \
  "$ISO/payload/bin/python3" -c "$PYT" 2>&1)
echo "$BEFORE" | grep -q "py-ok" \
  && note "（别名 .so 本来就在？→ 这次没有可验证的精简；不判失败）" \
  || ok "建链接前导入失败（意料之中，说明精简确实依赖 LINKS.txt）"

echo "== 4/6 按 LINKS.txt 建链接（等价 App 的 applyLinks）=="
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
PY_OK=0
if echo "$AFTER" | grep -q "py-ok"; then
  PY_OK=1; AFTER_ONE=$(echo "$AFTER" | tail -1)
  ok "建链接后导入成功：$AFTER_ONE"
else bad "建链接后仍然失败：$(echo "$AFTER" | tail -3)"; fi
NODEOK=$(env -i HOME="$F" TMPDIR="$F/tmp" LD_LIBRARY_PATH="$ISO/payload/runtime/lib" \
  "$ISO/payload/runtime/bin/node" -e 'require("zlib");require("crypto");require("fs");console.log("node-ok")' 2>&1)
echo "$NODEOK" | grep -q node-ok && NODE_OK=1 || NODE_OK=0
echo "$NODEOK" | grep -q node-ok && ok "node 原生模块正常" || bad "node 起不来：$NODEOK"
[ "$PY_OK" = 1 ] && [ "$NODE_OK" = 1 ] && NATIVE_OK=1

# ⚠️ 光"文件在包里"不等于"技能能用"。
#    这里**真的跑一次**随包脚本，任何语法/路径错误都会在这里暴露。
#    ⚠️ 位置必须在"建链接"**之后** —— 实测：node 自己就依赖 libz.so.1 这个别名，
#       链接没建之前跑 node 会 CANNOT LINK（这本身也反证了精简确实依赖 LINKS.txt/applyLinks）。
echo "== 4b/6 随包技能脚本真的能跑（必须在建链接之后）=="
# ⚠️ 判据是「脚本跑到了自己的结论」，**不是**「解析出了 provider」：
#    发行包里的 dshhome 是干净种子（不含用户配的 provider）→ 陌生设备首次跑，
#    它**应该**回「配置里还没有 providers 段」。这算通过；SyntaxError / CANNOT LINK 才算失败。
SKILLOUT=$(env -i HOME="$F" TMPDIR="$F/tmp" PATH="$ISO/payload/bin:/system/bin" \
  LD_LIBRARY_PATH="$ISO/payload/runtime/lib" \
  "$ISO/payload/runtime/bin/node" "$ISO/payload/dshhome/skills/dsh-review/scripts/review-channels.mjs" 2>&1)
if echo "$SKILLOUT" | grep -qE "个 provider|还没有 providers 段|没解析出来"; then
  SKILL_OK=1
  ok "review-channels.mjs 可执行：$(echo "$SKILLOUT" | head -2 | tail -1)"
else
  bad "review-channels.mjs 跑不起来：$(echo "$SKILLOUT" | head -3)"
fi

echo "== 5/6 隔离引擎启动（端口 $PORT，DSH_HOME=$ISO/payload/dshhome）=="
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
# pidOwned：引擎是**本脚本**起的，且等待过后仍活着（不是起完就崩）
if kill -0 "$PID" 2>/dev/null; then PIDOWN_OK=1; ok "隔离引擎进程仍在（pid=$PID）"; else bad "隔离引擎进程已退出"; fi
# homeIsolated：DSH_HOME 就在隔离目录里，且是干净种子（没有开发机自己的设置/会话）
case "$ISO/payload/dshhome" in
  "$F"/tmp/*) [ -f "$ISO/payload/dshhome/settings.yaml" ] || [ -d "$ISO/payload/dshhome/sessions" ] \
      || { HOME_ISO_OK=1; ok "DSH_HOME 隔离且是干净种子（无 settings.yaml / 无 sessions）"; } ;;
esac
[ "$HOME_ISO_OK" = 1 ] || bad "DSH_HOME 不像隔离的干净种子"
CODE=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null)
case "$CODE" in 401|200|403) ok "端口有响应（HTTP $CODE）" ;; *) bad "端口无响应（$CODE）" ;; esac
# ⑥ 正面证据：拿日志里的 token 换 cookie，再真跑一次 session/create（零模型请求）
TOKEN=$(sed -n 's/.*[?&]token=\([A-Za-z0-9_-]*\).*/\1/p' "$LOG" | tail -1)
if [ -n "$TOKEN" ]; then
  RPCJSON=$(env -i HOME="$F" TMPDIR="$F/tmp" LD_LIBRARY_PATH="$ISO/payload/runtime/lib" \
    "$NODE" -e '
    const base = "http://127.0.0.1:" + process.argv[1], token = process.argv[2];
    const done = o => { console.log(JSON.stringify(o)); process.exit(0); };
    (async () => {
      const login = await fetch(base + "/?token=" + token, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      if (login.status !== 303) return done({ ok: false, why: "login=" + login.status });
      const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
      if (!cookie) return done({ ok: false, why: "no-cookie" });
      const res = await fetch(base + "/api/session/create", {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "isolate-verify", method: "session/create",
          payload: { args: { request: { sessionId: "session-isolate-verify" } } } }),
        signal: AbortSignal.timeout(10000) });
      const body = await res.json().catch(() => ({}));
      const sid = body.result && body.result.value && body.result.value.sessionId;
      done({ ok: res.status === 200 && sid === "session-isolate-verify", status: res.status, sessionId: sid || null,
        why: res.status !== 200 ? "http-" + res.status : (sid ? "" : "no-sessionId") });
    })().catch(e => done({ ok: false, why: String((e && e.message) || e) }));
    ' "$PORT" "$TOKEN" 2>&1 | tail -1)
  case "$RPCJSON" in
    *'"ok":true'*) RPC_OK=1; ok "RPC 往返成功（session/create → session-isolate-verify）" ;;
    *) bad "RPC 往返失败：$RPCJSON" ;;
  esac
else
  bad "日志里没有 token，RPC 判据拿不到正面证据"
fi
kill $PID 2>/dev/null; sleep 2; kill -9 $PID 2>/dev/null

echo "== 6/6 声明与实物一致（declared-but-missing 必须为 0）+ 写报告 =="
# ⑦ 内核 package.json 声明的每个依赖，都必须能在 payload 里找到（缺一个 = 装机后加载失败）
PENDING=$(ISO_ROOT="$ISO/payload" ISO_MISSFILE="$ISO/declared-missing.txt" "$NODE" -e '
const fs = require("fs"), path = require("path");
const root = process.env.ISO_ROOT;
const kernel = path.join(root, "dshroot/lib/node_modules/@deepseek-ai/dsh");
const pkg = JSON.parse(fs.readFileSync(path.join(kernel, "package.json"), "utf8"));
const roots = [path.join(kernel, "node_modules"), path.join(root, "dshroot/lib/node_modules")];
const deps = Object.keys(pkg.dependencies || {});
const missing = deps.filter(n => !roots.some(r => fs.existsSync(path.join(r, n))));
fs.writeFileSync(process.env.ISO_MISSFILE, missing.join("\n") + (missing.length ? "\n" : ""));
console.log(missing.length);
')
if [ "$PENDING" = 0 ]; then
  ok "内核声明的依赖一个不缺（0 个 declared-but-missing）"
else
  bad "有 $PENDING 个声明了但没随包的依赖：$(head -5 "$ISO/declared-missing.txt" | tr '\n' ' ')"
fi
[ "$FAIL" = 0 ] && [ "$PENDING" = 0 ] && PLUGINS_OK=1

SELF_SHA=$("$NODE" -e 'const c=require("crypto"),f=require("fs");const h=c.createHash("sha256");h.update(f.readFileSync(process.argv[1]));console.log(h.digest("hex"))' "$SB/scripts/verify-dist-isolated.sh" 2>/dev/null)
ISO_FAIL="$FAIL" ISO_APK="$APK" ISO_REPORT="$APK.isolated-report.json" ISO_PORT="$PORT" \
ISO_HTTP="$CODE" ISO_FILES="$FILES_N" ISO_LINKS="$LN" ISO_PIDOWN="$PIDOWN_OK" ISO_RPC="$RPC_OK" \
ISO_NATIVE="$NATIVE_OK" ISO_PLUGINS="$PLUGINS_OK" ISO_SKILL="$SKILL_OK" ISO_PENDING="$PENDING" \
ISO_HOME="$HOME_ISO_OK" ISO_PY="$AFTER_ONE" ISO_LOG="$LOG" ISO_SELFSHA="$SELF_SHA" \
"$NODE" -e '
const fs = require("fs"), crypto = require("crypto"), path = require("path"), env = process.env;
const yn = v => v === "1";
const h = crypto.createHash("sha256"); h.update(fs.readFileSync(env.ISO_APK));
let logLines = 0; try { logLines = fs.readFileSync(env.ISO_LOG, "utf8").split("\n").filter(Boolean).length; } catch {}
const report = {
  schema: 1, kind: "isolated", ok: !yn(env.ISO_FAIL), checkedAt: new Date().toISOString(),
  apk: path.resolve(env.ISO_APK), apkSha256: h.digest("hex"),
  checks: {
    pidOwned: yn(env.ISO_PIDOWN), rpc: yn(env.ISO_RPC), plugins: yn(env.ISO_PLUGINS),
    native: yn(env.ISO_NATIVE), pending: Number(env.ISO_PENDING), homeIsolated: yn(env.ISO_HOME) },
  plugins: ["session-rewind", "turn-notify", "auto-summary-policy"],
  evidence: {
    port: Number(env.ISO_PORT), httpStatus: Number(env.ISO_HTTP) || 0, payloadFiles: Number(env.ISO_FILES),
    linksCreated: Number(env.ISO_LINKS), pythonAfterLinks: env.ISO_PY, skillScript: yn(env.ISO_SKILL) ? "ok" : "failed",
    engineLog: env.ISO_LOG, engineLogLines: logLines },
  method: [
    "pidOwned=本脚本起的引擎进程 25 秒后仍存活（kill -0）",
    "rpc=用日志 token 换 cookie 后真跑一次 session/create 并核对回传 sessionId（零模型请求）",
    "native=python(ssl/sqlite3/zlib/…) 与 node 原生模块在按 LINKS.txt 建链接后导入成功",
    "pending=内核 package.json 的 dependencies 里，payload 中找不到的个数（要求 0）",
    "homeIsolated=DSH_HOME 指向隔离目录且是干净种子（无 settings.yaml、无 sessions）",
    "plugins=四个随包插件目录在包里 + pending=0 + 启动无失败标记；注意隔离引擎日志实测只有 1 行，",
    "  所以这是间接证据，不等于逐个探过插件的 HTTP 面（别把它读成后者）"].join("；"),
  tool: { script: "selfbuild/scripts/verify-dist-isolated.sh", sha256: env.ISO_SELFSHA || "" }
};
fs.writeFileSync(env.ISO_REPORT, JSON.stringify(report, null, 2) + "\n");
console.log("  报告已写出：" + env.ISO_REPORT);
' || bad "报告写出失败"

echo
[ $FAIL = 0 ] && echo "✅ 发行包隔离验证通过" || echo "⛔ 发行包隔离验证失败"
echo "   （隔离目录保留在 $ISO，排查用；确认后删）"
exit $FAIL
