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
const tools = (indexSrc.match(/name: 'ontology_[a-z_]+'/g) || []).length;
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
