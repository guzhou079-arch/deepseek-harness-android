---
name: dsh-tier
description: 给本机 DeepSeek-V4.1-flash 做智力分档（low/high/max）并按任务难度自动切换。开工判档、收工回落到 high。
whenToUse: 每一轮用户消息进来时（判档后在动手前调用一次）；或用户说「省点钱 / 认真想 / 用 max」。
---

# 智力分档（low / high / max）

## 机制（已实测，不是推测）

引擎 RPC **`session/selectModel`** 可以**当场**改会话的推理档，**不用重启引擎、不用重装**：

```
node /sdcard/DeepSeekHarness/tools/tier.mjs low|high|max
node /sdcard/DeepSeekHarness/tools/tier.mjs --auto "<用户这句话>"   # 启发式判档
node /sdcard/DeepSeekHarness/tools/tier.mjs --show                  # 当前档
```

- 底层：`node tools/rpc-call.mjs session/selectModel '{"sessionId":…,"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"low"}'`
- 生效范围：**下一个 LLM 请求**开始（同一轮里紧接着的那一步就用新档）；
  选择会持久化进 profile 的 `agent-default-model` 条目 → 之后一直是这个档，直到下次改。
- 实测证据：设 `low` 后，会话日志下一条 `request/header` 里 `reasoningEffort` = `low`
  （`sessions/…/session.v4.jsonl.zstd`，多帧 zstd 要逐帧解）。
- 深档只有三档 + off：`deepseek-flash` 的 `reasoningEfforts` = low / high / max。

## 何时用哪一档

| 档 | 判据（满足其一） | 典型 |
|---|---|---|
| **low** | 只是取数/看一眼/搬运；不需要权衡 | 查用量、看通知、读文件、列目录、翻译、设提醒、简单发消息 |
| **high** | 默认。多步操作、要读代码、要判断但路径清楚 | 常规改代码、写文档、排简单报错、跑脚本 |
| **max** | 不可逆或代价高；要在两个方案里取舍；要说服自己"没编" | 装机/发版/删改数据、内核与协议改动、架构设计、根因分析、会审、写进记忆的"事实" |

判错只差一档，**宁可判高**（low 判错会误事，max 判错只是多花几分钱）。

## 纪律

1. **一轮只切一次**，在动手前切；`tier.mjs` 自带"同档不重复写"的判断。
2. 任务变重/变轻**可以中途切**（下一步就生效），但别来回抖。
3. 一轮结束回到 **high**（休息档），别把 `max` 留在默认位上烧钱。
4. 切换会写 profile 文件（`profiles/web/cordis.patch.yml`）—— 这是**预期**，也是它持久的原因；
   不要手改那个文件里的 effort，走 `tier.mjs`。
5. 子代理（subagent）默认**继承父档**；想让子代理单跑更低/更高的档，
   要在 `dsh-tool-subagent` 上开 `modelSelectionSettings: true`（**需重启引擎**，见中枢总计划 H2）。

## 省钱账（为什么值得做）

账单 ≈ 上下文 × 轮次，其中思考 token 按输出价计。日常大量轮次是"取数型"，
放在 `max` 上纯属浪费；反过来把架构/发版放在 `low` 上，判错一次的返工比省下的贵得多。
