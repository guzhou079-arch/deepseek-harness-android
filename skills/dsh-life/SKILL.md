---
name: dsh-life
description: DSH 智能生活与通知中枢：包含验证码自动提取与复制、微信/支付宝/各银行动账自动记账、快递取件码聚合、以及系统级定时任务调度 (Cron & AlarmManager)。用于“查验证码”、“看账单/记账”、“查快递”、“管理定时任务”等需求。
whenToUse: 当用户询问最近收到的验证码、查询消费账单、查看待取快递包裹、或者需要设置定时任务/提醒时使用。
---

# DSH 智能生活与通知中枢 (Life & Notification Hub)

用于管理生活流感知与定时自动化，底层基于本地 SQLite 数据库 `/sdcard/DeepSeekHarness/life.db` 与通知流监听守护进程。

## 一、CLI 快速查询与操作

CLI 入口脚本：`node /sdcard/DeepSeekHarness/tools/life.js`

### 1. 验证码查看与复制
```sh
node /sdcard/DeepSeekHarness/tools/life.js code           # 查看最近 10 条验证码
node /sdcard/DeepSeekHarness/tools/life.js code --copy   # 复制最新一条验证码到剪贴板
```

### 2. 动账流水与记账
```sh
node /sdcard/DeepSeekHarness/tools/life.js bill today    # 查看今日支出/收入流水与汇总
node /sdcard/DeepSeekHarness/tools/life.js bill month    # 查看本月消费分类统计（餐饮、购物、交通等）
node /sdcard/DeepSeekHarness/tools/life.js bill add --amount 25.0 --merchant "瑞幸" --cat "餐饮" --type expense
```

### 3. 待取快递管理
```sh
node /sdcard/DeepSeekHarness/tools/life.js pkg list      # 查看待取包裹与取件码清单
node /sdcard/DeepSeekHarness/tools/life.js pkg pick <ID或取件码> # 标记包裹已取件
```

### 4. 定时自动化任务 (Cron & AlarmManager)
```sh
node /sdcard/DeepSeekHarness/tools/life.js cron list     # 列出当前所有定时任务
node /sdcard/DeepSeekHarness/tools/life.js cron add --id task1 --name "早报" --expr "daily:08:30" --type builtin --payload "morning_brief"
node /sdcard/DeepSeekHarness/tools/life.js cron rm task1 # 删除定时任务
```

### 5. 守护进程状态与扫描
```sh
node /sdcard/DeepSeekHarness/tools/life.js status        # 查看中枢守护状态与今日数据
node /sdcard/DeepSeekHarness/tools/life.js daemon start  # 启动后台守护
node /sdcard/DeepSeekHarness/tools/life.js scan 50       # 回溯扫描最近 50 条历史通知
```

## 二、自动触发与后台闭环

1. **验证码全自动闭环**：收到短信/App通知时，后台守护自动匹配验证码，直接写入系统剪贴板并弹窗提示，用户切到目标 App 直接粘贴即可。
2. **动账静默入库**：微信支付、支付宝、各银行卡消费/收入自动解析商户与金额并归类入库。
3. **定时任务双重保障**：引擎在线时毫秒级 Node 定时触发；引擎休眠时同步向 Android AlarmManager 注册闹钟拉起。
