# Ontology Studio

企业级 Ontology + Harness 平台的落地工程。目标不是做一个「本体建模页面」，而是：

> Ontology 是企业业务语义底座，Harness 是智能执行底座，Studio 是资产生产和管理入口，Marketplace 是能力复用机制，Governance 是平台运行保障。

本文的架构划分、八个 Studio 的职责边界与四阶段路线，依据内部的《Ontology Studio 平台建设规划：以 Harness 工程为核心》讨论稿整理。该文档属内部资料，不随本仓库分发（本地副本 `docs/plan-source.md` 已被 `.gitignore` 排除）。

## 当前状态：v0.2

| 部分 | 状态 |
| --- | --- |
| 平台骨架（八个 Studio + 统一导航 + 演示数据） | ✅ 可运行，作为 Web GUI 的独立主面板 |
| 统一本体 IR + 正式 JSON Schema | ✅ `assets/ontology-ir.schema.json` |
| IR 校验器（含跨引用检查） | ✅ `lib/ir.mjs`，23 项测试 |
| 只读资产仓库（目录即数据源） | ✅ `lib/store.mjs` |
| Agent 工具 `ontology_*` | ✅ 四个工具，13 项测试 |
| 持久化 / 写操作 / 权限 / 审批执行 | ❌ 未开始 |

为什么先做成 DSH 插件而不是独立 Web 应用：

| 维度 | DSH 插件 | 独立应用 |
| --- | --- | --- |
| 上线成本 | 装包即用，跟随现有 GUI 主题/布局 | 需域名、部署、登录、鉴权 |
| Agent 集成 | 宿主进程内直接注册工具，Agent 与界面同源 | 需要另做 MCP / API 网关 |
| 迭代速度 | 改文件即见效 | 前后端联调 + 发布流程 |
| 边界 | 适合平台控制平面与交互 | 数据平面、图存储仍需独立服务 |

结论：**界面与 Agent 能力做插件，重数据能力（图存储、同步、联邦查询）做独立服务**，二者用标准 API 对接。

## 统一本体 IR

`assets/store-inventory.ir.json` 是「门店—商品—库存」资产包，`assets/ontology-ir.schema.json` 是它的正式 Schema（JSON Schema 2020-12）。设计要点：

- **一份 IR 驱动所有下游**：可视化模型、查询 API、Agent 工具定义、校验规则、测试用例都由它派生；
- **Schema 管形状，代码管引用**：JSON Schema 表达不了「主键必须是已声明属性」「关系端点必须存在」「动作写入的对象必须存在」「策略只能指向已定义动作」，这些在 `lib/ir.mjs` 里检查；
- **命名即约束**：包 id `域.名称`、对象 `PascalCase`、属性 `camelCase`、关系 `snake_case`、规则与策略 `域.名称`，写错就会被校验器拦下。

校验可以单独跑：

```bash
node test/ir.test.cjs      # 23 项：Schema 语义 + 跨引用 + 影响分析 + 仓库读取
```

## Agent 工具

宿主半注册了四个只读工具，Agent 可以直接读本体，而不是靠人贴文档：

| 工具 | 作用 | 典型提问 |
| --- | --- | --- |
| `ontology_list` | 列出所有资产包及其对象/关系/规则/动作数量与校验状态 | 「我们有哪些本体？」 |
| `ontology_get` | 读一个包；带 `objectId` 时返回该对象的属性、关系、相关规则与动作 | 「库存对象有哪些字段？能做什么动作？」 |
| `ontology_validate` | 校验结构与跨引用，返回带路径的精确问题列表 | 「改完了，帮我查有没有断链」 |
| `ontology_impact` | 对某个对象做影响分析：下游关系、规则、动作、审批策略 | 「改 availableQty 会影响什么？」 |

`ontology_get` 对 `Inventory` 的实际输出：

```
门店-商品-库存 / 库存 (Inventory)
门店 + SKU 维度的可售库存快照。
属性：
  - storeId（门店编号）: string 必填
  - skuId（SKU 编号）: string 必填
  - availableQty（可售数量）: number
  - safetyStock（安全库存）: number
  ...
关系：belongsTo → Store, references → Product
可用动作：adjustInventory(需审批), createTransfer(需审批), startStocktake
```

资产目录通过 `config.assetsDir` 覆盖；未配置时读包内的 `assets/`。目录里的每个 `*.ir.json` 就是一份资产，**改文件即全部部署步骤**。

```bash
node test/tools.test.cjs   # 13 项：激活、注册、四个工具的输入输出与降级路径
```

## 目录结构

```
dsh-ontology-studio/
├─ package.json            # bundle 清单：dsh.bundle.patch + dsh.client
├─ cordis.patch.yml        # 把插件行插入 profile 花名册
├─ index.js                # 宿主半：读取/校验本体，注册四个 ontology_* 工具
├─ lib/
│  ├─ ir.mjs               # IR 校验器、统计、影响分析（纯函数，无依赖）
│  └─ store.mjs            # 资产仓库：扫目录、按 mtime 缓存、变更即重校验
├─ client.js               # 浏览器半：主面板 + 侧栏入口 + 八个 Studio
├─ assets/
│  ├─ ontology-ir.schema.json      # IR 的正式 JSON Schema
│  └─ store-inventory.ir.json      # 零售示例资产包
├─ test/
│  ├─ ir.test.cjs          # 校验器 / 影响分析 / 仓库
│  ├─ tools.test.cjs       # 宿主半激活与工具端到端
│  └─ render-smoke.cjs     # 九个页面的渲染冒烟测试
├─ locale/{en,zh}.json     # 插件管理页的标题、描述、详情文档指向
├─ icon.svg
└─ docs/
   ├─ DETAIL.md            # 插件详情页正文
   └─ plan-source.md       # 规划原文（需求基线）
```

## 八个 Studio 与规划文档的对应关系

| 规划文档 | 本仓库落点 |
| --- | --- |
| Ontology Model Studio（对象/属性/关系/动作、多视角、影响分析） | `client.js` → `OntologyPage` + `assets/store-inventory.ir.json` |
| Data Studio（同步型 / 联邦型并存、字段映射） | `DataPage` |
| Logic & Action Studio（规则、函数、动作、审批闸门） | `LogicPage` |
| Agent & Harness Studio（Ontology-aware 上下文与工具） | `AgentPage` + `index.js` 的四个工具 |
| App Studio（应用依赖本体而非表结构） | `AppPage` |
| Governance Center（ID/版本/责任人/审核/审计） | `GovernancePage` |
| Marketplace（三层资产、安装与复用） | `MarketplacePage` |
| Observability & Evaluation（Trace 与质量闭环） | `ObservabilityPage` |

## 路线图

**阶段一 · 平台地基**
- [x] 统一导航壳 + 八个 Studio 的信息架构
- [x] 统一本体 IR 的正式 Schema
- [x] IR 校验器（结构 + 跨引用）与只读资产仓库
- [x] 元数据读取 API（以 Agent 工具形式交付）
- [ ] 写入路径：对象/属性变更、版本递增、发布状态机
- [ ] 权限模型与审批闸门的真实执行

**阶段二 · Harness 执行闭环**
- [x] Agent 能直接读本体（`ontology_*`）
- [ ] Context Engine：按任务自动装配对象、关系、规则、可用动作
- [ ] Rule / Function / Action 执行与结果回验
- [ ] 人工审批闸门 + Trace 落盘

**阶段三 · 资产与生态**
- [ ] Asset Registry：依赖声明、影响分析、安装与升级
- [ ] Plugin SDK 与扩展点（连接器、校验器、评测器、组件）
- [ ] 应用生成：由本体元数据生成页面与表单

**阶段四 · 智能化运营**
- [ ] AI 反向建模（从表结构/接口/文档生成初始本体）
- [ ] 自动影响分析与回归测试生成
- [ ] Agent 效果评测与自动优化

## 设计原则（来自规划文档）

1. **元数据驱动**：新增业务对象不写实体类、不写 Controller、不写页面。
2. **模型即代码**：本体、规则、动作、Agent 均可 YAML/JSON 声明、走 Git、可 Diff。
3. **AI Native**：AI 参与资产创建到发布的每个阶段，但不绕过治理。
4. **一切皆可复用资产**：独立安装、依赖管理、版本升级、跨域复用。
5. **API First + Event Driven**：先定接口与事件，再建 UI。

## 已知边界

- **只读**：工具只读资产目录，不写回；面板也不保存任何状态。
- **无权限校验**：界面上标注的权限/审批是示意，不产生实际拦截。
- **单包单目录**：资产仓库只扫 `assetsDir` 一层，尚无多租户与工作空间隔离。
- **未接真实数据源**：Data Studio 的映射进度与字段均为示例。
- **前端与宿主未联通**：面板读的是内嵌演示数据，尚未消费 `ontology_*` 的实时结果。
