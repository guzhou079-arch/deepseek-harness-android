#!/system/bin/sh
# ============================================================================
# 一键重建 proot + Alpine 运行环境（App 重装/清数据后会丢，用它几分钟恢复）
#
#   sh setup-proot-alpine.sh
#
# 产物：
#   files/work/linux/proot        Termux 的 proot（bionic，能在 Android 上跑）
#   files/work/linux/alpine/      Alpine 3.20 minirootfs
#   files/work/linux/run.sh       进入 guest 的统一入口（带同路径绑定，路径透明）
#
# 之后用 `sh install-proot-tools.sh` 把 guest 里的工具暴露成 $HOME/bin/<tool>。
# ============================================================================
set -e
F=/data/user/0/com.deepseek.harness/files
D=$F/work/linux
TMP=$F/tmp
PY=$F/payload/python/bin/python3.14
CURL=$F/payload/runtime/bin/curl
CA=$F/payload/runtime/etc/cacert.pem
ALPINE_VER=3.20.3
PROOT_VER=5.1.107.95
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/aarch64/alpine-minirootfs-${ALPINE_VER}-aarch64.tar.gz"
PROOT_URL="https://packages.termux.dev/apt/termux-main/pool/main/p/proot/proot_${PROOT_VER}_aarch64.deb"

mkdir -p "$D" "$TMP"

if [ ! -s "$TMP/alpine.tar.gz" ]; then
  echo "== 下载 Alpine minirootfs =="
  "$CURL" -L --cacert "$CA" --max-time 600 -o "$TMP/alpine.tar.gz" "$ALPINE_URL"
fi
if [ ! -s "$TMP/proot.deb" ]; then
  echo "== 下载 proot =="
  "$CURL" -L --cacert "$CA" --max-time 300 -o "$TMP/proot.deb" "$PROOT_URL"
fi

echo "== 解出 proot =="
"$PY" - "$TMP/proot.deb" "$D/proot" <<'PYEOF'
import sys, lzma, gzip, io, tarfile, os
deb, out = sys.argv[1], sys.argv[2]
raw = open(deb, 'rb').read()
assert raw[:8] == b'!<arch>\n', '不是 ar 归档'
p = 8; data = None
while p + 60 <= len(raw):
    name = raw[p:p+16].decode('utf8', 'replace').strip()
    size = int(raw[p+48:p+58].decode('ascii').strip())
    body = raw[p+60:p+60+size]
    if name.startswith('data.tar'):
        data = (name, body)
    p += 60 + size + (size % 2)
assert data, 'deb 里没有 data.tar'
name, body = data
if name.endswith('.xz'):   buf = lzma.decompress(body)
elif name.endswith('.gz'): buf = gzip.decompress(body)
elif name.endswith('.zst'):
    import zlib; buf = zlib.zstd_decompress(body)   # python3.14 自带 zstd
else:                      buf = body
t = tarfile.open(fileobj=io.BytesIO(buf))
member = None
for m in t.getmembers():
    if m.isfile() and m.name.endswith('/bin/proot'):
        member = m; break
assert member, 'deb 里找不到 bin/proot'
open(out, 'wb').write(t.extractfile(member).read())
os.chmod(out, 0o755)
print('  proot ->', out)
PYEOF

echo "== 解 Alpine rootfs =="
rm -rf "$D/alpine"; mkdir -p "$D/alpine"
"$PY" - "$TMP/alpine.tar.gz" "$D/alpine" <<'PYEOF'
import sys, tarfile
src, dst = sys.argv[1], sys.argv[2]
t = tarfile.open(src, 'r:gz')
t.extractall(dst, filter='tar')   # filter 避免 python 3.14 的告警
print('  条目:', len(t.getnames()))
PYEOF
mkdir -p "$D/tmp" "$D/alpine/storage/emulated/0" "$D/alpine$F" "$D/alpine/root" "$D/alpine/tc" "$D/alpine/keys" 2>/dev/null || true

echo "== 写 run.sh（进入 guest 的统一入口）=="
cat > "$D/run.sh" <<'EOF'
#!/system/bin/sh
# 在 proot+Alpine 里执行命令：
#   sh run.sh python3 -c 'print(1+1)'
D=/data/user/0/com.deepseek.harness/files/work/linux
F=/data/user/0/com.deepseek.harness/files
WD="$PWD"
case "$WD" in
  "$F"*|/sdcard*|/storage/emulated/0*) : ;;
  *) WD="/root" ;;
esac
exec env -u LD_LIBRARY_PATH -u LD_PRELOAD PROOT_TMP_DIR="$D/tmp" \
  "$D/proot" -r "$D/alpine" -0 -w "$WD" \
  -b /dev -b /proc -b /sys \
  -b /sdcard:/sdcard -b "$F:/host" \
  -b /storage/emulated/0:/storage/emulated/0 -b "$F:$F" \
  /bin/sh -lc 'exec "$@"' sh "$@"
EOF
chmod 755 "$D/run.sh"

echo "== 验证 =="
"$D/proot" --version 2>&1 | head -1
sh "$D/run.sh" sh -c 'cat /etc/alpine-release'
echo "✓ 完成。下一步：sh install-proot-tools.sh（把 guest 工具暴露到 \$HOME/bin）"
