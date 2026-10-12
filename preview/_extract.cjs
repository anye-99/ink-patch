// 从 app.asar 提取文件头（只提取 dist 与 electron + package.json，跳过 node_modules）
const fs = require('fs');
const path = require('path');

const ASAR = path.resolve(__dirname, '..', 'ink-notes', 'resources', 'app.asar');
const OUT = __dirname;

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const hb = Buffer.alloc(headerSize);
fs.readSync(fd, hb, 0, headerSize, 16);
const json = JSON.parse(hb.toString('utf8').replace(/^(