# 建模辅助：反向建模、应用生成与产物导出

把别处的东西搬进来（表结构、样例报文），把本体送出去（JSON Schema、Markdown、页面规格）。四件事都遵循同一条原则：确定性生成，人来做决定。

> 本文是 [README](../README.md) 的展开篇。

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

## 应用构建：从元数据生成页面规格

「应用依赖 Ontology 定义，而不是底层表结构」——这句要能兑现，得先有一样东西：把对象元数据翻译成页面规格。
```
ontology_generate_app({ packageId, objects: ["Inventory"] })
```

```
门店-商品-库存 · 应用规格（6 页，来自 retail.store-inventory v1.0.0）

库存（list）：7 列，1 个筛选器
  列：门店编号 / SKU 编号 / 在库数量 / 可售数量 / 锁定数量 / 安全库存 / 更新时间
  筛选：更新时间（dateRange）
  操作：库存调整（需审批）— 表单 storeId*, skuId*, availableQty*
        发起调拨（需审批）— 表单 fromStoreId*, toStoreId*, skuId*, qty*
```

派生规则都是确定性的：

| 来源 | 生成 |
| --- | --- |
| 属性声明 | 列表列（数值右对齐、枚举渲染成 badge、json 不进列表但进详情） |
| 枚举 / 日期属性 | 筛选器（select / dateRange） |
| action 的 inputSchema | 操作表单（保留必填标记与枚举取值） |
| 只有声明没有 effect 的动作 | 不生成表单，并在提示里点名 |

同一份 IR 生成**逐字相同**的规格，所以可以做快照对比——改一个属性，diff 里能直接看到多了一列。

面板的「应用构建」页读这个规格并渲染成预览。**它不是可交互应用**：规格到组件还需要一个渲染器，这一步没做，也不假装做了。
