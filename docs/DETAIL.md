# 本体工作台（Ontology Studio）

企业级语义建模与 Harness 智能执行平台，以 DSH 插件形式挂在 DeepSeek Harness 内：一个独立主面板、一个侧栏入口，加上 **37 个**可被 Agent 直接调用的本体工具。

## 装上之后能做什么

**看**：侧栏面板图标列表里多出「本体工作台」，点开是全屏面板，左侧按「概览 / 资产生产 / 执行编排 / 应用与生态 / 运行与治理」分组，共九个页面。

**改**：面板上可以直接新建、编辑、删除对象与属性、关系与规则。保存前按整个资产包校验，错误逐条显示在表单下方，**磁盘不会被动**；也可以切到图谱视图，拖节点排版、从节点右侧圆点拖到另一个对象直接建关系。

**用**：宿主半注册了 37 个工具，Agent 可以直接读写本体，不必由人贴文档。按用途分组：

| 用途 | 工具 |
| --- | --- |
| 读结构与状态 | `ontology_list`、`ontology_get`、`ontology_records`、`ontology_history` |
| 校验与分析 | `ontology_validate`、`ontology_impact`、`ontology_regression_plan`、`ontology_harness_check` |
| 改模型（写） | `ontology_upsert_object`、`ontology_upsert_link`、`ontology_delete_object`、`ontology_delete_link`、`ontology_publish` |
| 规则与动作 | `ontology_evaluate_rules`、`ontology_execute_action`、`ontology_eval_run`、`ontology_eval_compare` |
| 建模辅助 | `ontology_draft_object`（表结构）、`ontology_draft_from_payload`（样例报文） |
| 产物 | `ontology_export`（JSON Schema / Markdown）、`ontology_generate_app`（页面规格） |
| 资产市场（写） | `ontology_asset_catalog`、`ontology_install_asset`、`ontology_uninstall_asset`、`ontology_upgrade`、`ontology_diff` |
| 数据接入 | `ontology_draft_from_csv`、`ontology_package_from_csv`、`ontology_sync_csv`、`ontology_sync_status`（后三个写盘，走审批） |
| 治理与视角 | `ontology_upsert_view`、`ontology_delete_view`（写）、`ontology_metrics`、`ontology_lineage` |
| 业务流程 | `ontology_process_plan`（推演，不执行） |
| 运维 | `ontology_diagnostics`、`ontology_agents` |

所有写工具都遵循同一条不变量：**先构造「写完之后」的整包再校验，不通过就什么都不写**；都支持 `dryRun` 预览。

## 安全边界

- **只读模式**：`writeMode: readonly` 时写工具根本不注册，Agent 看不到。
- **人工审批**：写操作调用 Host 审批服务，只有 `allowed-once` 放行；服务缺失、无会话、抛错一律失败关闭。
- **原子写入**：先写临时文件再 rename，进程中途挂掉不会留下半截 JSON。
- **面板写入是人工操作**，不走审批闸门（与直接编辑 JSON 同层级），但有 CSRF 防护：跨站来源一律 403。

## 自检

装好后先跑 `ontology_diagnostics`，一次回答：代码与磁盘版本是否一致、资产是否通过校验、写入门禁档位、简报是否就绪、可选服务是否可用、面板跑的是哪一版客户端。

面板客户端有浏览器缓存，升级后若显示「演示数据」或布局异常，按 Ctrl+Shift+R 强刷。

## 更多

完整说明见仓库 [README](../README.md)（入口：安装、配置、三分钟上手）与 [USAGE](../USAGE.md)（面板每一步怎么点）。
