// app.asar 补丁体检工具：确认每个补丁标记在当前 asar 里是否在位、以及是哪个版本。
// 多补丁/多会话共用同一个工程时，用它替代「凭记忆猜」。
// 用法：node tools/check-asar.cjs [--asar=<path>]
const fs = require('fs');

const args = process.argv.slice(2);
const argBase = args.find((a) => a.startsWith('--asar='));
const ASAR = argBase ? argBase.slice(7) : 'D:\\墨记笔记\\ink-notes\\resources\\app.asar';
const align4 = (n) => n + ((4 - (n % 4)) % 4);

function parseAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(12);
  const hb = Buffer.alloc(headerSize);
  fs.readSync(fd, hb, 0, headerSize, 16);
  const json = JSON.parse(hb.toString('utf8').replace(/\0+$/, ''));
  fs.closeSync(fd);
  return { json, dataStart: align4(16 + headerSize) };
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

const CHECKS = [
  {
    file: /^electron\/main\.cjs$/,
    marks: [
      ['补丁 A 自动拉取', '[auto-pull] 自动拉取补丁开始'],
      ['补丁 C 文件优先', '[fs-mirror] 「磁盘文件夹为唯一数据源」补丁开始'],
      ['AI 助手侧边栏', '[ai-assistant] AI 助手侧边栏补丁开始'],
      ['IPC ink:fs-apply', 'ink:fs-apply'],
      ['IPC ink:fs-scan', 'ink:fs-scan'],
      ['IPC ink:ai-chat', 'ink:ai-chat'],
      ['frontmatter 保护（关键）', 'function fsSplitFrontmatter'],
      ['正文比对 fsBodyEqual（关键）', 'function fsBodyEqual'],
      ['自写抑制', 'function fsIsSelfWrite'],
      ['预演 planOnly（关键）', 'if (planOnly)'],
    ],
  },
  {
    file: /^electron\/preload\.cjs$/,
    marks: [
      ['watchVault', 'ink:watch-vault'],
      ['fsApply', 'ink:fs-apply'],
      ['fsScan', 'ink:fs-scan'],
      ['fsSeed', 'ink:fs-seed'],
      ['aiChat', 'ink:ai-chat'],
    ],
  },
  {
    file: /^dist\/assets\/index-.*\.js$/,
    marks: [
      ['补丁 A 自动拉取', '__inkAutoPullInstalled'],
      ['补丁 B 导出菜单', '__inkExportMenuInstalled'],
      ['补丁 C 文件优先', '__inkFsMirrorInstalled'],
      ['C：安全闸开关', 'ink-fs-mirror-force'],
      ['C：对账标记 v3', '|v3'],
      ['C：预演 flush', 'bootstrap-plan'],
      ['C：认领函数', 'claimExistingFiles'],
      ['AI 助手', '__inkAiToggle'],
    ],
  },
];

const parsed = parseAsar(ASAR);
const entries = collect(parsed.json);
const fd = fs.openSync(ASAR, 'r');
console.log('asar: ' + ASAR);
console.log('大小: ' + fs.statSync(ASAR).size + ' 字节，文件数: ' + entries.size + '\n');

for (const c of CHECKS) {
  const keys = [...entries.keys()].filter((k) => c.file.test(k));
  if (keys.length === 0) {
    console.log('✗ 找不到匹配 ' + c.file + ' 的条目');
    continue;
  }
  for (const k of keys) {
    const e = entries.get(k);
    const buf = Buffer.alloc(e.size);
    fs.readSync(fd, buf, 0, e.size, parsed.dataStart + parseInt(e.offset, 10));
    const text = buf.toString('utf8');
    console.log(k + '（' + e.size + ' 字节）');
    for (const [label, mark] of c.marks) {
      console.log('  ' + (text.includes(mark) ? '✓' : '✗') + ' ' + label);
    }
    console.log('');
  }
}
fs.closeSync(fd);
