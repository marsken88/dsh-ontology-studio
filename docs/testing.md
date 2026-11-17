# 测试

什么被测过、测得有多细。写路径的测试全部在临时目录里跑，不会改动仓库里的 assets/。

> 本文是 [README](../README.md) 的展开篇。

## 测试

```bash
npm test        # 36 组，共 479 项断言
```

| 文件 | 覆盖 |
| --- | --- |
| `test/actions.test.cjs` | 25 项：（待补说明） |
| `test/agents.test.cjs` | 9 项：（待补说明） |
| `test/api.test.cjs` | 29 项：（待补说明） |
| `test/app.test.cjs` | 12 项：（待补说明） |
| `test/concurrency.test.cjs` | 10 项：（待补说明） |
| `test/context.test.cjs` | 10 项：（待补说明） |
| `test/datasource.test.cjs` | 5 项：CSV 解析（引号内逗号）、类型推断、列名归一、填充率、包生成 |
| `test/diff.test.cjs` | 11 项：（待补说明） |
| `test/durability.test.cjs` | 9 项：（待补说明） |
| `test/e2e.test.cjs` | 12 项：（待补说明） |
| `test/evals.test.cjs` | 11 项：（待补说明） |
| `test/export.test.cjs` | 9 项：（待补说明） |
| `test/focus-wire.test.cjs` | 8 项：（待补说明） |
| `test/focus.test.cjs` | 9 项：（待补说明） |
| `test/harness.test.cjs` | 10 项：（待补说明） |
| `test/history.test.cjs` | 6 项：（待补说明） |
| `test/ir.test.cjs` | 27 项：（待补说明） |
| `test/lineage.test.cjs` | 8 项：覆盖率、断点（摘掉 storage 后下游全列出）、孤立属性、坏表达式不崩 |
| `test/lint.test.cjs` | 6 项：（待补说明） |
| `test/metrics.test.cjs` | 12 项：五种聚合、0 与「空」分得开、口径校验、坏表达式不崩 |
| `test/observability.test.cjs` | 10 项：轨迹摘要、P50/P95、空输入返回 null、没有失败就不编 topFailing |
| `test/panel-writes.test.cjs` | 23 项：（待补说明） |
| `test/process.test.cjs` | 13 项：流程声明校验、推演链（动作影响后续检查）、onFail、no-match、级联清理 |
| `test/registry.test.cjs` | 14 项：（待补说明） |
| `test/reverse.test.cjs` | 16 项：（待补说明） |
| `test/robust.test.cjs` | 10 项：（待补说明） |
| `test/router.test.cjs` | 12 项：（待补说明） |
| `test/rules.test.cjs` | 19 项：（待补说明） |
| `test/sample.test.cjs` | 14 项：（待补说明） |
| `test/sync-tool.test.cjs` | 9 项：装包写同步状态、源文件改了怎么说清、applySchema 与审批、没有 CSV 来源不瞎猜 |
| `test/sync.test.cjs` | 11 项：内容指纹不吃拼接亏、列结构差异、首次/无变化/加行加列、人读一句话 |
| `test/tools.test.cjs` | 26 项：（待补说明） |
| `test/views-tool.test.cjs` | 18 项：视图工具端到端：声明/改/写错不落盘/带 view 读与导出/删除/级联清理/结构守卫 |
| `test/views.test.cjs` | 14 项：视图声明校验（属性名必须存在）、覆盖统计、投影后仍是合法包、规则越界进 leaks |
| `test/write.test.cjs` | 32 项：（待补说明） |
| `test/render-smoke.cjs` | 九个页面渲染 + 实时数据通路（live model）+ 卡片不重复渲染 |

写路径的测试全部在临时目录里跑，**不会改动仓库里的 `assets/`**。

## 部署后验收

单元与集成测试跑的是仓库里的代码；**部署到实例上之后代码到底对不对**，用这份脚本：

```bash
node scripts/acceptance.mjs --base http://192.168.120.218
node scripts/acceptance.mjs --base http://127.0.0.1:49430 --package retail.store-inventory
```

它只打只读接口，不改任何数据，可以随时对正在跑的实例跑。检查的是不变量而不是快照：
版本号存在、资产通过校验、指标都带参与行数、血缘覆盖率的分母等于实际属性数、
流程步骤数对得上、轨迹摘要与条目数一致。

失败会指出具体哪一条对不上，并以非零退出码结束——所以它也能拦住「部署了旧版本」
（实测：对停在旧版本的实例跑，`/lineage` 直接 404）。
