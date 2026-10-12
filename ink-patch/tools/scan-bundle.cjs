// 在 bundle 中搜索关键词，输出每个命中位置的前后文片段（便于在压缩代码里定位实现）
// 用法：node tools/scan-bundle.cjs "关键词1" "关键词2" [--ctx=200] [--file=<path>]
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let ctx = 200;
let file = path.join(__dirname, '..', '..', 'preview', 'dist', 'assets', 'index-CXqJx8nv.js');
const keys = [];
let range = null;
for (const a of args) {
  if (a.startsWith('--ctx=')) ctx = parseInt(a.slice(6), 10);
  else if (a.startsWith('--file=')) file = a.slice(7);
  else if (a.startsWith('--range=')) {
    const [s, l] = a.slice(8).split(':').map(Number);
    range = { s, l };
  } else keys.push(a);
}
const raw = fs.readFileSync(file, 'utf8');
if (range) {
  console.log(`file: ${file}  range ${range.s}..${range.s + range.l}`);
  // 按 120 字符折行输出，并标注偏移，方便定位
  const seg = raw.slice(range.s, range.s + range.l);
  for (let i = 0; i < seg.length; i += 120) {
    console.log(String(range.s + i).padStart(8) + ' | ' + seg.slice(i, i + 120));
  }
  process.exit(0);
}
if (!keys.length) {
  console.error('用法: node tools/scan-bundle.cjs "关键词" [...] [--ctx=200] [--file=...]');
  process.exit(2);
}
const text = fs.readFileSync(file, 'utf8');
console.log(`file: ${file}  (${text.length} chars)`);
for (const k of keys) {
  const hits = [];
  let i = text.indexOf(k);
  while (i >= 0) {
    hits.push(i);
    i = text.indexOf(k, i + k.length);
  }
  console.log(`\n=== "${k}" → ${hits.length} 处命中 ===`);
  hits.slice(0, 20).forEach((p, n) => {
    const s = Math.max(0, p - ctx);
    const e = Math.min(text.length, p + k.length + ctx);
    console.log(`\n--- #${n + 1} @${p} ---`);
    console.log(text.slice(s, e).replace(/\n/g, '\\n'));
  });
  if (hits.length > 20) console.log(`  … 还有 ${hits.length - 20} 处`);
}
