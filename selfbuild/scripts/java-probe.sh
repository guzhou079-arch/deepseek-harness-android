#!/system/bin/sh
# ============================================================================
# java-probe.sh —— 给 App 侧 Java 加一个「自构建验证探针」路由
#
#   sh java-probe.sh apply     # 在 AccessibilityService.route() 里插入 /selfbuild-ping
#   sh java-probe.sh revert    # 移除
#   sh java-probe.sh check     # 看当前状态
#
# 为什么需要它：换 classes.dex 后必须能**证明新 dex 真的在跑**，
# 而不是"装了但跑的还是旧代码"。探针是一个只读 HTTP 路由，装机后：
#   curl 127.0.0.1:3181/selfbuild-ping
#   → {"ok":true,"build":"selfbuild-dex-v1","pid":12345,"uptimeMs":...}
#
# 只读、无副作用、不碰主屏；保留也无害（也可 revert 后再构建一次）。
# ============================================================================
SB=/storage/emulated/0/Download/Operit/dsh_own_app/selfbuild
SRC=/storage/emulated/0/Download/Operit/dsh_own_app/v118/android-app/src/com/deepseek/harness/AccessibilityService.java
NODE=/data/user/0/com.deepseek.harness/files/payload/runtime/bin/node
MARK='selfbuild-ping'

case "$1" in
  apply|revert)
    "$NODE" -e '
      const fs=require("fs");
      const [file, mode, mark]=process.argv.slice(1);
      let s=fs.readFileSync(file,"utf8");
      const anchor="        return jsonError(\"未知路由: \" + base);";
      const block=[
        "        // v1.22 自构建探针：证明「自己编译的 classes.dex」真的在跑（只读路由）",
        "        if (base.equals(\"/"+mark+"\")) {",
        "            return \"{\\\"ok\\\":true,\\\"build\\\":\\\"selfbuild-dex-v1\\\",\\\"pid\\\":\" + android.os.Process.myPid()",
        "                    + \",\\\"uptimeMs\\\":\" + android.os.SystemClock.elapsedRealtime() + \"}\";",
        "        }",
        ""
      ].join("\n");
      const has=s.indexOf("/"+mark+"\"")>=0;
      if(mode==="apply"){
        if(has){ console.log("已是 applied 状态，未改动"); process.exit(0); }
        if(s.indexOf(anchor)<0){ console.error("✗ 找不到插入锚点（route() 结构变了？）"); process.exit(2); }
        s=s.replace(anchor, block+anchor);
        fs.writeFileSync(file,s);
        console.log("✓ 已插入 /"+mark+" 路由");
      } else {
        if(!has){ console.log("当前未插入，无需 revert"); process.exit(0); }
        const i=s.indexOf("        // v1.22 自构建探针");
        const j=s.indexOf(anchor);
        if(i<0||j<0||j<i){ console.error("✗ 结构异常，拒绝自动 revert"); process.exit(3); }
        s=s.slice(0,i)+s.slice(j);
        fs.writeFileSync(file,s);
        console.log("✓ 已移除 /"+mark+" 路由");
      }
    ' "$SRC" "$1" "$MARK"
    ;;
  check)
    if rg -q "selfbuild-ping" "$SRC"; then echo "probe: 已插入"; else echo "probe: 未插入"; fi
    ;;
  *)
    sed -n '2,18p' "$SB/scripts/java-probe.sh"
    ;;
esac
