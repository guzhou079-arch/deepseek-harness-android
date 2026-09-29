#!/system/bin/sh
# 回滚：把账户 UI 的桌面独占门禁装回去
TGT="${DSH_KERNEL_FILE:-/data/user/0/com.deepseek.harness/files/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js}"
DIR=$(dirname "$0")
cp "$DIR/client.js.orig" "$TGT"
echo "已还原 $TGT"
echo "刷新页面即可（客户端 bundle 的 rev 会跟着内容变）。"
