/**
 * 前后端连线检查：路由与调用必须对得上。
 *
 * 踩过的坑：面板某次改名后前端还在调旧路径，页面静默变成空数据，
 * 不报错、不抛异常。这类断裂只有真看界面才发现。
 *
 * 检查三件事：
 * 1. 前端 get() 的路径，后端必须有对应路由
 * 2. 前端 post('/write/...') 的路径，写路由必须存在
 * 3. 后端路由里长期无人调用的，列出来（提示，不报错）
 */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const api = fs.readFileSync(path.join(root, 'lib/api.mjs'), 'utf8');
const writes = fs.readFileSync(path.join(root, 'lib/panel-writes.mjs'), 'utf8');
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

/* 后端读路由（按 `${prefix}/xxx` 形式注册的） */
const readRoutes = [...api.matchAll(/`\$\{prefix\}\/([a-z-]+)`/g)].map((m) => m[1]);

/* 后端写路由 */
const writeRoutes = [...new Set([...writes.matchAll(/\/write\/([a-z-]+)/g)].map((m) => m[1]))];

/* 前端调用 */
const usedRead = new Set([...client.matchAll(/get\('(\/[a-z-]+)/g)].map((m) => m[1].replace(/^\//, '')));
const usedWrite = new Set([...client.matchAll(/post\('\/write\/([a-z-]+)/g)].map((m) => m[1]));

/* POST 的读路由（上报类）不算 get，单独排除 */
const POST_ONLY = new Set(['panel-report']);
/* 供外部/工具使用、面板暂不调用的路由，明确列出而不是放任 */
const ALLOWED_UNUSED = new Set(['impact']);

const problems = [];

for (const r of usedRead) {
  if (!readRoutes.includes(r) && !writeRoutes.includes(r)) {
    problems.push(`前端 get('/${r}') 但后端没有这个路由`);
  }
}
for (const r of usedWrite) {
  if (!writeRoutes.includes(r)) {
    problems.push(`前端 post('/write/${r}') 但后端没有这个写路由`);
  }
}

const unused = readRoutes.filter((r) => !usedRead.has(r) && !POST_ONLY.has(r) && !ALLOWED_UNUSED.has(r));

console.log('读路由 ' + readRoutes.length + ' 条 | 写路由 ' + writeRoutes.length + ' 条 | 前端调用 ' + (usedRead.size + usedWrite.size) + ' 处');
if (problems.length) {
  console.log('\n❌ 断链 ' + problems.length + ' 处：');
  for (const p of problems) console.log('  - ' + p);
} else {
  console.log('✅ 前后端路径对得上');
}
if (unused.length) {
  console.log('\n⚠️ 后端有路由但面板未调用：' + unused.join(', '));
  console.log('  （如果是给外部用的，加入脚本里的 ALLOWED_UNUSED；如果是废弃的，删掉）');
}

process.exit(problems.length ? 1 : 0);
