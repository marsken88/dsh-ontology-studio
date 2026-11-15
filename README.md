# Ontology Studio

> **怎么用**：[USAGE.md](USAGE.md) —— 面板点选 / Agent 对话，两种改法写的是同一份文件。

[![test](https://github.com/marsken88/dsh-ontology-studio/actions/workflows/test.yml/badge.svg)](https://github.com/marsken88/dsh-ontology-studio/actions/workflows/test.yml)

企业级 Ontology + Harness 平台的落地工程。目标不是做一个「本体建模页面」，而是：

> Ontology 是企业业务语义底座，Harness 是智能执行底座，Studio 是资产生产和管理入口，Marketplace 是能力复用机制，Governance 是平台运行保障。

本文的架构划分、八个 Studio 的职责边界与四阶段路线，依据内部的《Ontology Studio 平台建设规划：以 Harness 工程为核心》讨论稿整理。该文档属内部资料，不随本仓库分发（本地副本 `docs/plan-source.md` 已被 `.gitignore` 排除）。

## 当前状态：v0.35

| 部分 | 状态 |
| --- | --- |
| 平台骨架（八个 Studio + 统一导航） | ✅ 作为 Web GUI 的独立主面板 |
| 统一本体 IR + 正式 JSON Schema | ✅ `assets/ontology-ir.schema.json` |
| IR 校验器（结构 + 跨引用 + 未知字段 + 影响分析） | ✅ `lib/ir.mjs` 与 JSON Schema 严格度一致 |
| 只读资产仓库（目录即数据源） | ✅ `lib/store.mjs` |
| 模型编辑 | ✅ 九个写工具（对象/关系/规则/发布/删除/动作/市场），校验门禁 + 级联策略 |
| 版本递增与发布状态机 | ✅ `ontology_publish` |
| 面板 ↔ 宿主联通 | ✅ 面板读真实资产，断线自动回落到演示数据（升级后需强刷） |
| 能力门禁（只读模式） | ✅ `writeMode: readonly` 直接不注册写工具 |
| 逐次人工审批 | ✅ 写操作调用 Host 审批服务，非 `allowed-once` 一律失败关闭 |
| 规则求值 | ✅ 自有表达式求值器（不用 eval），在示例数据上真算违规 |
| 执行轨迹 | ✅ 每次工具调用落一行 JSONL，面板可读 |
| Action 执行器 | ✅ 入参校验 → 审批 → 单/多 effect（赋值或增量）→ 规则回验 |
| Context Engine | ✅ 本体简报注入系统提示，稳定且有界，写入后自动刷新 |
| 可视化定义 | ✅ 面板可新建/编辑/删除**对象、关系、规则**；图谱视图支持拖节点排版与拖拽建关系 |
| 面板实时化 | ✅ 九个页面全部读真实资产 |
| 并发控制 | ✅ 乐观锁（etag CAS）+ 文件写锁，丢失更新会明确报冲突 |
| 版本历史 | ✅ 每次写入追加一条 JSONL，可查「改过什么、在哪个版本」 |
| 反向建模 | ✅ 从表结构生成本体草稿：类型映射、命名归一、主键推断、关系建议、预校验 |
| 产物导出 | ✅ IR → JSON Schema（draft 2020-12）/ Markdown 参考文档 |
| 资产市场 | ✅ catalog 安装/卸载/升级，依赖不满足则拒绝（两个方向都拦） |
| 版本对比 | ✅ 任意两个包按条目对比：新增/删除/变更逐条列出 |
| 应用构建 | ✅ 从对象元数据生成页面规格：列/筛选器/操作表单 |
| Agent 花名册 | ✅ 声明在本体包里，调用数据来自执行轨迹（声明与证据分开） |
| 本体体检 | ✅ 六方面（结构/规则/动作/护栏/数据/Agent）逐项检查，缺口带「怎么补」 |
| 规则评测 | ✅ 记录条件指纹；规则与数据同时变化时拒绝比较 |
| 图存储、数据同步、联邦查询 | ❌ 未开始（规划为独立服务） |

为什么先做成 DSH 插件而不是独立 Web 应用：

| 维度 | DSH 插件 | 独立应用 |
| --- | --- | --- |
| 上线成本 | 装包即用，跟随现有 GUI 主题/布局 | 需域名、部署、登录、鉴权 |
| Agent 集成 | 宿主进程内直接注册工具，Agent 与界面同源 | 需要另做 MCP / API 网关 |
| 迭代速度 | 改文件即见效 | 前后端联调 + 发布流程 |
| 边界 | 适合平台控制平面与交互 | 数据平面、图存储仍需独立服务 |

结论：**界面与 Agent 能力做插件，重数据能力（图存储、同步、联邦查询）做独立服务**，二者用标准 API 对接。

## 安装

前置：**DSH 0.2.x**（Desktop 应用或 `dsh web`）。本仓库是一个 DSH 插件包：
`package.json` 声明 `dsh.bundle.patch` 与 `dsh.client`，`cordis.patch.yml` 把插件行插进 profile 花名册。

**本地开发安装**（已在 Windows 与 Linux 主机上验证）：

```bash
# profile 不存在时先按默认模板建一个

dsh --profile <profile名> --from-default-profile web

# 以 link 方式装入本仓库

dsh plugin --profile <profile名> add link:<本仓库路径>

# 起宿主

dsh --profile <profile名> web
```

装好后左侧栏会出现 **Ontology Studio** 入口。

两点必须知道：

- **宿主半不会热重载**。改了 `index.js` 要先重启宿主；桌面版可以把插件开关关一次再打开，
  效果等同重载（`ontology_diagnostics` 里的「版本一致」会告诉你现在跑的是哪一版）。
- **客户端包会被浏览器缓存**。升级后如果面板显示「演示数据」，按 `Ctrl+Shift+R` 强刷。

## 三分钟上手

装好之后，四种最常见的动作：

**1. 先看有什么**

```
ontology_list
→ retail.store-inventory v1.0.0 (published) — 6 对象 / 5 关系 / 4 规则 / 4 动作
```

**2. 在面板里改本体**（人工操作，不走审批）

左侧栏 → Ontology Studio → **本体模型**：

- `+ 新建对象` 建一个对象，属性表逐行填字段
- 对象详情里 `+ 新增关系` 连到另一个对象
- `图谱视图` 看全貌：拖节点排版，从节点右侧圆点拖到另一个节点直接建关系

保存前会按整个资产包校验，错误直接列在表单下面，**磁盘不会被动**。

**3. 在面板里跑规则**（只读）

逻辑与动作页 → `在示例数据上跑一次`，就地看到几处违规、涉及哪几条规则。

**4. 让 Agent 做**（写操作弹审批）

```
你：这条规则改成 error 级别
你：改完 Inventory 之后要重新验哪些东西？
你：体检一下这份本体还缺什么
```

更多操作细节见 [USAGE.md](USAGE.md)。

## 工具速查

28 个工具（19 读 / 9 写）。按用途分组，逐条说明见[架构文档](docs/architecture.md)。

| 想做什么 | 用哪个 |
| --- | --- |
| 看有哪些包 / 看一个对象 | `ontology_list` · `ontology_get` |
| 校验 / 影响分析 / 回归清单 | `ontology_validate` · `ontology_impact` · `ontology_regression_plan` |
| 改模型 | `ontology_upsert_object` · `ontology_upsert_link` · `ontology_delete_object` · `ontology_delete_link` · `ontology_publish` |
| 跑规则 / 执行动作 | `ontology_evaluate_rules` · `ontology_execute_action` |
| 看事实数据 / 变更历史 | `ontology_records` · `ontology_history` |
| 从表结构或样例报文建草稿 | `ontology_draft_object` · `ontology_draft_from_payload` |
| 导出 / 生成页面规格 | `ontology_export` · `ontology_generate_app` |
| 资产市场 | `ontology_asset_catalog` · `ontology_install_asset` · `ontology_uninstall_asset` · `ontology_upgrade` · `ontology_diff` |
| Agent 与体检 | `ontology_agents` · `ontology_harness_check` |
| 效果评测 | `ontology_eval_run` · `ontology_eval_compare` |
| 装好没装好 | `ontology_diagnostics` |

所有写工具都遵循同一条不变量：**先构造「写完之后」的整包再校验，不通过就什么都不写**；都支持 `dryRun` 预览。

## 配置

全部配置项写进 profile 里这一行插件的 `config`：

```yaml
- id: dsh-ontology-studio
  name: dsh-ontology-studio
  config:
    assetsDir: E:/path/to/assets     # 资产目录，默认插件自带 assets/
    catalogDir: E:/path/to/catalog   # 可安装包目录，默认插件自带 catalog/
    writeMode: open                  # open（默认）| readonly：只读时写工具根本不注册
    approval: destructive            # never | destructive（默认）| all
    context: brief                   # off | brief（默认）| full
    contextMaxChars: 4000            # 简报字符上限
    trace: true                      # 执行轨迹开关
    traceFile: .ontology-traces.jsonl
    traceMaxLines: 500
    history: true                    # 变更历史开关
    historyFile: .ontology-history.jsonl
    panel: true                      # 面板健康上报开关
    evals: true                      # 规则评测运行日志开关
    evalFile: .ontology-evals.jsonl
    lintRules: []                    # 团队约定（只报建议，不阻断写入）
```

`lintRules` 的写法：

```yaml
    lintRules:
      - id: agent.published
        target: agent                # package | object | property | action | rule | agent
        field: status
        equals: published
        message: 上线的 Agent 状态必须是 published
      - id: object.naming
        target: object
        field: id
        pattern: ^[A-Z][A-Za-z0-9]*$
        message: 对象 id 必须 PascalCase
```

约定类检查**只出现在 `ontology_validate` 的建议里，不阻断写入**——一条团队约定不该能把平台卡死。

## 路线图

**阶段一 · 平台地基**
- [x] 统一导航壳 + 八个 Studio 的信息架构
- [x] 统一本体 IR 的正式 Schema
- [x] IR 校验器（结构 + 跨引用）与资产仓库
- [x] 读取 API（Agent 工具 + HTTP）
- [x] 写入路径：对象新增/替换、校验门禁、版本递增、发布状态
- [x] 面板消费宿主真实资产
- [x] 删除对象与关系维护（级联策略 + 整包校验）
- [x] 能力门禁：只读模式下写工具不注册
- [x] 逐次审批闸门：写操作前调用 Host 审批服务，失败关闭

**阶段二 · Harness 执行闭环**
- [x] Agent 能直接读本体（`ontology_*`）
- [x] 规则表达式求值：归属推导 + 在示例数据上算违规
- [x] 执行轨迹：每次工具调用落一行，面板可读
- [x] Context Engine（发现层）：本体简报注入系统提示，Agent 不必先试探
- [x] Context Engine（任务层）：每轮观察对话，在简报末尾追加一行「本轮可能相关」（纯增量，只加建议不改上下文）
- [x] Action 执行器：动作的入参校验、声明式副作用、执行与规则回验
- [x] 人工审批闸门串进业务动作流
- [x] 跨对象动作：一次调用改多行（调拨 = 调出扣减 + 调入增加）

**阶段三 · 资产与生态**
- [x] Asset Registry：依赖声明、安装/卸载/升级、版本对比
- [x] 校验器扩展点：`config.lintRules` 声明式团队约定（只报建议，不阻断写入）
- [ ] 连接器 / 评测器 / 组件的代码级 SDK —— 没有真实消费方之前不做，避免造空接口
- [x] 应用生成：由本体元数据生成页面规格（列 / 筛选器 / 操作表单）

**阶段四 · 智能化运营**
- [x] 反向建模（表结构 → 本体草稿）：确定性归一，理解交给模型
- [x] 从样例报文生成草稿：按值判类型、键名归一、主键与外键推断、嵌套对象抽出
- [ ] 直接从接口文档（OpenAPI / 文档正文）生成草稿 —— 需要模型解析，暂按「人贴一段样例 JSON」处理
- [x] 自动影响分析与回归清单：改一个对象后列出要重跑的规则、动作、关系、受影响 Agent 与产物
- [x] Agent 效果评测：按轨迹归因，给出每个 Agent 的调用量、成功率、声明了但没用过的工具
- [ ] 自动优化（自动改提示词/工具绑定）—— 需要评测基准与回滚机制，没做

## 设计原则（来自规划文档）

1. **元数据驱动**：新增业务对象不写实体类、不写 Controller、不写页面。
2. **模型即代码**：本体、规则、动作、Agent 均可 YAML/JSON 声明、走 Git、可 Diff。
3. **AI Native**：AI 参与资产创建到发布的每个阶段，但不绕过治理。
4. **一切皆可复用资产**：独立安装、依赖管理、版本升级、跨域复用。
5. **API First + Event Driven**：先定接口与事件，再建 UI。

## 深入阅读

README 只回答「这是什么、怎么装、怎么用、边界在哪」。想往下钻的：

| 文档 | 覆盖 |
| --- | --- |
| [架构：IR、三条通路与代码结构](docs/architecture.md) | 统一本体 IR、三条通路，同一份数据、目录结构、八个 Studio 与规划文档的对应关系 |
| [规则与动作](docs/rules-and-actions.md) | 规则真的能算、动作真的能执行 |
| [运行时：并发、轨迹、自检与评测](docs/runtime.md) | 执行轨迹、并发：丢失更新会报错，不会静默、装好没装好，一次调用确认 |
| [建模辅助：反向建模、应用生成与产物导出](docs/modeling.md) | 反向建模：表结构 → 本体草稿、一份 IR，两种产物、应用构建：从元数据生成页面规格 |
| [Agent 与资产流转](docs/agents-and-market.md) | Context Engine：进对话就懂这个本体、本体上下文 · 门店-商品-库存、Agent 花名册：声明 + 证据、资产市场：安装、卸载、依赖 |
| [测试](docs/testing.md) | 测试 |

## 已知边界

- **审批只在工具调用这一层**：闸门保护的是「Agent 通过工具改资产」。如果人直接编辑 `assets/*.ir.json`，当然不受审批约束——那本来就是模型即代码的入口。
- **审批需要有打开的 turn**：DSH 的审批请求必须被一个进行中的回合包住；在没有 turn 的上下文里调用会失败关闭（返回 `approval: 'unavailable'`）。
- **升级后要强刷页面**：浏览器会缓存客户端包，插件热重载后旧包仍在用，此时面板显示的是演示数据。按 Ctrl+Shift+R 强制刷新即可。
- **规则用 JS 数字**：`0.1 + 0.2 != 0.3`，字符串与数字比较会隐式转换。要精确得引入 decimal 类型，代价大于收益，故不做。
- **并发控制是单进程内的**：store.update() 把读-改-写整体放进文件锁，所以并发新增是排队而不是争抢；显式 ifEtag 保留 CAS 语义。多实例共享同一目录时仍没有分布式锁。
- **写入是原子的**：先写同目录临时文件再 rename，进程中途挂掉不会留下半截 JSON。
- **单包单目录**：只扫 `assetsDir` 一层，无多租户与工作空间隔离。
- **工具报错不等于没写盘**：宿主在执行之后校验返回值，返回结构不合法会报错，但副作用已经发生。写操作之后要用 ontology_records / ontology_history 回查，不要只看返回。
- **升级与对比只有工具入口**：面板的资产市场暂不提供升级按钮（写操作要走审批），ontology_diff / ontology_upgrade 需由 Agent 调用。
- **Agent 花名册是声明式的**：谁在用本体由人在 IR 里声明，不是自动发现的；轨迹只能证明「某个会话调用过」，会话与 Agent 的映射仍需人工维护。
- **反向建模有两种入口，都不是自动的**：`ontology_draft_object` 吃表结构，
  `ontology_draft_from_payload` 吃一段样例 JSON。OpenAPI 文档、文档正文、现有 SQL
  还不能直接喂进来——那需要模型解析，目前由人先贴一段样例。
- **任务层上下文是「加一行」，不是「缩小范围」**：`agent/pre-step` 观察本轮对话，
  在简报末尾追加一句「本轮可能相关：Inventory」。它不会裁剪掉别的对象——
  猜错只多一行建议，不会让答案缺料。真正按任务裁剪没做，那要改写进入每一步的消息，
  风险与收益不成比例。
- **规则只跑在示例数据上**：`store-inventory.records.json` 是手写的事实数据，没有接真实 POS / 库存库；`ontology_evaluate_rules` 证明的是「规则能算」，不是「线上库存准」。
- **四个动作里三个可执行**：`adjustInventory`、`createTransfer`、`startStocktake` 都声明了 `inputSchema` + `effect`；`createReplenishment` 只有定义。判断标准是「有没有声明 effect」，没有的动作会被直接列出，不会假装执行。
- **副作用只作用于示例事实数据**：动作改的是 `*.records.json`，没有回写 POS / 供应链系统。
