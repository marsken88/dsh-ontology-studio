// 修掉上一步破坏结构的插入，改用提前返回
const fs = require('fs');
const p = 'client.js';
let s = fs.readFileSync(p, 'utf8');

const bad = `        view2 === 'graph' && packageId && model.pkg && !editing
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
          : h('div', { style: { display: 'contents' } },
`;
if (!s.includes(bad)) throw new Error('bad block not found');
s = s.replace(bad, '');

// 在 return 之前插入图谱分支
const retAnchor = `      const c3 = { 业务视角: '说明', 数据视角: '主键', 技术视角: '存储位置', 'AI 视角': '语义约束' }[view];`;
if (!s.includes(retAnchor)) throw new Error('return anchor missing');
s = s.replace(
  retAnchor,
  retAnchor +
    `

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
        });
      }`
);

fs.writeFileSync(p, s);
console.log('graph branch fixed');
