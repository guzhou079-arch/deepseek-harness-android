#!/system/bin/sh
# ============================================================================
# 把 Termux 包**完整**解到我们自己的前缀（保留 bin/lib/libexec/include/share 结构）
#
#   sh install-termux-prefix.sh clang ndk-sysroot make binutils
#
# 和 install-python-native-deps.sh 的区别：那个只挑 site-packages/*.so/bin（给 python 加扩展用），
# 这个要保结构 —— 编译器/链接器必须能找到自己的内建头文件、资源目录和 sysroot。
#
# 产物：files/payload/termux-usr/{bin,lib,libexec,include,share,ndk-sysroot,…}
# ============================================================================
set -e
F=/data/user/0/com.deepseek.harness/files
ROOT=$F/payload/termux-usr
PY=$F/payload/python/bin/python3.14
NODE=$F/payload/runtime/bin/node
CURL=$F/payload/runtime/bin/curl
CA=$F/payload/runtime/etc/cacert.pem
T=$F/tmp
DEBS=$T/debs
IDX=$T/TermuxPackages
BASE=https://packages.termux.dev/apt/termux-main
mkdir -p "$DEBS" "$ROOT"

[ -n "$*" ] || { echo "用法: sh $0 <包名…>"; exit 2; }

if [ ! -s "$IDX" ]; then
  "$CURL" -sL --cacert "$CA" --max-time 300 -o "$IDX" "$BASE/dists/stable/main/binary-aarch64/Packages"
fi

echo "== 解析依赖（递归）=="
"$NODE" -e '
const fs=require("fs");
const idx=fs.readFileSync(process.argv[1],"utf8").split(/\n\n+/);
const P=new Map();
for(const st of idx){
  const g=k=>{const m=st.match(new RegExp("^"+k+": (.*)$","m"));return m?m[1].trim():null;};
  const n=g("Package"); if(!n) continue;
  P.set(n,{version:g("Version"),filename:g("Filename"),size:+(g("Size")||0),
           depends:(g("Depends")||"").split(",").map(s=>s.trim().split(/[\s(]/)[0]).filter(Boolean)});
}
const skip=new Set();
for(const n of P.keys()) if(n.endsWith("-static")||n.endsWith("-doc")||n.endsWith("-dev")) skip.add(n);
const out=new Map(), q=[...process.argv.slice(2)];
while(q.length){
  const n=q.shift();
  if(skip.has(n)||out.has(n)) continue;
  const e=P.get(n);
  if(!e){ console.error("  ⚠ 索引里没有: "+n); continue; }
  out.set(n,e);
  for(const d of e.depends) if(!out.has(d)) q.push(d);
}
let total=0;
for(const [n,e] of out){ total+=e.size; console.error("  "+n.padEnd(20)+(e.version||"").padEnd(14)+(e.size/1048576).toFixed(1)+"MB"); }
console.error("  共 "+out.size+" 个包，约 "+(total/1048576).toFixed(0)+"MB（下载量）");
for(const [n,e] of out) console.log(e.filename);
' "$IDX" "$@" > "$T/pkglist-full.txt" || { echo "  ✗ 解析失败"; exit 1; }

echo "== 下载 =="
for fn in $(cat "$T/pkglist-full.txt"); do
  b=$(basename "$fn")
  if [ ! -s "$DEBS/$b" ] || [ "$(head -c 8 "$DEBS/$b" 2>/dev/null)" != "!<arch>" ]; then
    "$CURL" -sL --cacert "$CA" --max-time 900 -o "$DEBS/$b" "$BASE/$fn" || echo "  ⚠ 下载失败 $b"
  fi
  printf "  %-40s %s\n" "$b" "$([ "$(head -c 8 "$DEBS/$b" 2>/dev/null)" = "!<arch>" ] && echo ok || echo ❌)"
done

echo "== 完整解包（保结构 + 软链）=="
"$PY" - "$DEBS" "$ROOT" "$T/pkglist-full.txt" <<'PYEOF'
import sys, os, lzma, gzip, io, tarfile
debs, root, listfile = sys.argv[1], sys.argv[2], sys.argv[3]
want = set()
for line in open(listfile):
    line = line.strip()
    if line: want.add(os.path.basename(line))
MARK = '/files/usr/'
n_f = n_l = n_skip = 0
for b in sorted(os.listdir(debs)):
    if b not in want or not b.endswith('.deb'): continue
    raw = open(os.path.join(debs, b), 'rb').read()
    if raw[:8] != b'!<arch>\n': continue
    p, data = 8, None
    while p + 60 <= len(raw):
        nm = raw[p:p+16].decode('utf8','replace').strip(); sz = int(raw[p+48:p+58].decode().strip())
        body = raw[p+60:p+60+sz]
        if nm.startswith('data.tar'): data = (nm, body)
        p += 60 + sz + (sz % 2)
    if not data: continue
    nm, body = data
    buf = lzma.decompress(body) if nm.endswith('.xz') else gzip.decompress(body) if nm.endswith('.gz') else body
    t = tarfile.open(fileobj=io.BytesIO(buf))
    for m in t.getmembers():
        i = m.name.find(MARK)
        if i < 0: n_skip += 1; continue
        rel = m.name[i + len(MARK):]
        if not rel: continue
        dst = os.path.join(root, rel)
        if m.isdir():
            os.makedirs(dst, exist_ok=True); continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if m.issym():
            if not os.path.lexists(dst):
                try: os.symlink(m.linkname, dst); n_l += 1
                except Exception: pass
            continue
        if m.islnk():   # 硬链接 → 复制目标内容
            try: t.extract(m, path=root, filter='tar')
            except Exception: pass
            continue
        if not m.isfile(): continue
        with open(dst,'wb') as f: f.write(t.extractfile(m).read())
        os.chmod(dst, 0o755 if m.mode & 0o100 else 0o644)
        n_f += 1
print(f'  文件 {n_f} 个，软链 {n_l} 个 → {root}')
print(f'  跳过（不在 usr/ 下）{n_skip} 个')
PYEOF

echo "== 顶层结构 =="
ls "$ROOT" | tr '\n' ' '; echo
[ -d "$ROOT/ndk-sysroot" ] && echo "  ndk-sysroot: $(ls "$ROOT/ndk-sysroot" | tr '\n' ' ')"
[ -d "$ROOT/bin" ] && echo "  bin: $(ls "$ROOT/bin" | head -8 | tr '\n' ' ')"
