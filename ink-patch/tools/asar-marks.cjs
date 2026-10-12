// 检查 app.asar 内三个被补丁文件的标记与大小（回答「现在到底打进了哪些补丁」）
// 用法: node tools/asar-marks.cjs
const fs = require('fs');
const path = require('path');

const ASAR = 'D:\\墨记笔记\\ink-notes\\resources\\app.asar';
const align4 = (n) => n + ((4 - (n % 4)) % 4);

function parseAsar(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(12);
  const hb = Buffer.alloc(headerSize);
  fs.readSync(fd, hb, 0, headerSize, 16);
  const json = JSON.parse(hb.toString('utf8').replace(/\0+$/, ''));
  fs.closeSync(fd);
  return { size, json, dataStart: align4(16 + headerSize) };
}

function collect(json) {
  const map = new Map();
  (function walk(node, prefix) {
    for (const [k, v] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + k : k;
      if (v.files) walk(v, p);
      else map.set(p, v);
    }
  })(json, '');
  return map;
}

const parsed = parseAsar(ASAR);
const entries = collect(parsed.json);
const fd = fs.openSync(ASAR, 'r');
function read(key) {
  const e = entries.get(key);
  if (!e) return null;
  const b = Buffer.alloc(e.size);
  fs.readSync(fd, b, 0, e.size, parsed.dataStart + parseInt(e.offset, 10));
  return b;
}

const bundleKey = [...entries.keys()].find((k) => /^dist\/assets\/index-.*\.js$/.test(k));
const bundle = read(bundleKey);
const main = read('electron/main.cjs');
const preload = read('electron/preload.cjs');
fs.closeSync(fd);

console.log('app.asar：' + ASAR);
console.log('  大小 ' + parsed.size + ' 字节，条目 ' + entries.size + '，数据区起点 ' + parsed.dataStart);
console.log('  ' + bundleKey + '：' + bundle.length + ' 字节');
console.log('  electron/main.cjs：' + (main ? main.length + ' 字节' : '缺失'));
console.log('  electron/preload.cjs：' + (preload ? preload.length + ' 字节' : '缺失'));

const marks = [
  ['A 自动拉取（bundle 运行时）', bundle, '__inkAutoPullInstalled'],
  ['B 导出菜单（bundle 运行时）', bundle, '__inkExportMenuInstalled'],
  ['B 导出按钮（JSX 替换）', bundle, '__inkExportMenu(e.currentTarget'],
  ['C 文件优先（bundle 运行时）', bundle, '__inkFsMirrorInstalled'],
  ['D AI 助手（bundle 运行时）', bundle, '__inkAiInstalled'],
  ['D AI 按钮（JSX 注入）', bundle, '__inkAiToggle'],
  ['D 编辑器注入（JSX）', bundle, 'onCreateEditor:__inkAiOnEditor'],
  ['E 反向链接（bundle 运行时）', bundle, '__inkBacklinksInstalled'],
  ['E 反链按钮（JSX 注入）', bundle, '__inkBacklinksToggle'],
  ['A 主进程', main, 'ink:watch-vault'],
  ['C 主进程', main, 'ink:fs-apply'],
  ['D 主进程', main, 'ink:ai-chat'],
  ['A 预加载', preload, 'watchVault'],
  ['C 预加载', preload, 'fsApply'],
  ['D 预加载', preload, 'getAiConfig'],
];

console.log('\n标记检查：');
let missing = 0;
for (const [label, buf, needle] of marks) {
  if (!buf) {
    console.log('  ？ ' + label + '（文件缺失）');
    missing++;
    continue;
  }
  const ok = buf.toString('utf8').includes(needle);
  if (!ok) missing++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + '  [' + needle + ']');
}
console.log('\n' + (missing === 0 ? '全部补丁在位 ✓' : '缺失 ' + missing + ' 项'));
process.exit(missing === 0 ? 0 : 1);
