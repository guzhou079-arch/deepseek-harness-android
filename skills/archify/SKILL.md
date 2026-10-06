---
name: archify
description: 将代码项目、系统架构、业务逻辑画成高颜值、直观可视化的现代架构图。优先在当前聊天窗口内原生渲染（Mermaid / 内联 SVG），极致体验，绝不强迫用户跳出浏览器。
whenToUse: 用户说「画个架构图 / 项目结构图 / 系统设计图 / 数据流图」或需要向用户清晰展示复杂代码、系统依赖关系时。
---

# 现代高颜值架构图技能 (archify)

一句话：**当前聊天窗口内原生内联呈现是第一公民！绝不让用户多走一步跳到外部浏览器**。

## 🎯 核心体验准则

1. **零跳转交付（顶级产品体验）**：
   - **首选方式**：直接在回答中使用标准 **`mermaid` 代码块** 渲染高颜值图表（流光配色、清晰层级、模块分组）。
   - **辅助方式**：若需要更细腻的毛玻璃视觉，直接内联输出 **SVG 矢量卡片**。
   - **禁止行为**：禁止让用户复制本地链接去外部浏览器打开，除非用户主动明确要求导出独立文件。

2. **架构图结构化规范**：
   - **自顶向下 / 业务流向清晰**：接入层 (UI/Client) ➔ 核心层 (Engine/Core) ➔ 工具与能力层 (Tools/Bridges) ➔ 基础设施与存储 (Storage/Network)。
   - **模块高亮配色**：
     - 📱 交互/客户端层：天蓝 / 灰蓝 (`#58a6ff`)
     - 🧠 核心引擎/中枢：深蓝 / 核心紫 (`#388bfd` / `#bc8cff`)
     - ⚙️ 工具与执行层：翠绿 (`#3fb950`)
     - 💾 存储与记忆层：深紫 / 琥珀 (`#d29922`)

## 🛠️ 标准输出范式（Mermaid 示例）

```mermaid
flowchart TD
    classDef client fill:#21262d,stroke:#58a6ff,stroke-width:2px,color:#f0f6fc;
    classDef core fill:#161b22,stroke:#bc8cff,stroke-width:2px,color:#f0f6fc;
    classDef tool fill:#161b22,stroke:#3fb950,stroke-width:2px,color:#f0f6fc;
    classDef data fill:#161b22,stroke:#d29922,stroke-width:2px,color:#f0f6fc;

    subgraph 📱 接入层
        App["Web GUI / 手机交互"]:::client
    end

    subgraph 🧠 核心层
        Agent["DSH 智能调度中枢"]:::core
    end

    subgraph ⚙️ 能力与存储
        Ops["安卓自动化工具链"]:::tool
        DB["mem.db 记忆中枢"]:::data
    end

    App ==> Agent
    Agent --> Ops
    Agent <--> DB
```
