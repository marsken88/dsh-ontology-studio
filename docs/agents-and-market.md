# Agent 与资产流转

本体怎么进入对话（Context Engine）、谁在用（Agent 花名册）、以及资产怎么在实例之间流动（市场安装/升级），最后附完整 HTTP API。

> 本文是 [README](../README.md) 的展开篇。

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

这是**发现层**的 Context Engine：让 Agent 知道有什么、该用哪个工具，细节仍按需用 `ontology_get` 拉取。

任务层也做了，但刻意做得很轻：`agent/pre-step` 只**观察**本轮对话，在简报末尾追加一行
「本轮可能相关：Inventory」。它从不改写进入这一步的消息——猜错只多一行建议，
不会让答案缺料。

## Agent 花名册：声明 + 证据

最后一个演示页面也接上真实数据了。设计问题先定下来：**花名册声明在本体包里**（延续「一切皆可复用资产」），运行数据来自执行轨迹——两者分开，不混成一个数。

```json
"agents": [
  {
    "id": "stock-replenisher",
    "name": "库存补货 Agent",
    "model": "deepseek-v4.1-flash",
    "status": "published",
    "usesObjects": ["Inventory", "Store", "Product"],
    "skills": ["补货建议生成"],
    "tools": ["ontology_get", "ontology_evaluate_rules", "ontology_execute_action"],
    "actions": ["createReplenishment"],
    "evalTarget": "补货准确率 ≥ 85%"
  }
]
```

校验器会拦 `usesObjects` / `actions` 指向不存在的东西——花名册不是自由文本。

调用归属靠轨迹里的 `agent` 字段（工具执行时记下 `exec.agent.id`）：

```
库存补货 Agent（stock-replenisher）· published
  依赖对象：Inventory, Store, Product
  实际调用：ontology_get 1 次；ontology_evaluate_rules 1 次

巡店助手 Agent（store-inspector）· gray
  实际调用：轨迹里没有这个 Agent 的调用

轨迹中无法归属到声明 Agent 的调用：1 次
```

两列要分开看：

- **声明了但轨迹里没有** → 可能还没上线；
- **有调用但没声明** → 有人绕过花名册直接用了工具（`unattributed` 会数出来）。

删除对象时的级联也会把它从每个 Agent 的 `usesObjects` 里摘掉，否则整包会因为悬空引用失效。

## 资产市场：安装、卸载、依赖

`catalog/` 里放着**可安装**的资产包（不加载），`assets/` 里是**已安装**的（运行时读取）。安装就是复制过去。

随包带了一个真实例子：`retail.member-loyalty`（会员权益，3 对象 / 2 规则 / 2 动作），它 `dependsOn: ["retail.store-inventory"]`。

```
ontology_asset_catalog
可安装（1）：
  · 可安装 retail.member-loyalty v0.2.0 — 3 对象 / 2 规则 / 2 动作；依赖 retail.store-inventory
已安装（1）：
  retail.store-inventory v1.0.0（6 对象）
```

依赖在**两个方向**都拦：

| 动作 | 拒绝条件 | 返回 |
| --- | --- | --- |
| 安装 | 依赖没装 | `missing-dependency` + 缺哪些 |
| 卸载 | 有别的包依赖它 | `required-by` + 谁依赖 |

所以不可能出现「装了会员包但库存包不在」这种半坏状态。包本身校验不通过、重复安装、市场里没有——都有明确错误码，不是笼统一句失败。

**面板不提供安装按钮。** 安装/卸载是写操作，走 Agent 工具才能经过写入门禁和审批闸门；在界面上放个按钮等于开一条绕过审批的后门。市场页只读展示。

### HTTP API（面板用）

| 路由 | 返回 |
| --- | --- |
| `GET /dsh-ontology-studio/status` | 资产目录、所有包摘要、校验问题汇总 |
| `GET /dsh-ontology-studio/package?id=<包id>` | 完整 IR + 该文件的问题列表 |
| `GET /dsh-ontology-studio/impact?id=<包id>&object=<对象id>` | 对象影响分析 |
| `GET /dsh-ontology-studio/traces?limit=40` | 最近的工具调用轨迹（新→旧） |
| `GET /dsh-ontology-studio/catalog` | 资产市场状态 |
| `GET /dsh-ontology-studio/app-spec?id=` | 生成的应用页面规格 |
| `GET /dsh-ontology-studio/agents?id=` | Agent 花名册与调用统计 |
| `GET /dsh-ontology-studio/evaluate?id=` | 在示例数据上跑规则求值（只读，面板可点） |
| `GET /dsh-ontology-studio/records?id=<包id>&object=&limit=` | 事实数据的行数抽样 |
| `GET /dsh-ontology-studio/history?id=&limit=40` | 资产包的变更历史（新→旧） |
| `POST /dsh-ontology-studio/panel-report` | 面板上报自己的渲染健康状态（落到 .ontology-panel.jsonl） |

写接口（面板上的人工操作，**不走 Agent 审批闸门**，与直接改 JSON 同层级）：

| 路由 | 作用 |
| --- | --- |
| `POST /dsh-ontology-studio/write/save-object` | 新增或替换对象，整包校验通过才落盘 |
| `POST /dsh-ontology-studio/write/delete-object` | 删除对象；有引用时 409 并列出依赖，`cascade` 才连带清理 |
| `POST /dsh-ontology-studio/write/save-link` | 新增或替换关系，两端对象必须已存在 |
| `POST /dsh-ontology-studio/write/delete-link` | 删除关系 |
| `POST /dsh-ontology-studio/write/save-rule` | 新增或替换规则，保存前真的解析表达式并推导归属 |
| `POST /dsh-ontology-studio/write/delete-rule` | 删除规则 |

写接口有 CSRF 防护：跨站 `origin` 或 `sec-fetch-site` 一律 403——写路由开在 localhost 上，
不设防的话用户打开的任意网页都能改他的本体。只读模式下这些接口整体 403。

读接口只接受 GET（其它方法 405），写接口只接受 POST；未知路由 404，handler 抛错返回 500（不会让请求挂住）。面板每个 Studio 的顶栏会显示数据来源：`实时资产` / `演示数据 · 服务未连接`。
