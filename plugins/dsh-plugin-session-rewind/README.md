# dsh-plugin-session-rewind · 会话回滚

给 DeepSeek Harness 的会话加一个「**回滚到某条消息之前**」——你发过的某条消息连同它之后的一切，
从新会话里彻底消失，模型上下文和界面都是干净的。

English: roll a harness session back to *before* a chosen message. Everything from that message on is gone
from a clean forked session; the model never sees the dirty tail again.

## 用法

```
/rewind        回滚到最后一条你发的消息之前
/rewind 2      回滚到倒数第 2 条你发的消息之前
/rewind <id>   按 messageId 精确指定（客户端「长按菜单」走这条）
```

命令回执会告诉你新会话 id 和「被丢掉的区间」。

## 为什么是 fork，而不是原地删条目

| 做法 | 模型上下文 | 界面气泡 | 会话 id |
|---|---|---|---|
| 追加 surface 替换事件 | 干净 ✅ | **还在** ❌ | 不变 |
| **fork 到这条之前**（本插件的做法） | 干净 ✅ | 消失 ✅ | 变 |

- DSH 的会话是**只追加事件日志**，没有 delete 事件类型；
- 界面的时间线是**按「追加事件」渲染的**（内核注释原文：*a landed replacement would erase conversation
  the user already saw*）⇒ 替换事件只能骗过模型，骗不过界面；
- 真正能把两样都清掉的官方通道就是 `ctx.sessionController.fork({ sessionId, atSeq })` ——
  也是聊天里「分支」按钮走的那条。它会把 `[0, atSeq]` 原样复制进新会话，自动重建成能继续聊的 agent
  （含工作区挂载），所以不需要我发明任何存储层的东西。

**本插件的全部价值 = 把 `atSeq` 算准**（= 目标消息 `seq − 1`，含头）+ 给人类一句能看懂的回执。

## ⛔ 不做「只删中间一条」

日志里 assistant 的工具调用（`tool/call`）和工具结果（`tool/result`）是**成对**写的；
中间挖洞会让会话结构不合法（这正是「会话被搞坏」的来源）。
回滚到某条之前（保留完整前缀）是结构安全的。

## 已知限制

- **会话 id 会变**：回滚后你继续用的是新会话，原会话改名为「…（回滚前）」留在列表里（可切回去）。
- **工作区文件不会回滚**：DSH 没有「每条消息一份文件快照」这种能力
  （`dsh-session-checkpoint-policy` 是崩溃持久化，不是文件快照）。要文件级回滚，工作区得是 git 仓库，另做。

## 两种入口

**① 长按（客户端，推荐）**：长按**你自己发的那条消息** → 弹确认框（不可撤销）→ 确认后 fork 到这条之前，
并**自动切到新会话**。
实现在 `lib/client.js`（手写客户端 bundle，形如 `window.__ModuleLoader__.load({id, factory})`，**不 require 任何包**）：
- 在 `conversation.chat.turnTail` 挂一个不渲染任何东西的占位组件，借它的 `inject(sessionId)`
  拿到当前会话与 chat 视图 store；
- 全局长按监听落在 `[data-chat-flow-kind="user"]` 上，取 `data-chat-node-key`；
- 该 key → `chat.getSnapshot().nodes.get(key).anchorSeq` = 这条消息的事件 seq ⇒ `atSeq = anchorSeq - 1`
  （与 Host 侧算法同源），然后 `ctx.sessions.fork({sessionId, atSeq})` + `ctx.uiWorkspace.openSession(child)`。

**② 命令 `/rewind`**：不想长按时用命令面板，见下。

## 验证状态（2026-10-10）

✅ **已在真引擎里跑通**（独立隔离实例，端口 3099，不动装机副本）：

1. `commands/list` 里出现 `rewind` ⇒ 插件真被加载；
2. `/rewind --seed 3` 造 3 条真人消息（零模型调用）→ `/rewind` → **真 fork**；
3. 磁盘逐条核对子会话（`verify-fork.mjs`）**全绿**：被回滚那条不在子会话、子会话 = 父会话 `[0,6]`
   逐条一致（seq/type/id）、多出 `session/end-seed` + `session/title`、父会话仍留原消息、标题不混淆。

跑法见 `/sdcard/DeepSeekHarness/tools/iso-rewind.sh`，RPC 探针 `/sdcard/DeepSeekHarness/tmp/rpc.mjs`。

## 诊断与测试用的隐藏参数

```
/rewind --debug     照实报出 sessionQuery 给的事件形状（类型分布 / source.kind / 最后 3 条真人消息）
/rewind --seed N    造 N 条真人消息（真实 user/message 事件），用于零模型成本地端到端验证
```

## 开发 / 测试

```sh
node test/core.test.mjs      # 拿真机上的 session.v4.jsonl.zstd 验边界算法（不需要引擎）
node test/handler.test.mjs   # 假 ctx 验「命令注册 → handler → fork」接线
node test/client.test.mjs    # 假 DOM 验「长按 → 确认框 → fork → 切会话」整条客户端逻辑
```

`core.test.mjs` 依赖 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`，会挑最大的几个真会话跑。

⚠️ **假 ctx 一律要按真 API 的形状写**（异步的地方必须 async、字段名照抄）。隔离实例 E2E 抓到的两个 bug
都是被"太好说话的假 ctx"藏住的：`observeSession()` 其实返回 Promise；`SessionHeader` 里根本没有 `title`。

## 挂载

- **挂到正在用的实例**：`sh /sdcard/DeepSeekHarness/tools/mount-rewind-live.sh mount`
  （改 live profile 的 patch + 软链，自动备份；`unmount` 摘掉）。
  ⚠️ **挂完要重启引擎才生效**（patch 在启动时读），会中断当前会话 ⇒ 时机由用户定。
- **隔离实例验证**：`sh /sdcard/DeepSeekHarness/tools/iso-rewind.sh up`（端口 3099，不动装机副本）。

`cordis.patch.yml` 是 `insert` 形式：
⚠️ 新增条目必须写在 `insert:` 下面；直接写 `- id:` 是**改已有条目**，不存在的 id 会被静默忽略。

⚠️ 假 DOM 里按文案找按钮时要**同时限定 `tagName === "BUTTON"`** —— 本插件弹窗的**标题**也叫「确认回滚」，
只按文案找会命中标题（它没有 click 处理），测试就会假失败。

MIT.
