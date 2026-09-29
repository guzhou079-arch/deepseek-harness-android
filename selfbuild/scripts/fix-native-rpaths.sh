#!/system/bin/sh
# ============================================================================
# 给我们的原生库统一补 RUNPATH（让整个 python 栈**不依赖 LD_LIBRARY_PATH**）
#
#   sh fix-native-rpaths.sh
#
# 为什么需要：这些库是 Termux 包里的，RUNPATH 写死成 /data/data/com.termux/files/usr/lib，
# 或者干脆没有 RUNPATH。平时靠外层 env 兜着，但**构建子进程（meson/ninja）里 env 会丢**，
# 于是 pandas 的所有构建步骤返回 127（命令未找到）。
# Android 的 linker 接受 RUNPATH 里的绝对路径，所以直接写我们的绝对路径最省事。
# ============================================================================
set -e
F=/data/user/0/com.deepseek.harness/files
R=$F/payload/termux-usr
PT=$R/bin/patchelf
RP="$F/payload/python/lib-extra:$F/payload/termux-usr/lib:$F/payload/runtime/lib:$F/payload/python/lib"
export LD_LIBRARY_PATH="$R/lib"

[ -x "$PT" ] || { echo "✗ 缺 patchelf：先跑 install-termux-prefix.sh patchelf"; exit 1; }

echo "== 收集 .so =="
LIST=$F/tmp/rpath-list.txt
: > "$LIST"
for d in "$F/payload/python/lib-extra" "$F/payload/runtime/lib" "$R/lib" "$F/payload/python/lib"; do
  [ -d "$d" ] && find "$d" -maxdepth 2 -name "*.so*" -type f >> "$LIST" 2>/dev/null
done
for sd in "$F/payload/python/lib/python3.14/site-packages" "$F/.local/lib/python3.14/site-packages"; do
  [ -d "$sd" ] && find "$sd" -name "*.so" -type f >> "$LIST" 2>/dev/null
done
sort -u "$LIST" -o "$LIST"
echo "  待处理 $(wc -l < "$LIST") 个"

echo "== 打 RUNPATH =="
n=0; skip=0
while read -r so; do
  [ -f "$so" ] || continue
  # 不要碰 bionic 自己的核心库（它们不该被改）
  case "$(basename "$so")" in
    libc.so|libm.so|libdl.so|liblog.so|libandroid.so|libz.so|ld-android.so|linker64) skip=$((skip+1)); continue ;;
  esac
  if "$PT" --set-rpath "$RP" "$so" 2>/dev/null; then n=$((n+1)); else skip=$((skip+1)); fi
done < "$LIST"
echo "  已打 $n 个，跳过 $skip 个"

echo "== 验证（干净环境，不给任何 LD_LIBRARY_PATH）=="
env -i HOME="$F" "$F/payload/python/bin/python3.14" - <<'PYEOF'
import sys
print('  python', sys.version.split()[0])
mods = ['numpy','PIL','lxml.etree','scipy','cryptography','matplotlib','kiwisolver','docx','pptx']
for m in mods:
    try:
        __import__(m); print(f'  ✅ {m}')
    except Exception as e:
        print(f'  ❌ {m}: {type(e).__name__}: {str(e)[:90]}')
PYEOF
