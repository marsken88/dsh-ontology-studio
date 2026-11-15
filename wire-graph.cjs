// 本体模型页加「列表 / 图谱」切换
const fs = require('fs');
const p = 'client.js';
let s = fs.readFileSync(p, 'utf8');
const before = s;

// 1) state
const stateAnchor = "      const [editing, setEditing] = useState(null);\n      const packageId = model && model.pkg ? model.pkg.id : null;";
if (!s.includes(stateAnchor)) throw new Error('state anchor missing');
s = s.replace(
  stateAnchor,
  stateAnchor + "\n      const [view2, setView2] = useState('list');"
);

// 2) 顶栏加切换：放在对象清单卡片 extra 里之前先加一个 Card 级切换
const listAnchor = `            extra: packageId
              ? h(
                  'button',
                  { type: 'button', className: 'os-btn', onClick: function () { setEditing('new'); } },
                  '+ 新建对象'
                )
              : null,`;
if (!s.includes(listAnchor)) throw new Error('list anchor missing');
s = s.replace(
  listAnchor,
  `            extra: packageId
              ? h(
                  'div',
                  { style: { display: 'flex', gap: 6 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'os-btn' + (view2 === 'graph' ? ' pri' : ''),
                      onClick: function () { setView2(view2 === 'graph' ? 'list' : 'graph'); },
                    },
                    view2 === 'graph' ? '列表视图' : '图谱视图'
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'os-btn', onClick: function () { setEditing('new'); } },
                    '+ 新建对象'
                  )
                )
              : null,`
);

// 3) 图谱模式下把整块内容换成 GraphView
const branchAnchor = `        editing && packageId && String(editing).indexOf('__link__') === 0`;
if (!s.includes(branchAnchor)) throw new Error('branch anchor missing');
s = s.replace(
  branchAnchor,
  `        view2 === 'graph' && packageId && model.pkg && !editing
          ? h(GraphView, {
              pkg: model.pkg,
              onSaved: function () {
                if (typeof props.onSaved === 'function') props.onSaved();
              },
              onPick: function (id) {
                setSel(id);
                setView2('list');
              },
            })
          : null,
        view2 === 'graph'
          ? null
          : h('div', { style: { display: 'contents' } },` 
);

fs.writeFileSync(p, s);
console.log('toggle wired (partial)');
