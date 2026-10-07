---
name: dsh-doc-publisher
description: Word / DOCX 专业商务与政企公文出版大师。一键生成大厂/政企标准排版 .docx 文档（带标准大标题、多级标题编号、正文字体/行距、自适应表格、规范页边距），支持直接在手机 WPS 与 Office 中打开，并提供可视化排版工作流与公文审计留痕卡片。
whenToUse: 用户需要生成标准 Word/DOCX 文档、撰写正式公文、技术立项报告、可行性方案、或商务合同时。
---

# Word / DOCX 商务与公文排版大师技能 (dsh-doc-publisher)

在手机端撰写正式公文、立项报告、商务提案或技术白皮书时，普通 Markdown 无法满足正式汇报的格式规范。本技能提供**零依赖、原生生成大厂与政企标准 `.docx` 文档**的能力，**严格执行排版工作流与公文留痕机制**。

---

## 🧭 可视化公文生成工作流 (Visual Publishing Flow)

每次排版与生成公文时，在回答中呈现标准的排版流向：

```mermaid
flowchart TD
    classDef step fill:#161b22,stroke:#58a6ff,stroke-width:2px,color:#f0f6fc;
    classDef style fill:#21262d,stroke:#bc8cff,stroke-width:2px,color:#f0f6fc;
    classDef docx fill:#21262d,stroke:#3fb950,stroke-width:2px,color:#f0f6fc;
    classDef audit fill:#21262d,stroke:#d29922,stroke-width:2px,color:#f0f6fc;

    Input["📥 原始大纲 / 纪要 / 提案草案"]:::step --> Struct["📑 结构化公文章节拆解 (一/1/(1))"]:::step
    Struct --> Style["🎨 规范样式注入 (微软雅黑/1.5倍行距/自适应表格)"]:::style
    Style --> Engine["⚙️ doc_publisher.py 零依赖打包生成"]:::docx
    Engine --> Card["📦 呈递 .docx 交付文件卡片 (present)"]:::docx
    Card --> Trace["📋 输出公文排版审计留痕卡片"]:::audit
```

---

## 🛠️ 核心交付规范

### 1. 结构与格式规范
- **一级大标题**：居中加粗，22pt 字号，主色深黑 (`#1F2328`)；
- **多级标题体系**：
  - 一级标题：如「一、 项目背景与建设目标」，16pt 加粗，科技蓝 (`#0969DA`)；
  - 二级标题：如「1.1 现有痛点与瓶颈分析」，14pt 加粗；
  - 三级标题：如「(1) 移动端协同延迟」，12pt；
- **正文与段落**：11pt 微软雅黑/Calibri，1.5 倍标准行距，段后间距 4pt；
- **表格规范**：浅灰表头底色 (`#F6F8FA`)、加粗表头、横向边框对齐。

### 2. 生成与呈递工具
调用 `/data/user/0/com.deepseek.harness/files/payload/dshhome/skills/dsh-doc-publisher/scripts/doc_publisher.py` 生成文件，并通过 `present` 工具呈递给用户。

---

## 📋 必带公文审计留痕卡片 (Doc Trace Card)

在交付物末尾，必须输出标准化的 **公文排版留痕卡片**：

```markdown
---
### 📑 公文出版审计留痕卡片 (Doc Publisher Trace Card)
- **文档编号**：`DOC-20261007-005`
- **文档标题**：`《DSH 移动端智能协同技术方案建议书》`
- **文档规格**：A4 标准纸张 · 1.5倍行距 · 微软雅黑/Calibri 字体 · 3 级标题体系
- **输出文件**：`/sdcard/Download/DSH_WorkLogs/DSH_移动协同方案.docx`
- **交付动作**：已通过 `present` 呈递，支持在手机 WPS / 电脑 Word 中即时打开
- **审计时间**：2026-10-07 19:10 (DSH Doc Publisher Engine)
---
```
