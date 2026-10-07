---
name: dsh-slides
description: 现代演示文稿 (PPTX) 自动化设计与生成技能。输入大纲或需求，一键生成结构清晰、排版专业、原生可编辑的 .pptx 文件（支持手机 WPS / 电脑 PowerPoint 直接打开编辑）。
whenToUse: 用户说「做个PPT / 生成演示文稿 / 做几页幻灯片 / 把这个报告做成PPT」时调用。
---

# 现代 PPTX 演示文稿设计技能 (ppt-design)

一句话：**告别纯文本大纲，一键生成真实可编辑的 `.pptx` 二进制演示文稿文件**。

## 🎯 核心设计规范

1. **结构化分页逻辑**：
   - **封面页 (Cover)**：大标题 + 副标题 + 演讲人/日期（深色高对比科技风 / 极简白风）。
   - **目录/框架页 (Agenda)**：3~4 个核心章节卡片。
   - **正文内容页 (Content)**：2~3 栏卡片对比、要点列表、或指标数据大字报（强调数字）。
   - **总结/致谢页 (Ending)**：核心结论复盘 + 感谢与 Q&A。

2. **视觉设计原则**：
   - **16:9 宽屏黄金比例**；
   - **字阶克制**：标题 28~36pt 加粗，正文 14~18pt，辅助说明 12pt；
   - **卡片化与呼吸感**：避免大段文字堆砌，采用圆角卡片、图标与短句提炼。

## 🛠️ 手机端零依赖生成机制

通过本技能内置的 `scripts/make_pptx.py`（使用 Python 标准 zipfile + XML 生成标准 Office Open XML 格式，无需臃肿依赖）：

```bash
python3 payload/dshhome/skills/ppt-design/scripts/make_pptx.py \
  --title "DeepSeek Harness 项目汇报" \
  --author "开发团队" \
  --output "/sdcard/DeepSeekHarness/demo.pptx" \
  --slides-json '[
    {"title": "项目背景与目标", "bullets": ["在安卓端构建自主编译、自进化的智能体", "解决外部网络风控与连接延迟", "打造高颜值内联交互与工具闭环"]},
    {"title": "核心技术突破", "bullets": ["全内网 IEPL 专线接入，90% 纯净度", "原生架构图与 PPTX 自动化引擎", "跨会话持久化记忆中枢 (mem.db)"]}
  ]'
```
