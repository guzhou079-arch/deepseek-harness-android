#!/system/bin/sh
# ============================================================================
# 会话/配置/钥匙 备份 —— 2026-09-29 那次"数据全清"的教训
#
#   sh backup-dshhome.sh                 # 立即备份（自动轮转，保留最近 5 份）
#   sh backup-dshhome.sh --auto          # 仅当最新备份超过 20 小时才做（供开机自检调用）
#   sh backup-dshhome.sh --list          # 列出备份
#   sh backup-dshhome.sh --restore <文件> # 还原（覆盖回去）
#
# 备什么（都很小、但丢了很痛）：
#   dshhome/           会话历史(17MB)、settings、cordis.patch.yml、profiles、AGENTS.md
#   keys/              签名钥匙（虽 /sdcard/Download/dsh_transfer 也有，多处更稳）
#   .pip/               pip 配置（cert + 源）
#   .local/…/usercustomize.py  TLS 修复
#   bin/               $HOME/bin 包装器（proot 工具入口）
# 不备：payload/（重装会重解压）、proot rootfs（用 setup-proot-alpine.sh 重建）
#
# 产出：/sdcard/DeepSeekHarness/backups/dshhome-YYYYmmdd-HHMMSS.tar.gz
# ============================================================================
F=/data/user/0/com.deepseek.harness/files
OUTDIR=/storage/emulated/0/DeepSeekHarness/backups
KEEP=5
mkdir -p "$OUTDIR"

latest() { ls -t "$OUTDIR"/dshhome-*.tar.gz 2>/dev/null | head -1; }

case "$1" in
  --list)
    ls -lt "$OUTDIR"/dshhome-*.tar.gz 2>/dev/null | awk '{printf "  %s  %s MB  %s %s\n", $9, int($5/1048576), $6, $7}'
    [ -z "$(latest)" ] && echo "  （还没有备份）"
    exit 0
    ;;
  --auto)
    L=$(latest)
    if [ -n "$L" ]; then
      # 最新备份的年龄（秒）；mksh 没有 stat -c %Y 的稳定保证，用 node 算
      AGE=$(/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node -e "
        const fs=require('fs');const p=process.argv[1];
        console.log(Math.floor((Date.now()-fs.statSync(p).mtimeMs)/1000));" "$L" 2>/dev/null)
      if [ -n "$AGE" ] && [ "$AGE" -lt 72000 ]; then
        echo "  最近备份 $((AGE/3600)) 小时前，跳过"
        exit 0
      fi
    fi
    ;;
  --restore)
    SRC="$2"
    [ -f "$SRC" ] || { echo "✗ 找不到备份: $SRC"; exit 1; }
    echo "== 还原 $SRC =="
    tar -xzf "$SRC" -C "$F" 2>&1 | head -5
    echo "✓ 已还原到 $F（dshhome/keys/.pip/bin 覆盖回去；重启 App 生效）"
    exit 0
    ;;
esac

TS=$(date +%Y%m%d-%H%M%S)
OUT="$OUTDIR/dshhome-$TS.tar.gz"
echo "== 打包 =="
# ⚠ toybox tar 对多个 -C 只认最后一个（实测：dshhome 会被整个漏掉）→ 只用一个 -C + 相对路径。
# 还原对应 `tar -xzf <归档> -C $F`。
# ⚠ 2026-10-03 修复：`.pip` / `bin` / `.local/.../usercustomize.py` 在本机**已经不存在**，
#   硬塞进 tar 会让整包以非 0 退出 —— 归档其实写出来了，但脚本报「✗ tar 失败」，看着像备份坏了。
#   → 先只挑存在的路径；顺带把**可再生**的 cache 排除掉（实测 111MB，占整包三分之一）。
ITEMS="payload/dshhome keys"
for p in .pip bin .local/lib/python3.14/site-packages/usercustomize.py; do
  if [ -e "$F/$p" ] || [ -L "$F/$p" ]; then ITEMS="$ITEMS $p"; else echo "  · 跳过（本机不存在）: $p"; fi
done
tar -czf "$OUT" -C "$F" --exclude 'payload/dshhome/cache' $ITEMS
if [ $? -ne 0 ]; then echo "✗ tar 失败（看上面报错）"; exit 1; fi

if [ ! -s "$OUT" ]; then echo "✗ 打包失败"; exit 1; fi
echo "  → $OUT（$(du -m "$OUT" | cut -f1)MB）"
tar -tzf "$OUT" 2>/dev/null | wc -l | sed 's/^/  条目: /'

echo "== 轮转（保留最近 $KEEP 份）=="
ls -t "$OUTDIR"/dshhome-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | while read -r old; do
  rm -f "$old" && echo "  删除旧备份 $(basename "$old")"
done

echo "== 当前备份 =="
ls -t "$OUTDIR"/dshhome-*.tar.gz 2>/dev/null | head -"$KEEP" | while read -r b; do
  printf "  %s  %sMB\n" "$(basename "$b")" "$(du -m "$b" | cut -f1)"
done
