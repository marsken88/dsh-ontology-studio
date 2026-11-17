/**
 * 文档一致性审计：链接是否可达、数字是否与代码一致、文件是否被引用。
 * 只报告事实，不改文件。
 */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const problems = [];
const notes = [];

function read(p) {
  return fs.readFileSync(path.join(root, p), 'utf8');
}

/* ---------- 1. 本地链接可达性 ---------- */
const docs = ['README.md', 'USAGE.md', ...fs.readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f)];
let linkCount = 0;

for (const file of docs) {
  const text = read(file);
  const base = path.dirname(file);
  // markdown 链接 + 图片
  const re = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const target = m[1];
    if (/^https?:/.test(target) || target.startsWith('#') || target.startsWith('mailto:')) continue;
    linkCount += 1;
    const clean = target.split('#')[0];
    if (!clean) continue;
    const resolved = path.resolve(root, base, clean);
    if (!fs.existsSync(resolved)) problems.push(`${file}: 链接指向不存在的文件 → ${target}`);
  }
}

/* ---------- 2. 数字一致性 ---------- */
const pkg = JSON.parse(read('package.json'));
const indexSrc = read('index.js');
const toolNames = (indexSrc.match(/name: 'ontology_[a-z_]+'/g) || []).map((m) => m.slice(7, -1));
const tools = toolNames.length;
const readOnlyTools = tools - (indexSrc.match(/registerWrite\(\{/g) || []).length;

const readme = read('README.md');
const statusTools = /(\d+) 个工具/.exec(readme);
if (statusTools && Number(statusTools[1]) !== tools) {
  problems.push(`README 写 ${statusTools[1]} 个工具，实际 ${tools}`);
}
if (readme.includes('28 个工具') && tools !== 28) problems.push(`README 的「28 个工具」与代码不符（实际 ${tools}）`);

const codeVersion = /const CODE_VERSION = '([^']+)'/.exec(indexSrc);
if (!codeVersion) problems.push('index.js 缺 CODE_VERSION');
else if (codeVersion[1] !== pkg.version) problems.push(`CODE_VERSION ${codeVersion[1]} ≠ package.json ${pkg.version}`);

const verInReadme = /## 当前状态：v([\d.]+)/.exec(readme);
if (verInReadme && verInReadme[1] !== pkg.version.replace(/\.0$/, '')) {
  notes.push(`README 标题写 v${verInReadme[1]}，package.json 是 ${pkg.version}（标题习惯省略 patch）`);
}

const engine = (pkg.engines && pkg.engines.node) || '';
if (!readme.includes(encodeURIComponent('≥').toLowerCase()) && !readme.includes('%E2%89%A5')) {
  problems.push('README 缺 node engines 徽标');
}

/* ---------- 2b. 插件清单里的工具数 ---------- */
// 用户装好后在插件页看到的就是这段文字，写错了会以为插件没更新。
for (const f of ['locale/zh.json', 'locale/en.json']) {
  const text = read(f);
  const m = /(\d+)\s*(?:个[^\d]{0,12}工具|agent-callable)/.exec(text);
  if (!m) continue;
  const num = Number(m[1]);
  if (num !== tools) problems.push(f + ': 写着 ' + num + ' 个工具，代码是 ' + tools);
}

/* ---------- 2c. 详情页的工具数 ---------- */
for (const f of ['docs/DETAIL.md']) {
  const text = read(f);
  const m = /\*\*(\d+)\s*个\*\*/.exec(text);
  if (m && Number(m[1]) !== tools) problems.push(f + ': 写着 ' + m[1] + ' 个工具，代码是 ' + tools);
}

/* ---------- 3. 徽标 ---------- */
const badges = {
  test: /actions\/workflows\/test\.yml\/badge\.svg/,
  version: /img\.shields\.io\/github\/package-json\/v\//,
  license: /img\.shields\.io\/github\/license\//,
  node: /img\.shields\.io\/badge\/node/,
  dsh: /powered_by-dsh/,
};
for (const [name, re] of Object.entries(badges)) {
  if (!re.test(readme)) problems.push('缺徽标：' + name);
}

/* ---------- 4. docs 是否都被引用（README / USAGE / 清单） ---------- */
// 插件详情页正文由 locale 里的 detail 字段指向，不在 README 里出现也正常。
const manifestRefs = ['package.json']
  .concat(fs.readdirSync('locale').filter((f) => f.endsWith('.json')).map((f) => 'locale/' + f))
  .map(read)
  .join('\n');
const docFiles = fs.readdirSync('docs').filter((f) => f.endsWith('.md') && f !== 'plan-source.md');
for (const file of docFiles) {
  const referenced =
    readme.includes('docs/' + file) || read('USAGE.md').includes('docs/' + file) || manifestRefs.includes(file);
  if (!referenced) notes.push(`docs/${file} 没有被 README / USAGE / 清单引用`);
}

/* ---------- 5. 标准仓库文件 ---------- */
for (const f of ['README.md', 'LICENSE', '.gitignore', 'package.json', 'cordis.patch.yml']) {
  if (!fs.existsSync(path.join(root, f))) problems.push('缺文件：' + f);
}
if (!pkg.license) problems.push('package.json 缺 license 字段');
if (!pkg.repository) problems.push('package.json 缺 repository 字段');

/* ---------- 6. USAGE 与 README 的主要入口 ---------- */
if (!readme.includes('USAGE.md')) problems.push('README 没有指向 USAGE.md');
if (!fs.existsSync(path.join(root, '.github/workflows/test.yml'))) problems.push('缺 CI 工作流');

/* ---------- 7. 插件详情页必须介绍每个工具 ---------- */
// 详情页是市场里给人看的正文：漏了某个工具，用户就不知道它存在。
const detailSrc = fs.readFileSync(path.join(root, 'docs/DETAIL.md'), 'utf8');
for (const name of toolNames) {
  if (!detailSrc.includes(name)) problems.push(`docs/DETAIL.md 没有介绍工具 ${name}`);
}

/* ---------- 8. 建模指南要覆盖每一种声明 ---------- */
// schema 里能写的东西，建模指南就得讲怎么写。新增一种声明却忘了写，
// 用户只能去翻 JSON Schema 或者源码。
const schema = JSON.parse(fs.readFileSync(path.join(root, 'assets/ontology-ir.schema.json'), 'utf8'));
const envelope = new Set(['irVersion', 'id', 'name', 'description', 'domain', 'version', 'owner', 'status', 'dependsOn', 'extensions']);
const modelingSrc = fs.readFileSync(path.join(root, 'docs/modeling.md'), 'utf8');
// 文档是中文的，用术语而不是英文 key 判断：每个声明至少要有一个说法出现
const TERMS = {
  objects: ['对象'],
  links: ['关系'],
  rules: ['规则'],
  actions: ['动作'],
  policies: ['策略'],
  agents: ['Agent'],
  views: ['视图'],
  metrics: ['指标'],
  processes: ['流程'],
};
for (const key of Object.keys(schema.properties || {})) {
  if (envelope.has(key)) continue;
  const terms = TERMS[key] || [key];
  if (!terms.some((t) => modelingSrc.includes(t))) {
    problems.push(`docs/modeling.md 没有讲怎么声明 ${key}（找不到任何一处「${terms.join(' / ')}」）`);
  }
}

/* ---------- 9. 测试文档要覆盖每个测试文件，数字要对得上 ---------- */
// 加了一个测试文件却在文档里不提，等于没加：读文档的人以为没测这件事。
const testingSrc = fs.readFileSync(path.join(root, 'docs/testing.md'), 'utf8');
const testDir = path.join(root, 'test');
const testFiles = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.cjs') || f === 'render-smoke.cjs');
for (const f of testFiles) {
  if (!testingSrc.includes(f)) problems.push(`docs/testing.md 没有提到 test/${f}`);
}
const chainGroups = (pkg.scripts.test.match(/node test\//g) || []).length;
const claimedGroups = Number((testingSrc.match(/# (\d+) 组/) || [])[1]);
if (Number.isFinite(claimedGroups) && claimedGroups !== chainGroups) {
  problems.push(`docs/testing.md 说 ${claimedGroups} 组，npm test 实际跑 ${chainGroups} 个测试文件`);
}
const claimedItems = Number((testingSrc.match(/共 (\d+) 项断言/) || [])[1]);
const tableItems = (testingSrc.match(/^\| `test\/[a-z0-9.-]+\.cjs` \| (\d+) 项/gm) || [])
  .map((row) => Number(row.match(/(\d+) 项/)[1]))
  .reduce((a, b) => a + b, 0);
if (Number.isFinite(claimedItems) && claimedItems !== tableItems) {
  problems.push(`docs/testing.md 说共 ${claimedItems} 项，表里加起来是 ${tableItems} 项`);
}

/* ---------- 输出 ---------- */
console.log('检查文档：', docs.length, '个文件，本地链接', linkCount, '条');
console.log('工具：', tools, '个（其中写工具', (indexSrc.match(/registerWrite\(\{/g) || []).length, '个）');
console.log('版本： package.json', pkg.version, '| CODE_VERSION', codeVersion && codeVersion[1]);
console.log('');
if (problems.length) {
  console.log('❌ 问题', problems.length, '项：');
  for (const p of problems) console.log('  -', p);
} else {
  console.log('✅ 未发现问题');
}
if (notes.length) {
  console.log('');
  console.log('ℹ️ 提示', notes.length, '项：');
  for (const n of notes) console.log('  -', n);
}
process.exit(problems.length ? 1 : 0);
