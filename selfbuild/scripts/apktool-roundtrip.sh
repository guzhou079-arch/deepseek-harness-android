#!/system/bin/sh
# ============================================================================
# 验证"改 AndroidManifest / 资源"的能力（此前判定为"做不到，没有 aapt2"）
#
#   sh apktool-roundtrip.sh <apk>
#
# 链路：apktool（纯 Java，跑在 proot+OpenJDK17 里）decode → 改一行 Manifest →
#       apktool build（--aapt 指向**原生 aarch64 aapt2**）→ 验签 → 验 payload 结构
#
# 依赖：files/payload/native-bin/aapt2（Termux 原生包，见 install-python-native-deps.sh）
#       $HOME/bin/aapt2 包装器（自动带 LD_LIBRARY_PATH，见 install-native-bin.sh）
# ============================================================================
set -e
F=/data/user/0/com.deepseek.harness/files
R="${DSH_PROJECT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SB="$R/selfbuild"
D=/storage/emulated/0/Download/Operit/dsh-toolchain
NODE=$F/payload/runtime/bin/node
APK="$1"
[ -f "$APK" ] || { echo "用法: sh $0 <apk>"; exit 2; }
OUT=$SB/work/apktool-test
rm -rf "$OUT"; mkdir -p "$OUT"
RUN="sh $F/work/linux/run.sh"

echo "== 1) decode（131MB 大包，耐心等）=="
$RUN java -Xmx1500m -jar $D/apktool.jar d -f -o "$OUT/dec" "$APK" 2>&1 | tail -6
if [ ! -f "$OUT/dec/AndroidManifest.xml" ]; then echo "✗ decode 没产出 AndroidManifest.xml"; exit 1; fi
echo "  ✅ Manifest 已解码为文本（$(wc -c < "$OUT/dec/AndroidManifest.xml") 字节）"
echo "  ✅ res 目录: $(ls "$OUT/dec/res" 2>/dev/null | wc -l) 项；smali: $(find "$OUT/dec" -name '*.smali' 2>/dev/null | wc -l) 个"

echo "== 2) 改 Manifest（插入一个标记 meta-data）=="
"$NODE" -e '
const fs=require("fs"), p=process.argv[1];
let s=fs.readFileSync(p,"utf8");
if(s.includes("dsh.roundtrip")){console.log("  已存在标记，跳过");process.exit(0);}
if(!s.includes("</application>")){console.error("  ✗ 找不到 </application>");process.exit(1);}
s=s.replace("</application>", "    <meta-data android:name=\"dsh.roundtrip\" android:value=\"ok\"/>\n</application>");
fs.writeFileSync(p,s); console.log("  ✅ 已插入 <meta-data android:name=\"dsh.roundtrip\">");
' "$OUT/dec/AndroidManifest.xml"

echo "== 3) rebuild（用原生 aapt2）=="
$RUN java -Xmx1500m -jar $D/apktool.jar b --aapt "$F/bin/aapt2" -o "$OUT/rebuilt.apk" "$OUT/dec" 2>&1 | tail -8
[ -s "$OUT/rebuilt.apk" ] || { echo "✗ 没产出 rebuilt.apk"; exit 1; }
echo "  ✅ 产出 $(du -m "$OUT/rebuilt.apk" | cut -f1)MB"

echo "== 4) 验签（用我们的钥匙签一遍，证明可装机）=="
$RUN java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool sign \
  --ks /keys/pkcs12.keystore --ks-pass pass:android --key-pass pass:android --ks-key-alias androidkey \
  --out "$OUT/rebuilt-signed.apk" "$OUT/rebuilt.apk" 2>&1 | tail -3
$RUN java -cp /tc/apksigner.jar com.android.apksigner.ApkSignerTool verify "$OUT/rebuilt-signed.apk" && echo "  ✅ 签名验证通过"

echo "== 5) 结构体检（payload 还在不在）=="
"$NODE" "$SB/scripts/verify-apk-payload.js" "$OUT/rebuilt-signed.apk" --inventory 2>&1 | tail -3

echo "== 6) 确认 Manifest 改动真的进了包 =="
$RUN java -jar $D/apktool.jar d -f -s -o "$OUT/verify" "$OUT/rebuilt-signed.apk" 2>&1 | tail -1
if rg -q "dsh.roundtrip" "$OUT/verify/AndroidManifest.xml" 2>/dev/null; then echo "  ✅ 重建后的包里能找到 dsh.roundtrip 标记"; else echo "  ❌ 标记丢了"; fi
echo "全部完成 → $OUT"
