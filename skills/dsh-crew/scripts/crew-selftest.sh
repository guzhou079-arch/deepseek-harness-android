#!/system/bin/sh
# crew-selftest.sh —— 班组工具的回归自测：不碰真实名册，全在临时目录里跑
# 用法：sh tools/crew-selftest.sh
# 退出码 0 = 全过；任一断言失败即退出 1 并打印现场。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CREW="$HERE/crew.js"
WEEKLY="$HERE/weekly.js"
TMP="$(dirname "$HERE")/tmp/crew-selftest.$$"
export DSH_CREW_DIR="$TMP"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; echo "    → $2"; }
must() { # must <描述> <期望子串> <命令...>
  desc="$1"; want="$2"; shift 2
  got="$("$@" 2>&1)"
  case "$got" in
    *"$want"*) ok "$desc" ;;
    *) bad "$desc" "期望含「$want」，实际：$(echo "$got" | head -3)" ;;
  esac
}

trap 'rm -rf "$TMP"' EXIT
rm -rf "$TMP"

echo "1) 建档与校验"
must "建 alpha" "建好了 alpha" node "$CREW" new alpha --role "测试甲"
must "建 beta"  "建好了 beta"  node "$CREW" new beta  --role "测试乙" --model cheap
must "check 报出空岗位卡" "岗位卡还空着" node "$CREW" check alpha
must "list 有两个成员" "alpha" node "$CREW" list

echo "2) 节奏与 due"
node "$CREW" routine alpha --add "每天 09:00|扫一遍 inbox" >/dev/null
node "$CREW" routine alpha --add "每周五 16:00|写周报" >/dev/null
node "$CREW" routine beta  --add "每周一 09:00|归档" >/dev/null
must "周四只有每日卡" "该动：1 条" node "$CREW" due --date 2026-11-05
must "同一天不重复开" "该动：0 条" node "$CREW" due --date 2026-11-05
must "周五四条中的两条" "该动：2 条" node "$CREW" due --date 2026-11-06
must "周一才轮到 beta" "beta" node "$CREW" due --date 2026-11-09

echo "3) 任务板（先清掉 due 开的卡，编号从 t001 重来）"
rm -f "$TMP/board.json"
must "开卡 t001" "开了一张：t001" node "$CREW" task add "写摘要" --gear draft --accept "<=800 字"
must "认领" "alpha 认领了 t001" node "$CREW" task claim t001 alpha
must "认领进记忆" "认领 t001" node "$CREW" recall alpha
must "收口" "t001 收口" node "$CREW" task done t001 --out crew/alpha/out/x.md
must "列表显示 done" "done" node "$CREW" task list

echo "3.5) 拉取式派活（pool / pull / shift）"
node "$CREW" new gamma --role "后端实现" --tags backend >/dev/null
rm -f "$TMP/board.json"
node "$CREW" task add "后端活" --role backend >/dev/null
node "$CREW" task add "通用活" >/dev/null
must "pool 列两张" "可领 2 张" node "$CREW" pool
must "shift 一人一张" "起 2 个会话" node "$CREW" shift
must "pull 领本岗位" "已领到 t001" node "$CREW" pull gamma
# lens 复测指出：只断言"列两张"在任何认领之前跑，测不出 owner 过滤，等于没牙
must "认领后不再列进 pool" "可领 1 张" node "$CREW" pool
must "别抢别人的卡" "已经在" node "$CREW" task claim t001 alpha
must "再领通用卡" "已领到 t002" node "$CREW" pull gamma
must "没活就停" "没有 gamma 能接的活" node "$CREW" pull gamma
must "shift 说没活" "没有可领的活" node "$CREW" shift

echo "4) 交接"
must "投线索" "交到 alpha/inbox/" node "$CREW" hand alpha "线索：看 README"
must "inbox 能列出" "inbox（1 条）" node "$CREW" inbox alpha
must "空状态提示" "没有 open 状态的任务" node "$CREW" task list --status open

echo "5) brief 的档位与任务板提示"
node "$CREW" task add "带档位" --gear investigation >/dev/null
BRIEF="$(node "$CREW" brief alpha --task "查一下" --gear investigation --task-id t002 --accept "回报结论" 2>&1)"
case "$BRIEF" in *"这趟的档位：调查"*) ok "brief 带档位" ;; *) bad "brief 带档位" "$(echo "$BRIEF" | tail -3)" ;; esac
case "$BRIEF" in *"task claim t002 alpha"*) ok "brief 指向盘上任务板" ;; *) bad "brief 指向盘上任务板" "没找到 claim 提示" ;; esac
case "$BRIEF" in *"怎么算完"*) ok "brief 带验收" ;; *) bad "brief 带验收" "没找到验收段" ;; esac

echo "6) 周报初稿"
OUT="$(node "$WEEKLY" --week 2026-11-02 --stdout 2>&1)"
case "$OUT" in *"# 周报初稿 2026-11-02"*) ok "周报初稿头" ;; *) bad "周报初稿头" "$(echo "$OUT" | head -2)" ;; esac
case "$OUT" in *"给写稿人的要求"*) ok "周报带要求段" ;; *) bad "周报带要求段" "缺要求段" ;; esac
case "$OUT" in *"周报初稿"*) ok "stdout 不落盘" ;; *) bad "stdout 不落盘" "输出异常" ;; esac

echo "7) 越界与坏输入"
must "不存在的任务要报错" "任务板上没有 t999" node "$CREW" task claim t999 alpha
must "不存在的成员要报错" "没这个成员" node "$CREW" show ghost
must "坏日期要报错" "日期要写成" node "$CREW" due --date 2026-13-99
must "坏档位要报错" "档位只有" node "$CREW" task add "x" --gear turbo
# 以下防回归：arbiter 审计 t006 查出的注入面（2026-11-05）
must "brief 也校验档位" "档位只有" node "$CREW" brief alpha --gear turbo --task x
must "任务 id 只收 tNNN" "任务 id 长这样" node "$CREW" brief alpha --task-id "t001; touch $TMP/PWNED" --task x
must "inbox 只能给文件名" "只给文件名" node "$CREW" inbox alpha ../board.json
must "--max 要数字" "要给个数字" node "$CREW" brief alpha --max abc --task x
must "forget --last 要正整数" "正整数" node "$CREW" forget alpha --last 三条
cp "$TMP/board.json" "$TMP/board.bak"
printf '{"seq":' > "$TMP/board.json"
must "坏板子要停下、别清空" "解析不了" node "$CREW" task list
must "坏板子留了现场备份" "board.json.bad-" ls "$TMP"
mv "$TMP/board.bak" "$TMP/board.json"
rm -f "$TMP"/board.json.bad-*

echo
echo "结果：$PASS 过，$FAIL 败"
[ "$FAIL" -eq 0 ] || exit 1
