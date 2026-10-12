// 还原墨记 InkNotes 的 app.asar（撤销自动拉取补丁）
// 用法：
//   node restore.cjs          还原到最新的备份
//   node restore.cjs --list   只列出可用备份
const fs = require('fs');
const path = require('path');

const DIR = 'D:\\墨记笔记\\ink-notes\\resources';
const ASAR = path.join(DIR, 'app.asar');

const backups = fs
  .readdirSync(DIR)
  .filter((f) => /^app\.asar\.bak-auto-pull-\d+$/.test(f))
  .sort()
  .map((f) => path.join(DIR, f));

if (backups.length === 0) {
  console.error('没有找到补丁备份（app.asar.bak-auto-pull-*），无法还原');
  process.exit(1);
}

console.log('可用备份（旧 → 新）：');
for (const b of backups) {
  const st = fs.statSync(b);
  console.log('  ' + path.basename(b) + '  ' + st.size + ' 字节  ' + st.mtime.toLocaleString());
}

if (process.argv.includes('--list')) process.exit(0);

const latest = backups[backups.length - 1];
console.log('\n将用 ' + path.basename(latest) + ' 覆盖 ' + ASAR);

const patched = ASAR + '.patched-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
if (fs.existsSync(ASAR)) {
  fs.copyFileSync(ASAR, patched);
  console.log('当前 app.asar 已另存为：' + path.basename(patched));
}
fs.copyFileSync(latest, ASAR);
console.log('已还原。请启动墨记确认可以正常打开。');
