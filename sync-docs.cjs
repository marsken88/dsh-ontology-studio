// 把最近几项能力同步进 USAGE 与 README 状态表
const fs = require('fs');
let n = 0;
const edit = (file, a, b, label) => {
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes(a)) throw new Error('anchor missing [' + label + ']');
  fs.writeFileSync(file, s.replace(a, b));
  n += 1;
};

/* USAGE：图谱三件事 + 体检卡片 + 版本重载 */
edit(
  'USAGE.md',
  '- `图谱视图` 看全貌：拖节点排版，从节点右侧圆点拖到另一个节点直接建关系',
  [
    '- `图谱` 看全貌，三种操作：',
    '  - **拖节点** → 改布局（只存在浏览器本地，不动本体）',
    '  - **从节点右侧圆点拖到另一个节点** → 直接建关系（会真的写资产）',
    '  - **双击画布空白处** → 新建对象',
  ].join('\n'),
  'usage graph'
);

edit(
  'USAGE.md',
  '## 六、出问题了怎么办',
  [
    '## 体检与版本',
    '',
    '**体检**：治理中心页顶部有一张「本体体检」卡，显示六方面（结构/规则/动作/护栏/数据/Agent）',
    '几项就绪、缺什么、怎么补。也可以直接问 Agent「体检一下」。',
    '',
    '**版本重载**：宿主升级后，浏览器可能还缓存着旧的面板代码。面板会自己发现——',
    '头部出现「宿主已更新到 vX，点此重载」，点一下即可，不用记 Ctrl+Shift+R。',
    '命令行也能查：`ontology_diagnostics` 里的「面板版本」一项。',
    '',
    '## 六、出问题了怎么办',
  ].join('\n'),
  'usage harness'
);

/* README 状态表：补三行 */
edit(
  'README.md',
  '| 规则评测 | ✅ 记录条件指纹；规则与数据同时变化时拒绝比较 |',
  [
    '| 规则评测 | ✅ 记录条件指纹；规则与数据同时变化时拒绝比较 |',
    '| 图谱视图 | ✅ 拖节点排版、拖连线建关系、双击空白建对象 |',
    '| 面板自更新 | ✅ 宿主与面板版本不一致时，头部给出一键重载入口 |',
  ].join('\n'),
  'readme rows'
);

console.log('applied', n);
