# Ontology Studio

企业级 Ontology + Harness 平台的落地工程。目标不是做一个「本体建模页面」，而是：

> Ontology 是企业业务语义底座，Harness 是智能执行底座，Studio 是资产生产和管理入口，Marketplace 是能力复用机制，Governance 是平台运行保障。

本文的架构划分、八个 Studio 的职责边界与四阶段路线，依据内部的《Ontology Studio 平台建设规划：以 Harness 工程为核心》讨论稿整理。该文档属内部资料，不随本仓库分发（本地副本 `docs/plan-source.md` 已被 `.gitignore` 排除）。

## 当前状态：v0.3

| 部分 | 状态 |
| --- | --- |
| 平台骨架（八个 Studio + 统一导航） | ✅ 作为 Web GUI 的独立主面板 |
| 统一本体 IR + 正式 JSON Schema | ✅ `assets/ontology-ir.schema.json` |
| IR 校验器（结构 + 跨引用 + 影响分析） | ✅ `lib/ir.mjs` |
| 只读资产仓库（目录即数据源） | ✅ `lib/store.mjs` |
| **写入路径**：新增/替换对象、版本递增、发布 | ✅ 校验门禁，失败即拒绝且不落盘 |
| **面板 ↔ 宿主联通** | ✅ 面板读真实资产，断线自动回落到演示数据 |
| Agent 工具 `ontology_*` | ✅ 六个，其中两个写工具 |
| 权限模型 / 审批闸门的真实执行 | ❌ 未开始 |
| 图存储、数据同步、联邦查询 | ❌ 未开始（规划为独立服务） |

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

- **一份 IR 驱动所有下游**：可视化模型、HTTP API、Agent 工具定义、校验规则、影响分析都由它派生；
- **Schema 管形状，代码管引用**：JSON Schema 表达不了「主键必须是已声明属性」「关系端点必须存在」「动作写入的对象必须存在」「策略只能指向已定义动作」，这些在 `lib/ir.mjs` 里检查；
- **命名即约束**：包 id `域.名称`、对象 `PascalCase`、属性 `camelCase`、关系 `snake_case`、规则与策略 `域.名称`，写错就会被校验器拦下。

目录里的每个 `*.ir.json` 就是一份资产，**改文件即全部部署步骤**；仓库按 mtime 缓存，文件一变就重校验。

## 三条通路，同一份数据

```
                     assets/*.ir.json  ← 唯一事实来源
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
      Agent 工具        HTTP API        面板（浏览器）
   ontology_* (6 个)  /dsh-ontology-*   fetch 同源接口
```

### Agent 工具

| 工具 | 读/写 | 作用 |
| --- | --- | --- |
| `ontology_list` | 读 | 列出资产包及对象/关系/规则/动作数量与校验状态 |
| `ontology_get` | 读 | 读一个包；带 `objectId` 时返回该对象的属性、关系、相关规则与动作 |
| `ontology_validate` | 读 | 校验结构与跨引用，返回带路径的问题列表 |
| `ontology_impact` | 读 | 对象影响分析：下游关系、规则、动作、审批策略 |
| `ontology_upsert_object` | **写** | 新增或替换一个对象定义；写入前校验整包，不成立就拒绝且磁盘保持原样；支持 `dryRun` |
| `ontology_publish` | **写** | 校验必须全通过，按 `patch`/`minor`/`major` 递增版本并置为 `published` |

`ontology_get('retail.store-inventory', 'Inventory')` 的实际渲染输出：

```
门店-商品-库存 / 库存 (Inventory)
门店 + SKU 维度的可售库存快照。
属性：
  - storeId（门店编号）: string 必填
  - availableQty（可售数量）: number
  - safetyStock（安全库存）: number
  ...
关系：belongsTo → Store, references → Product
可用动作：adjustInventory(需审批), createTransfer(需审批), startStocktake
```

写入的安全边界：**校验不过就不写**。`ontology_upsert_object` 会先构造出「写完之后」的整包再校验——包括跨引用——通过才落盘；`ontology_publish` 在包无效时同样拒绝，并把磁盘原样保留。

### HTTP API（面板用）

| 路由 | 返回 |
| --- | --- |
| `GET /dsh-ontology-studio/status` | 资产目录、所有包摘要、校验问题汇总 |
| `GET /dsh-ontology-studio/package?id=<包id>` | 完整 IR + 该文件的问题列表 |
| `GET /dsh-ontology-studio/impact?id=<包id>&object=<对象id>` | 对象影响分析 |

非 GET 返回 405，未知路由 404，handler 抛错返回 500（不会让请求挂住）。面板每个 Studio 的顶栏会显示数据来源：`实时资产` / `演示数据 · 服务未连接`。

## 测试

```bash
npm test        # 五组，共 59 项断言
```

| 文件 | 覆盖 |
| --- | --- |
| `test/ir.test.cjs` | 23 项：Schema 语义、每类错误各一条、影响分析、仓库读目录 |
| `test/tools.test.cjs` | 13 项：激活、`ctx.effect` 挂载、六个工具端到端、目录缺失降级 |
| `test/write.test.cjs` | 12 项：新增/替换对象、校验失败不落盘、`dryRun`、版本递增、发布拒绝 |
| `test/api.test.cjs` | 11 项：三条路由、400/404/405/500、目录缺失 |
| `test/render-smoke.cjs` | 九个页面渲染 + 实时数据通路（live model） |

写路径的测试全部在临时目录里跑，**不会改动仓库里的 `assets/`**。

## 目录结构

```
dsh-ontology-studio/
├─ package.json            # bundle 清单：dsh.bundle.patch + dsh.client
├─ cordis.patch.yml        # 把插件行插入 profile 花名册
├─ index.js                # 宿主半：六个工具 + 注册 HTTP 路由
├─ lib/
│  ├─ ir.mjs               # 校验器、统计、影响分析（纯函数，无依赖）
│  ├─ store.mjs            # 资产仓库：扫目录、mtime 缓存、安全写入、版本递增
│  └─ api.mjs              # 面板用的只读 JSON 路由
├─ client.js               # 浏览器半：主面板 + 侧栏入口 + 八个 Studio
├─ assets/
│  ├─ ontology-ir.schema.json      # IR 的正式 JSON Schema
│  └─ store-inventory.ir.json      # 零售示例资产包
├─ test/                   # 五组测试
├─ locale/{en,zh}.json     # 插件管理页的标题、描述、详情文档指向
├─ icon.svg
└─ docs/
   ├─ DETAIL.md            # 插件详情页正文
   └─ plan-source.md       # 规划原文（需求基线，默认不入库）
```

## 八个 Studio 与规划文档的对应关系

| 规划文档 | 本仓库落点 |
| --- | --- |
| Ontology Model Studio（对象/属性/关系/动作、多视角、影响分析） | `client.js` → `OntologyPage`，数据来自 `assets/*.ir.json` |
| Data Studio（同步型 / 联邦型并存、字段映射） | `DataPage`（骨架演示） |
| Logic & Action Studio（规则、函数、动作、审批闸门） | `LogicPage`（骨架演示） |
| Agent & Harness Studio（Ontology-aware 上下文与工具） | `AgentPage` + 六个 `ontology_*` 工具 |
| App Studio（应用依赖本体而非表结构） | `AppPage`（骨架演示） |
| Governance Center（ID/版本/责任人/审核/审计） | `GovernancePage`（骨架演示）+ `ontology_publish` 的版本状态机 |
| Marketplace（三层资产、安装与复用） | `MarketplacePage`（骨架演示） |
| Observability & Evaluation（Trace 与质量闭环） | `ObservabilityPage`（骨架演示） |

## 路线图

**阶段一 · 平台地基**
- [x] 统一导航壳 + 八个 Studio 的信息架构
- [x] 统一本体 IR 的正式 Schema
- [x] IR 校验器（结构 + 跨引用）与资产仓库
- [x] 读取 API（Agent 工具 + HTTP）
- [x] 写入路径：对象新增/替换、校验门禁、版本递增、发布状态
- [x] 面板消费宿主真实资产
- [ ] 删除对象与关系维护（会波及引用，需要级联策略）
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

- **无权限校验**：任何能调工具的 Agent 都能写资产目录；审批标记目前只是元数据。
- **无并发控制**：两个写入同时发生时后者覆盖前者，尚无 etag / 乐观锁。
- **单包单目录**：只扫 `assetsDir` 一层，无多租户与工作空间隔离。
- **五个 Studio 是骨架**：数据接入、逻辑动作、应用构建、治理、市场、可观测仍是演示数据。
- **无删除路径**：删对象会牵动关系与动作，留给下一阶段做级联策略。
