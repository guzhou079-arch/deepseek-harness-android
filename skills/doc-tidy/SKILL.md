---
name: doc-tidy
description: 读取/汇总/改名 Office 文档（xlsx/docx/pptx）的零依赖方法：用标准库解 zip+XML，不点 WPS 界面。需要"看表格/取正文/统计行列/批量整理"时加载。含自测命令。
whenToUse: 任务涉及 xlsx/docx/pptx 的内容读取、表头识别、多表汇总、批量改名或生成汇报数据时（尤其文件来自微信/QQ/下载目录）。
---

# 文档整理（零依赖版）

**核心原则：能读文件就绝不点 WPS/Office 界面。** 界面操作脆弱、慢、还烧 token；文件是确定性的。

## 工具

`scripts/doc_tidy.py`（纯标准库，随包分发，无第三方依赖）：

```sh
PY=/data/user/0/com.deepseek.harness/files/payload/bin/python3
D=<本技能目录>/scripts/doc_tidy.py

$PY $D info  <文件>   # JSON：表名 / 行列数 / 表头 / 前 5 行预览
$PY $D text  <文件>   # 纯文本：xlsx→TSV，docx/pptx→正文
$PY $D selftest       # 自测（现场造样例并读回），改完脚本必跑
```

- `.xlsx/.xlsm/.docx/.pptx` ✅ 支持（含共享字符串、内联字符串、多表、tab/换行）
- `.doc/.xls/.ppt`（旧二进制）❌ → 提示用户"另存为 xlsx/docx"
- `.pdf` ❌ 本机无 pdf 库也无 pdftotext → 提示用户转格式，或（可选）`pip install pypdf`

## 标准流程

1. **先 info**（看有几张表、表头是什么），**再决定怎么整理** —— 不要一上来全量 dump 正文。
2. 汇总/改名/生成新表：写一个**一次性脚本**放在任务目录里，跑完把脚本路径报给用户
   （下次同类任务直接复用，模型不再参与 ⇒ 0 token）。
3. 改文件**另存为新文件**，不要就地覆盖原始文件（用户的数据不可逆）。
4. 产出后用 `$PY $D info <新文件>` 回读核对（"写完必回读"）。

## 与"聊天里的文件"衔接

微信/QQ 收到的文件通常先在 `/sdcard/Download/WeiXin`（用户点过"保存到手机"）→ 直接读；
没有则见技能 `dsh-mobile` 的三路 fallback。
