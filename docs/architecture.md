# 架构：IR、三条通路与代码结构

这一篇讲「东西是怎么组织起来的」：本体 IR 的形状、Agent / HTTP / 面板三条通路、代码目录、以及八个 Studio 与规划文档的对应。

> 本文是 [README](../README.md) 的展开篇。

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
   ontology_*（28 个）  /dsh-ontology-*   fetch 同源接口
```

### Agent 工具

| 工具 | 读/写 | 作用 |
| --- | --- | --- |
| `ontology_list` | 读 | 列出资产包及对象/关系/规则/动作数量与校验状态 |
| `ontology_get` | 读 | 读一个包；带 `objectId` 时返回该对象的属性、关系、相关规则与动作 |
| `ontology_validate` | 读 | 校验结构与跨引用，返回带路径的问题列表 |
| `ontology_impact` | 读 | 对象影响分析：下游关系、规则、动作、审批策略 |
| `ontology_evaluate_rules` | 读 | 用示例数据真正求值业务规则，返回违规行与不可解析规则 |
| `ontology_draft_object` | 读 | 反向建模：表结构 → 本体对象草稿（只生成不写盘） |
| `ontology_diagnostics` | 读 | 自检：版本、资产、门禁、简报、服务、轨迹一次报全 |
| `ontology_records` | 读 | 查看事实数据：每个对象多少行、字段样例 |
| `ontology_history` | 读 | 变更历史：谁在哪个版本改了什么 |
| `ontology_export` | 读 | 导出 JSON Schema 或 Markdown 文档（只返回内容，不写文件） |
| `ontology_asset_catalog` | 读 | 资产市场：可安装 / 已安装 / 依赖是否满足 |
| `ontology_generate_app` | 读 | 由对象元数据生成页面规格（列/筛选器/操作表单） |
| `ontology_agents` | 读 | Agent 花名册（声明）+ 实际调用（轨迹） |
| `ontology_harness_check` | 读 | 体检：作为 Agent 底座还缺什么（结构/规则/动作/护栏/数据/Agent） |
| `ontology_eval_run` | 读 | 跑一次规则评测并记录条件指纹（包/规则/数据） |
| `ontology_eval_compare` | 读 | 对比两次评测；规则与数据同时变了会拒绝比较 |
| `ontology_install_asset` | **写** | 从 catalog 安装一个包，缺依赖则拒绝 |
| `ontology_uninstall_asset` | **写** | 卸载一个包，被依赖则拒绝 |
| `ontology_diff` | 读 | 对比两个包，按对象/关系/规则/动作/策略/Agent 分组 |
| `ontology_draft_from_payload` | 读 | 从一段样例报文反向生成对象草稿（只生成不写盘） |
| `ontology_regression_plan` | 读 | 改一个对象后要重验什么：规则/动作/关系/Agent/产物 |
| `ontology_upgrade` | **写** | 用市场里的同名新版本原位升级（支持 dryRun），记 op=upgrade |
| `ontology_upsert_object` | **写** | 新增或替换一个对象定义 |
| `ontology_upsert_link` | **写** | 新增或替换一条对象关系 |
| `ontology_delete_link` | **写** | 删除一条关系 |
| `ontology_delete_object` | **写** | 删除对象；被引用时默认拒绝，`cascade` 才连带清理 |
| `ontology_publish` | **写** | 校验全通过后按 `patch`/`minor`/`major` 递增版本并置为 `published` |
| `ontology_execute_action` | **写** | 执行业务动作：入参校验 → 审批 → 应用副作用到事实数据 → 规则回验 |

所有写工具都遵循同一条不变量：**先构造「写完之后」的整包再校验，不通过就什么都不写**；都支持 `dryRun` 预览。

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

删除是唯一有级联风险的写操作，所以它默认**拒绝**：

```
delete Inventory            → blocked：还有 2 条关系、3 个动作、1 条策略引用它
delete Inventory --cascade  → 删除对象 + 相关关系 + 只写它的动作
                              （动作还写别的对象则保留并从 writes 里摘掉它）
                              + 清理指向被删动作的策略
```

级联之后仍会整包校验，确保不留下悬空引用。

### 能力门禁：只读模式

在 profile 的 `cordis.patch.yml` 里给这一行加配置，写工具就**不会被注册**——不是禁用按钮，是 Agent 根本看不到这些工具：

```yaml
- id: dsh-ontology-studio
  name: dsh-ontology-studio
  config:
    writeMode: readonly        # 默认 open
    assetsDir: E:/path/to/assets
```

面板顶栏会显示「只读模式」，`/status` 也会返回 `readOnly: true`。

### 逐次审批闸门

`writeMode` 是全局开关；真正决定「这一次写能不能落盘」的是审批闸门：

```yaml
config:
  approval: destructive   # never | destructive（默认）| all
```

| 模式 | 需要审批的操作 |
| --- | --- |
| `never` | 无 |
| `destructive`（默认） | 删除对象、删除关系、发布版本 |
| `all` | 所有写入，含新增/替换对象与关系 |

每次需要审批时，宿主调用 DSH 的审批服务：

```js
approval.request({ agent, toolName, callId, reason, displayReason, signal })
  → 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
```

**只有 `allowed-once` 放行**，其余三种一律拒绝写盘。审批服务不存在、没有会话上下文、请求抛错（例如当前没有打开的 turn）——同样失败关闭，并在返回里带上 `approval` 字段说明原因。

面板顶栏会标明「删除/发布需审批」或「写入需审批」。

## 目录结构

```
dsh-ontology-studio/
├─ package.json            # bundle 清单：dsh.bundle.patch + dsh.client
├─ cordis.patch.yml        # 把插件行插入 profile 花名册
├─ index.js                # 宿主半：34 个工具 + 读写 HTTP 路由 + 上下文注入
├─ lib/
│  ├─ ir.mjs               # 校验器、统计、影响分析（纯函数，无依赖）
│  ├─ expr.mjs / expr-lexer.mjs  # 规则表达式词法与递归下降求值（不用 eval）
│  ├─ rules.mjs            # 规则归属推导与求值
│  ├─ actions.mjs          # 动作入参校验与声明式副作用
│  ├─ context.mjs          # 注入系统提示的本体简报（稳定 + 有界）
│  ├─ reverse.mjs          # 反向建模：表结构 → 本体草稿
│  ├─ trace.mjs            # 执行轨迹：追加式 JSONL，超限自动截断
│  ├─ store.mjs            # 资产仓库：扫目录、mtime 缓存、原子写入、CAS、版本递增
│  ├─ api.mjs              # 面板用的只读 JSON 路由
│  ├─ panel-writes.mjs     # 面板写路由：对象/关系/规则，CSRF 防护
│  ├─ registry.mjs         # 资产市场：catalog 扫描、安装、卸载、依赖校验
│  ├─ diff.mjs             # 两个包按条目对比
│  ├─ app.mjs              # 元数据 → 页面规格
│  ├─ sample.mjs           # 样例报文 → 对象草稿
│  ├─ regression.mjs       # 改动后的回归清单
│  ├─ harness-check.mjs    # 作为 Agent 底座的六方面体检
│  ├─ evals.mjs            # 规则评测运行与可比性判定
│  ├─ focus.mjs            # 任务层聚焦打分
│  ├─ openapi.mjs          # 本体 → OpenAPI 3.1（按主键生成路径参数）
│  ├─ datasource.mjs       # CSV → 对象草稿 → 资产包 IR（纯函数，不写盘）
│  ├─ sync.mjs             # 同步状态：内容指纹、列结构差异、人读的一句话
│  ├─ views.mjs            # 角色视角：声明的校验、覆盖统计、按视图投影
│  └─ lint.mjs             # config.lintRules 团队约定
├─ USAGE.md                # 面向使用者的操作说明（面板怎么点、Agent 怎么说）
├─ client.js               # 浏览器半：主面板 + 侧栏入口 + 九个页面 + 三个编辑器
├─ assets/
│  ├─ ontology-ir.schema.json      # IR 的正式 JSON Schema
│  ├─ store-inventory.ir.json      # 零售示例资产包
│  └─ store-inventory.records.json # 示例事实数据（规则跑在它上面）
├─ catalog/                # 可安装但未加载的资产包（含同 id 的新版本）
├─ test/                   # 30 个测试文件 + 3 道审计，npm test 依次跑
├─ locale/{en,zh}.json     # 插件管理页的标题、描述、详情文档指向
├─ icon.svg
└─ docs/
   ├─ DETAIL.md            # 插件详情页正文
   ├─ harness2-notes.md    # 从 Harness² 借了什么、明确不做什么
   └─ plan-source.md       # 规划原文（需求基线，默认不入库）
```

## 八个 Studio 与规划文档的对应关系

| 规划文档 | 本仓库落点 |
| --- | --- |
| Ontology Model Studio（对象/属性/关系/动作、多视角、影响分析） | `client.js` → `OntologyPage`，数据来自 `assets/*.ir.json` |
| Data Studio（同步型 / 联邦型并存、字段映射） | `DataPage` 读真实事实数据：行数、属性填充率；接入策略仍是设计说明 |
| Logic & Action Studio（规则、函数、动作、审批闸门） | `LogicPage` 读真实 IR：规则表达式、动作审批标记、可执行性 |
| Agent & Harness Studio（Ontology-aware 上下文与工具） | `AgentPage` 读真实花名册 + 轨迹归因 |
| App Studio（应用依赖本体而非表结构） | `AppPage` 读生成的页面规格并渲染预览 |
| Governance Center（ID/版本/责任人/审核/审计） | `GovernancePage` 读真实变更历史；权限与审核仍是演示 |
| Marketplace（三层资产、安装与复用） | `MarketplacePage` 读真实 catalog；依赖校验在工具层 |
| Observability & Evaluation（Trace 与质量闭环） | `ObservabilityPage` 读真实轨迹与调用统计 |
