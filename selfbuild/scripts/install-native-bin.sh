#!/system/bin/sh
# 给 payload/native-bin 里的原生可执行文件生成 $HOME/bin 包装器
# （Termux 原生 aarch64 二进制；需要 lib-extra + runtime/lib 里的依赖库）
F=/data/user/0/com.deepseek.harness/files
NB=$F/payload/native-bin
EXTRA=$F/payload/python/lib-extra
for b in "$NB"/*; do
  [ -f "$b" ] || continue
  n=$(basename "$b")
  case "$n" in *.*) continue ;; esac
  cat > "$F/bin/$n" <<WRAP
#!/system/bin/sh
# Termux 原生工具包装器（自动生成：selfbuild/scripts/install-native-bin.sh）
F=/data/user/0/com.deepseek.harness/files
if [ -n "\$LD_LIBRARY_PATH" ]; then LP="$EXTRA:\$LD_LIBRARY_PATH"; else LP="$EXTRA:$F/payload/runtime/lib"; fi
exec env LD_LIBRARY_PATH="\$LP" "$b" "\$@"
WRAP
  chmod 755 "$F/bin/$n"
done
echo "已生成 $(ls $F/bin | wc -l) 个包装器"
