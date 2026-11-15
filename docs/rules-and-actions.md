# 规则与动作

规则怎么真的算出违规，动作怎么真的改数据——包括声明式副作用、跨对象动作与审批闸门。

> 本文是 [README](../README.md) 的展开篇。

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
