#!/system/bin/sh
# ============================================================================
# DSH Android 自构建（selfbuild）—— 改自己，不需要电脑/构建机
#
#   全部零件都在手机上：
#     · proot + Alpine 3.20 + OpenJDK 17   → files/work/linux/run.sh
#     · android.jar / d8.jar / apksigner.jar → files/toolchain/
#     · pkcs12.keystore（v2+v3 签名）        → files/keys/
#     · payload 重打包                       → selfbuild/lib/{ziptool,selfbuild}.js
#
#   最小闭环：复用装机 APK 的骨架（资源/清单/dex 原样搬运），只替换
#   assets/payload.zip 里的引擎侧文件 → 重新签名 → 装机。
#   资源不改 → 不需要 aapt2；payload 是 STORE → 不需要重压缩 2 万个文件。
#
# 用法：
#   sh selfbuild.sh base                 # 取装机 APK 作为骨架（需可读）
#   sh selfbuild.sh payload              # 从骨架导出 assets/payload.zip
#   sh selfbuild.sh patch                # 用 build-overlay/ 覆盖 payload
#   sh selfbuild.sh pack                 # 骨架 + 新 payload → 未签名 APK
#   sh selfbuild.sh mark                 # 写 dshroot 标记（内核版本+revision，触发 App 全量解压）
#   sh selfbuild.sh version              # 版本号从 selfbuild/VERSION 读，code 自动取本机最大 +1
#   sh selfbuild.sh version 1.21         # 只允许与 VERSION 一致的名字（防飘号）；code 同样自动
#   sh selfbuild.sh sign                 # apksigner 签名 → out/
#   sh selfbuild.sh verify               # 指纹 + payload 一致性 + patch-check
#   sh selfbuild.sh install              # 经 App 内嵌特权桥 pm install -r
#   sh selfbuild.sh all                  # payload→patch→pack→sign→verify（不装机）
#   sh selfbuild.sh check                # 只跑装机副本的补丁完整性校验
# ============================================================================
set -e

R="${DSH_PROJECT:-$(cd "$(dirname "$0")/.." && pwd)}"
SB="$R/selfbuild"
WORK=$SB/work
OUT=$SB/out
NODE=/data/user/0/com.deepseek.harness/files/.bin/node
CURL=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/curl
RUN=/data/user/0/com.deepseek.harness/files/work/linux/run.sh
PY=/data/user/0/com.deepseek.harness/files/payload/bin/python3
TC=/data/user/0/com.deepseek.harness/files/toolchain
KEYS=/data/user/0/com.deepseek.harness/files/keys
PAYLOAD_DIR=/data/user/0/com.deepseek.harness/files/payload
# 底包的路径与 sha256 只在 lib/base-apk.js 里声明一处（以前这里默认 175、发行动用 295，
# 于是 `selfbuild.sh base` 刷新的是 175，出了包却用 295 那份 —— 换了骨架等于没换，产物上也看不出来）。
BASE=${DSH_BASE:-$("$NODE" "$SB/lib/base-apk.js" --path)}
export LD_LIBRARY_PATH="/data/user/0/com.deepseek.harness/files/payload/runtime/lib:${LD_LIBRARY_PATH:-}"
# 换内核后底本不再是 1.38 的 payload-old.zip；用 DSH_PAY_OLD 指到新内核底本（默认仍是老的）
PAY_OLD=${DSH_PAY_OLD:-$WORK/payload-old.zip}
PAY_NEW=$WORK/payload-new.zip

# ── 背景图 CSS：**唯一源**是 ../bg-patch/dsh-bg.css ──────────────────────
# ⚠️ 但出包实际用的是 build-overlay 里那份**副本**。两份不同步 = 改了源却没生效
#    （2026-10-01 真踩到：源码改好了、v1.29 包里却还是旧遮罩值，白打一版）。
#    这是"本地改动 vs 构建用副本"这一类坑的第三次，所以不再靠人记 ——
#    脚本一启动就同步，之后没有"哪份才算数"的问题。
BG_SRC="$R/bg-patch/dsh-bg.css"
BG_DST="$SB/build-overlay/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-bg.css"
# ⚠️ make-dist-apk.sh 会**先**改 overlay 的 CSS（换 SVG + 换发行遮罩值）**再**调本脚本，
#    所以那条路径下必须跳过自动同步，否则会把它刚改好的覆盖回去 —— 2026-10-01 真踩到，
#    打出来的包背景图变成了个人壁纸（而壁纸文件已被移走 → 用户那边是坏的）。
if [ -z "${DSH_SKIP_BG_SYNC:-}" ] && [ -f "$BG_SRC" ]; then
  mkdir -p "$(dirname "$BG_DST")"
  if ! cmp -s "$BG_SRC" "$BG_DST"; then
    cp "$BG_SRC" "$BG_DST"
    echo "  ↻ 背景 CSS 已从 bg-patch/ 同步到 build-overlay/（原本两份不一致）"
  fi
fi
UNSIGNED=$WORK/unsigned.apk
mkdir -p "$WORK" "$OUT"

CMD="$1"; shift 2>/dev/null || true

case "$CMD" in
base)
  APK=$(pm path com.deepseek.harness 2>/dev/null | sed -n 's/^package://p' | head -1)
  [ -n "$APK" ] || { echo "✗ 取不到装机 APK 路径（需要 Shizuku/root：pm path）"; exit 1; }
  cp "$APK" "$BASE" && chmod 644 "$BASE"
  echo "✓ 骨架 = $BASE ($(stat -c%s "$BASE") 字节)"
  ;;
payload)
  [ -f "$BASE" ] || { echo "✗ 没有骨架，先跑 base（或手动放 $BASE）"; exit 1; }
  # 默认底包必须与声明一致：同名不同内容的包换进来，产物看起来可能一模一样，事后无法反推。
  if [ -z "${DSH_BASE:-}" ]; then
    "$NODE" "$SB/lib/base-apk.js" --verify || { echo '✗ 默认底包校验失败（见上）；要用别的底包请显式设 DSH_BASE'; exit 1; }
  fi
  "$NODE" "$SB/lib/selfbuild.js" payload-extract "$BASE" "$PAY_OLD"
  ;;
patch)
  [ -f "$PAY_OLD" ] || { echo "✗ 先跑 payload"; exit 1; }
  # 2026-10-17：REVISION 改成「本次构建号」，并在 overlay 应用前写入。
  # 原来 payload.zip 里的 dshroot/REVISION 是内核投放日期（20260929…），同内核重出包时
  # 与设备上的值**完全一致** → dshrootRevisionChanged() 恒 false → dshroot 同步根本不跑。
  # 后果实测：本版新加进 overlay 的 dsh-host-webserver 补丁没落到设备，用户一开局域网引擎仍死。
  REV_STAMP="$(date +%Y%m%d%H%M%S)"
  printf '%s\n' "$REV_STAMP" > "$SB/build-overlay/dshroot/REVISION"
  # overlay 改过的文件清单：随包发 assets/dshroot_forced.txt，MainActivity 据此强制覆盖。
  # 没有它，即使同步跑了，fast/add 也只写 REVISION + 免检前缀，改过的旧文件永远不更新。
  mkdir -p "$WORK"
  # 归一化：overlay 里既有 lib/... 也有 dshroot/... 两种布局，统一成 payload 内的 dshroot/... 路径
  # 2026-10-27：清单来源补上 build-overlay/dshroot（真正的出包输入）。旧实现只扫
  # v118/dsh-patches/overlay（30 条历史补丁，部分路径在 payload 里早已不存在）——
  # build-overlay 里的内核文件改得再对，设备上 fast 同步也不会覆盖，新包等于白打。
  # 两个来源取并集，重复由 sort -u 收敛。
  # 2026-11-07：find 必须过滤开发备份。v1.48 包里 assets/dshroot_forced.txt 曾列进
  # client.js.bak-0.2.1rc5-20261106 / dsh-bg.css.bak-hashdrift-20261106 —— 就是这两行 find
  # 不过滤带出来的（payload-patch 的 walk 会滤，但 forced 清单走的是 find，不是 walk）。
  # 跳过集**唯一真相是 lib/overlay-skip.js**：这里的 find 参数由它生成，与 payload-patch 的
  # walk 同源。以前各写一份名单，find 挡 .DS_Store/~/.orig/.rej 而 walk 挡 .md5/.sha256，
  # 往 overlay 放个 .md5 就会出现「进包了但清单不知道」——两份规则必然漂移，所以合并。
  SKIP_ARGS=$("$NODE" -e 'process.stdout.write(require(process.argv[1]).findArgs().join(" "))' "$SB/lib/overlay-skip.js")
  ovl_find() {
    # shellcheck disable=SC2086  # 这里就要分词成 ! -name x 若干组
    find "$1" -type f $SKIP_ARGS
  }
  ( cd "$SB/build-overlay" && ovl_find dshroot | sed 's|^dshroot/||' ) > "$WORK/forced-a.txt"
  ( cd "$SB/../v118/dsh-patches/overlay" && ovl_find . | sed 's|^\./||; s|^dshroot/||' ) > "$WORK/forced-b.txt"
  cat "$WORK/forced-a.txt" "$WORK/forced-b.txt" | sed '/^$/d' | sed 's|^|dshroot/|' | sort -u > "$WORK/dshroot_forced.txt"
  rm -f "$WORK/forced-a.txt" "$WORK/forced-b.txt"
  echo "  REVISION(构建号)=$REV_STAMP；overlay 强制清单 $(wc -l < "$WORK/dshroot_forced.txt") 条"
  # DSH_FORCED_LIST：让 payload-patch 自己对账「动的条目是否都在 forced 清单里」。
  # 缺一条就说明设备端开机不会强刷它 —— 包内是新的、手机上是旧的，症状是「改了没生效」。
  DSH_FORCED_LIST="$WORK/dshroot_forced.txt" "$NODE" "$SB/lib/selfbuild.js" payload-patch "$PAY_OLD" "$PAY_NEW" "$SB/build-overlay"

  # ⚠️ 门禁：背景图注入必须真在**随包发出去的那份 payload** 里。
  #    背景图靠 open-in-app/lib/client.js 里的一段本地注入才会被加载（/dsh-bg.css?rev=）；
  #    而这段代码历史上只存在于骨架 APK 的那份文件里，overlay 里那份是"上游干净版"——
  #    overlay 一覆盖注入就没了，装上去背景图完全不显示（v1.27 发布版就是这么坏的）。
  #    所以判据是**结果**：payload 里那条条目里必须有注入。
  #    overlay 若还留着这个文件，也必须有注入 —— 那种情况它会在 patch 阶段盖掉好版本，
  #    正是事故的形状；两处都拦，缺一处都不算验过。
  BG_ENTRY="dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js"
  BG_OVL="$SB/build-overlay/$BG_ENTRY"
  BG_ZIP_OK=0
  "$NODE" "$SB/scripts/check-bg-injection.js" --zip "$PAY_NEW" --entry "$BG_ENTRY" && BG_ZIP_OK=1
  if [ -f "$BG_OVL" ]; then
    "$NODE" "$SB/scripts/check-bg-injection.js" "$BG_OVL" || {
      echo "✗ overlay 里那份 $BG_ENTRY 没有背景图注入。它会在 patch 阶段覆盖掉带注入的版本，"
      echo "  装上去背景图不显示（v1.27 事故）。要么从 overlay 删掉这个文件（底包那份是对的），"
      echo "  要么把它换成带注入的版本。"
      exit 1
    }
  fi
  if [ "$BG_ZIP_OK" != 1 ]; then
    echo "✗ 背景图注入整体丢失，不是覆盖问题："
    echo "  底包 295 里那条 $BG_ENTRY（61,189 B）是带注入的，现在包里也没有、overlay 里也没有，"
    echo "  说明这条文件整个没进 payload（或进的是别处的干净版本）→ 装上去背景图不会加载。"
    echo "  修：确认底包是 base-current-295.apk，且 overlay 没有同名文件把它盖掉。"
    exit 1
  fi

  # 内核基线（2026-11-07）：包里的内核字节必须等于「底包 + overlay」推出来的字节。
  # 判据是**推导**出来的，不是上一份已发货包，也不是手写 md5 清单：
  #   拿已发货包当基线 → 上次的错会被继承（底包 295 自己就是脏的）；
  #   拿 checks.manifest 的 md5 当基线 → 那份 md5 是 patch-check.sh --regen 从手机运行树刷的，
  #   改一次 overlay 就必红，红得没有意义。期望值能推导，这道闸门才可能常绿。
  # overlay 里有就取 overlay、没有就取底包 —— 这正好是 patch 的定义。
  # 关键字判定（补丁语义还在不在）留在 verify 阶段做，这里只管字节。
  "$NODE" "$SB/scripts/check-kernel-baseline.js" --payload "$PAY_NEW" --base-payload "$PAY_OLD" --overlay "$SB/build-overlay" || exit 1
  ;;
pack)
  # 用法: pack [--dex <classes.dex>] [--asset <本地文件>:<APK 内条目名>]...
  #   --asset：替换独立的 asset（如虚拟屏核心 assets/vscreen_shizuku.jar）。
  #   没有它的话，改这类 asset 的源码再 pack 也进不去包（v143 差点白装）。
  DEX=""; ASSETS=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dex)   DEX="$2"; shift 2 || exit 1;;
      --asset) ASSETS="$ASSETS --asset $2"; shift 2 || exit 1;;
      *) shift;;
    esac
  done
  if [ -f "$PAY_NEW" ]; then PAY=$PAY_NEW; else PAY=-; fi
  if [ -f "$WORK/dshroot_forced.txt" ]; then
    ASSETS="$ASSETS --asset $WORK/dshroot_forced.txt:assets/dshroot_forced.txt"
  fi
  [ "$PAY" = "-" ] && [ -z "$DEX" ] && [ -z "$ASSETS" ] && { echo "✗ 既没有 payload-new.zip 也没有 --dex/--asset"; exit 1; }
  [ -n "$DEX" ] && { [ -f "$DEX" ] || { echo "✗ 找不到 dex: $DEX"; exit 1; }; echo "  换 dex: $DEX"; }
  if [ -n "$DEX" ]; then
    "$NODE" "$SB/lib/selfbuild.js" apk-pack "$BASE" "$PAY" "$UNSIGNED" --dex "$DEX" --asset-receipt "$WORK/packed-assets.json" $ASSETS
  else
    "$NODE" "$SB/lib/selfbuild.js" apk-pack "$BASE" "$PAY" "$UNSIGNED" --asset-receipt "$WORK/packed-assets.json" $ASSETS
  fi
  ;;
mark)
  # 问题②的修复：App 只有「内核版本变化或 .complete 缺失」才全量解压；
  # 不写对这两个标记，新内核装上去只会走快速同步 → 树被撕成两半。
  #
  # 2026-10-12：改用 selfbuild.js 的 apk-marks（走 ziptool 原样搬运，只换这两个条目的字节）。
  # 旧实现 `set-apk-markers.py` 用 Python zipfile **整体重写 APK**：
  #   ① 骨架 resources.arsc 的 CRC 与中央目录不符（线上包也如此）→ Python 强校验 CRC 直接抛异常
  #      → 标记一个都没写、退出 1；
  #   ② 整体重写会丢 zipalign 对齐。
  # 而调用处又被 `| tail` 吃掉退出码 ⇒ **长期静默失败**（2026-10-10 查实）。这里显式 `|| exit 1`。
  [ -f "$UNSIGNED" ] || { echo "✗ 先跑 pack"; exit 1; }
  DSH_WORK="$WORK" "$NODE" "$SB/lib/selfbuild.js" apk-marks "$UNSIGNED" "$WORK/unsigned-marked.apk" || exit 1
  mv "$WORK/unsigned-marked.apk" "$UNSIGNED"
  ;;
version)
  # 改 APK 内 AndroidManifest.xml 的 versionName / versionCode（二进制直接改，不需要 aapt2）
  #
  # 为什么必须有这一步：selfbuild.sh 的骨架复用策略会把清单原样搬走，
  # 于是每个新包的 versionName 都还是骨架的值 → App 的 checkForUpdate
  # （MainActivity:924，拿 GitHub release tag 比本机 versionName）永远认为「已是最新」
  # → 别人收不到更新提示，只能靠人手传包。
  #
  # 用法: sh selfbuild.sh version [版本号] [versionCode]   —— 两个参数都可以不给
  #
  # 版本号只有一处真相：selfbuild/VERSION 第一行。这里是唯一把它写进 APK 的地方。
  #   无参        → VERSION 的名字 + 本机已出的最大 versionCode + 1
  #   给了名字    → 必须与 VERSION 一致（不然就是又一次「飘号」）
  #   给了 code   → 必须严格大于本机最大值（撞号/倒退直接停）
  [ -f "$UNSIGNED" ] || { echo "✗ 先跑 pack"; exit 1; }
  NAMEARG=""; CODEARG=""
  [ -z "${1:-}" ] || NAMEARG="--name $1"
  [ -z "${2:-}" ] || CODEARG="--code $2"
  PLAN=$("$NODE" "$SB/scripts/version-check.js" --plan $NAMEARG $CODEARG) || exit 1
  VN=$(echo "$PLAN" | sed -n 's/^name=//p')
  VC=$(echo "$PLAN" | sed -n 's/^code=//p')
  [ -n "$VN" ] && [ -n "$VC" ] || { echo "✗ 版本计划解析失败：$PLAN"; exit 1; }
  #      ⚠️ --share-target 不能省：它除了写 launchMode=singleTop，还会补上
  #         SEND / SEND_MULTIPLE 两条分享过滤器（见 lib/android-manifest.js 的
  #         patchManifest + hasShareTarget 回读）。发行流程 make-dist-apk.sh 一直带着它，
  #         而这条装机流程此前漏了 → 自建包里"分享到 DSH"是死的，本地闸门全绿也发现不了
  #         （2026-10-15 查实）。verify 里现在有 check-install-manifest.js 兜底。
  "$NODE" "$SB/scripts/set-apk-version.js" "$UNSIGNED" "$WORK/unsigned-v.apk" --name "$VN" --code "$VC" --share-target com.deepseek.harness.MainActivity
  mv "$WORK/unsigned-v.apk" "$UNSIGNED"
  ;;
sign)
  [ -f "$UNSIGNED" ] || { echo "✗ 先跑 pack"; exit 1; }
  TS=$(date +%Y%m%d-%H%M%S)
  APKOUT=$OUT/DeepSeekHarness-selfbuild-$TS.apk
  # proot 里只挂了 /sdcard（=$F 挂 /host、toolchain 挂 /tc、keys 挂 /keys）
  POUT=$(echo "$APKOUT"   | sed 's#^/storage/emulated/0#/sdcard#')
  PIN=$(echo "$UNSIGNED"  | sed 's#^/storage/emulated/0#/sdcard#')
  sh "$RUN" java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool sign \
    --ks /keys/pkcs12.keystore --ks-pass pass:android \
    --ks-key-alias androidkey --key-pass pass:android \
    --out "$POUT" "$PIN"
  echo "✓ 已签名: $APKOUT ($(stat -c%s "$APKOUT") 字节)"
  echo "$APKOUT" > "$WORK/last-apk.txt"
  ;;
verify)
  APK=$(cat "$WORK/last-apk.txt" 2>/dev/null || true)
  [ -f "$APK" ] || { echo '✗ 需要明确的已签名 last-apk.txt 产物'; exit 1; }
  echo '— 必须通过真实签名验证 —'
  sh "$RUN" java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool verify --verbose --print-certs "$APK"
  echo '— 包内 payload 必须等于「底包 + overlay」推出来的那份 —'
  "$NODE" "$SB/lib/selfbuild.js" payload-extract "$APK" "$WORK/payload-check.zip" >/dev/null
  # 2026-11-07 整改：原来这里是「拿 checks.manifest 的 md5 当闸门」，而那份 md5 是
  # patch-check.sh --regen 从**手机运行时树**刷出来的 —— 判据的来源和被测对象不是同一个东西：
  # 改 overlay → 打包 → 拿手机上的旧内容当期望 → 必红；想绿只能先装机再 regen，
  # 可那时验的又是已经装上的那份。改成两件事分开问：
  #   · 包对不对：字节必须等于「底包 + overlay」推导值（红就 exit 1）
  #   · 手机上被改过什么：只出漂移报告，不参与判定
  # checks.manifest 的关键字列还留着 —— 但只判「补丁语义还在不在」，不再认它的 md5；
  # 而且分两类报：本次打包丢的（红） vs 基线里就没有的（⚠ 基线缺口，补丁在更早换代时丢了）。
  # 注：strip 是 make-dist-apk.sh 里的事；将来若对 dist 包跑 verify，被 strip 摘掉的条目会判「丢了」，
  #     届时按 strip 清单加豁免，别为此放宽这道闸门。
  KB_ARGS="--payload $WORK/payload-check.zip --overlay $SB/build-overlay --keywords $SB/checks.manifest"
  if [ -f "$BASE" ]; then
    KB_ARGS="$KB_ARGS --base $BASE"
  elif [ -f "$PAY_OLD" ]; then
    KB_ARGS="$KB_ARGS --base-payload $PAY_OLD"
  else
    echo "✗ 内核基线没有判据：底包 APK（$BASE）和底包 payload（$PAY_OLD）都不在"
    rm -f "$WORK/payload-check.zip"
    exit 1
  fi
  LIVE_TREE=${DSH_LIVE_PAYLOAD:-/data/user/0/com.deepseek.harness/files/payload}
  if [ -d "$LIVE_TREE" ]; then KB_ARGS="$KB_ARGS --drift $LIVE_TREE"; fi
  set +e
  # shellcheck disable=SC2086  # KB_ARGS 要分词成若干组 --k v
  "$NODE" "$SB/scripts/check-kernel-baseline.js" $KB_ARGS
  CHK=$?
  set -e
  [ "$(realpath "$WORK/payload-check.zip")" = "$(realpath "$WORK")/payload-check.zip" ] || exit 1
  rm -f "$WORK/payload-check.zip"
  [ "$CHK" -eq 0 ] || exit 1
  echo '— 二进制 manifest 回读 —'
  "$NODE" "$SB/scripts/set-apk-version.js" "$APK" --dump
  # 光 dump 不算闸门：分享过滤器/singleTop/降级 versionCode 都要显式判定（2026-10-15 补）
  MCHK=""
  if [ -f "$BASE" ]; then MCHK="--base $BASE"; fi
  "$NODE" "$SB/scripts/check-install-manifest.js" "$APK" $MCHK
  # 关键 asset 闸门：2026-10-18 手搓 pack 命令漏了 --asset .../splash/boot.html，
  #   开机动画静默消失（Java 读不到就退回原生启动页），上面这些闸门全绿也看不出来。
  echo '— 关键 asset 必须真的在包里 —'
  if [ -f "$SB/required-assets.list" ]; then
    while IFS='|' read -r AN AMIN; do
      case "$AN" in ''|'#'*) continue;; esac
      ASZ=$(unzip -l "$APK" "$AN" 2>/dev/null | awk -v n="$AN" '$4==n {print $1}' | head -1)
      [ -n "$ASZ" ] || { echo "✗ 包里缺 asset: $AN"; exit 1; }
      [ "$ASZ" -ge "${AMIN:-1}" ] || { echo "✗ asset 太小: $AN ($ASZ < $AMIN)"; exit 1; }
      echo "  ✓ $AN ($ASZ B)"
    done < "$SB/required-assets.list"
  fi
  echo '— pack 输入 asset 与最终 APK 必须逐字节一致 —'
  "$NODE" "$SB/scripts/release-receipts.mjs" assets-check --apk "$APK" --assets "$WORK/packed-assets.json"
  if [ -f "$WORK/appbuild/out/compile-receipt.json" ]; then
    "$NODE" "$SB/scripts/release-receipts.mjs" compile-check --receipt "$WORK/appbuild/out/compile-receipt.json"
    "$NODE" "$SB/lib/selfbuild.js" dex-extract "$APK" "$WORK/check-classes.dex"
    cmp "$WORK/check-classes.dex" "$WORK/appbuild/out/classes.dex" || { echo '✗ APK dex 与内容哈希编译产物不同'; exit 1; }
  else echo '✗ 无编译输入收据，无法证明源码与 dex 关联'; exit 1
  fi
  ;;
check)
  sh "$SB/patch-check.sh"
  ;;
install)
  APK=$(cat "$WORK/last-apk.txt" 2>/dev/null || true)
  [ -f "$APK" ] || { echo "✗ 先 sign"; exit 1; }
  sh "$SB/install-apk.sh" "$APK"
  ;;
all)
  # 这条路**不传 --dex**：Java 改过时包里还是骨架的旧 dex，verify 的 cmp 必然失败。
  # 故意不改它的语义（免得悄悄把未发布的 Java 带进包），只把坑喊出来。
  echo '⚠️  all 不带 --dex；Java 改过就必须走 pack --dex 序列（见 notes/java-selfbuild-runbook.md）'
  sh "$SB/selfbuild.sh" payload
  sh "$SB/selfbuild.sh" patch
  sh "$SB/selfbuild.sh" pack
  sh "$SB/selfbuild.sh" mark
  # 2026-11-07：这一步原来在这个序列里根本没有 —— payload/patch/pack/mark/sign 每步都返回 0，
  #   签出来的包里清单还是骨架的 1.51.1/281。App 的 checkForUpdate 拿 GitHub tag 比本机
  #   versionName，于是装了自建包的人永远认为「已是最新」，收不到任何更新提示。
  PLAN=$("$NODE" "$SB/scripts/version-check.js" --plan) || { echo "✗ 版本闸门未通过"; exit 1; }
  VN=$(printf '%s\n' "$PLAN" | sed -n 's/^name=//p')
  VC=$(printf '%s\n' "$PLAN" | sed -n 's/^code=//p')
  [ -n "$VN" ] && [ -n "$VC" ] || { echo "✗ 版本计划解析失败：$PLAN"; exit 1; }
  echo "— 写入版本 $VN($VC)"
  sh "$SB/selfbuild.sh" version "$VN" "$VC"
  sh "$SB/selfbuild.sh" sign
  # 补步骤还不够：步骤会被人删、会被参数绕过，所以读回签名包自己判一次。
  #   这一行是断言不是流程 —— 包里的号不等于声明的号就 exit 1，宁可不往下走。
  "$NODE" "$SB/scripts/assert-apk-version.js" "$(cat "$WORK/last-apk.txt")" --name "$VN" --code "$VC" || exit 1
  sh "$SB/selfbuild.sh" verify
  ;;
*)
  sed -n '2,30p' "$SB/selfbuild.sh"
  ;;
esac
