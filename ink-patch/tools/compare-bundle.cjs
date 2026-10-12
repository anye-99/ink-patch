// 比对 asar 内的入口 bundle 与 preview/dist 提取副本是否逐字节一致
// 用法: node tools/compare-bundle.cjs
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ASAR = 'D:\\墨记笔记\\ink-notes\\resources\\app.asar';
const PREVIEW = 'D:\\墨记笔记\\preview\\dist\\assets';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const align4 = (n) => n + ((4 - (n % 4)) % 4);

function parseAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(12);
  const hb = Buffer.alloc(headerSize);
  fs.readSync(fd, hb, 0, headerSize, 16);
  const json = JSON.parse(hb.toString('utf8').replace(/\0+$/, ''));
  return { json, dataStart: align4(16 + headerSize), fd, size: fs.fstatSync(fd).size };
}

const p = parseAsar(ASAR);
const map = new Map();
(function walk(node, prefix) {
  for (const [k, v] of Object.entries(node.files || {})) {
    const q = prefix ? prefix + '/' + k : k;
    if (v.files) walk(v, q);
    else map.set(q, v);
  }
})(p.json, '');

const targets = [...map.keys()].filter((k) => /^dist\/assets\/index-.*\.(js|css)$/.test(k));
console.log('asar 大小 ' + p.size + '，条目 ' + map.size);
for (const key of targets) {
  const e = map.get(key);
  const buf = Buffer.alloc(e.size);
  fs.readSync(p.fd, buf, 0, e.size, p.dataStart + parseInt(e.offset, 10));
  const localPath = path.join(PREVIEW, path.basename(key));
  const exists = fs.existsSync(localPath);
  const local = exists ? fs.readFileSync(localPath) : null;
  console.log('\n' + key);
  console.log('  asar   : ' + e.size + ' 字节  ' + sha(buf));
  console.log('  preview: ' + (exists ? local.length + ' 字节  ' + sha(local) : '(缺失)'));
  console.log('  一致   : ' + (exists && sha(buf) === sha(local)));
  if (key.endsWith('.js')) {
    const t = buf.toString('utf8');
    console.log('  含自动拉取补丁: ' + t.includes('__inkAutoPullInstalled'));
    console.log('  含导出菜单补丁: ' + t.includes('__inkExportMenuInstalled'));
  }
}
fs.closeSync(p.fd);
