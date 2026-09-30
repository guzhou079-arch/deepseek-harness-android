#!/system/bin/sh
# ============================================================================
# javac-app.sh —— 手机内 proot 跑通「App 侧 Java → classes.dex」（不装机）
#
#   把 v118/android-app/src 下的 10 个 App 类 + vscreen/3 个类，在 proot(Alpine
#   + OpenJDK 17) 里用 -source 1.8 -target 1.8 -bootclasspath /tc/android.jar
#   编译，再交给 d8 出 classes.dex。
#
#   一条命令：
#     sh selfbuild/scripts/javac-app.sh
#     sh selfbuild/scripts/javac-app.sh --rjava /path/to/R.java
#
#   R.java 选源优先级：
#     1) --rjava <path>                          显式指定
#     2) selfbuild/work/gen/com/deepseek/harness/R.java   （任务A 的 aapt 产物）
#     3) 自动生成临时占位 R.java（只含源码真正引用的字段，值全 0）
#   → 脚本会打印**实际用的是哪一份**与 sha256，交付必须跑成 (2)。
#
#   产物（都在 selfbuild/work/appbuild/out/ 下）：
#     out/classes/           javac 输出（*.class）
#     out/classes.rsp        d8 的 class 清单（含 AAR 里的 class）
#     out/dex/classes.dex    d8 输出
#     out/classes.dex        同上（拷贝一份，方便直接引用）
#     out/logs/*.log         javac / d8 日志
#     out/aar/*/classes.jar  从 3 个 .aar 解出的 classes.jar
#
#   约定/坑：
#     · proot 内只挂了 /sdcard、/host(=App files)、/tc(=toolchain)、/keys
#       → 仓库路径必须写成 /sdcard/...，android.jar=/tc/android.jar，d8.jar=/tc/d8.jar
#     · proot 的 PATH 已含 java-17-openjdk/bin
#     · mksh 不支持 process substitution；本机 grep 对中文会静默漏匹配 → 用 rg
#     · 本脚本不修改任何 .java 源码，不装包，不碰 payload
# ============================================================================
set -e

R="${DSH_PROJECT:-$(cd "$(dirname "$0")/../.." && pwd)}"
REPO=$R
SB=$REPO/selfbuild
SRC=$REPO/v118/android-app/src
LIBS=$REPO/v118/android-app/libs
HARNESS=$SRC/com/deepseek/harness
VSC=$HARNESS/vscreen
BUILD=$SB/work/appbuild/out
GEN_A=$SB/work/gen/com/deepseek/harness/R.java
RUN=/data/user/0/com.deepseek.harness/files/work/linux/run.sh
RG=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/rg
NODE=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node
INNER=$BUILD/inner-javac.sh

usage() {
  sed -n '3,30p' "$0"
}

RJAVA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rjava)   RJAVA="${2:-}"; shift 2 ;;
    --rjava=*) RJAVA="${1#--rjava=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ 未知参数：$1（可用：--rjava <path>）" >&2; exit 2 ;;
  esac
done

# ---- 基本检查 -------------------------------------------------------------
[ -f "$RUN" ] || { echo "✗ 找不到 proot 入口 $RUN" >&2; exit 1; }
[ -d "$HARNESS" ] || { echo "✗ 找不到源码目录 $HARNESS" >&2; exit 1; }
[ -d "$VSC" ] || { echo "✗ 找不到 vscreen 目录 $VSC" >&2; exit 1; }
[ -f "$LIBS/shizuku-api.aar" ] || { echo "✗ 缺少 $LIBS/shizuku-api.aar" >&2; exit 1; }

mkdir -p "$BUILD/logs" "$BUILD/aar" "$BUILD/classes" "$BUILD/dex"
# 清掉上一版「平铺布局」的残留（旧产物曾直接放在 work/appbuild/ 下，现统一收进 out/）
rm -rf "$SB/work/appbuild/classes" "$SB/work/appbuild/dex" \
       "$SB/work/appbuild/classes.rsp" "$SB/work/appbuild/classes.dex" \
       "$SB/work/appbuild/gen-temp" "$SB/work/appbuild/inner-javac.sh" \
       "$SB/work/appbuild/logs" "$SB/work/appbuild/aar" \
       "$SB/work/appbuild/rcheck.txt" 2>/dev/null || true

# 10 个 App 类 + vscreen/*.java（与 build.sh 的 javac 源列表一致）
# 同时准备两份路径：APP_SRCS=Android 视角（给本脚本检查/生成 R），APP_SRCS_P=proot 视角
APP_SRCS=""; APP_SRCS_P=""
for c in MainActivity EngineService AlarmReceiver ScheduleExecutor OverlayService \
         UsageStatsHelper AccessibilityService VsreenBridgeService LogShareProvider NfcStore BuildEnvInstaller; do
  [ -f "$HARNESS/$c.java" ] || { echo "✗ 缺少源码 $HARNESS/$c.java" >&2; exit 1; }
  APP_SRCS="$APP_SRCS $HARNESS/$c.java"
  APP_SRCS_P="$APP_SRCS_P $R/v118/android-app/src/com/deepseek/harness/$c.java"
done
VSC_SRCS=$(ls "$VSC"/*.java 2>/dev/null || true)
[ -n "$VSC_SRCS" ] || { echo "✗ $VSC 下没有 .java" >&2; exit 1; }

# ---- R.java 选源 ----------------------------------------------------------
R_MODE=""
if [ -n "$RJAVA" ]; then
  [ -f "$RJAVA" ] || { echo "✗ --rjava 指定的文件不存在：$RJAVA" >&2; exit 1; }
  R_MODE="参数 --rjava"
elif [ -f "$GEN_A" ]; then
  RJAVA="$GEN_A"
  R_MODE="任务A 的 aapt 产物"
else
  RJAVA="$BUILD/gen-temp/com/deepseek/harness/R.java"
  R_MODE="临时占位（只含源码引用的字段，值全 0）"
fi

# 实际引用的 R 字段（用 rg 提取；先把 android.R. 中和掉，否则 R.attr/R.id 会被误算进来）
extract_r_fields() {
  # $1 = 源文件列表（空格分隔）
  cat $1 2>/dev/null \
    | sed 's/android\.R\./ANDROID_PLATFORM_R_/g' \
    | "$RG" -o -N '\bR\.[a-z]+\.[A-Za-z0-9_]+' 2>/dev/null \
    | sort -u
}

if [ "$R_MODE" = "临时占位（只含源码引用的字段，值全 0）" ]; then
  FIELDS=$(extract_r_fields "$APP_SRCS $VSC_SRCS")
  if [ -z "$FIELDS" ]; then
    echo "✗ 没从源码提取到任何 R.* 引用，拒绝生成空 R.java" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$RJAVA")"
  {
    echo "// 临时占位 R.java —— 由 selfbuild/scripts/javac-app.sh 自动生成，只用于跑通编译链路。"
    echo "// 值全部是 0；正式交付请等 selfbuild/work/gen/com/deepseek/harness/R.java（aapt 产物）。"
    echo "package com.deepseek.harness;"
    echo
    echo "public final class R {"
    echo "    private R() {}"
    for t in $(echo "$FIELDS" | sed 's/^R\.\([a-z]*\)\..*/\1/' | sort -u); do
      echo "    public static final class $t {"
      echo "$FIELDS" | sed -n "s/^R\.$t\.//p" | while read -r f; do
        [ -n "$f" ] && echo "        public static final int $f = 0;"
      done
      echo "    }"
    done
    echo "}"
  } > "$RJAVA"
  echo "== 临时 R.java 已生成：$RJAVA（$(echo "$FIELDS" | wc -l) 个字段）"
fi

[ -f "$RJAVA" ] || { echo "✗ R.java 不可用：$RJAVA" >&2; exit 1; }

# ---- 路径转 proot 视角（/storage/emulated/0 → /sdcard） --------------------
p2() { echo "$1" | sed 's#^/storage/emulated/0#/sdcard#'; }
SRC_P=$(p2 "$HARNESS"); VSC_P=$(p2 "$VSC"); LIBS_P=$(p2 "$LIBS")
BUILD_P=$(p2 "$BUILD"); RJAVA_P=$(p2 "$RJAVA")
INNER_P=$(p2 "$INNER")

echo "============================================================"
echo " javac-app.sh —— App 侧 Java → classes.dex（proot + JDK17 + d8）"
echo "  源码目录 : $SRC_P   (proot 视角)"
echo "  R.java   : $RJAVA_P"
echo "  来源     : $R_MODE"
echo "  产物目录 : $BUILD_P"
echo "============================================================"
echo "R.java sha256: $(sha256sum "$RJAVA" | cut -d' ' -f1)"

# ---- 生成 proot 内执行的脚本 ---------------------------------------------
# 用 quoted heredoc：内部 $ 不展开，路径全部由参数传入，避免嵌套引号地狱。
cat > "$INNER" <<'INNER_EOF'
#!/bin/sh
# 由 selfbuild/scripts/javac-app.sh 生成，只在 proot(Alpine) 内执行。
# 参数：$1=harness 源码目录 $2=vscreen 目录 $3=libs 目录 $4=build 目录
#       $5=android.jar $6=d8.jar $7=R.java $8=jar 源列表(空格分隔, 绝对路径)
set -e
SRCD="$1"; VSCD="$2"; LIBSD="$3"; BUILD="$4"; AJ="$5"; D8JAR="$6"; RJAVA="$7"
shift 7
APP_SRCS="$*"

echo "[proot] javac $(javac -version 2>&1)"
echo "[proot] 源文件数: $(echo $APP_SRCS | wc -w) + vscreen $(ls $VSCD/*.java | wc -l) + R.java"

# ---- 0) 解 3 个 AAR 的 classes.jar（既进 javac classpath，也进 d8） --------
AARDIR="$BUILD/aar"; CLSDIR="$BUILD/shizuku-cls"
rm -rf "$AARDIR" "$CLSDIR"; mkdir -p "$AARDIR" "$CLSDIR"
for a in shizuku-api shizuku-provider shizuku-aidl; do
  mkdir -p "$AARDIR/$a"
  ( cd "$AARDIR/$a" && jar xf "$LIBSD/$a.aar" classes.jar )
  ( cd "$CLSDIR"    && jar xf "$AARDIR/$a/classes.jar" )
done
NSHIZUKU=$(find "$CLSDIR" -name '*.class' | wc -l)
echo "[proot] shizuku class 数: $NSHIZUKU"

# ---- 1) javac -------------------------------------------------------------
GEN_CP=$(dirname "$(dirname "$(dirname "$RJAVA")")")
CP="$GEN_CP:$AARDIR/shizuku-api/classes.jar:$AARDIR/shizuku-provider/classes.jar:$AARDIR/shizuku-aidl/classes.jar"
rm -rf "$BUILD/classes"; mkdir -p "$BUILD/classes"
javac -encoding UTF-8 -source 1.8 -target 1.8 -bootclasspath "$AJ" \
  -classpath "$CP" -d "$BUILD/classes" \
  $APP_SRCS "$VSCD"/*.java "$RJAVA" \
  > "$BUILD/logs/javac.log" 2>&1 || {
    echo "!! javac 失败，日志尾部："; tail -40 "$BUILD/logs/javac.log"; exit 1;
  }
# 过滤掉无害噪音（bootstrap/Note/deprecat），其余 warning 照打
if [ -s "$BUILD/logs/javac.log" ]; then
  grep -v "bootstrap class path\|^Note:\|deprecat\|RestrictTo\|unchecked\|Recompile" \
    "$BUILD/logs/javac.log" || true
fi
NCLASS=$(find "$BUILD/classes" -name '*.class' | wc -l)
echo "[proot] javac class 数: $NCLASS"
[ "$NCLASS" -gt 0 ] || { echo "!! javac 产物为空"; exit 1; }

# ---- 2) classes.rsp（含 AAR 里的 class） ----------------------------------
RSP="$BUILD/classes.rsp"
{ find "$BUILD/classes" -name '*.class'; find "$CLSDIR" -name '*.class'; } > "$RSP"
echo "[proot] classes.rsp 行数: $(wc -l < "$RSP")"

# ---- 3) d8 ----------------------------------------------------------------
rm -rf "$BUILD/dex"; mkdir -p "$BUILD/dex"
java -cp "$D8JAR" com.android.tools.r8.D8 --release --lib "$AJ" --min-api 24 \
  --output "$BUILD/dex" "@$RSP" > "$BUILD/logs/d8.log" 2>&1 || {
    echo "!! d8 失败，日志尾部："; tail -40 "$BUILD/logs/d8.log"; exit 1;
  }
[ -s "$BUILD/logs/d8.log" ] && grep -v "^Warning\|^Info" "$BUILD/logs/d8.log" || true
[ -f "$BUILD/dex/classes.dex" ] || { echo "!! d8 没产出 classes.dex"; exit 1; }
cp "$BUILD/dex/classes.dex" "$BUILD/classes.dex"
echo "[proot] classes.dex: $(stat -c%s "$BUILD/dex/classes.dex") bytes"
INNER_EOF

# ---- 跑 proot -------------------------------------------------------------
sh "$RUN" sh "$INNER_P" "$SRC_P" "$VSC_P" "$LIBS_P" "$BUILD_P" \
  /tc/android.jar /tc/d8.jar "$RJAVA_P" $APP_SRCS_P

# ---- 统计（在 Android 侧做，便于直接看到真实字节数） ----------------------
NCLASS=$(find "$BUILD/classes" -name '*.class' | wc -l)
DEX=$BUILD/classes.dex
DSIZE=$(stat -c%s "$DEX")
echo "------------------------------------------------------------"
echo "✓ 编译完成"
echo "  R.java      : $RJAVA  （$R_MODE）"
echo "  R.java sha256: $(sha256sum "$RJAVA" | cut -d' ' -f1)"
echo "  class 数     : $NCLASS   [find $BUILD/classes -name '*.class' | wc -l]"
echo "  classes.rsp  : $(wc -l < "$BUILD/classes.rsp") 行（含 AAR 的 class）"
echo "  classes.dex  : $DSIZE bytes  ($DEX)"
echo "  副本         : $BUILD/dex/classes.dex ($(stat -c%s "$BUILD/dex/classes.dex") bytes)"

for sym in MainActivity AccessibilityService VsreenBridgeService NfcStore; do
  if "$RG" -a -q "$sym" "$DEX" 2>/dev/null; then
    echo "  dex 命中 $sym : ✓"
  else
    echo "  dex 命中 $sym : ✗"; FAIL=1
  fi
done

[ "$NCLASS" -ge 90 ] || { echo "✗ class 数 $NCLASS < 90"; exit 1; }
[ -n "${FAIL:-}" ] && { echo "✗ classes.dex 缺少关键类"; exit 1; }

# ---- dex 深度自检：header 一致性 + R 资源 ID 是否真的写进了 dex -------------
if [ -x "$NODE" ]; then
  DEXCHECK=$BUILD/logs/dexcheck.js
  cat > "$DEXCHECK" <<'JS_EOF'
const fs = require("fs");
const p = process.argv[2];
const b = fs.readFileSync(p);
let bad = 0;
const magic = b.slice(0, 4).toString("latin1");
const fileSize = b.readUInt32LE(32);
console.log("  dex 魔数        : " + JSON.stringify(b.slice(0,8).toString("latin1")));
console.log("  header 声明大小 : " + fileSize + " / 实际 " + b.length +
            (fileSize === b.length ? "  ✓" : "  ✗ 不一致"));
if (magic !== "dex\n" || fileSize !== b.length) bad = 1;
console.log("  string/type/method/class_defs : " +
  b.readUInt32LE(56) + "/" + b.readUInt32LE(64) + "/" + b.readUInt32LE(88) + "/" + b.readUInt32LE(96));
const ids = process.argv.slice(3);
if (ids.length) {
  let hit = 0; const miss = [];
  for (const s of ids) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(parseInt(s, 16) >>> 0, 0);
    if (b.includes(buf)) hit++; else miss.push(s);
  }
  console.log("  R 资源 ID 写入 dex : " + hit + "/" + ids.length + (miss.length ? "  ✗ 未命中 " + miss.join(",") : "  ✓"));
  if (hit !== ids.length) bad = 1;
} else {
  console.log("  R 资源 ID 写入 dex : (R.java 里没有 0x7F 常量，跳过——通常说明用的是临时占位 R.java)");
}
process.exit(bad);
JS_EOF
  RIDS=$("$RG" -o '0x7F[0-9A-Fa-f]{6}' "$RJAVA" | sort -u)
  "$NODE" "$DEXCHECK" "$DEX" $RIDS || { echo "✗ dex 自检未通过"; exit 1; }
else
  echo "  (未找到 node，跳过 dex 深度自检)"
fi

echo "✓ 交付：$DEX  （R.java 来源：$R_MODE）"
exit 0
