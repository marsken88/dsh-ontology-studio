# 测试

什么被测过、测得有多细。写路径的测试全部在临时目录里跑，不会改动仓库里的 assets/。

> 本文是 [README](../README.md) 的展开篇。

## 测试

```bash
npm test        # 二十七组，共 366 项断言
```

| 文件 | 覆盖 |
| --- | --- |
| `test/ir.test.cjs` | 27 项：Schema 语义、每类错误各一条、未知字段（含拼写错误）、影响分析、仓库读目录 |
| `test/context.test.cjs` | 10 项：简报内容、级别差异、稳定逐字一致、超长降级与截断 |
| `test/reverse.test.cjs` | 16 项：类型映射、命名归一、表名单数化、主键回退、关系推断、重复列、预校验、工具不写盘 |
| `test/concurrency.test.cjs` | 10 项：etag 稳定性、CAS 成功/过期、写锁不产出半截文件、五路并发全部成功且不丢数据、显式 ifEtag 仍拒绝过期写入 |
| `test/rules.test.cjs` | 19 项：表达式求值、语法拒绝代码注入、规则归属推导、违规行 |
| `test/actions.test.cjs` | 24 项：入参校验、effect 声明校验、赋值与增量、跨对象调拨（数量守恒）、规则回验、审批拒绝不写盘 |
| `test/export.test.cjs` | 9 项：类型映射、必填与主键、enum、money、、文档五节、动作可执行标记、工具不写盘 |
| `test/sample.test.cjs` | 14 项：类型推断、主键优先 id 再 *No 再 *Id、外键推关系、嵌套抽取、逐字稳定 |
| `test/focus.test.cjs` | 9 项：文本提取、id/中文名/属性名命中、排序与上限、无命中返回空 |
| `test/router.test.cjs` | 12 项：超长入参不回显、路径穿越只是 404、HEAD 无 body、非法方法 405、limit 夹取、请求体上限、原型不污染、除零与注入式表达式 |
| `test/durability.test.cjs` | 9 项：旧 etag 被拒、同 etag 并发只有一成功、十路并发不丢数据、无临时文件残留、改名失败时原文件完好 |
| `test/robust.test.cjs` | 10 项：空包/空对象/emoji 不崩、简报严格不超上限、悬空规则告警、坏表达式、工具层集成 |
| `test/lint.test.cjs` | 6 项：正则与 equals 规则、非法规则报错、只报建议不影响 ok |
| `test/diff.test.cjs` | 10 项：逐条定位变更、属性增删改、人读摘要、catalog 对比、升级落盘与留痕、无新版本拒绝、审批拒绝不写盘 |
| `test/agents.test.cjs` | 9 项：花名册校验、坏引用、id 规范、按 agent 归属、失败计数、未声明会话计入 unattributed |
| `test/app.test.cjs` | 12 项：每对象一页、数值右对齐、枚举 badge、筛选派生、表单来自 inputSchema、只有声明不生成表单、逐字稳定 |
| `test/registry.test.cjs` | 12 项：catalog 状态、依赖缺失拒绝安装、重复安装、被依赖拒绝卸载、先卸依赖方、工具层贯通 |
| `test/history.test.cjs` | 6 项：各类写入留痕、版本号跟随、失败不留痕、过滤与上限、关闭历史 |
| `test/tools.test.cjs` | 24 项：激活、`ctx.effect` 挂载、二十八个工具端到端、只读模式只剩十九个读工具、上下文段落与 pre-step 监听注册、缺少可选服务时照常工作、自检报告 |
| `test/write.test.cjs` | 32 项：对象与关系的增改删、级联、审批闸门、校验失败不落盘、`dryRun` 返回值符合 output schema、版本递增、发布拒绝 |
| `test/api.test.cjs` | 19 项：六条路由、400/404/405/500、只读与审批标记、面板上报、目录缺失 |
| `test/e2e.test.cjs` | 12 项：整条链路按真实使用顺序跑一遍（现状→建模→执行→回收→轨迹），验证各工具彼此自洽 |
| `test/evals.test.cjs` | 11 项：条件指纹可复现、三种可比组合、规则与数据双变被拒、跨包不比较 |
| `test/harness.test.cjs` | 10 项：六方面覆盖、空包全指出、无主键/孤立对象/全免审批/Agent 三项缺失分别点名 |
| `test/panel-writes.test.cjs` | 23 项：CSRF 拒绝跨站、校验失败不落盘、级联清理、关系与规则的增删、只读拒绝 |
| `test/focus-wire.test.cjs` | 8 项：pre-step 观察后简报真的多一行、换一句话换聚焦、监听器永远放行 |
| `test/render-smoke.cjs` | 九个页面渲染 + 实时数据通路（live model） |

写路径的测试全部在临时目录里跑，**不会改动仓库里的 `assets/`**。
