# 从 Harness² 借来的一个思路

[google-research/harness2](https://github.com/google-research/harness2)（Harness²: Recursive Agent Harnessing for an Open World）研究的是**递归优化 Agent 周围的 harness**：把 prompt、guardrails、memory、tool guidance、subagents、skills、scripts、plugins 八个组件当作可编辑对象，用 Propose–Probe–Compose 迭代改进。

本项目**没有**实现它的核心机制——那需要跑模型、做基准评测、维护改进 harness，和「本体资产平台」不是一回事。硬套会变成两套东西都不成立。

借的是它的一句判断：**Agent 的能力上限取决于它周围的 harness，而不只是模型**。

据此加了一个工具：`ontology_harness_check`。

## 它做什么

回答一个问题：**这份本体作为某个 Agent 的底座，还缺什么？**

六个方面逐项检查，全部从文件里算出来，不打分、不猜：

| 方面 | 检查什么 | 缺口示例 |
| --- | --- | --- |
| 结构 | 主键、属性、是否孤立 | `2 个对象没有任何关系：Supplier, Member` |
| 规则 | 有没有规则、多少条停用 | `一条规则都没有` |
| 动作 | 可执行比例 | `4 个动作都只有声明，没有一个可执行` |
| 护栏 | 可执行动作是否都有审批、审批动作是否有策略 | `所有可执行动作都不需要审批` |
| 数据 | 事实数据覆盖 | `没有任何事实数据` |
| Agent | 花名册是否声明了对象/工具/评测口径 | `巡店助手 Agent 没写评测口径` |

每条缺口都带「怎么补」，不是只告诉你"有问题"。

随包资产的体检结果：

```
✓ retail.store-inventory 六个方面都齐了（6/6）
注意：1 条规则处于停用状态：inventory.autoReplenish
注意：4 个动作里只有 3 个可执行
注意：1 个需审批动作没有对应的策略声明：createReplenishment
注意：6 个对象里只有 3 个有数据
```

**「就绪」不等于「没问题」**——所以缺口和提示分开列：缺口是「缺一块」，提示是「有但不完整」。

## 为什么不做那三件事

Harness² 有三样东西很吸引人，这里明确不做：

1. **自动改写 harness**：需要评测基准和回滚机制。没有基准自动改，就是自动把东西改坏。
2. **对比执行推断改动**（contrastive evidence）：需要同一任务跑多遍并比对行为。本插件不执行任务，只做建模与执行器。
3. **基准评测流水线**（judge / report）：那属于评测平台，不属于本体工作台。

这些写在 README 的「不做什么」里，免得以后有人问"为什么不像 Harness²"。
