#!/system/bin/sh
# ============================================================================
# 把 Alpine(proot) 里的命令行工具暴露成 $HOME/bin/<name> 包装器
#
#   sh install-proot-tools.sh                      # 默认清单
#   sh install-proot-tools.sh ffmpeg tesseract      # 指定工具（guest 命令名 = 包装器名）
#   sh install-proot-tools.sh python3:apy           # 别名：guest 里跑 python3，包装器叫 apy
#
# 为什么必须走 proot：Android 的 seccomp 会杀掉 musl 静态二进制
# （实测 johnvansickle 的 ffmpeg static → `Bad system call`；proot 也不能绕过）。
# Alpine 里 apk 装的动态版在 proot 下正常。
#
# 路径透明（v1.26.1）：除了 /sdcard 与 /host，现在还**把原生路径同路径绑定**——
#   /storage/emulated/0 → /storage/emulated/0，$HOME → $HOME
# 于是脚本里写原生路径也能用（原来只有 /sdcard 和 /host 可用，老是踩 "No such file"）。
# 参数改写保留作双保险。
# ============================================================================
D=/data/user/0/com.deepseek.harness/files/work/linux
F=/data/user/0/com.deepseek.harness/files
BIN=$F/bin
mkdir -p "$BIN"
# guest 内挂载点必须先存在，proot 才能绑到同路径
mkdir -p "$D/alpine/storage/emulated/0" "$D/alpine$F" 2>/dev/null

SPECS="$*"
[ -z "$SPECS" ] && SPECS="ffmpeg ffprobe pdftotext pdfinfo pdftoppm tesseract python3:apy"

for spec in $SPECS; do
  case "$spec" in
    *:*) GUEST="${spec%%:*}"; NAME="${spec##*:}" ;;
    *)   GUEST="$spec";       NAME="$spec" ;;
  esac
  cat > "$BIN/$NAME" <<EOF
#!/system/bin/sh
# Alpine(proot) 里的 $GUEST —— 由 selfbuild/scripts/install-proot-tools.sh 生成
D=$D
F=$F
# ① 参数路径改写（双保险；同路径绑定已让原生路径可用）
n=\$#
i=1
while [ \$i -le \$n ]; do
  a="\$1"; shift
  case "\$a" in
    /storage/emulated/0*) a="/sdcard\${a#/storage/emulated/0}" ;;
    /storage/self/primary*) a="/sdcard\${a#/storage/self/primary}" ;;
  esac
  set -- "\$@" "\$a"
  i=\$((i+1))
done
# ② cwd：原生路径已同路径绑定，直接用；不在绑定范围内才退 /root
WD="\$PWD"
case "\$WD" in
  "\$F"*|/sdcard*|/storage/emulated/0*) : ;;
  *) WD="/root" ;;
esac
exec env -u LD_PRELOAD \\
  LD_LIBRARY_PATH="\$D/lib" \\
  PROOT_TMP_DIR="\$D/tmp" \\
  PROOT_LOADER="\$D/termux/data/data/com.termux/files/usr/libexec/proot/loader" \\
  PROOT_LOADER_32="\$D/termux/data/data/com.termux/files/usr/libexec/proot/loader32" \\
  "\$D/proot" -r "\$D/alpine" -0 -w "\$WD" \\
  -b /dev -b /proc -b /sys -b /sdcard:/sdcard -b "\$F:/host" \\
  -b /storage/emulated/0:/storage/emulated/0 -b "\$F:\$F" \\
  /bin/sh -lc 'exec env -u LD_LIBRARY_PATH $GUEST "\$@"' sh "\$@"
EOF
  chmod 755 "$BIN/$NAME"
  echo "✓ $BIN/$NAME  → guest: $GUEST"
done

echo
echo "这些包装器在 \$HOME/bin（已在引擎 PATH 最前）。加新工具：proot 里 apk add，再跑本脚本。"
