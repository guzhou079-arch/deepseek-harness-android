#!/system/bin/sh
# ============================================================================
# 给**本机 Android python**（payload/python，Termux 系 3.14.6 构建）装原生扩展：
#   numpy / Pillow / lxml …
#
#   sh install-python-native-deps.sh python-numpy python-pillow python-lxml
#
# 为什么这条路可行（而 Alpine 的不行）：
#   本机 python 的 SOABI 是 `cpython-314-aarch64-linux-android`，与 Termux 仓库里
#   `python_3.14.6-1_aarch64.deb` **完全同版本同 ABI** → Termux 的原生 bionic 轮子可直接加载，
#   不经过 proot、不碰 Android 对 musl 静态/异构二进制的 seccomp 限制。
#
# 做的事：
#   ① 用 Termux 的 Packages 索引**递归解析依赖**（跳过 python / python-pip）
#   ② 下载 .deb
#   ③ 解包并把文件**重定位**到我们的前缀：
#        usr/lib/python3.14/site-packages/**  → payload/python/lib/python3.14/site-packages/
#        usr/lib/*.so*                        → payload/python/lib-extra/   （用 LD_LIBRARY_PATH 找到）
#      其它目录（bin/share）默认跳过，避免覆盖我们自己的东西
# ============================================================================
set -e
F=/data/user/0/com.deepseek.harness/files
PY=$F/payload/python/bin/python3.14
NODE=$F/payload/runtime/bin/node
CURL=$F/payload/runtime/bin/curl
CA=$F/payload/runtime/etc/cacert.pem
T=$F/tmp
DEBS=$T/debs
IDX=$T/TermuxPackages
BASE=https://packages.termux.dev/apt/termux-main
SP=$F/payload/python/lib/python3.14/site-packages
EXTRA=$F/payload/python/lib-extra
NBIN=$F/payload/native-bin

PKGS="$*"
[ -n "$PKGS" ] || { echo "用法: sh $0 <包名…>  例: sh $0 python-numpy python-pillow python-lxml"; exit 2; }

mkdir -p "$DEBS" "$SP" "$EXTRA" "$NBIN"

if [ ! -s "$IDX" ]; then
  echo "== 取 Termux 包索引 =="
  "$CURL" -sL --cacert "$CA" --max-time 300 -o "$IDX" "$BASE/dists/stable/main/binary-aarch64/Packages"
fi
echo "  索引条目: $(rg -c '^Package: ' "$IDX")"

echo "== 解析依赖（递归）=="
# 表格走 stderr、文件名清单走 stdout —— 两个流分开重定向，别混（混过一次：表格词被当成文件名去下载）
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
const skip=new Set(["python","python-pip","python-pip-static"]);
for(const n of P.keys()) if(n.endsWith("-static")) skip.add(n);
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
for(const [n,e] of out){ total+=e.size; console.error("  "+n.padEnd(22)+(e.version||"").padEnd(14)+(e.size/1048576).toFixed(1)+"MB"); }
console.error("  共 "+out.size+" 个包，约 "+(total/1048576).toFixed(1)+"MB");
for(const [n,e] of out) console.log(e.filename);
' "$IDX" $PKGS > "$T/pkglist.txt" || { echo "  ✗ 依赖解析失败"; exit 1; }
EOF_MARK=1
FILES=$(cat "$T/pkglist.txt")
echo "  待下载 $(echo "$FILES" | wc -l) 个 deb"

echo "== 下载 =="
for fn in $FILES; do
  b=$(basename "$fn")
  if [ ! -s "$DEBS/$b" ] || [ "$(head -c 8 "$DEBS/$b" 2>/dev/null)" != "!<arch>" ]; then
    "$CURL" -sL --cacert "$CA" --max-time 600 -o "$DEBS/$b" "$BASE/$fn"
  fi
  if [ "$(head -c 8 "$DEBS/$b" 2>/dev/null)" = "!<arch>" ]; then printf "  %-44s ok\n" "$b"
  else printf "  %-44s ❌ 不是合法 deb\n" "$b"; fi
done

echo "== 解包并重定位 =="
"$PY" - "$DEBS" "$SP" "$EXTRA" "$NBIN" <<'PYEOF'
import sys, os, lzma, gzip, io, tarfile, shutil
debs, sp, extra, nbin = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
SITE_MARK = '/usr/lib/python3.14/site-packages/'
n_site = n_lib = n_link = n_bin = n_skip = 0
for b in sorted(os.listdir(debs)):
    if not b.endswith('.deb'): continue
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
        # ⚠ deb 里的 soname（libxml2.so.16 → libxml2.so.16.x.y）是**符号链接**，
        # 只取普通文件会漏掉 → dlopen 报 "library libxml2.so.16 not found"。
        if m.issym():
            rel = m.name
            i = rel.find('/files/usr/')
            if i < 0: continue
            rel = rel[i + len('/files/usr/'):]
            if rel.startswith('lib/') and '.so' in os.path.basename(rel):
                dst = os.path.join(extra, os.path.basename(rel))
                if not os.path.lexists(dst):
                    try:
                        os.symlink(os.path.basename(m.linkname), dst); n_link += 1
                    except Exception:
                        pass
            continue
        if not m.isfile(): continue
        # 去掉 deb 里的 Termux 前缀
        rel = m.name
        i = rel.find('/files/usr/')
        if i < 0: n_skip += 1; continue
        rel = rel[i + len('/files/usr/'):]
        if rel.startswith('lib/python3.14/site-packages/'):
            tail = rel[len('lib/python3.14/site-packages/'):]
            if not tail: continue
            dst = os.path.join(sp, tail)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst,'wb') as f: f.write(t.extractfile(m).read())
            n_site += 1
        elif rel.startswith('lib/') and '.so' in os.path.basename(rel):
            dst = os.path.join(extra, os.path.basename(rel))
            if os.path.lexists(dst): n_skip += 1; continue      # 别覆盖已有的（尤其 libc++）
            with open(dst,'wb') as f: f.write(t.extractfile(m).read())
            os.chmod(dst, 0o755)
            n_lib += 1
        elif rel.startswith('bin/') and '/' not in rel[4:]:
            # 可执行文件（aapt/aapt2 等原生工具）→ native-bin，用包装器加 LD_LIBRARY_PATH 启动
            os.makedirs(nbin, exist_ok=True)
            dst = os.path.join(nbin, rel[4:])
            with open(dst,'wb') as f: f.write(t.extractfile(m).read())
            os.chmod(dst, 0o755)
            n_bin += 1
        else:
            n_skip += 1
print(f'  站点包文件 {n_site} 个 → {sp}')
print(f"  原生库 {n_lib} 个（含 soname 链接 {n_link} 个）→ {extra}")
print(f"  可执行 {n_bin} 个 → {nbin}")
print(f'  跳过（bin/share/静态/已有）{n_skip} 个')
PYEOF

echo "== 验证导入 =="
LD_LIBRARY_PATH="$EXTRA:$F/payload/runtime/lib" "$PY" - <<'PYEOF'
import os
mods = []
for name in ("numpy", "PIL", "lxml.etree"):
    try:
        m = __import__(name, fromlist=['*'])
        v = getattr(m, "__version__", "")
        mods.append(f"  ✅ {name} {v}")
    except Exception as e:
        mods.append(f"  ❌ {name}: {type(e).__name__}: {e}")
print("\n".join(mods))
PYEOF
