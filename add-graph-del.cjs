const fs = require('fs');
const p = 'client.js';
let s = fs.readFileSync(p, 'utf8');
let n = 0;
const must = (a, b, label) => {
  if (!s.includes(a)) throw new Error('anchor missing: ' + label);
  s = s.replace(a, b);
  n += 1;
};

/* 1) 图状态：待确认删除的节点 */
must(
  "      const [over, setOver] = useState(null);",
  "      const [over, setOver] = useState(null);\n      const [armed, setArmed] = useState(null);",
  'armed state'
);

/* 2) 删除逻辑：第一次点只是武装，第二次才发请求；有引用就拒绝 */
must(
  '      const persist = function (next) {',
  `      const removeNode = function (id) {
        if (armed !== id) {
          setArmed(id);
          setNotice('再点一次删除 ' + id + '。有引用时会被拒绝，并列出依赖。');
          return;
        }
        setArmed(null);
        setNotice('正在删除 ' + id + ' …');
        post('/write/delete-object', { packageId: pkg.id, objectId: id })
          .then(function (body) {
            if (body && body.ok) {
              setNotice('已删除 ' + id);
              if (typeof props.onSaved === 'function') props.onSaved();
              return;
            }
            if (body && body.error === 'has_dependents') {
              const d = body.dependents || {};
              setNotice(
                '未删除：' + (d.links || 0) + ' 条关系' +
                ((d.actions || []).length ? '、动作 ' + d.actions.join(', ') : '') +
                ((d.agents || []).length ? '、Agent ' + d.agents.join(', ') : '') +
                ' 引用它。要连带清理请到列表页的编辑界面里确认删除。'
              );
              return;
            }
            setNotice('未删除：' + ((body && (body.message || body.error)) || '未知原因'));
          })
          .catch(function (e) { setNotice('未删除：' + String(e && e.message)); });
      };

      const persist = function (next) {`,
  'removeNode'
);

/* 3) 节点右上角加删除标记 */
must(
  `                h('circle', {
                  cx: NODE_W,
                  cy: NODE_H / 2,
                  r: 14,
                  fill: 'transparent',
                  style: { cursor: 'crosshair' },
                  onMouseDown: function (event) { startLinkDrag(event, o.id); },
                })`,
  `                h('circle', {
                  cx: NODE_W,
                  cy: NODE_H / 2,
                  r: 14,
                  fill: 'transparent',
                  style: { cursor: 'crosshair' },
                  onMouseDown: function (event) { startLinkDrag(event, o.id); },
                }),
                h(
                  'text',
                  {
                    x: NODE_W - 10,
                    y: 15,
                    fontSize: '13',
                    textAnchor: 'middle',
                    fill: armed === o.id ? 'var(--dsw-alias-state-error-primary, #d33)' : 'var(--dsw-alias-label-tertiary, #999)',
                    style: { cursor: 'pointer' },
                    onClick: function (event) {
                      event.stopPropagation();
                      removeNode(o.id);
                    },
                  },
                  armed === o.id ? '确认' : '×'
                )`,
  'delete mark'
);

/* 4) 提示文案补一句 */
must(
  '拖动节点只改布局，不改本体；从节点右侧圆点拖到另一节点可建关系；双击空白处新建对象。写入前按整包校验。',
  '拖动节点只改布局；从右侧圆点拖到另一节点可建关系；双击空白处新建对象；点节点右上角的 × 删除（需点两次确认，有引用会被拒绝）。',
  'hint text'
);

fs.writeFileSync(p, s);
console.log('applied', n);
