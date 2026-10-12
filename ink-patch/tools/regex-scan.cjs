// 在 bundle 里按「正则」搜索并输出命中位置 + 上下文（scan-bundle.cjs 只支持字面串，
// 压缩产物里定位函数定义、变量绑定需要正则）。
// 用法：node tools/regex-scan.cjs "<regex>" ["<regex2>" ...] [--ctx=200] [--max=8] [--file=<path>] [--flag=g]
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let ctx = 200;
let max = 8;
let flag = 'g';
let file = path.join(__dirname, '..', '..', 'preview', 'dist', 'assets', 'index-CXqJx8nv.js');
const pats = [];
for (const a of args) {
  if (a.startsWith('--ctx=')) ctx = parseInt(a.slice(6), 10);
  else if (a.startsWith('--max=')) max = parseInt(a.slice(6), 10);
  else if (a.startsWith('--flag=')) flag = a.slice(7);
  else if (a.startsWith('--file=')) file = a.slice(7);
  else pats.push(a);
}
if (!pats.length) {
  console.error('用法: node tools/regex-scan.cjs "<regex>" [...] [--ctx=200] [--max=8] [--file=...] [--flag=g]');
  process.exit(2);
}
const text = fs.readFileSync(file, 'utf8');
console.log(`file: ${file}  (${text.length} chars)`);
for (const p of pats) {
  let re;
  try {
    re = new RegExp(p, flag.includes('g') ? flag : flag + 'g');
  } catch (err) {
    console.log(`\n=== /${p}/ 无效正则：${err.message}`);
    continue;
  }
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    hits.push({ i: m.index, s: m[0] });
    if (m[0] === '') re.lastIndex++;
    if (hits.length >= 400) break;
  }
  console.log(`\n=== /${p}/ → ${hits.length} 处命中${hits.length > max ? `（显示前 ${max}）` : ''} ===`);
  hits.slice(0, max).forEach((h, n) => {
    const s = Math.max(0, h.i - ctx);
    const e = Math.min(text.length, h.i + h.s.length + ctx);
    console.log(`\n--- #${n + 1} @${h.i} [${h.s}] ---`);
    console.log(text.slice(s, e).replace(/\n/g, '\\n'));
  });
}
