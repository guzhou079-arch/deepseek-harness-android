---
name: dsh-code-craft
description: 深度代码工程、架构设计、PR 审查与重构大师。覆盖 5 维代码审查（安全/并发/内存/兼容性/坏味道）、重构 Diff 生成、全场景单元测试与 Mock 打桩，并在交付时自动输出可视化分析流程与工作留痕审计卡片。
whenToUse: 用户需要 Code Review、重构代码、分析架构缺陷、编写单元测试、或审查 Git Diff / PR 时。
---

# 深度代码工程与架构评审技能 (dsh-code-craft)

当面对代码审查、系统重构、编写测试或排查深度缺陷时，本技能提供工业级、大厂标准的工程交付物，**严格执行可视化分析流程与工作留痕机制**。

---

## 🧭 可视化工作流程 (Visual Workflow)

每次执行代码审查或重构时，首先在回答中内联呈现标准推导流程：

```mermaid
flowchart TD
    classDef step fill:#161b22,stroke:#58a6ff,stroke-width:2px,color:#f0f6fc;
    classDef audit fill:#21262d,stroke:#3fb950,stroke-width:2px,color:#f0f6fc;
    classDef risk fill:#21262d,stroke:#f85149,stroke-width:2px,color:#f0f6fc;

    Input["📥 代码 / Diff 输入与语义建模"]:::step --> Scan["🔍 5 维工程矩阵扫描"]:::step
    Scan --> Sec["1. 安全合规 (注入/溢出/权限)"]:::risk
    Scan --> Perf["2. 性能与内存 (GC/死锁/竞态)"]:::risk
    Scan --> Compat["3. 向后兼容性 (API漂移/破坏)"]:::risk
    Scan --> Clean["4. 代码坏味道与架构坏损"]:::risk
    Scan --> Test["5. 边界值与单测覆盖"]:::risk
    
    Sec & Perf & Compat & Clean & Test --> Output["📦 重构 Diff / 单元测试输出"]:::step
    Output --> Audit["📋 生成工作留痕审计卡片 (Audit Card)"]:::audit
```

---

## 🛠️ 核心交付规范

### 1. 5 维工业级 Code Review 评审单
必须对目标代码进行 5 大维度评定并给出打分（⭐ 1~5 分）与逐行风险定位：
- **安全与合规性**：有无 SQL/命令注入、反序列化、未授权访问、敏感信息泄漏；
- **并发与性能**：有无竞态条件 (Race Condition)、死锁风险、线程安全漏洞、CPU/内存暴涨或 GC 停顿；
- **架构与向后兼容**：接口变更是否破坏老版本客户端调用、有无违反开闭原则、模块强耦合；
- **代码整洁度与坏味道**：是否有超长方法、重复代码 (DRY)、魔法数字、反模式设计；
- **测试与可维护性**：异常分支是否可测、有无边界条件遗漏。

### 2. 生产级重构方案 (Refactor Diff)
- 使用标准 Unified Diff 格式清晰展示修改前后对比；
- 明确写出重构动机（提高内聚、消除副作用、降低圈复杂度）。

### 3. 全路径覆盖率单元测试 (Unit Tests)
- 覆盖 **正常路径 (Happy Path)**；
- 覆盖 **极端边界条件 (Edge Cases)**：`null`、空字符串、极大数值溢出、超时重试；
- 覆盖 **异常分支 (Exceptions)**：断言预期的异常抛出；
- 提供清晰的 Mock 数据与桩函数。

---

## 📋 必带工作留痕卡片 (Artifact Trace Card)

在每次交付物末尾，必须输出标准化的**工作留痕卡片**：

```markdown
---
### 📌 工作留痕审计卡片 (Code Craft Audit Card)
- **任务编号**：`CC-20261007-001`
- **审查对象**：`OrderPaymentService.java` (L45-L180)
- **风险评级**：`🟡 中危 (Medium Risk)`（发现 1 处并发幂等隐患，2 处异常未捕获）
- **主要决策**：
  1. 引入分布式锁/数据库乐观锁解决订单重复扣款风险；
  2. 提取公共校验逻辑至 `PaymentValidator` 消除重复代码；
  3. 补齐 5 组边界单测，分支覆盖率由 42% 提升至 95%。
- **生成时间**：2026-10-07 18:40 (DSH Code Craft Engine)
---
```
