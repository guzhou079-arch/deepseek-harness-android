---
name: dsh-doc-search
description: 手机本地代码仓库、技术文档、配置文件与日志的秒级轻量级索引与精准智能检索（Local Code & Doc RAG）。用于“帮我查一下源码里怎么写的”、“检索本地文档”、“针对某个项目进行代码问答”等需求。
---

# 本地文档与代码库智能检索技能 (`dsh-doc-search`)

本技能为 DSH 安卓端提供了零第三方依赖的本地知识库秒级分块与高精度智能问答检索能力。

知识库索引文件存放在 `/sdcard/Download/DSH_Knowledge/`。

## 常用操作

> 脚本位置：优先使用随包分发的 `<本技能目录>/scripts/rag.mjs`，或 `/sdcard/DeepSeekHarness/tools/rag.mjs`。

### 1. 为指定目录/代码仓建立知识库
```bash
node <本技能目录>/scripts/rag.mjs index <目录路径> [--name 知识库名称]
```
- 自动过滤 `node_modules`、`.git`、`build` 等冗余目录，提取所有源码与 Markdown/文本文件分块切片。

### 2. 查看所有已有知识库
```bash
node <本技能目录>/scripts/rag.mjs list
```

### 3. 多维关键词/语义检索
```bash
node <本技能目录>/scripts/rag.mjs search "<查询内容/函数名/报错信息>" [--kb 知识库名称]
```

### 4. 获取 AI 问答参考上下文
```bash
node <本技能目录>/scripts/rag.mjs context "<问题>" [--kb 知识库名称]
```
- 直接输出结构化 Markdown 上下文代码段与行号，供 AI 精准分析作答。
