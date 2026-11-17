/**
 * 前端样式静态检查。
 *
 * 1) client.js 里 className 用到的 os-* 类，CSS 里必须都有定义
 *    （踩过：.os-field / .os-input 从没定义，输入框裸奔）
 * 2) 顶层规则里同一选择器不能被定义两次
 *    （踩过：.os-li 我加的 flex 被后面原有的 block 覆盖，改了等于没改）
 *
 * @media 里的重复定义是响应式覆盖，不算问题。
 * 这两类问题都不会让功能测试变红，只在界面上表现为样式缺失或改动不生效。
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(process.cwd(), 'client.js'), 'utf8');

/* ---------- 取 CSS ---------- */
const HEAD = 'const CSS = `';
const start = src.indexOf(HEAD);
if (start < 0) throw new Error('client.js 里找不到 CSS 模板');
const end = src.indexOf('`', start + HEAD.length);
if (end < 0) throw new Error('CSS 模板没有闭合');
const css = src.slice(start + HEAD.length, end);
const topLevel = css.split('@media')[0];

/* ---------- CSS 定义的选择器 ---------- */
const rules = [];
(() => {
  let depth = 0;
  let mediaDepth = -1; // 当前所在的 @media 内部深度，-1 表示不在媒体查询里
  let buf = '';
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      const sel = buf.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      buf = '';
      if (sel.startsWith('@media') || sel.startsWith('@container')) {
        depth += 1;
        mediaDepth = depth;
        continue;
      }
      const top = mediaDepth < 0 || depth < mediaDepth;
      for (const raw of sel.split(',')) {
        const one = raw.split('\n').pop().trim();
        if (one.startsWith('.')) rules.push({ sel: one, top });
      }
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (mediaDepth >= 0 && depth < mediaDepth) mediaDepth = -1;
      buf = '';
      continue;
    }
    buf += ch;
  }
})();

const definedClass = new Set();
for (const { sel } of rules) {
  for (const part of sel.split(/[\s>+~]+/)) {
    if (!part.startsWith('.')) continue;
    for (const name of part.split('.').filter(Boolean)) definedClass.add(name);
  }
}

/* ---------- 代码里用到的 className ---------- */
const used = new Map();
src.split('\n').forEach((line, i) => {
  for (const m of line.matchAll(/className:\s*'([^']*)'/g)) {
    for (const token of m[1].split(/\s+/)) {
      if (/^os-[a-z0-9-]+$/.test(token) && !used.has(token)) used.set(token, i + 1);
    }
  }
});

/* ---------- 检查 ---------- */
const problems = [];
const warnings = [];

for (const [cls, line] of used) {
  if (!definedClass.has(cls)) problems.push(`client.js:${line} 用了 .${cls}，但 CSS 里没有定义`);
}

const topCount = new Map();
for (const { sel, top } of rules) if (top) topCount.set(sel, (topCount.get(sel) || 0) + 1);
for (const [sel, n] of topCount) {
  if (n > 1) warnings.push(`${sel} 在顶层被定义了 ${n} 次（后者覆盖前者）`);
}

/* ---------- 检查：永远禁用的按钮 ---------- */
// 踩过：顶栏「新建资产」写着 disabled: true 活了好几轮，看起来能点其实永远点不动。
// 目前只允许市场页演示分支里的两个（宿主离线时才出现）；再多就是新的死按钮。
const DISABLED_ALLOWED = 2;
const disabledCount = (src.match(/disabled:\s*true/g) || []).length;
if (disabledCount > DISABLED_ALLOWED) {
  problems.push(
    `client.js 里有 ${disabledCount} 个永远禁用的按钮（允许上限 ${DISABLED_ALLOWED}）：新加的请改成可用，或说明为什么必须是占位`
  );
}

console.log('CSS 选择器 ' + new Set(rules.map((r) => r.sel)).size + ' 个 | 代码用到的 os-* 类 ' + used.size + ' 个 | 永久禁用按钮 ' + disabledCount + ' 个');
if (problems.length) {
  console.log('\n❌ 缺定义 ' + problems.length + ' 处：');
  for (const p of problems) console.log('  - ' + p);
} else {
  console.log('✅ 所有用到的类都有定义');
}
if (warnings.length) {
  console.log('\n⚠️ 重复定义 ' + warnings.length + ' 处：');
  for (const w of warnings) console.log('  - ' + w);
}
process.exit(problems.length ? 1 : 0);
