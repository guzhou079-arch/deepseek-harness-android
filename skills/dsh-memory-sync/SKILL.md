---
name: dsh-memory-sync
description: 跨会话长期记忆中枢与知识提炼技能。自动从对话中提取关键事实、用户偏好、踩坑教训沉淀至本地 SQLite 记忆库 (mem.db)，并在新会话中按关键词/语义精准召回，极致节省 Token。
whenToUse: 用户说「记住这个 / 以后都这么做 / 保存这条经验 / 查一下记忆 / 之前怎么说的」时调用。
---

# 跨会话记忆与经验中枢技能 (memos)

一句话：**告别开局失忆，用极低 Token 成本实现跨会话永续记忆与经验沉淀**。

## 🎯 核心机制

1. **结构化存储（mem.db）**：
   - **`lesson`（教训/避坑）**：踩过的坑、修复方案、技术红线，永不清理。
   - **`fact`（客观事实）**：环境配置、账号属性、网络状态、项目结构。
   - **`preference`（用户偏好）**：沟通习惯、UI风格偏好、操作禁忌。

2. **召回与使用原则**：
   - **非必要不全量读**：每次只检索与当前任务强相关的 2~3 条记忆；
   - **写前自查、写后回读**：写入记忆必须按字节校验，防止脏数据污染。

## 🛠️ 常用记忆操作命令

```bash
# 工具不一定在 $DSH_HOME/tools：老布局在 /sdcard/DeepSeekHarness/tools，有「所有文件
# 访问权限」的设备上插件首次运行会把记忆栈铺到那儿（那份可能比包内版新）；新装、没这个
# 权限的设备铺不出去，就用插件自带的那份。按这个顺序找，第一个找到的就是该用的。
for d in /sdcard/DeepSeekHarness/tools "$DSH_HOME/tools" \
         "$DSH_HOME/profiles/web/node_modules/dsh-memory-ui/tools"; do
  [ -f "$d/mem.js" ] && { MEM_TOOLS=$d; break; }
done
MEM="node $MEM_TOOLS/mem.js"

# 0. 先看一眼库的状态（条数 / 注入预算 / 哪些条目陈旧）
$MEM status

# 1. 查找记忆（按关键词）
$MEM find 关键词1 关键词2

# 2. 添加一条避坑教训（自动置顶）
$MEM add --id lesson-custom-name --kind lesson --title "教训标题" --hot --tags 标签1,标签2 <<'EOF'
经过与结论（正文走 stdin，防止 shell 展开）
EOF

# 3. 记录流水日志
$MEM log "完成了某某任务，验证方式为..."
```

正文一律走 stdin 或 `--body-file`，别用 `--body`：那个会被 shell 展开，引号和反引号先没了，
写进去的就不是你原话。
