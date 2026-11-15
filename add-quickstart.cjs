const fs = require('fs');
let s = fs.readFileSync('README.md', 'utf8');
if (s.includes('## 三分钟上手')) throw new Error('已存在');

const block = [
  '## 三分钟上手',
  '',
  '装好之后，四种最常见的动作：',
  '',
  '**1. 先看有什么**',
  '',
  '```
  ontology_list
  → retail.store-inventory v1.0.0 (published) — 6 对象 / 5 关系 / 4 规则 / 4 动作
  ```',
  '',
  '**2. 在面板里改本体**（人工操作，不走审批）',
  '',
  '左侧栏 → Ontology Studio → **本体模型**：',
  '',
  '- `+ 新建对象` 建一个对象，属性表逐行填字段',
  '- 对象详情里 `+ 新增关系` 连到另一个对象',
  '- `图谱视图` 看全貌，拖节点排版、从右侧圆点拖到另一个节点直接建关系',
  '',
  '保存前会按整个资产包校验，错误直接列在表单下面，**磁盘不会被动**。',
  '',
  '**3. 在面板里跑规则**（只读）',
  '',
  '逻辑与动作页 → `在示例数据上跑一次`，就地看到几处违规、涉及哪几条规则。',
  '',
  '**4. 让 Agent 做**（写操作弹审批）',
  '',
  '```
  你：这条规则改成 error 级别
  你：改完 Inventory 之后要重新验哪些东西？
  你：体检一下这份本体还缺什么
  ```',
  '',
  '更多操作细节见 [USAGE.md](USAGE.md)。',
  '',
  '## 工具速查',
  '',
  '28 个工具（19 读 / 9 写）。按用途分组，完整说明见 [架构文档](docs/architecture.md)。',
  '',
  '| 想做什么 | 用哪个 |',
  '| --- | --- |',
  '| 看有哪些包 / 看一个对象 | `ontology_list` · `ontology_get` |',
  '| 校验 / 改完看影响 | `ontology_validate` · `ontology_impact` · `ontology_regression_plan` |',
  '| 改模型 | `ontology_upsert_object` · `ontology_upsert_link` · `ontology_delete_*` · `ontology_publish` |',
  '| 跑规则 / 执行动作 | `ontology_evaluate_rules` · `ontology_execute_action` |',
  '| 看事实数据 / 变更历史 | `ontology_records` · `ontology_history` |',
  '| 从表结构或样例报文建草稿 | `ontology_draft_object` · `ontology_draft_from_payload` |',
  '| 导出 / 生成页面规格 | `ontology_export` · `ontology_generate_app` |',
  '| 资产市场 | `ontology_asset_catalog` · `ontology_install_asset` · `ontology_uninstall_asset` · `ontology_upgrade` · `ontology_diff` |',
  '| Agent 与体检 | `ontology_agents` · `ontology_harness_check` |',
  '| 评测 | `ontology_eval_run` · `ontology_eval_compare` |',
  '| 装好没装好 | `ontology_diagnostics` |',
  '',
  '所有写工具都遵循同一条不变量：**先构造「写完之后」的整包再校验，不通过就什么都不写**；都支持 `dryRun`。',
  '',
  '## 深入阅读',
  '',
].join('\n');

// 已有的「深入阅读」标题块替换成新块（新块自带标题与引导）
const anchor = '## 深入阅读';
if (!s.includes(anchor)) throw new Error('anchor missing');
s = s.replace(anchor, block.trimEnd() + '\n\nREADME 只回答「这是什么、怎么装、怎么用、边界在哪」。想往下钻的：');
fs.writeFileSync('README.md', s);
console.log('sections added');
