// 统计 bundle 中若干字面锚点的出现次数（补丁注入前的唯一性检查）。
// 用法：node tools/count-anchor.cjs [--file=<path>] "<anchor>" [...]
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let file = path.join(__dirname, '..', '..', 'preview', 'dist', 'assets', 'index-CXqJx8nv.js');
const needles = [];
for (const a of args) {
  if (a.startsWith('--file=')) file = a.slice(7);
  else needles.push(a);
}
const text = fs.readFileSync(file, 'utf8');
console.log('file: ' + file + '  (' + text.length + ' chars)');
for (const n of needles) {
  let count = 0;
  let i = text.indexOf(n);
  const first = i;
  while (i >= 0) {
    count++;
    i = text.indexOf(n, i + n.length);
  }
  console.log((count === 1 ? 'OK  ' : count === 0 ? 'MISS' : 'DUP ') + String(count).padStart(3) + '  @' + first + '  ' + n);
}
