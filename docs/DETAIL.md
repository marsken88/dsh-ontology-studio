# 本体工作台（Ontology Studio）

企业级语义建模与 Harness 智能执行平台，以 DSH 插件形式挂在 DeepSeek Harness 内：一个独立主面板、一个侧栏入口，加上四个可以被 Agent 直接调用的本体工具。

## 装上之后能做什么

**看**：侧栏面板图标列表里多出「本体工作台」，点开是全屏面板，左侧八个 Studio 分组导航，右侧是当前 Studio 的内容。

**用**：宿主半注册了十一个工具，Agent 可以直接读写本体，不必由人贴文档：

| 工具 | 读/写 | 作用 |
| --- | --- | --- |
| `ontology_list` | 读 | 列出资产包及其对象/关系/规则/动作数量与校验状态 |
| `ontology_get` | 读 | 读一个包（含 etag）；给 `objectId` 时返回该对象的属性、关系、相关规则与动作 |
| `ontology_validate` | 读 | 校验结构与跨引用，返回带路径的问题列表 |
| `ontology_impact` | 读 | 对某个对象做影响分析：下游关系、规则、动作、审批策略 |
| `ontology_evaluate_rules` | 读 | 用示例数据真正求值业务规则，返回违规行与不可解析的规则 |
| `ontology_draft_object` | 读 | 反向建模：表结构 → 本体对象草稿（只生成不写盘） |
| `ontology_diagnostics` | 读 | 自检：版本、资产、门禁、简报、服务、轨迹一次报全 |
| `ontology_records` | 读 | 查看事实数据的行数与字段样例 |
| `ontology_history` | 读 | 变更历史：谁在哪个版本改了什么 |
| `ontology_export` | 读 | 导出 JSON Schema 或 Markdown 文档（只返回内容，不写文件） |
| `ontology_upsert_object` | 写 | 新增或替换一个对象定义 |
| `ontology_upsert_link` | 写 | 新增或替换一条对象关系 |
| `ontology_delete_link` | 写 | 删除一条关系 |
| `ontology_delete_object` | 写 | 删除对象；被引用时默认拒绝，传 `cascade` 才连带清理 |
| `ontology_publish` | 写 | 校验全通过后递增版本并置为 published |
| `ontology_execute_action` | 写 | 执行业务动作：入参校验 → 审批 → 应用副作用到事实数据 → 规则回验 |

试试问：「查一下 retail.store-inventory 里 Inventory 对象的字段和可用动作」「改 availableQty 会影响哪些东西？」

**写**：写入是有门禁的——工具会先构造「写完之后」的整包再校验，包括关系端点、主键、动作写入对象等跨引用；任何一项不成立就拒绝写盘。`dryRun` 可以先预览。删除对象是唯一有级联风险的操作，默认拒绝并列出全部依赖，需要 `cascade: true` 才会连带清理关系、动作与策略。

**只读模式**：在 profile 的插件配置里设 `writeMode: readonly`，写工具根本不会被注册——不是禁用按钮，是 Agent 看不到这些能力。面板顶栏会显示「只读模式」。

**审批闸门**：`approval` 有三档——`never` / `destructive`（默认，删除与发布需审批）/ `all`（所有写入都要审批）。需要审批时宿主调用 DSH 的审批服务，只有 `'allowed-once'` 放行，`rejected`、`cancelled`、`unavailable` 一律拒绝写盘；审批服务缺失或请求抛错同样失败关闭。

**反向建模**：给一张物理表的列名/类型/注释/主键，生成可直接入库的本体对象草稿——类型映射、命名归一、表名单数化、主键推断、外键列的关系建议，并在目标包副本上预校验。确定性归一，理解交给模型；草稿不写盘，确认后用 upsert 落库。

**产物**：同一份 IR 能导出 JSON Schema（draft 2020-12，含 enum/日期格式/主键标记）与 Markdown 参考文档，供其它系统与文档站直接消费；只返回内容，不替你决定落盘位置。

**留痕**：每次写入追加一条记录到 .ontology-history.jsonl（操作、对象、版本、内容摘要、etag），失败的写入不留痕。治理页读它渲染版本时间线。

**并发安全**：写入带 etag 乐观锁——拿本次读取的指纹做 CAS，文件被别人改过就返回 `conflict: true` 和最新 etag，不会静默覆盖；同进程内还有按文件的写锁，不会写出半截 JSON。

**进对话就懂本体**：插件通过 systemPrompt 段落注入一份本体简报（对象、规则、可执行与不可执行的动作、工具用法），Agent 不必先调工具试探。简报对同样的本体逐字稳定、默认 4000 字符上限、写入后自动刷新。可用 `context: off|brief|full` 与 `contextMaxChars` 调整。

**动作能执行**：动作声明了 `inputSchema` 与 `effect` 才能跑；`effect` 可以是数组，一次改多行（调拨 = 调出扣减 + 调入增加，总量守恒），改法支持 `set` 赋值与 `adjust` 增量表达式。执行链路是：入参校验 → 判定审批（动作标记或策略）→ 按匹配键写回事实数据 → 用规则回验前后违规数 → 落盘并记入轨迹。`effect` 是声明式的，只说明改哪个对象的哪些字段，不含代码。匹配不到行会如实报失败，不会假装成功。

**规则能算**：规则只有一句表达式，归属对象由「覆盖它引用的所有属性的那个对象」推导；推不出来会明确列为 skipped，而不是默认通过。求值器是自己写的词法与递归下降，不用 eval，资产文件里塞不进代码。

**执行轨迹**：每次工具调用追加一行 JSONL（工具、成败、耗时、摘要），面板的可观测页读 `/traces` 展示；失败与拒绝都如实记录。

**看实时数据**：面板通过 `/dsh-ontology-studio/status` 与 `/package` 读宿主正在看的那份资产，顶栏会标明「实时资产」或「演示数据 · 服务未连接」。宿主不可达时自动回落到内嵌演示数据，面板不会白屏。

## 八个 Studio

| Studio | 这一版展示的内容 |
| --- | --- |
| 平台总览 | 资产计数、能力闭环、近期变更、待审批 |
| 本体模型 Studio | 对象清单 + 属性/关系/动作明细，四视角切换，影响分析 |
| Data Studio | 数据源清单（同步型 / 联邦型）、字段映射与映射进度 |
| Logic & Action Studio | 业务规则、动作（含审批标记）、函数 |
| Agent & Harness Studio | Agent 清单及其依赖的本体/Skill/工具，Runtime 组件 |
| App Studio | 基于本体生成的应用列表与生成来源 |
| Governance Center | 版本、审核、权限、审计四个视图 |
| Marketplace | 可安装资产包及其依赖 |
| Observability | Harness Trace 明细、评测指标、成本 |

## 本体资产

`assets/` 下的每个 `*.ir.json` 就是一份资产包，`assets/ontology-ir.schema.json` 是它的正式 Schema。编辑 JSON 文件就是全部「部署」步骤——仓库按文件 mtime 自动重校验。

校验分成两层，缺一不可：

- **Schema 管形状**：字段类型、必填、枚举、命名模式。
- **代码管引用**：主键必须是已声明属性、关系两端必须存在、动作写入的对象必须存在、策略只能指向已定义动作。

## 边界（这一版明确不做的事）

- **审批只在工具调用这一层**：直接编辑资产 JSON 不受审批约束，那本来就是这个仓库的模型即代码入口。
- **审批需要有打开的 turn**：没有进行中的回合时调用会失败关闭。
- **并发控制是单进程内的**：多实例共享同一目录时没有分布式锁。
- **规则只跑在示例数据上**：`*.records.json` 是手写事实数据，没有接真实数据源。
- **校验器已与 Schema 对齐**：未知字段（含拼写错误）会被拦下。
- **反向建模只吃表结构**：接口文档与样例报文还生成不了草稿。
- **上下文是静态简报**：还没有按任务裁剪相关对象。
- **两个动作可执行**（adjustInventory、createTransfer）：其余两个没有声明 effect，会被列出而不是假装跑通。
- **副作用只作用于示例事实数据**：没有回写真实业务系统。
- **未接真实数据源与图存储**：Data Studio 的映射进度、字段均为示例。
- **三个 Studio 仍是骨架**：Agent & Harness、应用构建、资产市场是演示数据；总览、本体、数据接入、逻辑动作、治理、可观测已接真实资产。
- **治理只做到变更留痕**：权限模型、审核流程、跨环境发布仍是演示，需要真实的身份与审批后端。

## 文件结构

- `index.js` — 宿主半，读取与校验本体、注册四个工具。
- `lib/ir.mjs` — 纯函数校验器、统计、影响分析。
- `lib/store.mjs` — 资产仓库，扫目录 + mtime 缓存。
- `client.js` — 浏览器半，注册 `main` 面板与 `sidebar.panellist` 入口。
- `cordis.patch.yml` — 把插件行插入 profile 花名册。
- `locale/en.json`、`locale/zh.json` — 插件管理页展示用的标题、描述与详情文档指向。
- `assets/ontology-ir.schema.json`、`assets/store-inventory.ir.json` — Schema 与示例资产包。
- `test/` — 校验器、宿主工具、面板渲染三组测试。
- `docs/DETAIL.md` — 插件详情页正文。

## 样式约定

只使用宿主主题令牌（`--dsw-alias-*`、`--dsw-specific-sidebar-fill`），不写死颜色，因此浅色/深色主题自动跟随；不加载任何 Harness Client 包，控件为自绘。
