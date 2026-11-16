/**
 * Ontology Studio — Client half.
 *
 * Registers one main panel (key `dsh-ontology-studio`) plus its sidebar entry, so
 * the platform shell opens as its own column in the DSH Web GUI. Everything is
 * demo data: no host round-trip, no persistence, no real ontology runtime.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ontology-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useMemo = React.useMemo;
    const useEffect = React.useEffect;

    const PANEL_ID = 'dsh-ontology-studio';
    const API_BASE = '/dsh-ontology-studio';

    /** 客户端包版本：与 package.json 同步，用于自检判断面板是否刷新过。 */
    const CLIENT_VERSION = '0.43.0';

    /**
     * POST helper for panel writes. Resolves with the response body even on 4xx,
     * because a validation failure is information the form has to show.
     */
    function post(path, body) {
      return fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
      }).then(function (response) {
        return response.json().catch(function () {
          return { ok: false, message: 'HTTP ' + response.status };
        });
      });
    }

    /* ------------------------------------------------------------------ *
     * styles — theme tokens only, so light/dark follow the host
     * ------------------------------------------------------------------ */
    const CSS = `.os-graph, .os-graph * { user-select: none; -webkit-user-select: none; }
.os-root *{box-sizing:border-box}

.os-root{box-sizing:border-box;display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.os-rail{flex:0 0 212px;min-width:0;display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1)}
.os-brand{display:flex;align-items:center;gap:9px;padding:14px 14px 8px}
.os-mark{flex:none;width:26px;height:26px;border-radius:8px;background:var(--dsw-alias-brand-primary);color:#fff;display:flex;align-items:center;justify-content:center}
.os-brand-n{font-size:13px;font-weight:600;letter-spacing:.01em}
.os-brand-s{font-size:11px;color:var(--dsw-alias-label-secondary)}
.os-rail-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 8px 14px}
.os-group{font-size:11px;color:var(--dsw-alias-label-secondary);padding:12px 8px 4px;letter-spacing:.06em}
.os-nav{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.os-nav:hover{background:var(--dsw-alias-bg-layer-2)}
.os-nav.on{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.os-nav-i{flex:none;display:flex;color:var(--dsw-alias-label-secondary)}
.os-nav.on .os-nav-i{color:var(--dsw-alias-brand-primary)}
.os-nav-l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.os-rail-foot{padding:9px 14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}
.os-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
.os-head{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;padding:16px 24px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.os-head-t{flex:1;min-width:0}
.os-title{font-size:16px;font-weight:600;margin:0}
.os-desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.os-body{flex:1 1 auto;min-height:0;overflow:auto;padding:18px 24px 48px}
@media (max-width:980px){.os-body{padding:14px 14px 40px}.os-head{padding:14px 14px 12px}}
.os-grid{display:grid;gap:12px}
.os-g2{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.os-g3{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.os-g4{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.os-split{display:grid;grid-template-columns:minmax(180px,240px) minmax(0,1fr);gap:12px;align-items:stretch}
@media (max-width:980px){.os-split{grid-template-columns:minmax(0,1fr)}}
.os-tbl-wrap{overflow-x:auto}
.os-tbl-wrap>.os-tbl{min-width:100%}
.os-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}
.os-card-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.os-card-t{flex:1;min-width:0;font-size:12px;font-weight:600;white-space:nowrap}
.os-card-s{font-size:11px;color:var(--dsw-alias-label-secondary)}
.os-card-b{padding:12px 14px}
.os-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.os-field-l{font-size:11px;color:var(--dsw-alias-label-secondary)}
.os-input{width:100%;box-sizing:border-box;height:30px;padding:0 8px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.os-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
select.os-input{padding-right:4px}
.os-flush{padding:0}
.os-kpi{font-size:22px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.os-kpi-l{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:1px}
.os-kpi-d{font-size:11px;margin-top:6px;color:var(--dsw-alias-label-secondary)}
.os-tbl{width:100%;border-collapse:collapse;font-size:12px}
.os-tbl th{text-align:left;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.os-tbl td{padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}
.os-tbl tr:last-child td{border-bottom:0}
.os-tbl tbody tr:hover{background:var(--dsw-alias-bg-layer-2)}
.os-b{display:inline-flex;align-items:center;gap:4px;padding:0 7px;border-radius:999px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.os-b.on{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.os-b.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.os-b.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.os-b.brand{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.os-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.os-bar>i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary)}
.os-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12px;cursor:pointer}
.os-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.os-btn.pri{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.os-btn[disabled]{opacity:.55;cursor:default}
.os-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow:auto}
.os-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:9px 10px;margin-bottom:-1px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
.os-tab.on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.os-li{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:8px 12px;border:0;border-left:2px solid transparent;background:transparent;color:inherit;font:inherit;cursor:pointer}
.os-li:hover{background:var(--dsw-alias-bg-layer-2)}
.os-li.on{background:var(--dsw-alias-bg-layer-2);border-left-color:var(--dsw-alias-brand-primary)}
.os-li-t{font-size:12px;font-weight:600}
.os-li-s{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:1px}
.os-loop{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.os-loop-s{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2)}
.os-loop-t{font-size:12px;font-weight:600}
.os-loop-d{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.os-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l1);font-size:12px}
.os-row:last-child{border-bottom:0}
.os-grow{flex:1;min-width:0}
.os-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.os-muted{color:var(--dsw-alias-label-secondary)}
.os-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);margin-top:7px}
.os-step{display:flex;gap:10px;padding:6px 0}
.os-step-t{font-size:12px;font-weight:600}
.os-step-d{font-size:11px;color:var(--dsw-alias-label-secondary)}
.os-note{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 12px}
.os-tile{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:12px;background:var(--dsw-alias-bg-layer-1)}
.os-tile:hover{border-color:var(--dsw-alias-border-l2)}
.os-rowhead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
`;

    /* ------------------------------------------------------------------ *
     * chrome primitives
     * ------------------------------------------------------------------ */
    function Badge(p) {
      return h('span', { className: 'os-b' + (p.tone ? ' ' + p.tone : '') }, p.children);
    }

    function Card(p) {
      return h(
        'section',
        { className: 'os-card', style: p.span ? { gridColumn: 'span ' + p.span } : undefined },
        p.title
          ? h(
              'header',
              { className: 'os-card-h' },
              h('span', { className: 'os-card-t' }, p.title),
              p.sub ? h('span', { className: 'os-card-s' }, p.sub) : null,
              p.extra || null
            )
          : null,
        h('div', { className: 'os-card-b' + (p.flush ? ' os-flush' : '') }, p.children)
      );
    }

    function Stat(p) {
      return h(
        'div',
        { className: 'os-card' },
        h(
          'div',
          { className: 'os-card-b' },
          h('div', { className: 'os-kpi' }, p.value),
          h('div', { className: 'os-kpi-l' }, p.label),
          p.delta ? h('div', { className: 'os-kpi-d' }, p.delta) : null
        )
      );
    }

    function Table(p) {
      return h(
        'div',
        { className: 'os-tbl-wrap' },
        h(
        'table',
        { className: 'os-tbl' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            p.columns.map((c) =>
              h('th', { key: c.key, style: c.width ? { width: c.width } : undefined }, c.label)
            )
          )
        ),
        h(
          'tbody',
          null,
          p.rows.map((row, i) =>
            h(
              'tr',
              { key: row.key == null ? i : row.key },
              p.columns.map((c) =>
                h('td', { key: c.key }, c.render ? c.render(row) : String(row[c.key] == null ? '—' : row[c.key]))
              )
            )
          )
        )
        )
      );
    }

    function Bar(p) {
      return h(
        'div',
        { className: 'os-bar' },
        h('i', { style: { width: Math.max(0, Math.min(100, p.value)) + '%', background: p.color || undefined } })
      );
    }

    function Tabs(p) {
      return h(
        'div',
        { className: 'os-tabs' },
        p.items.map((it) =>
          h(
            'button',
            {
              key: it,
              type: 'button',
              className: 'os-tab' + (it === p.value ? ' on' : ''),
              onClick: function () {
                p.onChange(it);
              },
            },
            it
          )
        )
      );
    }

    function Notes(p) {
      return h('div', { className: 'os-note' }, p.children);
    }

    /* ------------------------------------------------------------------ *
     * glyphs
     * ------------------------------------------------------------------ */
    const GLYPH = {
      overview: h('rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.6 }),
      ontology: [
        h('circle', { key: 'a', cx: 12, cy: 5.5, r: 2.5 }),
        h('circle', { key: 'b', cx: 5.5, cy: 17.5, r: 2.5 }),
        h('circle', { key: 'c', cx: 18.5, cy: 17.5, r: 2.5 }),
        h('path', { key: 'd', d: 'M12 8v4.5M12 12.5l-4.6 3.2M12 12.5l4.6 3.2' }),
      ],
      data: [
        h('ellipse', { key: 'a', cx: 12, cy: 6, rx: 6.5, ry: 2.8 }),
        h('path', { key: 'b', d: 'M5.5 6v12c0 1.5 3 2.8 6.5 2.8s6.5-1.3 6.5-2.8V6' }),
        h('path', { key: 'c', d: 'M5.5 12c0 1.5 3 2.8 6.5 2.8s6.5-1.3 6.5-2.8' }),
      ],
      logic: [
        h('path', { key: 'a', d: 'M13.2 2.8 5 13.4h5.4L9.8 21.2 18 10.6h-5.4z' }),
      ],
      agent: [
        h('rect', { key: 'a', x: 4, y: 7.5, width: 16, height: 11, rx: 3.2 }),
        h('path', { key: 'b', d: 'M12 3.5v4M8.4 12.5v1.6M15.6 12.5v1.6' }),
      ],
      app: [
        h('rect', { key: 'a', x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.6 }),
        h('path', { key: 'b', d: 'M3.5 9h17' }),
      ],
      governance: [
        h('path', { key: 'a', d: 'M12 2.8 4.8 5.6v6.1c0 4.6 3 8.2 7.2 9.6 4.2-1.4 7.2-5 7.2-9.6V5.6z' }),
        h('path', { key: 'b', d: 'M9.2 12.1l2 2 3.6-3.9' }),
      ],
      marketplace: [
        h('path', { key: 'a', d: 'M5.5 7.5h13l-1.1 12a1.6 1.6 0 0 1-1.6 1.5H8.2a1.6 1.6 0 0 1-1.6-1.5z' }),
        h('path', { key: 'b', d: 'M8.8 7.5V6.2a3.2 3.2 0 0 1 6.4 0v1.3' }),
      ],
      observability: [
        h('path', { key: 'a', d: 'M3 13h3.2l2.3-6.6 3.2 12 2.6-8 1.7 2.6H21' }),
      ],
    };

    function Glyph(p) {
      const size = p.size || 15;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        GLYPH[p.name] || GLYPH.overview
      );
    }

    /* ------------------------------------------------------------------ *
     * demo data
     * ------------------------------------------------------------------ */
    const NAV = [
      { group: '概览', items: [{ id: 'overview', label: '平台总览', icon: 'overview' }] },
      {
        group: '资产生产',
        items: [
          { id: 'ontology', label: '本体模型', icon: 'ontology' },
          { id: 'data', label: '数据接入', icon: 'data' },
        ],
      },
      {
        group: '执行编排',
        items: [
          { id: 'logic', label: '逻辑与动作', icon: 'logic' },
          { id: 'agent', label: 'Agent & Harness', icon: 'agent' },
        ],
      },
      {
        group: '应用与生态',
        items: [
          { id: 'app', label: '应用构建', icon: 'app' },
          { id: 'marketplace', label: '资产市场', icon: 'marketplace' },
        ],
      },
      {
        group: '运行与治理',
        items: [
          { id: 'governance', label: '治理中心', icon: 'governance' },
          { id: 'observability', label: '可观测与评测', icon: 'observability' },
        ],
      },
    ];

    const PAGE = {
      overview: ['平台总览', 'Ontology 是业务语义底座，Harness 是智能执行底座，八个 Studio 负责资产生产与运营。'],
      ontology: ['Ontology Model Studio', '业务对象、属性、关系、动作的统一建模入口，支持四视角与影响分析。'],
      data: ['Data Studio', '让现有系统的数据被本体统一理解：同步型与联邦型并存，不要求数据搬家。'],
      logic: ['Logic & Action Studio', '本体不只是静态模型，还要描述业务能做什么，以及行为的实际影响。'],
      agent: ['Agent & Harness Studio', 'Ontology-aware Harness：Agent 的上下文、工具、约束与执行边界都来自本体。'],
      app: ['App Studio', '应用依赖本体定义而不是底层表结构，元数据变化可被页面自动感知。'],
      marketplace: ['Marketplace & Extension Center', '能力一旦建成，就成为可复制、可安装、可升级的资产。'],
      governance: ['Governance Center', '唯一 ID、版本、责任人、审核、审计与回滚：企业级平台的必要条件。'],
      observability: ['Observability & Evaluation Center', '不只记录返回了什么，还记录为什么这样执行、用了什么数据、有没有真正完成任务。'],
    };

    const OBJECTS = [
      {
        id: 'Inventory',
        name: '库存',
        domain: '供应链',
        owner: '供应链数字化组',
        version: '1.0.3',
        status: '已发布',
        table: 'dwd_inventory',
        desc: '门店 + SKU 维度的可售库存快照。',
        keys: ['storeId', 'skuId'],
        props: [
          { name: 'storeId', label: '门店编号', type: 'string', required: true, source: 'pos.store_code', indexed: true },
          { name: 'skuId', label: 'SKU 编号', type: 'string', required: true, source: 'item.sku_code', indexed: true },
          { name: 'onHandQty', label: '在库数量', type: 'number', source: 'inv.qty_on_hand' },
          { name: 'availableQty', label: '可售数量', type: 'number', source: 'inv.qty_available', note: '可售 = 在库 − 锁定' },
          { name: 'lockedQty', label: '锁定数量', type: 'number', source: 'inv.qty_locked' },
          { name: 'safetyStock', label: '安全库存', type: 'number', source: 'rule.safety_stock', constraint: '>= 0' },
          { name: 'updatedAt', label: '更新时间', type: 'datetime', source: 'inv.gmt_modified' },
        ],
        links: [
          ['belongsTo', 'Store 门店', 'n:1', '每个库存行属于一个门店'],
          ['references', 'Product 商品', 'n:1', '每个库存行引用一个商品'],
        ],
        actions: [
          ['adjustInventory', '库存调整', '需审批', '写 Inventory'],
          ['createTransfer', '发起调拨', '需审批', '写 Order, Inventory'],
          ['startStocktake', '发起盘点', '免审批', '写 Inventory'],
        ],
        impact: [
          ['数据源', 'POS 系统 · 商品中心 API', '字段映射需重新校验'],
          ['业务规则', '低库存预警、缺货告警', '表达式引用 availableQty'],
          ['Agent', '库存补货 Agent', '依赖本对象做补货建议'],
          ['应用页面', '门店库存看板', '表格列依赖本属性'],
        ],
      },
      {
        id: 'Store',
        name: '门店',
        domain: '门店运营',
        owner: '门店运营组',
        version: '1.1.0',
        status: '已发布',
        table: 'dim_store',
        desc: '可独立经营的物理门店，库存与销售的最小组织单元。',
        keys: ['storeId'],
        props: [
          { name: 'storeId', label: '门店编号', type: 'string', required: true, source: 'mdm.store_code', indexed: true },
          { name: 'storeName', label: '门店名称', type: 'string', required: true, source: 'mdm.store_name' },
          { name: 'city', label: '所属城市', type: 'string', source: 'mdm.city_code' },
          { name: 'format', label: '店型', type: 'enum', source: 'mdm.store_format', constraint: '大卖场 | 标超 | 便利店' },
          { name: 'openDate', label: '开业日期', type: 'date', source: 'mdm.open_date' },
        ],
        links: [
          ['hasMany', 'Inventory 库存', '1:n', '一个门店有多条库存记录'],
          ['hasMany', 'Order 订单', '1:n', '门店产生的销售与调拨单'],
        ],
        actions: [['createTransfer', '门店间调拨', '需审批', '写 Order, Inventory']],
        impact: [
          ['数据源', '门店主数据', '新增店型枚举需同步映射'],
          ['Agent', '巡店助手 Agent', '按门店维度组织上下文'],
        ],
      },
      {
        id: 'Product',
        name: '商品',
        domain: '商品管理',
        owner: '商品中心',
        version: '2.0.1',
        status: '已发布',
        table: 'dim_product',
        desc: '商品主数据，SKU 是其可售卖形态。',
        keys: ['productId'],
        props: [
          { name: 'productId', label: '商品编号', type: 'string', required: true, source: 'item.item_code', indexed: true },
          { name: 'productName', label: '商品名称', type: 'string', required: true, source: 'item.item_name' },
          { name: 'category', label: '品类', type: 'string', source: 'item.cate_code' },
          { name: 'brand', label: '品牌', type: 'string', source: 'item.brand_name' },
          { name: 'shelfLifeDays', label: '保质期（天）', type: 'number', source: 'item.shelf_life' },
        ],
        links: [
          ['suppliedBy', 'Supplier 供应商', 'n:m', '商品可来自多个供应商'],
          ['referencedBy', 'Inventory 库存', '1:n', ''],
        ],
        actions: [],
        impact: [['业务规则', '库存周转健康度', '按品类计算周转']],
      },
      {
        id: 'Order',
        name: '订单',
        domain: '交易',
        owner: '交易中台',
        version: '1.4.2',
        status: '已发布',
        table: 'dwd_order',
        desc: '含 POS 销售单、补货采购单与门店调拨单。',
        keys: ['orderId'],
        props: [
          { name: 'orderId', label: '订单号', type: 'string', required: true, source: 'ord.order_no', indexed: true },
          { name: 'orderType', label: '订单类型', type: 'enum', source: 'ord.order_type', constraint: '销售 | 采购 | 调拨' },
          { name: 'amount', label: '金额', type: 'money', source: 'ord.pay_amount' },
          { name: 'createdAt', label: '创建时间', type: 'datetime', source: 'ord.gmt_create' },
        ],
        links: [['contains', 'Product 商品', 'n:m', '订单行明细']],
        actions: [['createReplenishment', '生成补货建议', '需审批', '写 Order']],
        impact: [['应用页面', '补货工作台', '订单列表依赖订单类型']],
      },
      {
        id: 'Supplier',
        name: '供应商',
        domain: '供应链',
        owner: '采购部',
        version: '0.9.0',
        status: '草稿',
        table: 'dim_supplier',
        desc: '供货方及其供货品类范围。',
        keys: ['supplierId'],
        props: [
          { name: 'supplierId', label: '供应商编号', type: 'string', required: true, source: 'sup.sup_code', indexed: true },
          { name: 'supplierName', label: '供应商名称', type: 'string', required: true, source: 'sup.sup_name' },
          { name: 'leadTimeDays', label: '到货周期（天）', type: 'number', source: 'sup.lead_time' },
        ],
        links: [['supplies', 'Product 商品', 'n:m', '']],
        actions: [],
        impact: [['业务规则', '补货提前期', '依赖到货周期字段']],
      },
      {
        id: 'Member',
        name: '会员',
        domain: '会员运营',
        owner: '会员中心',
        version: '0.4.0',
        status: '草稿',
        table: 'dim_member',
        desc: '会员基础信息与等级，用于门店维度的客群分析。',
        keys: ['memberId'],
        props: [
          { name: 'memberId', label: '会员编号', type: 'string', required: true, source: 'crm.member_id', indexed: true },
          { name: 'level', label: '会员等级', type: 'enum', source: 'crm.member_level', constraint: '普通 | 银卡 | 金卡' },
          { name: 'joinDate', label: '入会日期', type: 'date', source: 'crm.join_date' },
        ],
        links: [['shopsAt', 'Store 门店', 'n:m', '常到访门店']],
        actions: [],
        impact: [],
      },
    ];

    const SOURCES = [
      {
        name: 'POS 交易库',
        kind: '同步型',
        dialect: 'MySQL 8.0',
        tables: 42,
        objects: 'Order, Store',
        progress: 100,
        status: 'healthy',
        note: 'CDC 增量同步，延迟 < 30s',
      },
      {
        name: '商品中心 API',
        kind: '联邦型',
        dialect: 'REST / OpenAPI',
        tables: 6,
        objects: 'Product, Supplier',
        progress: 72,
        status: 'building',
        note: '按需调用，不落湖；QPS 限流 50',
      },
      {
        name: '供应链中台',
        kind: '同步型',
        dialect: 'Hive / JDBC',
        tables: 128,
        objects: 'Inventory, Order',
        progress: 88,
        status: 'building',
        note: 'T+1 全量 + 小时级增量',
      },
      {
        name: '门店主数据',
        kind: '联邦型',
        dialect: 'MDM SDK',
        tables: 4,
        objects: 'Store',
        progress: 100,
        status: 'healthy',
        note: '权威源，只读',
      },
    ];

    const MAPPING = [
      ['store_code', 'Inventory.storeId', 'string', '直接映射', 'ok'],
      ['sku_code', 'Inventory.skuId', 'string', '直接映射', 'ok'],
      ['qty_on_hand', 'Inventory.onHandQty', 'number', '直接映射', 'ok'],
      ['qty_available', 'Inventory.availableQty', 'number', '直接映射', 'ok'],
      ['qty_locked', 'Inventory.lockedQty', 'number', '直接映射', 'ok'],
      ['safety_qty', 'Inventory.safetyStock', 'number', '空值默认 0', 'warn'],
      ['gmt_modified', 'Inventory.updatedAt', 'datetime', '时区 Asia/Shanghai', 'ok'],
      ['store_type', 'Store.format', 'enum', '枚举值需映射', 'warn'],
    ];

    const RULES = [
      ['inventory.lowStockWarning', '低库存预警', 'availableQty < safetyStock', 'warn', '启用', '供应链数字化组'],
      ['inventory.stockoutAlert', '缺货告警', 'availableQty <= 0', 'error', '启用', '门店运营组'],
      ['inventory.turnoverHealth', '库存周转健康度', 'turnoverDays between 12 and 35', 'info', '启用', '供应链数字化组'],
      ['inventory.autoReplenish', '自动补货触发', 'availableQty < safetyStock && leadTime < 3', 'warn', '草稿', '供应链数字化组'],
    ];

    const ACTIONS = [
      ['adjustInventory', '库存调整', 'InventoryAdjustment', '需审批', 'Inventory', '1.0.3'],
      ['createTransfer', '发起调拨', 'TransferRequest', '需审批', 'Order, Inventory', '1.0.1'],
      ['startStocktake', '发起盘点', 'StocktakeRequest', '免审批', 'Inventory', '1.0.0'],
      ['createReplenishment', '生成补货建议', 'ReplenishmentRequest', '需审批', 'Order', '0.8.2'],
    ];

    const FUNCTIONS = [
      ['fn.availableQty', '可售数量计算', 'onHand − locked', '纯函数'],
      ['fn.turnoverDays', '库存周转天数', 'avgInventory / dailySales', '纯函数'],
      ['fn.suggestQty', '建议补货量', '需求预测 − 在库 − 在途', '调用模型服务'],
      ['fn.routeTransfer', '调拨路径寻优', '最近门店 + 运力约束', '外部服务'],
    ];

    const AGENTS = [
      {
        name: '库存补货 Agent',
        status: '已发布',
        model: 'deepseek-v4.1-flash',
        ontology: ['Inventory', 'Store', 'Product', 'Order'],
        skills: ['补货建议生成', '门店对比分析'],
        tools: ['ontology.query', 'order.create', 'notify.feishu'],
        actions: ['createReplenishment'],
        eval: '补货准确率 87%',
      },
      {
        name: '巡店助手 Agent',
        status: '灰度',
        model: 'deepseek-v4.1-flash',
        ontology: ['Store', 'Inventory'],
        skills: ['陈列检查', '缺货巡检'],
        tools: ['ontology.query', 'vision.read_image'],
        actions: ['startStocktake'],
        eval: '任务完成率 92%',
      },
      {
        name: '会员运营 Agent',
        status: '草稿',
        model: 'deepseek-v4.1-flash',
        ontology: ['Member', 'Store', 'Order'],
        skills: ['客群分层', '活动效果归因'],
        tools: ['ontology.query', 'crm.segment'],
        actions: [],
        eval: '尚未评测',
      },
    ];

    const RUNTIME = [
      ['Agent Loop', 'Think / Tool / Verify 执行循环'],
      ['Context Engine', '本体对象 + 关系 + 规则 + 工具 + 权限'],
      ['Tool & Skill Runtime', '统一 Tool Registry，MCP / SDK 双适配'],
      ['Memory & Policy', '会话记忆、策略校验、人工审批闸门'],
      ['Evaluation', 'Trace 回放、指标评测、回归验证'],
    ];

    const APPS = [
      ['门店库存看板', '看板', 'Inventory, Store, Product', '已发布', '2 个页面模板'],
      ['补货工作台', '工作台', 'Inventory, Order', '已发布', '含审批流'],
      ['商品运营台', '管理台', 'Product, Supplier', '内测', '表单自动生成'],
      ['调拨审批页', '表单', 'Inventory, Order', '草稿', '由 Action 生成'],
    ];

    const VERSIONS = [
      ['retail.store-inventory', '1.0.0', '已发布', '供应链数字化组', '2026-11-13 09:20', '首个完整资产包'],
      ['retail.store-inventory', '0.9.2', '已发布', '供应链数字化组', '2026-11-06 15:41', '补充规则与动作'],
      ['本体 Inventory', '1.0.3', '已发布', '供应链数字化组', '2026-11-12 18:03', '新增 safetyStock'],
      ['本体 Supplier', '0.9.0', '草稿', '采购部', '2026-11-11 11:12', '待审核'],
    ];

    const APPROVALS = [
      ['调整门店 S-0213 的可售库存 −120', 'adjustInventory', '库存补货 Agent', '待审批', 'urgent'],
      ['调拨 400 件至 S-0188（跨区域）', 'createTransfer', '运营专员 李明', '待审批', 'warn'],
      ['发布本体 Supplier 0.9.0', 'release', '采购部 王芳', '待审批', 'warn'],
      ['启用规则 inventory.autoReplenish', 'publishRule', '供应链数字化组', '已通过', 'on'],
    ];

    const PERMISSIONS = [
      ['供应链数字化组', '本体 · 规则 · 动作', '读写', '4 人'],
      ['门店运营组', '本体只读 · 动作执行', '读写（受限）', '12 人'],
      ['商品中心', 'Product 本体维护', '读写', '3 人'],
      ['库存补货 Agent', 'Ontology 查询 · Order 创建', '受限', '服务身份'],
    ];

    const AUDIT = [
      ['18:03', 'Inventory.safetyStock', '新增属性', '供应链数字化组'],
      ['17:22', '库存补货 Agent', '调用 adjustInventory（被策略拦截）', 'system/policy'],
      ['16:40', 'retail.store-inventory 1.0.0', '发布', '供应链数字化组'],
      ['15:05', 'Store.format', '枚举值调整', '门店运营组'],
    ];

    const ASSETS = [
      ['门店-商品-库存资产包', '业务场景资产', '1.0.0', '本体 6 · 规则 4 · 动作 4 · Agent 1', '已安装'],
      ['库存补货 Agent 模板', 'Agent 模板', '0.6.0', '依赖 3 个本体 · 2 个 Skill', '已安装'],
      ['Hive 数据连接器', '连接器', '2.1.0', '平台组件', '可安装'],
      ['零售行业语义模型', '通用语义资产', '1.2.0', 'Object 模板 24 个', '可安装'],
      ['库存预警组件', '应用组件', '0.3.1', '依赖 Inventory 本体', '可安装'],
      ['评测器：补货准确率', '评测器', '1.0.0', '依赖 Trace Schema', '已安装'],
    ];

    const TRACES = [
      {
        id: 'trace_8f2a',
        title: '为 S-0213 生成补货建议',
        agent: '库存补货 Agent',
        status: '已人工审批',
        ms: 4210,
        tokens: '12.4k',
        cost: '¥0.08',
        steps: [
          ['01 任务解析', '识别目标门店与时间窗', 'ok'],
          ['02 上下文构建', '加载 Inventory 42 行 / 规则 2 条 / 动作 1 个', 'ok'],
          ['03 计划', '对比近 14 天销量与在途库存', 'ok'],
          ['04 工具调用', 'ontology.query(inventory), order.create(draft)', 'ok'],
          ['05 结果校验', '建议量 480 件，符合安全库存约束', 'ok'],
          ['06 人工审批', '大区经理 张伟 通过', 'ok'],
          ['07 写回', '供应链系统回写成功', 'ok'],
        ],
      },
      {
        id: 'trace_7c11',
        title: '调拨 400 件至 S-0188',
        agent: '库存补货 Agent',
        status: '等待审批',
        ms: 3180,
        tokens: '9.1k',
        cost: '¥0.06',
        steps: [
          ['01 任务解析', '跨区域调拨，命中策略 policy.crossRegion.transfer', 'warn'],
          ['02 上下文构建', '加载两个门店库存 + 运力约束', 'ok'],
          ['03 计划', '确定调拨量 400 件', 'ok'],
          ['04 工具调用', 'transfer.preview', 'ok'],
          ['05 人工审批', '等待大区经理确认', 'warn'],
        ],
      },
      {
        id: 'trace_6b03',
        title: '盘点 S-0213 冷冻区',
        agent: '巡店助手 Agent',
        status: '失败',
        ms: 1240,
        tokens: '3.2k',
        cost: '¥0.02',
        steps: [
          ['01 任务解析', '识别盘点范围', 'ok'],
          ['02 工具调用', 'vision.read_image 超时', 'err'],
          ['03 重试', '仍失败，返回可恢复错误', 'err'],
        ],
      },
    ];

    const EVALS = [
      ['补货准确率', '87%', '+4pt', '近 7 天 128 次执行'],
      ['任务成功率', '94%', '+1pt', '含人工兜底'],
      ['平均耗时', '3.9s', '−0.6s', 'P50'],
      ['单次成本', '¥0.06', '−12%', '模型 + 工具'],
    ];

    /* ------------------------------------------------------------------ *
     * live ontology (Host-owned assets, served over the plugin's own route)
     * ------------------------------------------------------------------ */
    const STATUS_TEXT = { published: '已发布', draft: '草稿', deprecated: '已弃用' };

    function useOntologyState() {
      const [nonce, setNonce] = useState(0);
      const [state, setState] = useState({ phase: 'loading', value: null, file: null, ir: null, error: null, traces: [], records: null, history: [], catalog: null, appSpec: null, agents: null });
      useEffect(function () {
        let alive = true;
        const get = function (path) {
          return fetch(API_BASE + path, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(
            function (res) {
              return res.ok ? res.json() : Promise.reject(new Error(path + ' → ' + res.status));
            }
          );
        };
        if (typeof fetch !== 'function') {
          setState({ phase: 'offline', value: null, file: null, ir: null, error: 'no fetch', traces: [], records: null, history: [], catalog: null, appSpec: null, agents: null });
          return function () {};
        }
        get('/status')
          .then(function (body) {
            if (!alive) return null;
            const value = body && body.value;
            const first = value && value.packages ? value.packages.filter(function (p) { return p.ok; })[0] : null;
            if (!first) {
              setState({ phase: 'empty', value: value, file: null, ir: null, error: null, traces: [], records: null, history: [], catalog: null, appSpec: null, agents: null });
              return null;
            }
            return get('/package?id=' + encodeURIComponent(first.id)).then(function (pkg) {
              return Promise.all([
                get('/traces?limit=30').catch(function () {
                  return { value: { entries: [] } };
                }),
                get('/records?id=' + encodeURIComponent(first.id) + '&limit=3').catch(function () {
                  return { value: null };
                }),
                get('/history?id=' + encodeURIComponent(first.id) + '&limit=40').catch(function () {
                  return { value: { entries: [] } };
                }),
                get('/catalog').catch(function () {
                  return { value: null };
                }),
                get('/app-spec?id=' + encodeURIComponent(first.id)).catch(function () {
                  return { value: null };
                }),
                get('/harness?id=' + encodeURIComponent(first.id)).catch(function () {
                  return { value: null };
                }),
                get('/agents?id=' + encodeURIComponent(first.id)).catch(function () {
                  return { value: null };
                }),
              ]).then(function (both) {
                if (!alive) return;
                const entries = (both[0] && both[0].value && both[0].value.entries) || [];
                const records = (both[1] && both[1].value) || null;
                const historyEntries = (both[2] && both[2].value && both[2].value.entries) || [];
                const catalog = (both[3] && both[3].value) || null;
                const appSpec = (both[4] && both[4].value) || null;
                const harness = (both[5] && both[5].value) || null;
                const agents = (both[6] && both[6].value) || null;
                setState({
                  phase: 'live',
                  value: value,
                  file: pkg.value.file,
                  ir: pkg.value.ir,
                  error: null,
                  traces: entries,
                  records: records,
                  history: historyEntries,
                  catalog: catalog,
                  appSpec: appSpec,
                  harness: harness,
                  agents: agents,
                });
              });
            });
          })
          .catch(function (error) {
            if (alive) {
              setState({ phase: 'offline', value: null, file: null, ir: null, error: String(error && error.message), traces: [], records: null, history: [], catalog: null, appSpec: null, agents: null });
            }
          });
        return function () {
          alive = false;
        };
      }, [nonce]);
      /** Re-read everything from the Host; Agent writes make the panel stale. */
      const reload = function () {
        setNonce(function (n) {
          return n + 1;
        });
      };
      return [state, reload];
    }

    /** Project one IR object onto the shape the pages render. */
    function objectFromIr(obj, ir) {
      const objects = ir.objects || [];
      const nameOf = function (id) {
        const hit = objects.filter(function (o) { return o.id === id; })[0];
        return hit ? id + ' ' + hit.name : id;
      };
      const status = STATUS_TEXT[ir.status] || ir.status || '草稿';
      const props = (obj.properties || []).map(function (p) {
        return {
          name: p.name,
          label: p.label || p.name,
          type: p.type,
          required: p.required === true,
          source: p.source,
          note: p.description,
          constraint: p.enum ? p.enum.join(' | ') : undefined,
        };
      });
      const propNames = props.map(function (p) { return p.name; });
      const links = (ir.links || [])
        .filter(function (l) { return l.source === obj.id || l.target === obj.id; })
        .map(function (l) {
          const outbound = l.source === obj.id;
          return [l.type, nameOf(outbound ? l.target : l.source), l.cardinality || '—', outbound ? '出向' : '入向'];
        });
      const actions = (ir.actions || [])
        .filter(function (a) { return (a.writes || []).indexOf(obj.id) >= 0; })
        .map(function (a) {
          return [a.id, a.name, a.approvalRequired ? '需审批' : '免审批', '写 ' + (a.writes || []).join(', ')];
        });
      const rules = (ir.rules || []).filter(function (r) {
        const expression = String(r.expression || '');
        return propNames.some(function (name) {
          return new RegExp('\\b' + name + '\\b').test(expression);
        });
      });
      const actionIds = actions.map(function (a) { return a[0]; });
      const policies = (ir.policies || []).filter(function (p) {
        return (p.appliesTo || []).some(function (a) { return actionIds.indexOf(a) >= 0; });
      });
      const impact = []
        .concat(links.map(function (l) { return ['关系', l[0] + ' → ' + l[1], l[3]]; }))
        .concat(rules.map(function (r) { return ['业务规则', r.id, r.enabled === false ? '已停用' : r.severity]; }))
        .concat(actions.map(function (a) { return ['业务动作', a[0], a[2]]; }))
        .concat(policies.map(function (p) { return ['审批策略', p.id, p.effect]; }));
      return {
        id: obj.id,
        name: obj.name,
        desc: obj.description || '',
        domain: ir.domain || '—',
        owner: ir.owner || '—',
        version: ir.version,
        status: status,
        table: null,
        keys: obj.keys || [],
        props: props,
        links: links,
        actions: actions,
        impact: impact,
      };
    }

    function buildModel(state) {
      const live = state.phase === 'live' && state.ir;
      if (live) {
        const problems = state.value ? state.value.problems || [] : [];
        return {
          phase: state.phase,
          live: true,
          label: '实时资产',
          readOnly: state.value ? state.value.readOnly === true : false,
          approval: state.value && state.value.approval ? state.value.approval : 'destructive',
          hostVersion: (state.value && state.value.version) || null,
          traces: state.traces || [],
          records: state.records || null,
          history: state.history || [],
          catalog: state.catalog || null,
          appSpec: state.appSpec || null,
          harness: state.harness || null,
          agents: state.agents || null,
          dir: state.value ? state.value.dir : null,
          file: state.file,
          problems: problems,
          pkg: state.ir,
          objects: (state.ir.objects || []).map(function (o) { return objectFromIr(o, state.ir); }),
          rules: (state.ir.rules || []).length,
          links: (state.ir.links || []).length,
          actions: (state.ir.actions || []).length,
        };
      }
      return {
        phase: state.phase,
        live: false,
        label: state.phase === 'offline' ? '演示数据 · 服务未连接' : '演示数据',
        readOnly: false,
        approval: 'never',
        traces: [],
        records: null,
        history: [],
        catalog: null,
        appSpec: null,
        harness: null,
        agents: null,
        dir: null,
        file: null,
        problems: [],
        pkg: null,
        objects: OBJECTS,
        rules: RULES.length,
        links: 5,
        actions: ACTIONS.length,
      };
    }

    /* ------------------------------------------------------------------ *
     * pages
     * ------------------------------------------------------------------ */
    function OverviewPage(props) {
      const model = props.model || buildModel({ phase: 'demo' });
      const loop = [
        ['企业业务知识', '制度、流程、数据资产、接口、规则'],
        ['Ontology 语义建模', '对象、属性、关系、事件、规则、动作'],
        ['Harness 智能执行', '上下文、Skills、工具、Agent、权限、评测'],
        ['业务应用与自动化', '查询分析、决策、运营、流程自动化'],
      ];
      const published = model.objects.filter(function (o) { return o.status === '已发布'; }).length;
      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g4' },
          h(Stat, {
            value: String(model.objects.length),
            label: '本体对象',
            delta: model.live
              ? (model.pkg ? (model.pkg.objects || []).reduce(function (n, o) { return n + (o.properties || []).length; }, 0) + ' 个属性' : '—')
              : published + ' 已发布 · ' + (model.objects.length - published) + ' 草稿',
          }),
          h(Stat, { value: String(model.rules), label: '业务规则', delta: model.live ? '来自当前资产包' : '演示数据' }),
          h(Stat, { value: String(model.actions), label: '业务动作', delta: model.live ? '含审批标记' : '演示数据' }),
          h(Stat, { value: String(model.links), label: '对象关系', delta: model.live ? '资产包内声明' : '演示数据' })
        ),
        model.live
          ? h(
              Card,
              {
                title: '资产校验',
                sub: model.dir,
                extra: h(Badge, { tone: model.problems.length ? 'err' : 'on' }, model.problems.length ? model.problems.length + ' 个问题' : '全部通过'),
              },
              model.problems.length
                ? model.problems.slice(0, 8).map(function (p, i) {
                    return h(
                      'div',
                      { key: i, className: 'os-row' },
                      h(Badge, { tone: 'err' }, p.code),
                      h('span', { className: 'os-grow os-mono' }, p.path),
                      h('span', { className: 'os-muted' }, p.message)
                    );
                  })
                : h(
                    'div',
                    { className: 'os-row' },
                    h('span', { className: 'os-grow' }, model.file || '—'),
                    h('span', { className: 'os-muted os-mono' }, '结构与跨引用均已通过')
                  )
            )
          : null,
        h(
          Card,
          { title: '能力闭环', sub: '运行数据与人工反馈回流到资产沉淀' },
          h(
            'div',
            { className: 'os-loop' },
            loop.map((s, i) =>
              h(
                'div',
                { key: s[0], className: 'os-loop-s' },
                h('div', { className: 'os-mono os-muted' }, '0' + (i + 1)),
                h('div', { className: 'os-loop-t' }, s[0]),
                h('div', { className: 'os-loop-d' }, s[1])
              )
            )
          )
        ),
        h(
          'div',
          { className: 'os-grid os-g2' },
          h(
            Card,
            { title: '近期变更', sub: model.live ? '来自 .ontology-history.jsonl' : '演示数据', flush: true },
            h(
              'div',
              { style: { padding: '4px 14px 10px' } },
              model.live
                ? (model.history || []).slice(0, 5).map(function (e, i) {
                    return h(
                      'div',
                      { key: i, className: 'os-row' },
                      h('span', { className: 'os-grow' }, e.summary || e.op),
                      h('span', { className: 'os-muted os-mono' }, 'v' + (e.version || '?'))
                    );
                  }).concat(
                    (model.history || []).length
                      ? []
                      : [h('div', { key: 'none', className: 'os-row os-muted' }, '还没有变更记录：这个包还没被改过。')]
                  )
                : [
                    ['10 分钟前', 'Inventory.safetyStock 新增', '供应链数字化组'],
                    ['1 小时前', '补货准确率评测通过 87%', '系统'],
                    ['3 小时前', '发布 retail.store-inventory 1.0.0', '供应链数字化组'],
                    ['昨天', '商品中心 API 映射完成 72%', '商品中心'],
                  ].map((r) =>
                    h(
                      'div',
                      { key: r[1], className: 'os-row' },
                      h('span', { className: 'os-grow' }, r[1]),
                      h('span', { className: 'os-muted os-mono' }, r[0])
                    )
                  )
            )
          ),
          h(
            Card,
            {
              title: model.live ? '需要审批的动作' : '待处理',
              sub: model.live ? '来自本体声明，不是待办队列' : '演示数据',
              flush: true,
            },
            h(
              'div',
              { style: { padding: '4px 14px 10px' } },
              model.live
                ? (model.pkg && model.pkg.actions ? model.pkg.actions : [])
                    .filter(function (a) {
                      return a.approvalRequired === true;
                    })
                    .map(function (a) {
                      const executable = Boolean(a.effect && Array.isArray(a.inputSchema) && a.inputSchema.length);
                      return h(
                        'div',
                        { key: a.id, className: 'os-row' },
                        h('span', { className: 'os-grow' }, a.name + '（' + a.id + '）'),
                        h(Badge, { tone: executable ? 'warn' : '' }, executable ? '需审批' : '仅声明')
                      );
                    })
                : APPROVALS.filter((a) => a[3] === '待审批').map((a) =>
                    h(
                      'div',
                      { key: a[0], className: 'os-row' },
                      h('span', { className: 'os-grow' }, a[0]),
                      h(Badge, { tone: a[4] === 'urgent' ? 'err' : 'warn' }, a[3])
                    )
                  )
            )
          )
        ),
        h(
          Notes,
          null,
          model.live
            ? '数据来自宿主正在读取的本体资产包（' + (model.pkg ? model.pkg.id + ' v' + model.pkg.version : '—') + '），与 Agent 调用 ontology_* 工具看到的是同一份文件。写入路径已开放：Agent 可新增/替换对象并发布版本。'
            : '当前显示的是内嵌演示数据：宿主 API 尚未连接（' + model.phase + '）。如果刚升级过插件，先强制刷新一次页面（ctrl+shift+r）——浏览器会缓存旧的客户端包。'
        )
      );
    }

    const VIEWS = ['业务视角', '数据视角', '技术视角', 'AI 视角'];


    /** Types the IR accepts; keep in sync with assets/ontology-ir.schema.json. */
    var PROPERTY_TYPES = ['string', 'number', 'integer', 'money', 'boolean', 'date', 'datetime', 'enum', 'json'];

    function blankObject() {
      return {
        id: '',
        name: '',
        description: '',
        keys: [],
        properties: [{ name: 'id', label: '编号', type: 'string', required: true }],
      };
    }

    /** Relations touching one object, straight from the IR so ids survive. */
    function rawLinks(model, objectId) {
      const pkg = model && model.pkg;
      if (!pkg || !Array.isArray(pkg.links)) return [];
      return pkg.links
        .filter(function (l) {
          return l.source === objectId || l.target === objectId;
        })
        .map(function (l) {
          const outgoing = l.source === objectId;
          const otherId = outgoing ? l.target : l.source;
          const other = (pkg.objects || []).filter(function (o) {
            return o.id === otherId;
          })[0];
          return {
            key: l.id,
            id: l.id,
            type: l.type,
            direction: outgoing ? '出向' : '入向',
            cardinality: l.cardinality || '—',
            other: other ? other.id + '（' + other.name + '）' : otherId,
            source: l.source,
            target: l.target,
          };
        });
    }

    /** The IR object, not the view model: the editor must save what the file holds. */
    function rawObject(model, id) {
      const pkg = model && model.pkg;
      const found = pkg && Array.isArray(pkg.objects) ? pkg.objects.filter(function (o) { return o.id === id; })[0] : null;
      return found ? JSON.parse(JSON.stringify(found)) : null;
    }

    /**
     * Inline editor for one object. Saving goes to the panel write route, which
     * validates the whole package and returns the validator's own problems, so
     * the form can show exactly what is wrong instead of a generic failure.
     */
    function ObjectEditor(props) {
      const [draft, setDraft] = useState(props.initial ? JSON.parse(JSON.stringify(props.initial)) : blankObject());
      const [busy, setBusy] = useState(false);
      const [problems, setProblems] = useState([]);
      const [confirmDelete, setConfirmDelete] = useState(false);
      const isNew = !props.initial;

      const patch = function (field, value) {
        const next = JSON.parse(JSON.stringify(draft));
        next[field] = value;
        setDraft(next);
      };
      const patchProperty = function (index, field, value) {
        const next = JSON.parse(JSON.stringify(draft));
        next.properties[index][field] = value;
        setDraft(next);
      };
      const addProperty = function () {
        const next = JSON.parse(JSON.stringify(draft));
        next.properties.push({ name: '', label: '', type: 'string', required: false });
        setDraft(next);
      };
      const removeProperty = function (index) {
        const next = JSON.parse(JSON.stringify(draft));
        next.properties.splice(index, 1);
        setDraft(next);
      };

      const save = function () {
        if (busy) return;
        setBusy(true);
        setProblems([]);
        // Drop empty rows so a half-filled line does not fail validation.
        const clean = JSON.parse(JSON.stringify(draft));
        clean.properties = (clean.properties || []).filter(function (p) {
          return String(p.name || '').trim() !== '';
        });
        clean.keys = (clean.keys || []).filter(function (k) {
          return clean.properties.some(function (p) {
            return p.name === k;
          });
        });
        if (!clean.keys.length && clean.properties.length) clean.keys = [clean.properties[0].name];

        post('/write/save-object', { packageId: props.packageId, object: clean })
          .then(function (body) {
            if (body && body.ok) {
              props.onDone();
              return;
            }
            setProblems((body && body.problems) || [{ message: (body && (body.message || body.error)) || '保存失败' }]);
          })
          .catch(function (error) {
            setProblems([{ message: String(error && error.message) }]);
          })
          .then(function () {
            setBusy(false);
          });
      };

      const remove = function () {
        if (busy) return;
        setBusy(true);
        setProblems([]);
        post('/write/delete-object', { packageId: props.packageId, objectId: draft.id, cascade: props.cascade })
          .then(function (body) {
            if (body && body.ok) {
              props.onDone();
              return;
            }
            if (body && body.error === 'has_dependents') {
              const d = body.dependents || {};
              setProblems([
                {
                  message:
                    '这个对象还被引用：' +
                    (d.links || 0) +
                    ' 条关系' +
                    ((d.actions || []).length ? '、动作 ' + d.actions.join(', ') : '') +
                    ((d.agents || []).length ? '、Agent ' + d.agents.join(', ') : '') +
                    '。勾选「连带清理」后再删。',
                },
              ]);
              setConfirmDelete(true);
              return;
            }
            setProblems((body && body.problems) || [{ message: (body && (body.message || body.error)) || '删除失败' }]);
          })
          .catch(function (error) {
            setProblems([{ message: String(error && error.message) }]);
          })
          .then(function () {
            setBusy(false);
          });
      };

      const field = function (label, value, onChange, placeholder) {
        return h(
          'label',
          { className: 'os-field' },
          h('span', { className: 'os-field-l' }, label),
          h('input', {
            className: 'os-input',
            value: value || '',
            placeholder: placeholder || '',
            onChange: function (event) {
              onChange(event.target.value);
            },
          })
        );
      };

      return h(
        Card,
        {
          title: isNew ? '新建对象' : '编辑 ' + (draft.name || draft.id),
          sub: '保存前会按整个资产包校验，错误直接显示在下面',
          extra: h(
            'button',
            {
              type: 'button',
              className: 'os-btn',
              onClick: function () {
                props.onCancel();
              },
            },
            '取消'
          ),
        },
        h(
          'div',
          { className: 'os-grid os-g2' },
          field('对象 ID（PascalCase）', draft.id, function (v) {
            patch('id', v);
          }, 'Warehouse'),
          field('中文名称', draft.name, function (v) {
            patch('name', v);
          }, '区域仓')
        ),
        field('说明', draft.description, function (v) {
          patch('description', v);
        }, '这个对象代表什么'),
        h(
          'div',
          { style: { marginTop: 12, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontWeight: 600 } }, '属性'),
          h('span', { className: 'os-muted' }, '主键默认取第一个属性'),
          h('span', { className: 'os-grow' }),
          h(
            'button',
            { type: 'button', className: 'os-btn', onClick: addProperty },
            '+ 添加属性'
          )
        ),
        h(Table, {
          columns: [
            {
              key: 'name',
              label: '字段名',
              render: function (r) {
                return h('input', {
                  className: 'os-input',
                  value: r.p.name,
                  placeholder: 'warehouseNo',
                  onChange: function (event) {
                    patchProperty(r.index, 'name', event.target.value);
                  },
                });
              },
            },
            {
              key: 'label',
              label: '中文名',
              render: function (r) {
                return h('input', {
                  className: 'os-input',
                  value: r.p.label || '',
                  placeholder: '仓库编号',
                  onChange: function (event) {
                    patchProperty(r.index, 'label', event.target.value);
                  },
                });
              },
            },
            {
              key: 'type',
              label: '类型',
              width: '16%',
              render: function (r) {
                return h(
                  'select',
                  {
                    className: 'os-input',
                    value: r.p.type,
                    onChange: function (event) {
                      patchProperty(r.index, 'type', event.target.value);
                    },
                  },
                  PROPERTY_TYPES.map(function (t) {
                    return h('option', { key: t, value: t }, t);
                  })
                );
              },
            },
            {
              key: 'required',
              label: '必填',
              width: '10%',
              render: function (r) {
                return h('input', {
                  type: 'checkbox',
                  checked: r.p.required === true,
                  onChange: function (event) {
                    patchProperty(r.index, 'required', event.target.checked);
                  },
                });
              },
            },
            {
              key: 'ops',
              label: '',
              width: '10%',
              render: function (r) {
                return h(
                  'button',
                  {
                    type: 'button',
                    className: 'os-btn',
                    onClick: function () {
                      removeProperty(r.index);
                    },
                  },
                  '删除'
                );
              },
            },
          ],
          rows: (draft.properties || []).map(function (p, index) {
            return { key: index, index: index, p: p };
          }),
        }),
        problems.length
          ? h(
              'div',
              { className: 'os-card-b', style: { marginTop: 10 } },
              problems.map(function (p, i) {
                return h(
                  'div',
                  { key: i, className: 'os-row' },
                  h(Badge, { tone: 'err' }, p.code || '错误'),
                  h('span', { className: 'os-grow' }, (p.path ? p.path + ' — ' : '') + (p.message || ''))
                );
              })
            )
          : null,
        h(
          'div',
          { style: { marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' } },
          h(
            'button',
            { type: 'button', className: 'os-btn pri', onClick: save, disabled: busy },
            busy ? '保存中…' : '保存'
          ),
          isNew
            ? null
            : h(
                'button',
                { type: 'button', className: 'os-btn', onClick: remove, disabled: busy },
                confirmDelete ? '确认连带删除' : '删除对象'
              ),
          h('span', { className: 'os-grow' }),
          h('span', { className: 'os-muted' }, '面板上的改动是人工操作，不走 Agent 审批；写入仍会过整包校验')
        )
      );
    }


    var CARDINALITIES = ['n:1', '1:n', '1:1', 'n:n'];

    /** snake_case id from "<source>_<type>_<target>" so relations stay predictable. */
    function linkIdFor(source, type, target) {
      const toSnake = function (name) {
        return String(name || '')
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .replace(/[\s\-.]+/g, '_')
          .toLowerCase();
      };
      return toSnake(source) + '_' + toSnake(type || 'references') + '_' + toSnake(target);
    }

    /** Inline editor for one relation, saved through the panel write route. */
    function LinkEditor(props) {
      const objects = props.objects || [];
      const initial = props.initial;
      const [draft, setDraft] = useState(
        initial
          ? JSON.parse(JSON.stringify(initial))
          : { id: '', source: props.sourceObjectId, target: '', type: 'references', cardinality: 'n:1' }
      );
      const [busy, setBusy] = useState(false);
      const [problems, setProblems] = useState([]);
      const isNew = !initial;

      const patch = function (field, value) {
        const next = JSON.parse(JSON.stringify(draft));
        next[field] = value;
        // Keep the id in step with the ends and the verb until it is hand-edited.
        if (isNew && (field === 'target' || field === 'type')) {
          next.id = linkIdFor(next.source, next.type, next.target);
        }
        setDraft(next);
      };

      const save = function () {
        if (busy) return;
        setBusy(true);
        setProblems([]);
        post('/write/save-link', { packageId: props.packageId, link: draft })
          .then(function (body) {
            if (body && body.ok) {
              props.onDone();
              return;
            }
            setProblems((body && body.problems) || [{ message: (body && (body.message || body.error)) || '保存失败' }]);
          })
          .catch(function (error) {
            setProblems([{ message: String(error && error.message) }]);
          })
          .then(function () {
            setBusy(false);
          });
      };

      const remove = function () {
        if (busy || isNew) return;
        setBusy(true);
        setProblems([]);
        post('/write/delete-link', { packageId: props.packageId, linkId: draft.id })
          .then(function (body) {
            if (body && body.ok) {
              props.onDone();
              return;
            }
            setProblems((body && body.problems) || [{ message: (body && (body.message || body.error)) || '删除失败' }]);
          })
          .catch(function (error) {
            setProblems([{ message: String(error && error.message) }]);
          })
          .then(function () {
            setBusy(false);
          });
      };

      const options = objects.map(function (o) {
        return h('option', { key: o.id, value: o.id }, o.id + '（' + o.name + '）');
      });

      return h(
        Card,
        {
          title: isNew ? '新增关系' : '编辑关系 ' + draft.id,
          sub: '两端对象必须已存在；保存前按整包校验',
          extra: h(
            'button',
            { type: 'button', className: 'os-btn', onClick: function () { props.onCancel(); } },
            '取消'
          ),
        },
        h(
          'div',
          { className: 'os-grid os-g3' },
          h(
            'label',
            { className: 'os-field' },
            h('span', { className: 'os-field-l' }, '起点对象'),
            h(
              'select',
              {
                className: 'os-input',
                value: draft.source,
                onChange: function (event) {
                  patch('source', event.target.value);
                },
              },
              options
            )
          ),
          h(
            'label',
            { className: 'os-field' },
            h('span', { className: 'os-field-l' }, '关系动词'),
            h('input', {
              className: 'os-input',
              value: draft.type,
              placeholder: 'references / belongsTo / replenishedFrom',
              onChange: function (event) {
                patch('type', event.target.value);
              },
            })
          ),
          h(
            'label',
            { className: 'os-field' },
            h('span', { className: 'os-field-l' }, '目标对象'),
            h(
              'select',
              {
                className: 'os-input',
                value: draft.target,
                onChange: function (event) {
                  patch('target', event.target.value);
                },
              },
              [h('option', { key: '', value: '' }, '（选择对象）')].concat(options)
            )
          )
        ),
        h(
          'div',
          { className: 'os-grid os-g2' },
          h(
            'label',
            { className: 'os-field' },
            h('span', { className: 'os-field-l' }, '基数'),
            h(
              'select',
              {
                className: 'os-input',
                value: draft.cardinality || 'n:1',
                onChange: function (event) {
                  patch('cardinality', event.target.value);
                },
              },
              CARDINALITIES.map(function (c) {
                return h('option', { key: c, value: c }, c);
              })
            )
          ),
          h(
            'label',
            { className: 'os-field' },
            h('span', { className: 'os-field-l' }, '关系 ID'),
            h('input', {
              className: 'os-input',
              value: draft.id,
              placeholder: 'inventory_references_supplier',
              onChange: function (event) {
                const next = JSON.parse(JSON.stringify(draft));
                next.id = event.target.value;
                setDraft(next);
              },
            })
          )
        ),
        problems.length
          ? h(
              'div',
              { className: 'os-card-b', style: { marginTop: 10 } },
              problems.map(function (pr, i) {
                return h(
                  'div',
                  { key: i, className: 'os-row' },
                  h(Badge, { tone: 'err' }, pr.code || '错误'),
                  h('span', { className: 'os-grow' }, (pr.path ? pr.path + ' — ' : '') + (pr.message || ''))
                );
              })
            )
          : null,
        h(
          'div',
          { style: { marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', { type: 'button', className: 'os-btn pri', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          isNew ? null : h('button', { type: 'button', className: 'os-btn', onClick: remove, disabled: busy }, '删除关系'),
          h('span', { className: 'os-grow' }),
          h('span', { className: 'os-muted' }, '关系删掉不波及对象与动作')
        )
      );
    }


    /* ------------------------------------------------------------------ *
     * Graph view: drag nodes to arrange, drag from a node's edge to another
     * to create a relation. Positions are a view concern, so they live in
     * localStorage, not in the IR.
     * ------------------------------------------------------------------ */
    var NODE_W = 168;
    var NODE_H = 62;

    function layoutOf(ids, size) {
      // Deterministic ring layout: same package always starts from the same picture.
      const radius = Math.max(180, Math.min(size.width, size.height) / 2 - 120);
      const cx = size.width / 2;
      const cy = size.height / 2;
      const out = {};
      ids.forEach(function (id, i) {
        const angle = (Math.PI * 2 * i) / Math.max(1, ids.length) - Math.PI / 2;
        out[id] = {
          x: Math.round(cx + radius * Math.cos(angle) - NODE_W / 2),
          y: Math.round(cy + radius * Math.sin(angle) - NODE_H / 2),
        };
      });
      return out;
    }

    function GraphView(props) {
      const pkg = props.pkg;
      const objects = (pkg && pkg.objects) || [];
      const links = (pkg && pkg.links) || [];
      const size = { width: 1000, height: 560 };
      const storeKey = 'os:graph:' + (pkg ? pkg.id : 'demo');

      const [positions, setPositions] = useState(function () {
        const base = layoutOf(objects.map(function (o) { return o.id; }), size);
        try {
          const saved = JSON.parse(localStorage.getItem(storeKey) || 'null');
          if (saved && typeof saved === 'object') {
            for (const id of Object.keys(saved)) if (base[id]) base[id] = saved[id];
          }
        } catch (error) {
          /* a broken saved layout must not block the view */
        }
        return base;
      });
      // { kind: 'node'|'link', id, dx, dy, x, y }
      const [drag, setDrag] = useState(null);
      const [over, setOver] = useState(null);
      const [notice, setNotice] = useState('');
      const svgRef = React.useRef(null);

      const persist = function (next) {
        try {
          localStorage.setItem(storeKey, JSON.stringify(next));
        } catch (error) {
          /* private mode: layout just will not survive a reload */
        }
      };

      const pointOf = function (event) {
        const svg = svgRef.current;
        if (!svg || typeof svg.getBoundingClientRect !== 'function') return { x: 0, y: 0 };
        const rect = svg.getBoundingClientRect();
        const scale = rect.width ? size.width / rect.width : 1;
        return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
      };

      const startNodeDrag = function (event, id) {
        const point = pointOf(event);
        const pos = positions[id];
        if (!pos) return;
        setDrag({ kind: 'node', id: id, dx: point.x - pos.x, dy: point.y - pos.y });
        event.preventDefault();
      };

      const startLinkDrag = function (event, id) {
        const point = pointOf(event);
        setDrag({ kind: 'link', id: id, x: point.x, y: point.y });
        event.preventDefault();
        event.stopPropagation();
      };

      const onMove = function (event) {
        if (!drag) return;
        const point = pointOf(event);
        if (drag.kind === 'node') {
          const next = Object.assign({}, positions, {
            [drag.id]: { x: Math.round(point.x - drag.dx), y: Math.round(point.y - drag.dy) },
          });
          setPositions(next);
        } else {
          setDrag(Object.assign({}, drag, { x: point.x, y: point.y }));
        }
      };

      const onUp = function () {
        if (!drag) return;
        if (drag.kind === 'node') {
          persist(positions);
          setDrag(null);
          return;
        }
        const target = over;
        setDrag(null);
        setOver(null);
        if (!target || target === drag.id) return;
        // Create the relation with a predictable id, then let the caller refresh.
        const link = {
          id: linkIdFor(drag.id, 'references', target),
          source: drag.id,
          target: target,
          type: 'references',
          cardinality: 'n:1',
        };
        setNotice('正在创建关系 ' + link.id + ' …');
        post('/write/save-link', { packageId: pkg.id, link: link })
          .then(function (body) {
            if (body && body.ok) {
              setNotice('已创建关系 ' + link.id);
              if (typeof props.onSaved === 'function') props.onSaved();
              return;
            }
            const first = (body && (body.problems || [])[0]) || {};
            setNotice('未创建：' + (first.message || (body && body.error) || '未知原因'));
          })
          .catch(function (error) {
            setNotice('未创建：' + String(error && error.message));
          });
      };

      const edges = links
        .filter(function (l) {
          return positions[l.source] && positions[l.target];
        })
        .map(function (l, i) {
          const from = positions[l.source];
          const to = positions[l.target];
          const x1 = from.x + NODE_W / 2;
          const y1 = from.y + NODE_H / 2;
          const x2 = to.x + NODE_W / 2;
          const y2 = to.y + NODE_H / 2;
          return { key: l.id || i, id: l.id, type: l.type, x1: x1, y1: y1, x2: x2, y2: y2, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
        });

      return h(
        Card,
        {
          title: '图谱',
          sub: objects.length + ' 个对象 · ' + links.length + ' 条关系 — 拖动节点排版，从节点右侧圆点拖到另一个节点建关系',
          extra: h(
            'div',
            { style: { display: 'flex', gap: 6 } },
            h(
              'button',
              {
                type: 'button',
                className: 'os-btn',
                onClick: function () {
                  const reset = layoutOf(objects.map(function (o) { return o.id; }), size);
                  setPositions(reset);
                  persist(reset);
                  setNotice('已恢复自动布局');
                },
              },
              '重排'
            )
          ),
          flush: true,
        },
        h(
          'div',
          { className: 'os-graph', style: { display: 'flex', justifyContent: 'center', overflow: 'auto', maxHeight: '70vh', background: 'transparent', userSelect: 'none', WebkitUserSelect: 'none' } },
          h(
            'svg',
            {
              ref: svgRef,
              viewBox: '0 0 ' + size.width + ' ' + size.height,
              style: {
                width: size.width + 'px',
                height: size.height + 'px',
                display: 'block',
                userSelect: 'none',
                cursor: drag ? 'grabbing' : 'default',
              },
              onMouseMove: onMove,
              onMouseUp: onUp,
              onMouseLeave: onUp,
              onDoubleClick: function (event) {
                if (event.target === event.currentTarget && typeof props.onNewNode === 'function') props.onNewNode();
              },
            },
            h('defs', null,
              h('marker', { id: 'os-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' },
                h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--dsw-alias-border-l1, #8a8a8a)' })
              )
            ),
            edges.map(function (e) {
              return h('g', { key: e.key },
                h('line', {
                  x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2,
                  stroke: 'var(--dsw-alias-border-l1, #8a8a8a)',
                  strokeWidth: '1.5',
                  markerEnd: 'url(#os-arrow)',
                }),
                h('text', {
                  x: e.mx, y: e.my - 4,
                  fontSize: '11', textAnchor: 'middle',
                  fill: 'var(--dsw-alias-label-tertiary, #888)',
                }, e.type)
              );
            }),
            drag && drag.kind === 'link' && positions[drag.id]
              ? h('line', {
                  x1: positions[drag.id].x + NODE_W,
                  y1: positions[drag.id].y + NODE_H / 2,
                  x2: drag.x,
                  y2: drag.y,
                  stroke: 'var(--dsw-alias-brand-primary, #4c8dff)',
                  strokeWidth: '2',
                  strokeDasharray: '4 3',
                })
              : null,
            objects.map(function (o) {
              const pos = positions[o.id] || { x: 0, y: 0 };
              const active = over === o.id;
              return h('g', { key: o.id, transform: 'translate(' + pos.x + ',' + pos.y + ')' },
                h('rect', {
                  width: NODE_W,
                  height: NODE_H,
                  rx: 10,
                  fill: 'var(--dsw-alias-bg-l1, #fff)',
                  stroke: active ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'var(--dsw-alias-border-l1, #d0d0d0)',
                  strokeWidth: active ? 2 : 1,
                  style: { cursor: 'grab' },
                  onMouseDown: function (event) { startNodeDrag(event, o.id); },
                  onMouseEnter: function () { if (drag && drag.kind === 'link') setOver(o.id); },
                  onMouseLeave: function () { if (over === o.id) setOver(null); },
                  onClick: function () { if (props.onPick) props.onPick(o.id); },
                }),
                h('text', { x: 12, y: 24, fontSize: '13', fontWeight: 600, fill: 'var(--dsw-alias-label-primary, #222)', style: { pointerEvents: 'none' } }, o.name || o.id),
                h('text', { x: 12, y: 44, fontSize: '11', fill: 'var(--dsw-alias-label-tertiary, #888)', style: { pointerEvents: 'none' } },
                  o.id + ' · ' + ((o.properties || []).length) + ' 属性'),
                h('circle', {
                  cx: NODE_W,
                  cy: NODE_H / 2,
                  r: 6,
                  fill: 'var(--dsw-alias-brand-primary, #4c8dff)',
                  style: { cursor: 'crosshair' },
                  onMouseDown: function (event) { startLinkDrag(event, o.id); },
                }),
                // 6px 圆点既难点也难拖：上面盖一个透明的更大命中区
                h('circle', {
                  cx: NODE_W,
                  cy: NODE_H / 2,
                  r: 14,
                  fill: 'transparent',
                  style: { cursor: 'crosshair' },
                  onMouseDown: function (event) { startLinkDrag(event, o.id); },
                })
              );
            })
          )
        ),
        notice ? h('div', { className: 'os-card-b os-muted' }, notice) : null,
        h(Notes, null, '拖动节点只改布局，不改本体；布局存在浏览器本地。建关系会真的写入资产——保存前按整包校验，失败会把校验问题贴在下面。')
      );
    }


    /** 两个只读检查：改这个对象要重验什么、和市场的版本差在哪。 */
    function ChecksCard(props) {
      const [plan, setPlan] = useState(null);
      const [diff, setDiff] = useState(null);
      const [busy, setBusy] = useState('');

      const loadPlan = function () {
        if (busy) return;
        setBusy('plan');
        get('/regression?id=' + encodeURIComponent(props.packageId) + '&object=' + encodeURIComponent(props.objectId))
          .then(function (body) { setPlan((body && body.value) || { error: '没有返回' }); })
          .catch(function (e) { setPlan({ error: String(e && e.message) }); })
          .then(function () { setBusy(''); });
      };

      const loadDiff = function () {
        if (busy) return;
        setBusy('diff');
        get('/diff?id=' + encodeURIComponent(props.packageId))
          .then(function (body) { setDiff((body && body.value) || { available: false }); })
          .catch(function (e) { setDiff({ available: false, message: String(e && e.message) }); })
          .then(function () { setBusy(''); });
      };

      const planRows = (plan && plan.items) || [];
      const d = diff && diff.diff;

      return h(
        Card,
        {
          title: '变更前检查',
          sub: '两个只读分析：改这个对象要重验什么、和市场里的版本差在哪',
          extra: h(
            'div',
            { style: { display: 'flex', gap: 6 } },
            h('button', { type: 'button', className: 'os-btn', onClick: loadPlan, disabled: busy === 'plan' }, busy === 'plan' ? '读取中…' : '要重验什么'),
            h('button', { type: 'button', className: 'os-btn', onClick: loadDiff, disabled: busy === 'diff' }, busy === 'diff' ? '读取中…' : '与市场版本对比')
          ),
          flush: true,
        },
        plan
          ? plan.error
            ? h('div', { className: 'os-card-b os-muted' }, plan.error)
            : h(Table, {
                columns: [
                  { key: 'kind', label: '类别', width: '12%', render: function (r) { return h(Badge, { tone: 'brand' }, r.kind); } },
                  { key: 'title', label: '要重验什么' },
                  { key: 'how', label: '怎么验' },
                ],
                rows: planRows.map(function (it, i) { return { key: i, kind: it.kind, title: it.title, how: it.how === '—' ? '—' : it.how }; }),
              })
          : null,
        diff
          ? !diff.available
            ? h('div', { className: 'os-card-b os-muted' }, diff.message || '没有其它版本')
            : h(
                'div',
                { className: 'os-card-b' },
                h('div', { className: 'os-mono', style: { marginBottom: 6 } }, 'v' + d.from.version + ' → v' + d.to.version + '：' + diff.summary),
                (d.sections || [])
                  .filter(function (sec) { return sec.added.length || sec.removed.length || sec.changed.length; })
                  .map(function (sec) {
                    return h(
                      'div',
                      { key: sec.collection, className: 'os-row' },
                      h('span', { style: { width: 72, flex: 'none' } }, h(Badge, { tone: 'brand' }, sec.collection)),
                      h('span', { className: 'os-grow os-muted' },
                        (sec.added.length ? '新增 ' + sec.added.join(', ') + '；' : '') +
                        (sec.removed.length ? '删除 ' + sec.removed.join(', ') + '；' : '') +
                        (sec.changed.length ? '变更 ' + sec.changed.map(function (c) { return c.id; }).join(', ') : ''))
                    );
                  })
              )
          : null,
        !plan && !diff ? h('div', { className: 'os-card-b os-muted' }, '点上面的按钮取结果。两项都是只读的，不会改任何数据。') : null
      );
    }

    function OntologyPage(props) {
      const model = props.model || buildModel({ phase: 'demo' });
      const objects = model.objects && model.objects.length ? model.objects : OBJECTS;
      const [sel, setSel] = useState('Inventory');
      const [view, setView] = useState(VIEWS[0]);
      const [editing, setEditing] = useState(null);
      const [view2, setView2] = useState('list');
      const packageId = model && model.pkg ? model.pkg.id : null;
      const reloadAfterWrite = function () {
        setEditing(null);
        if (typeof props.onSaved === 'function') props.onSaved();
      };
      const obj = objects.filter((o) => o.id === sel)[0] || objects[0];

      const rows = obj.props.map((p) => {
        const isKey = obj.keys.indexOf(p.name) >= 0;
        const base = { key: p.name, name: p.name, label: p.label, type: p.type };
        if (view === '业务视角')
          return Object.assign(base, { c3: p.note || p.label, c4: p.required ? '必填' : '可选' });
        if (view === '数据视角')
          return Object.assign(base, { c3: isKey ? '是' : '否', c4: p.source || '—' });
        if (view === '技术视角')
          return Object.assign(base, {
            c3: obj.table ? obj.table + '.' + p.name : p.source || '—',
            c4: isKey ? 'unique' : p.indexed ? 'index' : '—',
          });
        return Object.assign(base, {
          c3: p.constraint || (p.required ? '必填，非空' : '可空'),
          c4: p.required ? '可读写' : '只读',
        });
      });

      const c3 = { 业务视角: '说明', 数据视角: '主键', 技术视角: '存储位置', 'AI 视角': '语义约束' }[view];

      // 图谱是纯视图：拖动改布局，连线真的写资产。
      if (view2 === 'graph' && packageId && model.pkg) {
        return h(GraphView, {
          pkg: model.pkg,
          onSaved: function () {
            if (typeof props.onSaved === 'function') props.onSaved();
          },
          onPick: function (id) {
            setSel(id);
            setView2('list');
          },
          onBack: function () {
            setView2('list');
          },
          onNewNode: function () {
            setView2('list');
            setEditing('new');
          },
        });
      }
      const c4 = { 业务视角: '必填', 数据视角: '来源字段', 技术视角: '索引', 'AI 视角': 'Agent 权限' }[view];

      return h(
        'div',
        { className: 'os-split' },
        h(
          Card,
          {
            title: '对象清单',
            sub: objects.length + ' 个',
            extra: packageId
              ? h(
                  'div',
                  { style: { display: 'flex', gap: 6 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'os-btn',
                      onClick: function () { setView2('graph'); },
                    },
                    '图谱'
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'os-btn', onClick: function () { setEditing('new'); } },
                    '+ 新建'
                  )
                )
              : null,
            flush: true,
          },
          h(
            'div',
            { style: { padding: '4px 0 6px' } },
            objects.map((o) =>
              h(
                'div',
                {
                  key: o.id,
                  role: 'button',
                  tabIndex: 0,
                  className: 'os-li' + (o.id === sel ? ' on' : ''),
                  style: { cursor: 'pointer' },
                  onClick: function () {
                    setSel(o.id);
                  },
                },
                h(
                  'div',
                  { className: 'os-grow', style: { minWidth: 0 } },
                  h('div', { className: 'os-rowhead' }, h('span', { className: 'os-li-t' }, o.name), o.status === '草稿' ? h(Badge, { tone: 'warn' }, '草稿') : null),
                  h('div', { className: 'os-li-s' }, o.id + ' · ' + o.props.length + ' 属性')
                ),
                packageId
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'os-btn',
                        onClick: function (event) {
                          event.stopPropagation();
                          setEditing(o.id);
                        },
                      },
                      '编辑'
                    )
                  : null
              )
            )
          )
        ),
        editing && packageId && String(editing).indexOf('__link__') === 0
          ? h(LinkEditor, {
              packageId: packageId,
              sourceObjectId: obj.id,
              objects: (model.pkg && model.pkg.objects) || [],
              initial:
                String(editing) === '__link__'
                  ? null
                  : rawLinks(model, obj.id).filter(function (l) {
                      return l.id === String(editing).slice('__link__:'.length);
                    })[0],
              onDone: reloadAfterWrite,
              onCancel: function () {
                setEditing(null);
              },
            })
          : editing && packageId
          ? h(ObjectEditor, {
              packageId: packageId,
              initial: editing === 'new' ? null : rawObject(model, editing),
              onDone: reloadAfterWrite,
              onCancel: function () {
                setEditing(null);
              },
            })
          : h(
          'div',
          { className: 'os-grid' },
          h(ChecksCard, { packageId: packageId, objectId: obj.id }),
          h(
            Card,
            {
              title: obj.name + '（' + obj.id + '）',
              sub: obj.domain + ' · v' + obj.version + ' · ' + obj.owner,
              extra: h(Badge, { tone: obj.status === '草稿' ? 'warn' : 'on' }, obj.status),
            },
            h('div', { className: 'os-muted', style: { marginBottom: 10 } }, obj.desc),
            h(Tabs, { items: VIEWS, value: view, onChange: setView }),
            h(
              'div',
              { style: { margin: '0 -14px' } },
              h(Table, {
                columns: [
                  { key: 'name', label: '属性', width: '22%', render: (r) => h('span', { className: 'os-mono' }, r.name) },
                  { key: 'label', label: '名称', width: '20%' },
                  { key: 'type', label: '类型', width: '14%' },
                  { key: 'c3', label: c3 },
                  { key: 'c4', label: c4 },
                ],
                rows: rows,
              })
            )
          ),
          h(
            'div',
            { className: 'os-grid os-g2' },
            h(
              Card,
              {
                title: '关系',
                sub: packageId && model.pkg ? (model.pkg.links || []).length + ' 条声明' : '演示数据',
                extra:
                  packageId && model.pkg
                    ? h(
                        'button',
                        { type: 'button', className: 'os-btn', onClick: function () { setEditing('__link__'); } },
                        '+ 新增关系'
                      )
                    : null,
                flush: true,
              },
              rawLinks(model, obj.id).length
                ? h(Table, {
                    columns: [
                      { key: 'type', label: '类型', render: (r) => h(Badge, { tone: 'brand' }, r.type) },
                      { key: 'other', label: '另一端对象' },
                      { key: 'direction', label: '方向', width: '10%' },
                      { key: 'cardinality', label: '基数', width: '10%' },
                      {
                        key: 'ops',
                        label: '',
                        width: '18%',
                        render: (r) =>
                          packageId && model.pkg
                            ? h(
                                'div',
                                { style: { display: 'flex', gap: 6 } },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'os-btn',
                                    onClick: function () {
                                      setEditing('__link__:' + r.id);
                                    },
                                  },
                                  '编辑'
                                ),
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'os-btn',
                                    onClick: function () {
                                      post('/write/delete-link', { packageId: packageId, linkId: r.id }).then(function () {
                                        if (typeof props.onSaved === 'function') props.onSaved();
                                      });
                                    },
                                  },
                                  '删除'
                                )
                              )
                            : null,
                      },
                    ],
                    rows: rawLinks(model, obj.id),
                  })
                : h('div', { className: 'os-card-b os-muted' }, '这个对象还没有关系——新建关系才能和别的对象连起来。')
            ),
            h(
              Card,
              { title: '动作', flush: true },
              obj.actions.length
                ? h(Table, {
                    columns: [
                      { key: '1', label: '动作' },
                      { key: '2', label: '审批', render: (r) => r['2'] },
                      { key: '3', label: '写入' },
                    ],
                    rows: obj.actions.map((a) => ({ key: a[0], 1: a[0] + ' · ' + a[1], 2: h(Badge, { tone: a[2] === '需审批' ? 'warn' : 'on' }, a[2]), 3: a[3] })),
                  })
                : h('div', { className: 'os-card-b os-muted' }, '该对象暂未定义动作。')
            )
          ),
          h(
            Card,
            { title: '模型影响分析', sub: '修改该对象时自动识别的依赖' },
            obj.impact.length
              ? obj.impact.map((r) =>
                  h(
                    'div',
                    { key: r[1], className: 'os-row' },
                    h('span', { style: { width: 76, flex: 'none' }, className: 'os-mono os-muted' }, r[0]),
                    h('span', { className: 'os-grow' }, r[1]),
                    h('span', { className: 'os-muted' }, r[2])
                  )
                )
              : h('div', { className: 'os-muted' }, '暂无下游依赖。')
          )
        )
      );
    }

    /**
     * Coverage of an object's declared properties across its sample rows:
     * which properties the fact data actually fills in, and which it never has.
     */
    function coverageOf(object, sampleRows) {
      const props = (object && (object.props || object.properties)) || [];
      const rows = sampleRows || [];
      return props.map(function (p) {
        const present = rows.filter(function (row) {
          return row[p.name] !== undefined && row[p.name] !== null;
        }).length;
        return {
          name: p.name,
          label: p.label || p.name,
          type: p.type,
          presence: rows.length ? Math.round((present / rows.length) * 100) : 0,
          present: present,
          rows: rows.length,
        };
      });
    }

    function DataLivePage(props) {
      const model = props.model;
      const records = model.records;
      const objects = model.objects || [];
      const withRows = records.objects.filter(function (o) {
        return o.rows > 0;
      });
      const [picked, setPicked] = useState((withRows[0] || {}).id || '');
      const current = withRows.filter(function (o) {
        return o.id === picked;
      })[0] || withRows[0];
      const objectDef = objects.filter(function (o) {
        return current && o.id === current.id;
      })[0];
      const coverage = current ? coverageOf(objectDef, current.sample) : [];
      const missing = coverage.filter(function (c) {
        return c.present === 0;
      });

      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g4' },
          h(Stat, { value: String(records.totalRows), label: '事实数据行数', delta: records.file ? records.file.split(/[\\/]/).pop() : '—' }),
          h(Stat, { value: String(withRows.length), label: '有数据的对象', delta: objects.length + ' 个已建模' }),
          h(Stat, { value: String(objects.length - withRows.length), label: '尚无数据的对象', delta: '规则与动作跑不到' }),
          h(Stat, {
            value: missing.length + ' 项',
            label: '从未填充的属性',
            delta: current ? current.id + ' 的 ' + coverage.length + ' 个属性' : '—',
          })
        ),
        h(
          Card,
          { title: '事实数据', sub: records.file, extra: h(Badge, { tone: 'on' }, '真实文件') },
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            withRows.map(function (o) {
              return h(
                'button',
                {
                  key: o.id,
                  type: 'button',
                  className: 'os-btn' + (current && o.id === current.id ? ' pri' : ''),
                  onClick: function () {
                    setPicked(o.id);
                  },
                },
                o.id + ' · ' + o.rows + ' 行'
              );
            })
          ),
          h(
            'div',
            { className: 'os-note', style: { marginTop: 10 } },
            '这是示例事实数据，规则求值与动作执行都跑在它上面。真实数据源（同步型 / 联邦型）尚未接入，本页下方的「接入策略」仍是设计说明。'
          )
        ),
        h(
          Card,
          {
            title: '属性覆盖 · ' + (current ? current.id : '—'),
            sub: '本体声明的属性在事实数据里的填充情况（抽样 ' + (current ? current.sample.length : 0) + ' 行）',
            flush: true,
          },
          h(Table, {
            columns: [
              { key: 'name', label: '属性', render: (r) => h('span', { className: 'os-mono' }, r.name) },
              { key: 'label', label: '名称' },
              { key: 'type', label: '类型' },
              { key: 'present', label: '出现行数', width: '14%' },
              {
                key: 'presence',
                label: '填充率',
                width: '26%',
                render: (r) =>
                  h(
                    'div',
                    null,
                    h(Bar, { value: r.presence, color: r.presence === 0 ? 'var(--dsw-alias-state-warn-primary)' : undefined }),
                    h('div', { className: 'os-mono os-muted', style: { marginTop: 3 } }, r.presence + '%')
                  ),
              },
            ],
            rows: coverage.map((c) => Object.assign({ key: c.name }, c)),
          })
        ),
        h(
          'div',
          { className: 'os-grid os-g2' },
          h(
            Card,
            { title: '接入策略（设计）' },
            h(
              'div',
              null,
              [
                ['同步型', '数据加工、同步到平台管理的对象存储或索引，适合高频查询与跨源关联。'],
                ['联邦型', '保留源系统作为事实来源，平台按需获取，适合权威主数据与低延迟写入。'],
              ].map(function (r) {
                return h(
                  'div',
                  { key: r[0], className: 'os-row', style: { alignItems: 'flex-start' } },
                  h('span', { style: { width: 64, flex: 'none' } }, h(Badge, { tone: 'brand' }, r[0])),
                  h('span', { className: 'os-grow os-muted' }, r[1])
                );
              })
            )
          ),
          h(
            Card,
            { title: '字段映射（演示）' },
            h(Table, {
              columns: [
                { key: '0', label: '源字段', render: (r) => h('span', { className: 'os-mono' }, r[0]) },
                { key: '1', label: '本体属性', render: (r) => h('span', { className: 'os-mono' }, r[1]) },
                { key: '2', label: '类型' },
                { key: '3', label: '转换' },
              ],
              rows: MAPPING.slice(0, 6).map((m) => ({ key: m[0], 0: m[0], 1: m[1], 2: m[2], 3: m[3] })),
            })
          )
        )
      );
    }

    function DataPage(props) {
      const model = (props && props.model) || buildModel({ phase: 'demo' });
      // Hook order must stay stable across live/demo switches.
      const [sel, setSel] = useState(0);
      if (model.live && model.records && model.records.objects) return h(DataLivePage, { model: model });
      const src = SOURCES[sel];
      return h(
        'div',
        { className: 'os-grid' },
        h(
          Card,
          { title: '数据源', sub: SOURCES.length + ' 个已接入', flush: true },
          h(Table, {
            columns: [
              { key: 'name', label: '数据源' },
              { key: 'kind', label: '接入方式', render: (r) => h(Badge, { tone: r.kind === '同步型' ? 'brand' : '' }, r.kind) },
              { key: 'dialect', label: '协议 / 方言' },
              { key: 'tables', label: '表 / 接口', width: '10%' },
              { key: 'objects', label: '映射到本体' },
              { key: 'progress', label: '映射进度', width: '18%', render: (r) => h('div', null, h(Bar, { value: r.progress }), h('div', { className: 'os-mono os-muted', style: { marginTop: 3 } }, r.progress + '%')) },
              {
                key: 'status',
                label: '状态',
                render: (r) => h(Badge, { tone: r.status === 'healthy' ? 'on' : 'warn' }, r.status === 'healthy' ? '运行中' : '映射中'),
              },
            ],
            rows: SOURCES.map((s) => Object.assign({ key: s.name }, s)),
          })
        ),
        h(
          'div',
          { className: 'os-grid os-g2' },
          h(
            Card,
            { title: '字段映射 · ' + src.name, sub: src.note, flush: true },
            h(Table, {
              columns: [
                { key: '0', label: '源字段', render: (r) => h('span', { className: 'os-mono' }, r[0]) },
                { key: '1', label: '本体属性', render: (r) => h('span', { className: 'os-mono' }, r[1]) },
                { key: '2', label: '类型' },
                { key: '3', label: '转换' },
                { key: '4', label: '', width: '8%', render: (r) => h(Badge, { tone: r[4] === 'ok' ? 'on' : 'warn' }, r[4] === 'ok' ? '就绪' : '待确认') },
              ],
              rows: MAPPING.map((m) => ({ key: m[0], 0: m[0], 1: m[1], 2: m[2], 3: m[3], 4: m[4] })),
            })
          ),
          h(
            'div',
            { className: 'os-grid' },
            h(
              Card,
              { title: '接入策略' },
              h(
                'div',
                null,
                [
                  ['同步型', '数据加工、同步到平台管理的对象存储或索引，适合高频查询与跨源关联。'],
                  ['联邦型', '保留源系统作为事实来源，平台按需获取，适合权威主数据与低延迟写入。'],
                ].map((r) =>
                  h(
                    'div',
                    { key: r[0], className: 'os-row', style: { alignItems: 'flex-start' } },
                    h('span', { style: { width: 64, flex: 'none' } }, h(Badge, { tone: 'brand' }, r[0])),
                    h('span', { className: 'os-grow os-muted' }, r[1])
                  )
                )
              )
            ),
            h(
              Card,
              { title: '切换数据源' },
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                SOURCES.map((s, i) =>
                  h(
                    'button',
                    {
                      key: s.name,
                      type: 'button',
                      className: 'os-btn' + (i === sel ? ' pri' : ''),
                      onClick: function () {
                        setSel(i);
                      },
                    },
                    s.name
                  )
                )
              )
            ),
            h(Notes, null, '两种接入方式必须并存：不能为了做 Ontology 就要求企业把所有系统数据搬进平台。')
          )
        )
      );
    }


    var SEVERITIES = ['error', 'warn', 'info'];

    /** Inline editor for one rule. Expressions are parsed by the host on save. */
    function RuleEditor(props) {
      const initial = props.initial;
      const [draft, setDraft] = useState(
        initial
          ? JSON.parse(JSON.stringify(initial))
          : { id: '', name: '', expression: '', severity: 'warn', enabled: true, owner: '' }
      );
      const [busy, setBusy] = useState(false);
      const [problems, setProblems] = useState([]);
      const [notice, setNotice] = useState('');
      const isNew = !initial;

      const patch = function (field, value) {
        const next = JSON.parse(JSON.stringify(draft));
        next[field] = value;
        setDraft(next);
      };

      const save = function () {
        if (busy) return;
        setBusy(true);
        setProblems([]);
        setNotice('');
        post('/write/save-rule', { packageId: props.packageId, rule: draft })
          .then(function (body) {
            if (body && body.ok) {
              props.onDone(body);
              return;
            }
            setProblems((body && body.problems) || [{ message: (body && (body.message || body.error)) || '保存失败' }]);
          })
          .catch(function (error) {
            setProblems([{ message: String(error && error.message) }]);
          })
          .then(function () {
            setBusy(false);
          });
      };

      const remove = function () {
        if (busy || isNew) return;
        setBusy(true);
        setProblems([]);
        post('/write/delete-rule', { packageId: props.packageId, ruleId: draft.id })
          .then(function (body) {
            if (body && body.ok) {
              props.onDone(body);
              return;
            }
            setProblems((body && body.problems) || [{ message: (body && (body.message || body.error)) || '删除失败' }]);
          })
          .catch(function (error) {
            setProblems([{ message: String(error && error.message) }]);
          })
          .then(function () {
            setBusy(false);
          });
      };

      const field = function (label, value, onChange, placeholder) {
        return h(
          'label',
          { className: 'os-field' },
          h('span', { className: 'os-field-l' }, label),
          h('input', {
            className: 'os-input',
            value: value || '',
            placeholder: placeholder || '',
            onChange: function (event) {
              onChange(event.target.value);
            },
          })
        );
      };

      return h(
        Card,
        {
          title: isNew ? '新增规则' : '编辑规则 ' + draft.id,
          sub: '表达式保存前会真的解析一遍，绑不到对象会被拒绝',
          extra: h(
            'button',
            { type: 'button', className: 'os-btn', onClick: function () { props.onCancel(); } },
            '取消'
          ),
        },
        h(
          'div',
          { className: 'os-grid os-g2' },
          field('规则 ID（域.camelCase）', draft.id, function (v) {
            patch('id', v);
          }, 'inventory.lockedTooMuch'),
          field('规则名称', draft.name, function (v) {
            patch('name', v);
          }, '锁定量超过在库量')
        ),
        field('表达式', draft.expression, function (v) {
          patch('expression', v);
        }, 'lockedQty > onHandQty'),
        h(
          'div',
          { className: 'os-grid os-g3' },
          h(
            'label',
            { className: 'os-field' },
            h('span', { className: 'os-field-l' }, '级别'),
            h(
              'select',
              {
                className: 'os-input',
                value: draft.severity,
                onChange: function (event) {
                  patch('severity', event.target.value);
                },
              },
              SEVERITIES.map(function (v) {
                return h('option', { key: v, value: v }, v);
              })
            )
          ),
          h(
            'label',
            { className: 'os-field' },
            h('span', { className: 'os-field-l' }, '状态'),
            h(
              'select',
              {
                className: 'os-input',
                value: draft.enabled === false ? 'off' : 'on',
                onChange: function (event) {
                  patch('enabled', event.target.value === 'on');
                },
              },
              [h('option', { key: 'on', value: 'on' }, '启用'), h('option', { key: 'off', value: 'off' }, '停用')]
            )
          ),
          field('维护人', draft.owner, function (v) {
            patch('owner', v);
          }, '供应链数字化组')
        ),
        problems.length
          ? h(
              'div',
              { className: 'os-card-b', style: { marginTop: 10 } },
              problems.map(function (pr, i) {
                return h(
                  'div',
                  { key: i, className: 'os-row' },
                  h(Badge, { tone: 'err' }, pr.code || '错误'),
                  h('span', { className: 'os-grow' }, (pr.path ? pr.path + ' — ' : '') + (pr.message || ''))
                );
              })
            )
          : null,
        h(
          'div',
          { style: { marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', { type: 'button', className: 'os-btn pri', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          isNew ? null : h('button', { type: 'button', className: 'os-btn', onClick: remove, disabled: busy }, '删除规则'),
          h('span', { className: 'os-grow' }),
          h('span', { className: 'os-muted' }, '表达式会被真正解析，写错立刻知道')
        )
      );
    }

    /** Rules and actions straight from the loaded package when it is live. */
    function logicModel(model) {
      const pkg = model && model.live ? model.pkg : null;
      if (!pkg) {
        return {
          live: false,
          rules: RULES.map((r) => ({ id: r[0], name: r[1], expression: r[2], severity: r[3], enabled: r[4] === '启用', owner: r[5] })),
          actions: ACTIONS.map((a) => ({
            id: a[0],
            name: a[1],
            input: a[2],
            approvalRequired: a[3] === '需审批',
            writes: a[4],
            version: a[5],
            executable: true,
          })),
        };
      }
      return {
        live: true,
        rules: (pkg.rules || []).map((r) => ({
          id: r.id,
          name: r.name,
          expression: r.expression,
          severity: r.severity,
          enabled: r.enabled !== false,
          owner: r.owner || '—',
        })),
        actions: (pkg.actions || []).map((a) => ({
          id: a.id,
          name: a.name,
          input: a.input || '—',
          approvalRequired: a.approvalRequired === true,
          writes: (a.writes || []).join(', ') || '—',
          version: pkg.version,
          executable: Boolean(a.effect && Array.isArray(a.inputSchema) && a.inputSchema.length),
          effects: Array.isArray(a.effect) ? a.effect.length : a.effect ? 1 : 0,
        })),
      };
    }

    function LogicPage(props) {
      const model = (props && props.model) || buildModel({ phase: 'demo' });
      const data = logicModel(model);
      // The panel's only actionable control: rule evaluation is read-only, so it
      // needs no approval. Writes stay tool-only on purpose.
      const [run, setRun] = useState(null);
      const [editing, setEditing] = useState(null);
      const packageId = model && model.pkg ? model.pkg.id : null;
      const afterWrite = function () {
        setEditing(null);
        if (typeof props.onSaved === 'function') props.onSaved();
      };
      const [busy, setBusy] = useState(false);
      const runEvaluation = function () {
        if (!model.pkg || busy) return;
        setBusy(true);
        get('/evaluate?id=' + encodeURIComponent(model.pkg.id))
          .then(function (body) {
            setRun((body && body.value) || { available: false, message: '没有返回结果' });
          })
          .catch(function (error) {
            setRun({ available: false, message: String(error && error.message) });
          })
          .then(function () {
            setBusy(false);
          });
      };
      const enabledRules = data.rules.filter(function (r) { return r.enabled; }).length;
      const execActions = data.actions.filter(function (a) { return a.executable; }).length;
      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g4' },
          h(Stat, { value: String(data.rules.length), label: '业务规则', delta: enabledRules + ' 条启用' }),
          h(Stat, { value: String(data.actions.length), label: '业务动作', delta: execActions + ' 个可执行' }),
          h(Stat, {
            value: String(data.actions.filter(function (a) { return a.approvalRequired; }).length),
            label: '需审批',
            delta: '写操作走闸门',
          }),
          h(Stat, {
            value: String(data.actions.filter(function (a) { return !a.executable; }).length),
            label: '仅声明',
            delta: '缺 inputSchema 或 effect',
          })
        ),
        editing && packageId
          ? h(RuleEditor, {
              packageId: packageId,
              initial:
                editing === 'new'
                  ? null
                  : (model.pkg.rules || []).filter(function (r) {
                      return r.id === editing;
                    })[0],
              onDone: afterWrite,
              onCancel: function () {
                setEditing(null);
              },
            })
          : null,
        h(
          Card,
          {
            title: '业务规则',
            sub: data.live ? '来自当前资产包，可被 ontology_evaluate_rules 真正求值' : '演示数据',
            extra: data.live
              ? h(
                  'div',
                  { style: { display: 'flex', gap: 6 } },
                  h(
                    'button',
                    { type: 'button', className: 'os-btn', onClick: function () { setEditing('new'); } },
                    '+ 新增规则'
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'os-btn', onClick: runEvaluation, disabled: busy },
                    busy ? '求值中…' : '在示例数据上跑一次'
                  )
                )
              : null,
            flush: true,
          },
          h(Table, {
            columns: [
              { key: 'id', label: '规则 ID', render: (r) => h('span', { className: 'os-mono' }, r.id) },
              { key: 'name', label: '名称' },
              { key: 'expression', label: '表达式', render: (r) => h('span', { className: 'os-mono' }, r.expression) },
              {
                key: 'severity',
                label: '级别',
                render: (r) => h(Badge, { tone: r.severity === 'error' ? 'err' : r.severity === 'warn' ? 'warn' : '' }, r.severity),
              },
              { key: 'enabled', label: '状态', render: (r) => h(Badge, { tone: r.enabled ? 'on' : 'warn' }, r.enabled ? '启用' : '已停用') },
              { key: 'owner', label: '维护人' },
              {
                key: 'ops',
                label: '',
                width: '16%',
                render: (r) =>
                  packageId && model.pkg
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: 6 } },
                        h(
                          'button',
                          { type: 'button', className: 'os-btn', onClick: function () { setEditing(r.id); } },
                          '编辑'
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'os-btn',
                            onClick: function () {
                              post('/write/delete-rule', { packageId: packageId, ruleId: r.id }).then(function () {
                                if (typeof props.onSaved === 'function') props.onSaved();
                              });
                            },
                          },
                          '删除'
                        )
                      )
                    : null,
              },
            ],
            rows: data.rules.map((r) => Object.assign({ key: r.id }, r)),
          })
        ),
        run
          ? h(
              Card,
              { title: '求值结果', sub: '刚刚在示例事实数据上跑的一次（只读，未写盘）', flush: true },
              run.available === false
                ? h('div', { className: 'os-card-b os-muted' }, run.message || '无法求值')
                : h(
                    'div',
                    null,
                    h(
                      'div',
                      { style: { padding: '10px 14px', display: 'flex', gap: 16, flexWrap: 'wrap' } },
                      h(Badge, { tone: run.summary.violations ? 'warn' : 'on' }, run.summary.violations + ' 处违规'),
                      h('span', { className: 'os-muted' }, run.summary.evaluated + ' 条规则生效'),
                      h('span', { className: 'os-muted' }, run.summary.rows + ' 行数据'),
                      run.summary.unresolved ? h('span', { className: 'os-muted' }, run.summary.unresolved + ' 条无法解析归属') : null
                    ),
                    h(Table, {
                      columns: [
                        { key: 'rule', label: '规则', render: (r) => h('span', { className: 'os-mono' }, r.rule) },
                        { key: 'object', label: '对象' },
                        { key: 'evaluated', label: '求值行数', width: '12%' },
                        {
                          key: 'violations',
                          label: '违规',
                          width: '12%',
                          render: (r) => h(Badge, { tone: r.violations.length ? 'warn' : 'on' }, String(r.violations.length)),
                        },
                      ],
                      rows: (run.results || []).map((r) => Object.assign({ key: r.rule }, r)),
                    }),
                    (run.skipped || []).length
                      ? h(
                          'div',
                          { style: { padding: '8px 14px 12px' } },
                          (run.skipped || []).map((s) =>
                            h('div', { key: s.rule, className: 'os-row os-muted' }, '跳过 ' + s.rule + '：' + s.reason)
                          )
                        )
                      : null
                  )
            )
          : null,
        h(
          Card,
          {
            title: '业务动作',
            sub: data.live ? '可执行 = 同时声明了 inputSchema 与 effect' : '演示数据',
            flush: true,
          },
          h(Table, {
            columns: [
              { key: 'id', label: '动作 ID', render: (r) => h('span', { className: 'os-mono' }, r.id) },
              { key: 'name', label: '名称' },
              { key: 'input', label: '入参类型', render: (r) => h('span', { className: 'os-mono' }, r.input) },
              {
                key: 'approvalRequired',
                label: '审批',
                render: (r) => h(Badge, { tone: r.approvalRequired ? 'warn' : 'on' }, r.approvalRequired ? '需审批' : '免审批'),
              },
              { key: 'writes', label: '写入对象' },
              {
                key: 'executable',
                label: '可执行',
                render: (r) =>
                  h(
                    Badge,
                    { tone: r.executable ? 'on' : '' },
                    r.executable ? '可执行' + (r.effects > 1 ? ' · ' + r.effects + ' effect' : '') : '仅声明'
                  ),
              },
            ],
            rows: data.actions.map((a) => Object.assign({ key: a.id }, a)),
          })
        ),
        h(
          'div',
          { className: 'os-grid os-g2' },
          h(
            Card,
            { title: '函数', flush: true },
            h(Table, {
              columns: [
                { key: '0', label: '函数', render: (r) => h('span', { className: 'os-mono' }, r[0]) },
                { key: '1', label: '名称' },
                { key: '2', label: '实现' },
                { key: '3', label: '类型' },
              ],
              rows: FUNCTIONS.map((r) => ({ key: r[0], 0: r[0], 1: r[1], 2: r[2], 3: r[3] })),
            })
          ),
          h(
            Card,
            { title: '执行约束' },
            h(
              'div',
              null,
              [
                ['高风险动作必须人工审批', '库存调整、跨区域调拨走审批闸门'],
                ['Agent 不得绕过权限体系', '所有写操作经 Runtime 与策略校验'],
                ['结果必须回验', '不能因 Agent 声称成功就视为成功'],
              ].map((r) =>
                h(
                  'div',
                  { key: r[0], className: 'os-row' },
                  h(Badge, { tone: 'brand' }, '闸门'),
                  h('span', { className: 'os-grow' }, r[0]),
                  h('span', { className: 'os-muted' }, r[1])
                )
              )
            )
          )
        )
      );
    }

    function AgentLivePage(props) {
      const model = props.model;
      const roster = (model.agents && model.agents.agents) || [];
      const usage = (model.agents && model.agents.usage) || { byTool: {} };
      const callsOf = function (id) {
        const per = usage.byTool && usage.byTool[id] ? usage.byTool[id] : {};
        return Object.keys(per).reduce(function (n, tool) { return n + per[tool].ok + per[tool].fail; }, 0);
      };
      const published = roster.filter(function (a) { return a.status === 'published'; }).length;
      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g4' },
          h(Stat, { value: String(roster.length), label: '声明 Agent', delta: published + ' 个已发布' }),
          h(Stat, {
            value: String(roster.filter(function (a) { return callsOf(a.id) > 0; }).length),
            label: '轨迹里有调用的',
            delta: usage.scanned + ' 条轨迹',
          }),
          h(Stat, { value: String(roster.reduce(function (n, a) { return n + ((a.tools || []).length); }, 0)), label: '绑定工具', delta: '声明总和' }),
          h(Stat, { value: String(usage.unattributed || 0), label: '无法归属的调用', delta: '会话未在花名册里' })
        ),
        h(
          Card,
          { title: 'Agent 花名册', sub: '声明在本体包里；调用数据来自执行轨迹', extra: h(Badge, { tone: 'on' }, '声明 + 证据'), flush: true },
          roster.length
            ? h(Table, {
                columns: [
                  { key: 'name', label: 'Agent', render: function (r) { return h('span', { style: { fontWeight: 600 } }, r.name); } },
                  {
                    key: 'status',
                    label: '状态',
                    width: '10%',
                    render: function (r) {
                      const tone = r.status === 'published' ? 'on' : r.status === 'gray' ? 'warn' : '';
                      return h(Badge, { tone: tone }, r.status || 'draft');
                    },
                  },
                  { key: 'model', label: '模型', render: function (r) { return h('span', { className: 'os-mono os-muted' }, r.model || '—'); } },
                  {
                    key: 'usesObjects',
                    label: '依赖对象',
                    render: function (r) { return h('span', { className: 'os-mono' }, (r.usesObjects || []).join(', ') || '—'); },
                  },
                  {
                    key: 'tools',
                    label: '工具',
                    render: function (r) { return h('span', { className: 'os-mono os-muted' }, (r.tools || []).join(', ') || '—'); },
                  },
                  {
                    key: 'calls',
                    label: '实际调用',
                    width: '12%',
                    render: function (r) {
                      const n = callsOf(r.id);
                      return h(Badge, { tone: n ? 'on' : '' }, n ? n + ' 次' : '无记录');
                    },
                  },
                ],
                rows: roster.map(function (a) { return Object.assign({ key: a.id }, a, { calls: callsOf(a.id) }); }),
              })
            : h('div', { className: 'os-card-b os-muted' }, '这个资产包还没有声明任何 Agent。')
        ),
        roster.length
          ? h(
              Card,
              { title: '调用明细', sub: '每个 Agent 实际调用了哪些工具、成功几次', flush: true },
              h(Table, {
                columns: [
                  { key: 'agent', label: 'Agent' },
                  { key: 'tool', label: '工具', render: function (r) { return h('span', { className: 'os-mono' }, r.tool); } },
                  { key: 'ok', label: '成功', width: '10%' },
                  { key: 'fail', label: '失败', width: '10%' },
                ],
                rows: roster.flatMap(function (a) {
                  const per = (usage.byTool && usage.byTool[a.id]) || {};
                  return Object.keys(per).map(function (tool) {
                    return { key: a.id + ':' + tool, agent: a.name, tool: tool, ok: per[tool].ok, fail: per[tool].fail };
                  });
                }),
              })
            )
          : null,
        h(
          Notes,
          null,
          '花名册是声明，调用数据是证据——两列分开看：声明了但轨迹里没有，可能是还没上线；有调用但没声明，说明有人绕过花名册直接用了工具。'
        )
      );
    }

    function AgentPage(props) {
      const model = (props && props.model) || buildModel({ phase: 'demo' });
      if (model.live && model.agents && (model.agents.agents || []).length) return h(AgentLivePage, { model: model });
      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g3' },
          AGENTS.map((a) =>
            h(
              'div',
              { key: a.name, className: 'os-tile' },
              h('div', { className: 'os-rowhead' }, h('span', { style: { fontWeight: 600 } }, a.name), h(Badge, { tone: a.status === '已发布' ? 'on' : a.status === '灰度' ? 'warn' : '' }, a.status)),
              h('div', { className: 'os-muted os-mono', style: { margin: '4px 0 8px' } }, a.model),
              h(
                'div',
                { className: 'os-row' },
                h('span', { className: 'os-muted', style: { width: 46, flex: 'none' } }, '本体'),
                h('span', { className: 'os-grow' }, a.ontology.join(' · '))
              ),
              h(
                'div',
                { className: 'os-row' },
                h('span', { className: 'os-muted', style: { width: 46, flex: 'none' } }, 'Skills'),
                h('span', { className: 'os-grow' }, a.skills.join(' · '))
              ),
              h(
                'div',
                { className: 'os-row' },
                h('span', { className: 'os-muted', style: { width: 46, flex: 'none' } }, '工具'),
                h('span', { className: 'os-grow os-mono' }, a.tools.join(' · '))
              ),
              h(
                'div',
                { className: 'os-row' },
                h('span', { className: 'os-muted', style: { width: 46, flex: 'none' } }, '评测'),
                h('span', { className: 'os-grow' }, a.eval)
              )
            )
          )
        ),
        h(
          Card,
          { title: 'Harness Runtime 组件', sub: '独立公共服务，所有 Studio 共用', flush: true },
          h(Table, {
            columns: [
              { key: '0', label: '组件', width: '22%', render: (r) => h('span', { style: { fontWeight: 600 } }, r[0]) },
              { key: '1', label: '职责' },
            ],
            rows: RUNTIME.map((r) => ({ key: r[0], 0: r[0], 1: r[1] })),
          })
        ),
        h(
          Card,
          { title: '统一执行协议', sub: '任务 → 上下文 → 计划 → 策略 → 执行 → 校验 → 审批 → 回写 → Trace' },
          h(
            'div',
            { className: 'os-loop' },
            ['任务解析', '上下文构建', '计划与策略校验', 'Agent 执行循环', '结果校验', '人工审批', '写回与 Trace'].map((s, i) =>
              h(
                'div',
                { key: s, className: 'os-loop-s' },
                h('div', { className: 'os-mono os-muted' }, '0' + (i + 1)),
                h('div', { className: 'os-loop-t' }, s)
              )
            )
          )
        )
      );
    }

    function AppLivePage(props) {
      const spec = props.model.appSpec;
      const [picked, setPicked] = useState((spec.pages[0] || {}).id || '');
      const page = spec.pages.filter(function (p) { return p.id === picked; })[0] || spec.pages[0];
      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g4' },
          h(Stat, { value: String(spec.pageCount), label: '生成页面', delta: spec.objectCount + ' 个对象' }),
          h(Stat, { value: String(spec.pages.reduce(function (n, p) { return n + p.columns.length; }, 0)), label: '列表列', delta: '来自属性声明' }),
          h(Stat, { value: String(spec.pages.reduce(function (n, p) { return n + p.actions.length; }, 0)), label: '操作表单', delta: '来自 action inputSchema' }),
          h(Stat, { value: 'v' + spec.generatedFrom.version, label: '元数据版本', delta: spec.generatedFrom.packageId })
        ),
        h(
          Card,
          { title: '页面清单', sub: '应用依赖 Ontology 定义，属性一变规格就跟着变', extra: h(Badge, { tone: 'on' }, '自动生成'), flush: true },
          h(
            'div',
            { style: { padding: '10px 14px', display: 'flex', flexWrap: 'wrap', gap: 6 } },
            spec.pages.map(function (p) {
              return h(
                'button',
                {
                  key: p.id,
                  type: 'button',
                  className: 'os-btn' + (page && p.id === page.id ? ' pri' : ''),
                  onClick: function () {
                    setPicked(p.id);
                  },
                },
                p.title + ' · ' + p.columns.length + ' 列'
              );
            })
          )
        ),
        page
          ? h(
              Card,
              { title: page.title + '（' + page.kind + '）', sub: '来源对象 ' + page.source, flush: true },
              h(Table, {
                columns: [
                  { key: 'label', label: '列', render: function (r) { return h('span', { style: { fontWeight: 600 } }, r.label); } },
                  { key: 'field', label: '字段', render: function (r) { return h('span', { className: 'os-mono' }, r.field); } },
                  { key: 'type', label: '类型' },
                  { key: 'display', label: '渲染' },
                  { key: 'align', label: '对齐', width: '10%' },
                ],
                rows: page.columns.map(function (c) { return Object.assign({ key: c.field }, c); }),
              })
            )
          : null,
        h(
          'div',
          { className: 'os-grid os-g2' },
          h(
            Card,
            { title: '筛选器', flush: true },
            page && page.filters.length
              ? h(Table, {
                  columns: [
                    { key: 'label', label: '筛选' },
                    { key: 'field', label: '字段', render: function (r) { return h('span', { className: 'os-mono' }, r.field); } },
                    { key: 'kind', label: '控件', render: function (r) { return h(Badge, { tone: 'brand' }, r.kind); } },
                  ],
                  rows: page.filters.map(function (f) { return Object.assign({ key: f.field }, f); }),
                })
              : h('div', { className: 'os-card-b os-muted' }, '这个对象没有可枚举/可日期过滤的属性，列表页不带筛选器。')
          ),
          h(
            Card,
            { title: '操作表单', flush: true },
            page && page.actions.length
              ? h(Table, {
                  columns: [
                    { key: 'label', label: '操作' },
                    {
                      key: 'approvalRequired',
                      label: '审批',
                      width: '14%',
                      render: function (r) { return h(Badge, { tone: r.approvalRequired ? 'warn' : 'on' }, r.approvalRequired ? '需审批' : '免审批'); },
                    },
                    {
                      key: 'form',
                      label: '表单字段',
                      render: function (r) {
                        return h(
                          'span',
                          { className: 'os-mono os-muted' },
                          r.form.map(function (f) { return f.field + (f.required ? '*' : ''); }).join(', ')
                        );
                      },
                    },
                  ],
                  rows: page.actions.map(function (a) { return Object.assign({ key: a.actionId }, a); }),
                })
              : h('div', { className: 'os-card-b os-muted' }, '这个对象没有可执行动作，页面不含操作表单。')
          )
        ),
        (spec.notes || []).length
          ? h(
              Notes,
              null,
              '生成时的提示：' + spec.notes.join('；')
            )
          : null,
        h(Notes, null, '这是由本体元数据生成的页面规格，不是可交互应用：真正渲染还需一个前端把规格转成组件。面板只展示规格，不发起任何业务操作。')
      );
    }

    function AppPage(props) {
      const model = (props && props.model) || buildModel({ phase: 'demo' });
      if (model.live && model.appSpec && (model.appSpec.pages || []).length) return h(AppLivePage, { model: model });
      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g2' },
          APPS.map((a) =>
            h(
              'div',
              { key: a[0], className: 'os-tile' },
              h('div', { className: 'os-rowhead' }, h('span', { style: { fontWeight: 600 } }, a[0]), h(Badge, { tone: a[3] === '已发布' ? 'on' : a[3] === '草稿' ? '' : 'warn' }, a[3])),
              h('div', { className: 'os-muted', style: { marginTop: 4 } }, a[1] + ' · ' + a[4]),
              h('div', { className: 'os-mono os-muted', style: { marginTop: 6 } }, '依赖本体：' + a[2])
            )
          )
        ),
        h(Notes, null, '关键设计：应用依赖 Ontology 定义而不是底层数据库表结构，本体属性变化可被页面自动感知；复杂交互仍支持代码扩展。')
      );
    }

    function GovernanceLivePage(props) {
      const model = props.model;
      const entries = model.history || [];
      const pkg = model.pkg || {};
      const needApproval = (pkg.actions || []).filter(function (a) {
        return a.approvalRequired === true;
      });
      const hc = model.harness || null;
      const gaps = (hc && hc.gaps) || [];
      const harnessCard = hc
        ? h(
            Card,
            {
              title: '本体体检',
              sub: hc.readyAreas + '/' + hc.totalAreas + ' 个方面就绪' + (gaps.length ? '，' + gaps.length + ' 处缺口' : ''),
              extra: h(Badge, { tone: gaps.length ? 'warn' : 'on' }, hc.verdict === 'ready' ? '就绪' : '待补'),
              flush: true,
            },
            gaps.length
              ? h(Table, {
                  columns: [
                    { key: 'area', label: '方面', width: '12%', render: function (r) { return h(Badge, { tone: 'brand' }, r.area); } },
                    { key: 'title', label: '缺口' },
                    { key: 'how', label: '怎么补' },
                  ],
                  rows: gaps.map(function (g, i) { return { key: i, area: g.area, title: g.title, how: g.how }; }),
                })
              : h('div', { className: 'os-card-b os-muted' }, '六个方面都齐了。')
          )
        : null;
      return h(
        'div',
        { className: 'os-grid' },
        harnessCard,
        h(
          'div',
          { className: 'os-grid os-g4' },
          h(Stat, { value: 'v' + (pkg.version || '?'), label: '当前版本', delta: pkg.status === 'published' ? '已发布' : '草稿' }),
          h(Stat, { value: String((pkg.objects || []).length), label: '受管对象', delta: (pkg.links || []).length + ' 条关系' }),
          h(Stat, { value: String(needApproval.length), label: '需审批动作', delta: needApproval.map(function (a) { return a.id; }).join(', ') || '无' }),
          h(Stat, { value: String(entries.length), label: '变更记录', delta: '来自 .ontology-history.jsonl' })
        ),
        h(
          Card,
          {
            title: '变更历史',
            sub: '每次写入追加一条，文件内容只反映当前状态，历史才回答「改过什么」',
            extra: h(Badge, { tone: 'on' }, '真实记录'),
            flush: true,
          },
          entries.length
            ? h(Table, {
                columns: [
                  {
                    key: 'ts',
                    label: '时间',
                    width: '18%',
                    render: function (r) {
                      return h('span', { className: 'os-mono os-muted' }, new Date(r.ts).toLocaleString());
                    },
                  },
                  { key: 'version', label: '版本', width: '10%', render: function (r) { return h('span', { className: 'os-mono' }, 'v' + (r.version || '?')); } },
                  { key: 'op', label: '操作', width: '18%', render: function (r) { return h(Badge, { tone: 'brand' }, r.op); } },
                  { key: 'summary', label: '内容' },
                ],
                rows: entries.map(function (e, i) {
                  return Object.assign({ key: i }, e);
                }),
              })
            : h('div', { className: 'os-card-b os-muted' }, '还没有任何变更记录：这个包还没被改过。')
        ),
        h(
          Notes,
          null,
          '这里只记录「资产包变了什么」。权限模型、审核流程、跨环境发布仍是演示数据——那些需要真实的身份与审批后端。'
        )
      );
    }

    function GovernancePage(props) {
      const model = (props && props.model) || buildModel({ phase: 'demo' });
      const [tab, setTab] = useState('版本');
      if (model.live && model.history && model.history.length) return h(GovernanceLivePage, { model: model });
      const body = {
        版本: h(Table, {
          columns: [
            { key: '0', label: '资产', render: (r) => h('span', { className: 'os-mono' }, r[0]) },
            { key: '1', label: '版本' },
            { key: '2', label: '状态', render: (r) => h(Badge, { tone: r[2] === '已发布' ? 'on' : 'warn' }, r[2]) },
            { key: '3', label: '责任人' },
            { key: '4', label: '时间' },
            { key: '5', label: '说明' },
          ],
          rows: VERSIONS.map((r, i) => ({ key: i, 0: r[0], 1: r[1], 2: r[2], 3: r[3], 4: r[4], 5: r[5] })),
        }),
        审核: h(Table, {
          columns: [
            { key: '0', label: '变更内容' },
            { key: '1', label: '类型', render: (r) => h('span', { className: 'os-mono' }, r[1]) },
            { key: '2', label: '发起方' },
            { key: '3', label: '状态', render: (r) => h(Badge, { tone: r[4] }, r[3]) },
          ],
          rows: APPROVALS.map((r, i) => ({ key: i, 0: r[0], 1: r[1], 2: r[2], 3: r[3], 4: r[4] === 'urgent' ? 'err' : r[4] })),
        }),
        权限: h(Table, {
          columns: [
            { key: '0', label: '角色 / 身份' },
            { key: '1', label: '可操作范围' },
            { key: '2', label: '权限', render: (r) => h(Badge, { tone: r[2] === '受限' || r[2] === '读写（受限）' ? 'warn' : 'on' }, r[2]) },
            { key: '3', label: '成员' },
          ],
          rows: PERMISSIONS.map((r, i) => ({ key: i, 0: r[0], 1: r[1], 2: r[2], 3: r[3] })),
        }),
        审计: h(Table, {
          columns: [
            { key: '0', label: '时间', width: '10%' },
            { key: '1', label: '对象' },
            { key: '2', label: '动作' },
            { key: '3', label: '操作者' },
          ],
          rows: AUDIT.map((r, i) => ({ key: i, 0: r[0], 1: h('span', { className: 'os-mono' }, r[1]), 2: r[2], 3: r[3] })),
        }),
      }[tab];
      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g4' },
          h(Stat, { value: '26', label: '受管资产', delta: '6 个资产类型' }),
          h(Stat, { value: '4', label: '待审批', delta: '1 项紧急' }),
          h(Stat, { value: '9', label: '历史版本', delta: '可回滚' }),
          h(Stat, { value: '100%', label: '变更留痕', delta: '含 Agent 操作' })
        ),
        h(Card, { title: '治理视图', flush: true }, h(Tabs, { items: ['版本', '审核', '权限', '审计'], value: tab, onChange: setTab }), h('div', { style: { marginTop: -1 } }, body))
      );
    }

    function MarketplaceLivePage(props) {
      const model = props.model;
      const catalog = model.catalog || { available: [], installed: [], missingDeps: [] };
      const missing = catalog.missingDeps || [];
      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g4' },
          h(Stat, { value: String((catalog.available || []).length), label: '市场可安装', delta: 'catalog 目录' }),
          h(Stat, { value: String((catalog.installed || []).length), label: '已安装', delta: '资产目录' }),
          h(Stat, {
            value: String((catalog.available || []).filter(function (a) { return a.upgradable; }).length),
            label: '可升级',
            delta: '市场里有同 id 的新版本',
          }),
          h(Stat, {
            value: String(missing.length),
            label: '依赖缺失',
            delta: missing.length ? missing.map(function (m) { return m.package; }).join(', ') : '全部满足',
          })
        ),
        h(
          Card,
          { title: '资产市场', sub: 'catalog 里可安装的资产包', extra: h(Badge, { tone: 'on' }, '真实目录'), flush: true },
          h(Table, {
            columns: [
              { key: 'id', label: '资产包', render: function (r) { return h('span', { className: 'os-mono' }, r.id); } },
              { key: 'name', label: '名称' },
              { key: 'version', label: '版本', width: '9%' },
              { key: 'objects', label: '对象', width: '8%' },
              { key: 'rules', label: '规则', width: '8%' },
              { key: 'actions', label: '动作', width: '8%' },
              {
                key: 'dependsOn',
                label: '依赖',
                render: function (r) {
                  return r.dependsOn && r.dependsOn.length
                    ? h('span', { className: 'os-mono os-muted' }, r.dependsOn.join(', '))
                    : h('span', { className: 'os-muted' }, '—');
                },
              },
              {
                key: 'installed',
                label: '状态',
                width: '16%',
                render: function (r) {
                  if (r.upgradable) return h(Badge, { tone: 'warn' }, '可升级 v' + (r.installedVersion || '?') + ' → v' + r.version);
                  return h(Badge, { tone: r.installed ? 'on' : '' }, r.installed ? '已安装' : r.ok ? '可安装' : '包不合法');
                },
              },
            ],
            rows: (catalog.available || []).map(function (a) { return Object.assign({ key: a.id }, a); }),
          })
        ),
        h(
          Card,
          { title: '已安装', sub: '运行时真正读取的资产包', flush: true },
          h(Table, {
            columns: [
              { key: 'id', label: '资产包', render: function (r) { return h('span', { className: 'os-mono' }, r.id); } },
              { key: 'version', label: '版本', width: '12%' },
              { key: 'objects', label: '对象', width: '10%' },
            ],
            rows: (catalog.installed || []).map(function (i) { return Object.assign({ key: i.id }, i); }),
          })
        ),
        h(
          Notes,
          null,
          '安装与卸载走 Agent 工具 ontology_install_asset / ontology_uninstall_asset（受写入门禁与审批闸门约束），面板只读展示——不提供绕过审批的按钮。'
        )
      );
    }

    function MarketplacePage(props) {
      const model = (props && props.model) || buildModel({ phase: 'demo' });
      if (model.live && model.catalog) return h(MarketplaceLivePage, { model: model });
      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g3' },
          ASSETS.map((a) =>
            h(
              'div',
              { key: a[0], className: 'os-tile' },
              h('div', { className: 'os-rowhead' }, h('span', { style: { fontWeight: 600 } }, a[0]), h(Badge, { tone: a[4] === '已安装' ? 'on' : '' }, a[4])),
              h('div', { className: 'os-muted', style: { marginTop: 4 } }, a[1] + ' · v' + a[2]),
              h('div', { className: 'os-mono os-muted', style: { marginTop: 6 } }, a[3]),
              h(
                'div',
                { style: { marginTop: 10, display: 'flex', gap: 6 } },
                h('button', { type: 'button', className: 'os-btn', disabled: true }, a[4] === '已安装' ? '已安装' : '安装'),
                h('button', { type: 'button', className: 'os-btn', disabled: true }, '详情')
              )
            )
          )
        ),
        h(
          Card,
          { title: '三层资产结构', sub: '新增业务场景应该越来越快' },
          h(
            'div',
            { className: 'os-grid os-g3' },
            [
              ['基础技术资产', '连接器、插件 SDK、组件、Runtime、模型适配器、通用工具'],
              ['通用语义资产', 'Object 模板、Link 模板、业务术语、规则模板、行业模型'],
              ['业务场景资产', '库存管理、会员运营、商品管理、门店运营、智能巡店'],
            ].map((r) =>
              h(
                'div',
                { key: r[0], className: 'os-loop-s' },
                h('div', { className: 'os-loop-t' }, r[0]),
                h('div', { className: 'os-loop-d' }, r[1])
              )
            )
          )
        )
      );
    }

    /** Live trace list when the Host is recording; demo detail view otherwise. */
    function ObservabilityPage(props) {
      const model = props.model || buildModel({ phase: 'demo' });
      if (!model.live) return h(ObservabilityDemo, props);
      const live = model.traces || [];
      const okCount = live.filter(function (e) { return e.ok; }).length;
      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g4' },
          h(Stat, { value: String(live.length), label: '已记录调用', delta: '来自执行轨迹' }),
          h(Stat, { value: String(okCount), label: '成功', delta: live.length - okCount + ' 次失败' }),
          h(Stat, {
            value: live.length ? Math.round(live.reduce(function (n, e) { return n + (e.ms || 0); }, 0) / live.length) + 'ms' : '—',
            label: '平均耗时',
            delta: 'P50 近似',
          }),
          h(Stat, { value: String((model.pkg && (model.pkg.actions || []).filter(function (a) { return a.effect && Array.isArray(a.inputSchema) && a.inputSchema.length; }).length) || 0), label: '可执行动作', delta: model.actions + ' 个本体动作' })
        ),
        h(
          Card,
          { title: '执行轨迹（实时）', sub: model.dir, extra: h(Badge, { tone: 'on' }, '真实记录') },
          live.length === 0
            ? h('div', { className: 'os-card-b os-muted' }, '这个实例还没有任何工具调用记录。调用一次 ontology_* 工具后刷新即可看到真实轨迹。')
            : h(
            'div',
            { style: { margin: '0 -14px' } },
            h(Table, {
              columns: [
                {
                  key: 'ts',
                  label: '时间',
                  width: '14%',
                  render: function (r) {
                    return h('span', { className: 'os-mono os-muted' }, new Date(r.ts).toLocaleTimeString());
                  },
                },
                { key: 'tool', label: '工具', width: '22%', render: function (r) { return h('span', { className: 'os-mono' }, r.tool); } },
                {
                  key: 'ok',
                  label: '结果',
                  width: '10%',
                  render: function (r) { return h(Badge, { tone: r.ok ? 'on' : 'err' }, r.ok ? 'ok' : 'failed'); },
                },
                { key: 'ms', label: '耗时', width: '10%', render: function (r) { return h('span', { className: 'os-mono' }, (r.ms || 0) + 'ms'); } },
                {
                  key: 'summary',
                  label: '摘要',
                  render: function (r) { return h('span', { className: 'os-muted' }, r.summary || r.error || '—'); },
                },
              ],
              rows: live.map(function (entry, i) { return Object.assign({ key: i }, entry); }),
            })
          )
        ),
        h(
          Notes,
          null,
          '这些是宿主真实记录的工具调用，每次 ontology_* 执行追加一行到 .ontology-traces.jsonl。评测指标仍是演示数据——真实评测需要把业务结果回写后才有基准。'
        )
      );
    }

    function ObservabilityDemo(props) {
      const [sel, setSel] = useState(0);
      const tr = TRACES[sel];
      return h(
        'div',
        { className: 'os-grid' },
        h(
          'div',
          { className: 'os-grid os-g4' },
          EVALS.map((e) => h(Stat, { key: e[0], value: e[1], label: e[0], delta: e[2] + ' · ' + e[3] }))
        ),
        h(
          'div',
          { className: 'os-split', style: { gridTemplateColumns: '320px minmax(0,1fr)' } },
          h(
            Card,
            { title: 'Harness Trace', sub: TRACES.length + ' 条', flush: true },
            h(
              'div',
              { style: { padding: '4px 0 6px' } },
              TRACES.map((t, i) =>
                h(
                  'button',
                  {
                    key: t.id,
                    type: 'button',
                    className: 'os-li' + (i === sel ? ' on' : ''),
                    onClick: function () {
                      setSel(i);
                    },
                  },
                  h('div', { className: 'os-rowhead' }, h('span', { className: 'os-li-t' }, t.title), h(Badge, { tone: t.status === '失败' ? 'err' : t.status === '等待审批' ? 'warn' : 'on' }, t.status)),
                  h('div', { className: 'os-li-s os-mono' }, t.agent + ' · ' + t.ms + 'ms')
                )
              )
            )
          ),
          h(
            'div',
            { className: 'os-grid' },
            h(
              Card,
              {
                title: tr.title,
                sub: tr.id + ' · ' + tr.agent,
                extra: h(Badge, { tone: tr.status === '失败' ? 'err' : tr.status === '等待审批' ? 'warn' : 'on' }, tr.status),
              },
              h(
                'div',
                { style: { display: 'flex', gap: 18, marginBottom: 10 } },
                [
                  ['耗时', tr.ms + 'ms'],
                  ['Tokens', tr.tokens],
                  ['成本', tr.cost],
                ].map((m) =>
                  h('div', { key: m[0] }, h('div', { className: 'os-mono os-muted' }, m[0]), h('div', { style: { fontWeight: 600 } }, m[1]))
                )
              ),
              tr.steps.map((s, i) =>
                h(
                  'div',
                  { key: i, className: 'os-step' },
                  h('span', {
                    className: 'os-dot',
                    style: {
                      background:
                        s[2] === 'err'
                          ? 'var(--dsw-alias-state-error-primary)'
                          : s[2] === 'warn'
                          ? 'var(--dsw-alias-state-warn-primary)'
                          : 'var(--dsw-alias-brand-primary)',
                    },
                  }),
                  h('div', { className: 'os-grow' }, h('div', { className: 'os-step-t' }, s[0]), h('div', { className: 'os-step-d' }, s[1]))
                )
              )
            ),
            h(Notes, null, '质量闭环：执行任务 → 记录过程 → 质量评测 → 优化 Harness（上下文/Prompt/工具/规则）→ 回归验证 → 发布 → 再次执行。')
          )
        )
      );
    }

    const PAGES = {
      overview: OverviewPage,
      ontology: OntologyPage,
      data: DataPage,
      logic: LogicPage,
      agent: AgentPage,
      app: AppPage,
      governance: GovernancePage,
      marketplace: MarketplacePage,
      observability: ObservabilityPage,
    };

    /* ------------------------------------------------------------------ *
     * panel
     * ------------------------------------------------------------------ */
    /**
     * Page-level error boundary. A throwing page would otherwise blank the whole
     * slot entry; here it degrades to a readable card, and the failure is posted
     * to the Host so it can be inspected from disk instead of guessed from a
     * screenshot.
     */
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      componentDidCatch(error, info) {
        reportPanel({ phase: 'page-error', page: this.props.page, error: String(error && error.message), detail: String((info && info.componentStack) || '').slice(0, 400) });
      }
      componentDidUpdate(prev) {
        if (prev.page !== this.props.page && this.state.error) this.setState({ error: null });
      }
      render() {
        if (!this.state.error) return this.props.children;
        return h(
          'div',
          { className: 'os-card' },
          h(
            'div',
            { className: 'os-card-h' },
            h('span', { className: 'os-card-t' }, '这个页面渲染失败'),
            h(Badge, { tone: 'err' }, this.props.page || '—')
          ),
          h(
            'div',
            { className: 'os-card-b' },
            h('div', { className: 'os-mono', style: { marginBottom: 8 } }, String(this.state.error.message || this.state.error)),
            h('div', { className: 'os-muted' }, '错误已上报到宿主（.ontology-panel.jsonl）。切到别的页面再切回来可以重试。')
          )
        );
      }
    }

    /** Best-effort UI health report; never blocks or throws. */
    function reportPanel(payload) {
      try {
        if (typeof fetch !== 'function') return;
        fetch(API_BASE + '/panel-report', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ ts: Date.now(), v: CLIENT_VERSION, href: typeof location !== 'undefined' ? location.pathname : '' }, payload)),
        }).catch(function () {});
      } catch (error) {
        /* reporting must never break rendering */
      }
    }

    function OntologyStudio() {
      const [page, setPage] = useState('overview');
      const pair = useOntologyState();
      const ontology = pair[0];
      const reload = pair[1];
      const model = useMemo(function () {
        return buildModel(ontology);
      }, [ontology]);
      useEffect(
        function () {
          reportPanel({ phase: 'render', page: page, live: model.live, problems: model.problems.length });
        },
        [page, model.live]
      );
      useEffect(function () {
        if (typeof window === 'undefined' || !window.addEventListener) return function () {};
        const onFocus = function () {
          reload();
        };
        window.addEventListener('focus', onFocus);
        return function () {
          window.removeEventListener('focus', onFocus);
        };
      }, []);
      const meta = PAGE[page] || PAGE.overview;
      const Body = PAGES[page] || OverviewPage;
      const pkgBadge = model.pkg
        ? h(Badge, { tone: 'brand' }, model.pkg.id + ' v' + model.pkg.version)
        : h(Badge, { tone: 'brand' }, 'retail.store-inventory');
      return h(
        'div',
        { className: 'os-root' },
        h('style', null, CSS),
        h(
          'aside',
          { className: 'os-rail' },
          h(
            'div',
            { className: 'os-brand' },
            h('span', { className: 'os-mark' }, h(Glyph, { name: 'ontology', size: 16 })),
            h('div', null, h('div', { className: 'os-brand-n' }, 'Ontology Studio'), h('div', { className: 'os-brand-s' }, '语义建模与智能执行'))
          ),
          h(
            'div',
            { className: 'os-rail-scroll' },
            NAV.map((g) =>
              h(
                'div',
                { key: g.group },
                h('div', { className: 'os-group' }, g.group),
                g.items.map((it) =>
                  h(
                    'button',
                    {
                      key: it.id,
                      type: 'button',
                      className: 'os-nav' + (it.id === page ? ' on' : ''),
                      onClick: function () {
                        setPage(it.id);
                      },
                    },
                    h('span', { className: 'os-nav-i' }, h(Glyph, { name: it.icon, size: 15 })),
                    h('span', { className: 'os-nav-l' }, it.label)
                  )
                )
              )
            )
          ),
          h('div', { className: 'os-rail-foot' }, model.live ? '已连接宿主资产' : model.label)
        ),
        h(
          'div',
          { className: 'os-main' },
          h(
            'header',
            { className: 'os-head' },
            h('div', { className: 'os-head-t' }, h('h1', { className: 'os-title' }, meta[0]), h('div', { className: 'os-desc' }, meta[1])),
            h(
              'button',
              { type: 'button', className: 'os-btn', onClick: reload, title: '重新读取宿主的资产、事实数据、历史、轨迹与市场' },
              '刷新'
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'os-btn pri',
                title: '到「本体模型」页新建对象',
                onClick: function () { setPage('ontology'); },
              },
              '新建资产'
            ),
            pkgBadge,
            h(Badge, { tone: model.live ? 'on' : 'warn' }, model.label),
            model.readOnly ? h(Badge, { tone: 'warn' }, '只读模式') : null,
            model.live && model.approval !== 'never'
              ? h(Badge, { tone: 'warn' }, model.approval === 'all' ? '写入需审批' : '删除/发布需审批')
              : null,
            model.problems.length ? h(Badge, { tone: 'err' }, model.problems.length + ' 个校验问题') : null,
            model.live && model.hostVersion && model.hostVersion !== CLIENT_VERSION
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'os-btn',
                    title: '宿主已加载新版本，面板还在用旧代码',
                    onClick: function () { if (typeof location !== 'undefined' && location.reload) location.reload(); },
                  },
                  '宿主已更新到 v' + model.hostVersion + '，点此重载'
                )
              : null,
          ),
          h(
            'div',
            { className: 'os-body' },
            h(PageBoundary, { page: page, key: page }, h(Body, { model: model, onSaved: reload }))
          )
        )
      );
    }

    function PanelIcon(props) {
      const size = (props && props.size) || 16;
      return h(
        'span',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: size,
            height: size,
            color: props && props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
          },
        },
        h(Glyph, { name: 'ontology', size: Math.round(size * 0.94) })
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots;
        const label = () => 'Ontology Studio';
        const bind = function (run) {
          if (typeof ctx.effect === 'function') ctx.effect(run);
          else run();
        };
        bind(function () {
          return slots.inject('main', function () {
            return slots.register({ name: 'main', key: PANEL_ID }, OntologyStudio);
          });
        });
        bind(function () {
          return slots.inject('sidebar.panellist', function () {
            return slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: label }, PanelIcon);
          });
        });
      },
    };
  },
});
