---
name: dsh-mobile
description: 在这台安卓手机上"用 App 干活"的通用方法：读屏/点击/输入/手势/起 App/文件/剪贴板/通知/定时/虚拟屏。任何"帮我在某个 App 里做某事"的任务都先加载它。内含省 token 的硬规矩（别 dump 整屏、能走数据就不点界面）。
whenToUse: 任务涉及操作手机上的其他 App（微信/QQ/飞书/WPS/浏览器/设置等），或需要在手机本地读写文件、发通知、定时执行、跨 App 串流程时。
---

# 安卓手机自动化（DSH 内嵌版）

## 三个通道（按优先级用）

1. **免特权通道**（永远可用）：文件系统（`/sdcard` 全读写）、剪贴板、`android_notify`、定时任务、
   以及两个 HTTP 桥 —— 引擎 `127.0.0.1:3080`、App 桥 `127.0.0.1:3081`。
2. **无障碍桥** `http://127.0.0.1:3181`（不需特权，但用户必须开着「屏幕助手」）：
   `/status` `/dump` `/tap?text=`   ⚠️ **`/find` 实测不存在**（2026-10-03 核，返回「未知路由」）——要定位控件只能 `/dump` 后自己筛；筛选放在脚本里不花钱，把 dump 读进模型才花钱 `/input?text=` `/back` `/home` `/scroll?direction=` `/swipe`
   `/hold` `/touch` `/gesture` `/screenshot` `/open-file` `/notifications*`
3. **特权通道**（Shizuku，**每周有 4 天不可用**）：`shizuku_shell`、`pm`、`am`、`dumpsys`、
   虚拟屏、读 `Android/data/<包名>`（微信收到的文件就在这里）。

## ⛔ 省 token 的硬规矩（违反 = 账单翻几倍）

- **不要为了"看一眼"就 `/dump`**：一屏常有 600+ 节点。要点击就直接 `/tap?text=发送`；
  要确认/定位控件：**桥没有 `/find`**，只能 `/dump` 后自己筛（**在脚本里筛**，别把整树读进上下文）。
- **能走数据就绝不点界面**：文件、剪贴板、Intent、HTTP 优先；UI 只用在"非点不可"的地方
  （发消息、点"接收"、点"用其他应用打开"）。
- **第二遍必须固化成脚本**：同一件事做过一次就写进本技能 `scripts/` 或
  `/sdcard/DeepSeekHarness/skills-local/`，下次一条命令跑完，不让模型重新拆步骤。
- **一次拿全**：合并读屏、合并确认，不要"点一下读一次"。

## 纪律

- **不可逆动作（发送/删除/支付）默认停在「草稿 + 用户确认」**；白名单可免（配置在
  `/sdcard/DeepSeekHarness/config/`，个人数据，不进包）。
- **发消息前必须核对收件人姓名**；发送后截图回证。
- **前台是游戏 / 全屏应用时不许动主屏**：不要 tap/swipe/back/home，也不要为了"看一眼"截图或
  切前台。**别靠包名清单判断** —— 动手前先看前台是什么（`GET http://127.0.0.1:3181/status`
  的 `package` 字段，或 `android_a11y_status`）；自绘界面（节点数很小甚至为 0）同样按"游戏"对待。
  想长期排除某几个 App，把包名写进用户自己的配置，**别写死在技能里**。
- **长任务优先虚拟屏**（需特权），跑完用 `android_notify` 汇报。
- **不要在手机上前台跑重编译**；出包/装机类重活留给用户在场时做。

## 常用配方

- **取微信收到的文件**：先看 `Download/WeiXin`（免特权，用户点过"保存到手机"的都在这里）；
  没有再看特权通道下的 `/sdcard/Android/data/com.tencent.mm/MicroMsg/Download`；
  两条都不行就提示用户点一次"保存到手机"。
- **给某人发消息**：`/tap?text=<联系人>` → `/dump` 脚本内过滤核对 → `/input?text=<内容>`
  → **确认闸门** → `/tap?text=发送` → `/screenshot` 回证。
- **文档整理**：不要点 WPS 界面。xlsx/docx/pptx 本质是 zip+XML，用 python 标准库直接读改
  （需要更强能力时 `pip install openpyxl python-docx`）。
- **定时/提醒**：`android_schedule`（AlarmManager，关掉 App 也会触发）。
