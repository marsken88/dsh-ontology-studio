# Ontology Studio

企业级 Ontology + Harness 平台的落地工程。目标不是做一个「本体建模页面」，而是：

> Ontology 是企业业务语义底座，Harness 是智能执行底座，Studio 是资产生产和管理入口，Marketplace 是能力复用机制，Governance 是平台运行保障。

本文的架构划分、八个 Studio 的职责边界与四阶段路线，依据内部的《Ontology Studio 平台建设规划：以 Harness 工程为核心》讨论稿整理。该文档属内部资料，不随本仓库分发（本地副本 `docs/plan-source.md` 已被 `.gitignore` 排除）。

## 当前状态：v0.18.2

| 部分 | 状态 |
| --- | --- |
| 平台骨架（八个 Studio + 统一导航） | ✅ 作为 Web GUI 的独立主面板 |
| 统一本体 IR + 正式 JSON Schema | ✅ `assets/ontology-ir.schema.json` |
| IR 校验器（结构 + 跨引用 + 未知字段 + 影响分析） | ✅ `lib/ir.mjs` 与 JSON Schema 严格度一致 |
| 只读资产仓库（目录即数据源） | ✅ `lib/store.mjs` |
| 模型编辑：对象、关系的增改删 | ✅ 五个写工具，校验门禁 + 级联策略 |
| 版本递增与发布状态机 | ✅ `ontology_publish` |
| 面板 ↔ 宿主联通 | ✅ 面板读真实资产，断线自动回落到演示数据 |
| 能力门禁（只读模式） | ✅ `writeMode: readonly` 直接不注册写工具 |
| 逐次人工审批 | ✅ 写操作调用 Host 审批服务，非 `allowed-once` 一律失败关闭 |
| 规则求值 | ✅ 自有表达式求值器（不用 eval），在示例数据上真算违规 |
| 执行轨迹 | ✅ 每次工具调用落一行 JSONL，面板可读 |
| Action 执行器 | ✅ 入参校验 → 审批 → 单/多 effect（赋值或增量）→ 规则回验 |
| Context Engine | ✅ 本体简报注入系统提示，稳定且有界，写入后自动刷新 |
| 面板实时化 | ✅ 总览/本体/数据接入/逻辑动作/治理/可观测六页读真实资产（其余三页仍是演示） |
| 并发控制 | ✅ 乐观锁（etag CAS）+ 文件写锁，丢失更新会明确报冲突 |
| 版本历史 | ✅ 每次写入追加一条 JSONL，可查「改过什么、在哪个版本」 |
| 反向建模 | ✅ 从表结构生成本体草稿：类型映射、命名归一、主键推断、关系建议、预校验 |
| 产物导出 | ✅ IR → JSON Schema（draft 2020-12）/ Markdown 参考文档 |
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
| `ontology_evaluate_rules` | 读 | 用示例数据真正求值业务规则，返回违规行与不可解析规则 |
| `ontology_draft_object` | 读 | 反向建模：表结构 → 本体对象草稿（只生成不写盘） |
| `ontology_diagnostics` | 读 | 自检：版本、资产、门禁、简报、服务、轨迹一次报全 |
| `ontology_records` | 读 | 查看事实数据：每个对象多少行、字段样例 |
| `ontology_history` | 读 | 变更历史：谁在哪个版本改了什么 |
| `ontology_export` | 读 | 导出 JSON Schema 或 Markdown 文档（只返回内容，不写文件） |
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

## 规则真的能算

规则在 IR 里只有一句表达式，没有对象指针。`ontology_evaluate_rules` 会：

1. **推导归属**：找出「声明的属性覆盖表达式里所有标识符」的那个对象；
2. **在示例数据上求值**：逐行计算，收集违规行与命中值；
3. **推不出来就明说**：不猜、不默认通过。

实际输出（`assets/store-inventory.records.json`，11 行数据）：

```
规则求值：2 条生效 / 4 条声明，扫描 11 行数据
违规：4 处，涉及 2 条规则
✗ inventory.lowStockWarning（Inventory，5 行） → 3 处违规
    row 0: {"availableQty":80,"safetyStock":150}
    row 4: {"availableQty":18,"safetyStock":40}
✗ inventory.stockoutAlert（Inventory，5 行） → 1 处违规
    row 1: {"availableQty":0}
- 跳过 inventory.turnoverHealth：无法解析到对象：turnoverDays 不是任何对象的属性
- 跳过 inventory.autoReplenish：无法解析到对象：leadTime 不是任何对象的属性
```

那两条被跳过的规则不是缺陷，是**真实发现**：表达式引用了本体里没有声明的字段，说明模型和规则还没对齐。

### 面板自己会报告健康状态

页面渲染崩了，用户只会看到白屏，而 Agent 看不到屏幕。所以面板有两道自检：

- **页面级错误边界**：某一页抛错时降级成一张错误卡片（含错误信息），不会把整个面板打空；
- **上报**：每次切页 `POST /panel-report`，页面崩了也上报 —— 一条 `{"phase":"page-error","page":"data","error":"..."}` 落进 `.ontology-panel.jsonl`，出问题可以直接读文件，不用猜。

两层都刻意做成「永不阻断渲染」：上报失败无声忽略，错误卡片始终可读。

规则和动作都跑在**事实数据**上，所以给了一个直接看数据的入口：

```
ontology_records({ packageId, objectId: "Inventory", limit: 2 })
```

```
事实数据：11 行（assets/store-inventory.records.json）
Inventory：5 行
  {"storeId":"S-0213","skuId":"SKU-1001","availableQty":80,"safetyStock":150,…}
  {"storeId":"S-0213","skuId":"SKU-1002","availableQty":0,"safetyStock":20,…}
  …还有 3 行
```

规则说「有 3 行低于安全库存」时，可以直接看那 3 行到底长什么样，而不是凭结论反推数据。

求值器是手写的词法 + 递归下降（`lib/expr.mjs`、`lib/expr-lexer.mjs`），**不用 `eval`、不用 `Function`**：函数调用、赋值、分号、花括号全部是语法错误，资产文件里塞不进可执行代码。

## 执行轨迹

每个 `ontology_*` 调用都会追加一行 JSONL：

```json
{"ts":1794585923436,"tool":"ontology_get","ok":true,"ms":0,"summary":"ontology_get: retail.store-inventory · Inventory","error":null}
```

- 记录的是**真的发生了什么**：被拒绝的删除、找不到的包都记为 `ok: false` 并带上原因；
- 文件超过上限自动只留最近 N 条，一行写坏（进程被杀）只是被跳过，不会让读失败；
- 面板的「可观测与评测」页读 `/traces` 渲染，没连上宿主时才回落到演示数据。

轨迹默认落在 `assetsDir` 的上一级 `.ontology-traces.jsonl`，已加入 `.gitignore`；可用 `config.traceFile` 改位置，`config.trace: false` 关闭。

## 动作真的能执行

动作不是一句描述，它要能跑。跑一条链路：

```json
{
  "id": "adjustInventory",
  "inputSchema": [
    { "name": "storeId", "type": "string", "required": true },
    { "name": "skuId", "type": "string", "required": true },
    { "name": "availableQty", "type": "number", "required": true }
  ],
  "approvalRequired": true,
  "writes": ["Inventory"],
  "effect": {
    "object": "Inventory",
    "matchKeys": ["storeId", "skuId"],
    "set": { "availableQty": "availableQty" }
  }
}
```

`ontology_execute_action` 依次做五件事：

```
① 入参校验      缺字段 / 类型错 / 负数 / 未知字段 → 直接拒绝，不碰数据
② 判定审批      action.approvalRequired 或策略 effect=require-approval
③ 应用副作用    按 matchKeys 定位行，只改 set 里声明的字段
④ 规则回验      执行前后各跑一次规则，报告违规数的变化
⑤ 写回 + 轨迹   落盘事实数据，调用本身进入 Trace
```

真实输出：

```
adjustInventory：命中 1 行，更新 1 行 → assets/store-inventory.records.json
  {"availableQty":80} → {"availableQty":200}
规则回验：违规 4 → 3
```

**effect 是声明式的，不含代码**：它只说改哪个对象的哪些字段、值从入参的哪个字段来。执行器是唯一碰数据的东西，资产文件依旧塞不进可执行代码。

`matched === 0` 时返回失败并说明匹配键，不伪造成功——「Agent 说成功了」和「真的改了」是两件事，这一步就是拿后者卡前者。

### 跨对象动作：一次调用改多行

`effect` 可以是一个对象，也可以是数组。数组按顺序应用，每项自己声明 `matchKeys` 和改法。`matchKeys` 的每一项可以是字段名，也可以是 `{ field, from }`——用来处理「入参叫 `fromStoreId`、目标行上叫 `storeId`」这种错位。

动作的改法有两种：

| 写法 | 含义 |
| --- | --- |
| `set` | 直接赋入参的值 |
| `adjust` | 按表达式做增量，例如 `"-qty"`、`"qty * -1"`（表达式同样走安全求值器，只能引用入参字段） |

`createTransfer` 就是跨对象动作：

```json
"effect": [
  { "object": "Inventory",
    "matchKeys": [{ "field": "storeId", "from": "fromStoreId" }, { "field": "skuId", "from": "skuId" }],
    "adjust": { "availableQty": "-qty" } },
  { "object": "Inventory",
    "matchKeys": [{ "field": "storeId", "from": "toStoreId" }, { "field": "skuId", "from": "skuId" }],
    "adjust": { "availableQty": "qty" } }
]
```

实测一次调拨 50 件：

```
调拨前: S-0213:80  S-0188:95
调拨后: S-0213:30  S-0188:145      ← 总量守恒，没多也没少
```

只有一侧命中（比如调出门店不存在）时，工具如实报告 `matched: 1` 并在 `effects` 里给出每项的命中数，不假装整笔成功。

删除对象时会连带清理指向它的 effect 条目——多 effect 的动作保留其余项，`writes` 里不再有对象的动作整条删除。

目前只有 `adjustInventory` 同时声明了 `inputSchema` 与 `effect`；其余三个动作会被明确列出为不可执行，而不是静默跑通。

## Context Engine：进对话就懂这个本体

Agent 不该靠一次次调工具去试探「这里有什么」。插件通过 `ctx.systemPrompt.section()` 把一份本体简报注入系统提示：

```
## 本体上下文 · 门店-商品-库存
资产包 `retail.store-inventory` v1.0.0（published，域 supply-chain）

### 对象
- **Inventory** 库存（7 属性，主键 storeId+skuId）
- **Store** 门店（5 属性，主键 storeId）
...

### 规则（4 条）
- inventory.lowStockWarning [warn] `availableQty < safetyStock`
- inventory.autoReplenish [warn，已停用] `...

### 可执行动作
- adjustInventory 库存调整（需审批）→ 写 Inventory；入参 storeId, skuId, availableQty

### 暂不可执行的动作
- createTransfer 发起调拨（缺 inputSchema 或 effect）
```

三个设计约束：

- **稳定**：同样的本体产出**逐字相同**的文本。简报每步都在提示里，一变就可能击穿 prompt 缓存；
- **有界**：默认 4000 字符。超长时先丢掉属性明细，再截断并明确标注「已截断、可用 ontology_get 查」；
- **自更新**：写工具执行后重建缓存，Agent 改完本体立刻看到新结构，不需要重启。

```yaml
config:
  context: brief        # off | brief（默认）| full
  contextMaxChars: 4000
```

这是**发现层**的 Context Engine：让 Agent 知道有什么、该用哪个工具，细节仍按需用 `ontology_get` 拉取。按任务动态挑选相关对象属于任务层，还没做。

## 并发：丢失更新会报错，不会静默

两个 Agent 同时改一份资产，最坏的结果不是报错，而是**其中一笔悄无声息地消失**。这里有两道防线：

**1. 乐观锁（etag CAS）。** 每次写入都带着「它读到时的内容指纹」：

```
ontology_get  → { …, etag: "sha256-3f2a…" }
ontology_upsert_object { …, ifEtag: "sha256-3f2a…" }
  ├─ 文件没变  → 写入，返回新 etag
  └─ 文件变了  → { ok: false, conflict: true, etag: "sha256-9c71…" }
                 「资产已被修改，请重新读取（ontology_get）后再写入」
```

写入工具会自动拿**本次读取**的 etag 做 CAS，所以即使调用方不传 `ifEtag`，并发写入也不会互相覆盖——输的一方拿到明确冲突和最新 etag，重试即可。

**2. 每文件写锁。** 所有写入经过同一个串行队列，不会出现两个 `writeFile` 交错写出半截 JSON。

实测：五路并发新增对象 → **1 成功、4 冲突**，最终文件里只多出 1 个对象，没有丢失也没有多余。

```bash
node test/concurrency.test.cjs   # 10 项
```

边界：这是**单进程内**的保护。多个 DSH 实例共享同一资产目录时没有分布式锁——那需要外部协调（文件租约或数据库），不在当前范围。

## 装好没装好，一次调用确认

重启之后先跑这个：

```
ontology_diagnostics
```

```
本体工作台 v0.13.0 自检：正常
✓ 资产目录：…/assets（1 个资产包）
✓ 资产包：1 个全部通过校验
✓ 写入能力：可写（审批档位 destructive）
✓ 上下文简报：1209 字符，已就绪
✓ 工具注册：13 个（读写）：ontology_list, ontology_get, …
✓ 服务 approval：可用
✓ 执行轨迹：…/.ontology-traces.jsonl（可写）
```

三个用途：

- **确认加载的是新代码**：版本来自 `package.json`。宿主不会热重载宿主半，如果这里显示的是旧版本号，说明还需要重启——光看「工具有没有」是看不出来的，旧的 6 个工具也在；
- **确认可选服务**：`approval` / `systemPrompt` / `webServer` 缺任何一个，对应能力会静默降级（写入不再要审批、没有本体简报、面板读不到数据），自检会点名；
- **确认资产健康**：目录、包数量、校验状态、轨迹可写性一次报全。

有 `fail` 项时 `ok` 就是 `false`；`warn` 只是降级，不阻止使用。

## 反向建模：表结构 → 本体草稿

规划文档里的 AI 反向建模，我把它拆成两半：**理解交给模型，归一化交给平台**。`ontology_draft_object` 做后一半——它是确定性的，同样的表永远产出同样的草稿。

```
输入 dwd_transfer_order（门店调拨单表）
  transfer_no   varchar(32)  调拨单号  PK
  from_store_id bigint       调出门店
  to_store_id   bigint       调入门店
  qty           int          调拨数量  NOT NULL
  status        enum('draft','approved','done')
                ↓
TransferOrder（门店调拨单），主键 transferNo
  - transferNo : string 必填    - qty : integer 必填
  - fromStoreId : integer      - status : enum [draft/approved/done]
  - toStoreId : integer
关系建议：transfer_order_from_store_references_store → Store
          transfer_order_to_store_references_store   → Store
预校验：并入后整包仍然合法
```

做了这些归一：

| 环节 | 规则 |
| --- | --- |
| 类型映射 | `decimal` → money、`timestamp` → datetime、`tinyint(1)` → boolean、`enum(...)` 解析出取值；认不出的类型降级 string 并**明确标注原类型** |
| 命名 | 列名 snake_case → camelCase（`SKU_CODE` → `skuCode`；已有驼峰保持原样）；表名去 `dwd_`/`dim_`/`ods_` 等前缀并单数化（`ads_sales` → `Sale`） |
| 主键 | 优先 `primaryKey` 标记，其次 `id` 列，都没有就**报问题而不是猜** |
| 关系 | `*_id` 列按对象名匹配，支持限定词（`fromStoreId` → Store）；指向未知对象不硬造 |
| 预校验 | 草稿并入目标包副本后跑一遍校验，直接告诉你「能不能入库」 |

**它不写盘。** 生成草稿 → 人/Agent 审阅 → 用 `ontology_upsert_object` 落库。反向建模最容易出的错是「看起来很合理但语义不对」，所以草稿必须过一遍人工或显式确认。

## 一份 IR，两种产物

规划里说「一个模型定义可以生成 API、SDK、接口文档、校验规则」。目前落地了两种，都从同一份 IR 派生：

**JSON Schema**（draft 2020-12），给别的系统做记录校验：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "retail.store-inventory/Inventory",
  "title": "库存",
  "type": "object",
  "required": ["storeId", "skuId"],
  "properties": {
    "availableQty": { "type": "number", "title": "可售数量" },
    "updatedAt": { "type": "string", "format": "date-time" },
    "storeId": { "type": "string", "title": "门店编号" }
  },
  "additionalProperties": false,
  "x-primary-key": ["storeId", "skuId"]
}
```

类型映射：`money → number`、`date/datetime → string + format`、`enum → string + enum`、`json → object`；`keys` 导出成 `x-primary-key`（JSON Schema 没有主键概念）。

**Markdown 参考文档**：对象/属性表、关系表、规则表（标停用）、动作表（标可执行与审批）、策略列表。

```bash
ontology_export({ packageId, format: "json-schema" | "markdown", objectId? })
```

只返回内容、不写文件——落在哪里由调用方决定，插件不替人做目录决策。

### HTTP API（面板用）

| 路由 | 返回 |
| --- | --- |
| `GET /dsh-ontology-studio/status` | 资产目录、所有包摘要、校验问题汇总 |
| `GET /dsh-ontology-studio/package?id=<包id>` | 完整 IR + 该文件的问题列表 |
| `GET /dsh-ontology-studio/impact?id=<包id>&object=<对象id>` | 对象影响分析 |
| `GET /dsh-ontology-studio/traces?limit=40` | 最近的工具调用轨迹（新→旧） |
| `GET /dsh-ontology-studio/records?id=<包id>&object=&limit=` | 事实数据的行数抽样 |
| `GET /dsh-ontology-studio/history?id=&limit=40` | 资产包的变更历史（新→旧） |
| `POST /dsh-ontology-studio/panel-report` | 面板上报自己的渲染健康状态（落到 .ontology-panel.jsonl） |

非 GET 返回 405，未知路由 404，handler 抛错返回 500（不会让请求挂住）。面板每个 Studio 的顶栏会显示数据来源：`实时资产` / `演示数据 · 服务未连接`。

## 测试

```bash
npm test        # 十三组，共 203 项断言
```

| 文件 | 覆盖 |
| --- | --- |
| `test/ir.test.cjs` | 27 项：Schema 语义、每类错误各一条、未知字段（含拼写错误）、影响分析、仓库读目录 |
| `test/context.test.cjs` | 10 项：简报内容、级别差异、稳定逐字一致、超长降级与截断 |
| `test/reverse.test.cjs` | 16 项：类型映射、命名归一、表名单数化、主键回退、关系推断、重复列、预校验、工具不写盘 |
| `test/concurrency.test.cjs` | 10 项：etag 稳定性、CAS 成功/过期、写锁不产出半截文件、五路并发只有一个成功、冲突后按返回 etag 重试 |
| `test/rules.test.cjs` | 19 项：表达式求值、语法拒绝代码注入、规则归属推导、违规行 |
| `test/actions.test.cjs` | 24 项：入参校验、effect 声明校验、赋值与增量、跨对象调拨（数量守恒）、规则回验、审批拒绝不写盘 |
| `test/export.test.cjs` | 9 项：类型映射、必填与主键、enum、money、、文档五节、动作可执行标记、工具不写盘 |
| `test/history.test.cjs` | 6 项：各类写入留痕、版本号跟随、失败不留痕、过滤与上限、关闭历史 |
| `test/tools.test.cjs` | 21 项：激活、`ctx.effect` 挂载、十三个工具端到端、只读模式只剩七个读工具、上下文段落注册与关闭、缺少可选服务时照常工作、自检报告 |
| `test/write.test.cjs` | 29 项：对象与关系的增改删、级联、审批闸门、对象与关系的增改删、校验失败不落盘、级联策略、`dryRun`、版本递增、发布拒绝 |
| `test/api.test.cjs` | 19 项：六条路由、400/404/405/500、只读与审批标记、面板上报、目录缺失 |
| `test/e2e.test.cjs` | 12 项：整条链路按真实使用顺序跑一遍（现状→建模→执行→回收→轨迹），验证各工具彼此自洽 |
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
│  ├─ expr.mjs / expr-lexer.mjs  # 规则表达式词法与递归下降求值（不用 eval）
│  ├─ rules.mjs            # 规则归属推导与求值
│  ├─ actions.mjs          # 动作入参校验与声明式副作用
│  ├─ context.mjs          # 注入系统提示的本体简报（稳定 + 有界）
│  ├─ reverse.mjs          # 反向建模：表结构 → 本体草稿
│  ├─ trace.mjs            # 执行轨迹：追加式 JSONL，超限自动截断
│  ├─ store.mjs            # 资产仓库：扫目录、mtime 缓存、安全写入、版本递增
│  └─ api.mjs              # 面板用的只读 JSON 路由
├─ client.js               # 浏览器半：主面板 + 侧栏入口 + 八个 Studio
├─ assets/
│  ├─ ontology-ir.schema.json      # IR 的正式 JSON Schema
│  ├─ store-inventory.ir.json      # 零售示例资产包
│  └─ store-inventory.records.json # 示例事实数据（规则跑在它上面）
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
| Data Studio（同步型 / 联邦型并存、字段映射） | `DataPage` 读真实事实数据：行数、属性填充率；接入策略仍是设计说明 |
| Logic & Action Studio（规则、函数、动作、审批闸门） | `LogicPage` 读真实 IR：规则表达式、动作审批标记、可执行性 |
| Agent & Harness Studio（Ontology-aware 上下文与工具） | `AgentPage` + 六个 `ontology_*` 工具 |
| App Studio（应用依赖本体而非表结构） | `AppPage`（骨架演示） |
| Governance Center（ID/版本/责任人/审核/审计） | `GovernancePage` 读真实变更历史；权限与审核仍是演示 |
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
- [x] 删除对象与关系维护（级联策略 + 整包校验）
- [x] 能力门禁：只读模式下写工具不注册
- [x] 逐次审批闸门：写操作前调用 Host 审批服务，失败关闭

**阶段二 · Harness 执行闭环**
- [x] Agent 能直接读本体（`ontology_*`）
- [x] 规则表达式求值：归属推导 + 在示例数据上算违规
- [x] 执行轨迹：每次工具调用落一行，面板可读
- [x] Context Engine（发现层）：本体简报注入系统提示，Agent 不必先试探
- [ ] Context Engine（任务层）：按当前任务自动挑选相关对象与可用动作
- [x] Action 执行器：动作的入参校验、声明式副作用、执行与规则回验
- [x] 人工审批闸门串进业务动作流
- [x] 跨对象动作：一次调用改多行（调拨 = 调出扣减 + 调入增加）

**阶段三 · 资产与生态**
- [ ] Asset Registry：依赖声明、影响分析、安装与升级
- [ ] Plugin SDK 与扩展点（连接器、校验器、评测器、组件）
- [ ] 应用生成：由本体元数据生成页面与表单

**阶段四 · 智能化运营**
- [x] 反向建模（表结构 → 本体草稿）：确定性归一，理解交给模型
- [ ] 从接口文档 / 样例报文生成草稿（现在只吃表结构）
- [ ] 自动影响分析与回归测试生成
- [ ] Agent 效果评测与自动优化

## 设计原则（来自规划文档）

1. **元数据驱动**：新增业务对象不写实体类、不写 Controller、不写页面。
2. **模型即代码**：本体、规则、动作、Agent 均可 YAML/JSON 声明、走 Git、可 Diff。
3. **AI Native**：AI 参与资产创建到发布的每个阶段，但不绕过治理。
4. **一切皆可复用资产**：独立安装、依赖管理、版本升级、跨域复用。
5. **API First + Event Driven**：先定接口与事件，再建 UI。

## 已知边界

- **审批只在工具调用这一层**：闸门保护的是「Agent 通过工具改资产」。如果人直接编辑 `assets/*.ir.json`，当然不受审批约束——那本来就是模型即代码的入口。
- **审批需要有打开的 turn**：DSH 的审批请求必须被一个进行中的回合包住；在没有 turn 的上下文里调用会失败关闭（返回 `approval: 'unavailable'`）。
- **并发控制是单进程内的**：etag CAS 挡住「读到旧版本再覆盖」，写锁挡住同进程内的交错写；多实例共享同一目录时仍没有分布式锁。
- **单包单目录**：只扫 `assetsDir` 一层，无多租户与工作空间隔离。
- **三个页面是骨架**：Agent & Harness、应用构建、资产市场仍是演示数据（总览、本体、数据接入、逻辑动作、治理、可观测已接真实资产）。
- **反向建模只吃表结构**：接口文档、样例报文、现有 SQL 还生成不了草稿。
- **上下文是静态简报，不是按任务挑选**：每次装配注入的是整个资产包的摘要，还没有「这次任务只和 Inventory 有关」的裁剪。
- **规则只跑在示例数据上**：`store-inventory.records.json` 是手写的事实数据，没有接真实 POS / 库存库；`ontology_evaluate_rules` 证明的是「规则能算」，不是「线上库存准」。
- **只有一个动作真正可执行**：`adjustInventory` 声明了 `inputSchema` + `effect`，其余三个只有定义；判断标准是「有没有声明 effect」，没有的动作会被直接列出，不会假装执行。
- **副作用只作用于示例事实数据**：动作改的是 `*.records.json`，没有回写 POS / 供应链系统。
