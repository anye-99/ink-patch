// 墨记 InkNotes asar 补丁打包工具（v1）
// 用法：
//   node pack.cjs --dry-run    仅生成并自检，不替换（默认）
//   node pack.cjs --apply      备份原 app.asar 后用补丁版替换
// 安全性：
//   - 只改动 3 个文件（electron/main.cjs、electron/preload.cjs、dist/assets/index-*.js）
//   - 未修改文件的数据区逐字节保留，offset 不变
//   - 生成后先全量自检（integrity + 抽样字节比对），通过才替换
//   - 替换前把原 asar 备份为 app.asar.bak-auto-pull-<时间戳>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ASAR = 'D:\\墨记笔记\\ink-notes\\resources\\app.asar';
const SRC = path.join(__dirname, 'src');
const APPLY = process.argv.includes('--apply');
const align4 = (n) => n + ((4 - (n % 4)) % 4);
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ts = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

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
  return { size, headerSize, json, dataStart: align4(16 + headerSize) };
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

function readEntry(fd, dataStart, asarPath, p, e) {
  if (e.unpacked) return fs.readFileSync(path.join(asarPath + '.unpacked', ...p.split('/')));
  const b = Buffer.alloc(e.size);
  fs.readSync(fd, b, 0, e.size, dataStart + parseInt(e.offset, 10));
  return b;
}

// 基线选择：只要存在「干净的官方原版备份」，就从它重建全部补丁。
// 为什么必须这样：按标记跳过（「已在位就不重打」）会让补丁**无法升级到新版本**——
// 实测踩过：改完 snippet 重新打包，因为标记还在，asar 里留着的仍是旧版逻辑。
const BASE_ARG = (process.argv.find((a) => a.startsWith('--base=')) || '').slice(7);

function findCleanBaseline() {
  const dir = path.dirname(ASAR);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^app\.asar\.bak-auto-pull-\d+$/.test(n)).sort();
  } catch {
    return null;
  }
  const markers = [
    '__inkAutoPullInstalled',
    '__inkExportMenuInstalled',
    '__inkFsMirrorInstalled',
    '__inkAiToggle',
    '__inkBacklinksToggle',
  ];
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      const pr = parseAsar(p);
      const pe = collect(pr.json);
      const bk = [...pe.keys()].find((k) => /^dist\/assets\/index-.*\.js$/.test(k));
      if (!bk) continue;
      const e = pe.get(bk);
      const f = fs.openSync(p, 'r');
      const buf = Buffer.alloc(e.size);
      fs.readSync(f, buf, 0, e.size, pr.dataStart + parseInt(e.offset, 10));
      fs.closeSync(f);
      if (!markers.some((m) => buf.toString('utf8').includes(m))) return p;
    } catch {
      /* 坏备份：跳过 */
    }
  }
  return null;
}

console.log('=== 1. 解析 app.asar ===');
if (!fs.existsSync(ASAR)) {
  console.error('找不到 app.asar：' + ASAR);
  process.exit(1);
}
const BASELINE = BASE_ARG || findCleanBaseline() || ASAR;
console.log(
  '  基线：' +
    BASELINE +
    (BASELINE === ASAR ? '（当前 asar；未找到干净的官方备份，将按标记增量打补丁）' : '（干净基线：从官方原版重建全部补丁）')
);
const parsed = parseAsar(BASELINE);
const entries = collect(parsed.json);
console.log('文件数 ' + entries.size + '，数据区起点 ' + parsed.dataStart + '，总大小 ' + parsed.size);

const fd = fs.openSync(BASELINE, 'r');
const dataRegion = Buffer.alloc(parsed.size - parsed.dataStart);
fs.readSync(fd, dataRegion, 0, dataRegion.length, parsed.dataStart);

// 目标 bundle（dist/assets/index-<hash>.js）
const bundles = [...entries.keys()].filter((k) => /^dist\/assets\/index-.*\.js$/.test(k));
if (bundles.length !== 1) {
  console.error('预期恰好 1 个 index-*.js，实际 ' + bundles.length + '：' + bundles.join(', '));
  process.exit(1);
}
const bundleKey = bundles[0];
const bundleSource = readEntry(fd, parsed.dataStart, BASELINE, bundleKey, entries.get(bundleKey));
fs.closeSync(fd);
console.log('入口 bundle：' + bundleKey + '（' + bundleSource.length + ' 字节）');

console.log('\n=== 2. 校验注入前提 ===');
const bundleText = bundleSource.toString('utf8');
const uiPatches = require('./src/ui-patches.cjs');

// 本工具可重复运行：自动拉取补丁已在位时只补 UI 层，避免把 main/preload 再塞一遍
const hasAutoPull = bundleText.includes('__inkAutoPullInstalled');
const hasFsMirror = bundleText.includes('__inkFsMirrorInstalled');
const hasUiPatch = bundleText.includes(uiPatches.MARKER);
const hasAiPanel = bundleText.includes(uiPatches.AI_MARKER);
const hasBacklinks = bundleText.includes(uiPatches.BACKLINKS_MARKER);
console.log('  导出按钮合并补丁已在位：' + (hasUiPatch ? '是（本轮跳过）' : '否（本轮应用）'));
console.log('  AI 助手补丁已在位：' + (hasAiPanel ? '是（本轮跳过）' : '否（本轮应用）'));
console.log('  反向链接补丁已在位：' + (hasBacklinks ? '是（本轮跳过）' : '否（本轮应用）'));
console.log('  自动拉取补丁已在位：' + (hasAutoPull ? '是（本轮只补 UI 层）' : '否（本轮同时补自动拉取）'));
console.log('  文件优先补丁已在位：' + (hasFsMirror ? '是（本轮跳过）' : '否（本轮追加）'));
const required = [
  ['读目录 NG()', /function NG\(\)/],
  ['开关 FG()', /function FG\(\)/],
  ['增量合并 LG()', /function LG\(/],
  ['全量拉取 RG()', /function RG\(/],
  // 文件优先补丁把 Dexie 表钩子挂在 index chunk 导入的实例上，绑定的本地名必须是 _
  ['Dexie 实例绑定（T as _）', /[,{]T as _[,}]/],
];
let missing = 0;
for (const [label, re] of required) {
  const ok = re.test(bundleText);
  console.log('  ' + (ok ? '✓' : '✗') + ' 官方函数存在：' + label);
  if (!ok) missing++;
}
if (missing > 0) {
  console.error('官方函数缺失，可能墨记版本已变化，补丁中止（请重新定位注入点）');
  process.exit(1);
}

console.log('\n=== 3. 构造补丁文件 ===');
const snippet = fs.readFileSync(path.join(SRC, 'auto-pull.snippet.js'), 'utf8');
const exportMenuSnippet = fs.readFileSync(path.join(SRC, 'export-menu.snippet.js'), 'utf8');
const fsMirrorSnippet = fs.readFileSync(path.join(SRC, 'fs-mirror.snippet.js'), 'utf8');
const aiPanelSnippet = fs.readFileSync(path.join(SRC, 'ai-panel.snippet.js'), 'utf8');
const backlinksSnippet = fs.readFileSync(path.join(SRC, 'backlinks.snippet.js'), 'utf8');
const newMain = fs.readFileSync(path.join(SRC, 'electron-main.cjs'));
const newPreload = fs.readFileSync(path.join(SRC, 'electron-preload.cjs'));
for (const s of ['[auto-pull]', 'ink:watch-vault', '[fs-mirror]', 'ink:fs-apply', '[ai-assistant]', 'ink:ai-chat']) {
  if (!newMain.toString('utf8').includes(s)) {
    console.error('electron-main.cjs 缺少标记 ' + s);
    process.exit(1);
  }
}

// 3a. UI 文本补丁：两个导出按钮 → 一个「导出」按钮（点击弹菜单）；已在位则跳过
let uiText = bundleText;
if (!hasUiPatch) {
  const uiResult = uiPatches.applyBundlePatches(uiText, (m) => console.log(m));
  if (!uiResult.ok) {
    console.error('UI 补丁不可应用：' + uiResult.error);
    process.exit(1);
  }
  uiText = uiResult.text;
}
// 3a2. AI 助手补丁：编辑器 onCreateEditor 注入 + 工具栏「AI」按钮。
// 它的工具栏锚点就是上一步的导出按钮，因此必须排在 applyBundlePatches 之后。
if (!hasAiPanel) {
  const aiResult = uiPatches.applyAiPatches(uiText, (m) => console.log(m));
  if (!aiResult.ok) {
    console.error('AI 助手补丁不可应用：' + aiResult.error);
    process.exit(1);
  }
  uiText = aiResult.text;
}
// 3a3. 反向链接补丁：工具栏「反链」按钮注入
if (!hasBacklinks) {
  const blResult = uiPatches.applyBacklinksPatches(uiText, (m) => console.log(m));
  if (!blResult.ok) {
    console.error('反向链接补丁不可应用：' + blResult.error);
    process.exit(1);
  }
  uiText = blResult.text;
}
// 3b. 追加运行时代码（自动拉取 / 导出菜单 / 文件优先 / AI 助手 / 反向链接，各自按自身标记去重）
const appended =
  (hasAutoPull ? '' : snippet + '\n') +
  (hasUiPatch ? '' : exportMenuSnippet) +
  (hasFsMirror ? '' : fsMirrorSnippet) +
  (hasAiPanel ? '' : aiPanelSnippet) +
  (hasBacklinks ? '' : backlinksSnippet);
const newBundle = Buffer.concat([Buffer.from(uiText, 'utf8'), Buffer.from('\n' + appended, 'utf8')]);
console.log('  入口 bundle：' + bundleSource.length + ' → ' + newBundle.length + ' 字节');

// 主进程/预加载脚本始终用源文件的最新版替换：它们由本项目自己维护（含补丁 A + 补丁 C），
// 无条件替换才能保证「已经打过补丁 A 的 asar」也能补上补丁 C。
const replacements = [
  { key: 'electron/main.cjs', buf: newMain },
  { key: 'electron/preload.cjs', buf: newPreload },
  { key: bundleKey, buf: newBundle },
];

for (const r of replacements) {
  const e = entries.get(r.key);
  if (!e) {
    console.error('asar 中找不到 ' + r.key);
    process.exit(1);
  }
  console.log('  ' + r.key + '：' + e.size + ' → ' + r.buf.length + ' 字节');
}

// 布局：未修改文件保持原 offset；修改文件追加到数据区末尾（原地回收旧内容不值得，浪费几 MB）
let cursor = dataRegion.length;
for (const r of replacements) {
  cursor = align4(cursor);
  const e = entries.get(r.key);
  delete e.unpacked;
  e.size = r.buf.length;
  e.offset = String(cursor);
  const h = sha256hex(r.buf);
  e.integrity = { algorithm: 'SHA256', hash: h, blockSize: 4194304, blocks: [h] };
  r.offset = cursor;
  cursor += r.buf.length;
}

console.log('\n=== 3.5 语法自检（语法错误会让墨记白屏，必须先过） ===');
{
  const { execFileSync } = require('child_process');
  const os = require('os');
  const syntaxCheck = (label, file) => {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      console.log('  ✓ 语法通过：' + label);
      return true;
    } catch (err) {
      console.error('  ✗ 语法错误：' + label);
      console.error(String((err.stderr || Buffer.from('')).toString('utf8')).slice(0, 1500));
      return false;
    }
  };
  const bundleCheckPath = path.join(os.tmpdir(), 'ink-bundle-check.mjs');
  fs.writeFileSync(bundleCheckPath, newBundle);
  let syntaxOk = true;
  if (!syntaxCheck('入口 bundle（ESM，含补丁）', bundleCheckPath)) syntaxOk = false;
  if (!syntaxCheck('electron/main.cjs', path.join(SRC, 'electron-main.cjs'))) syntaxOk = false;
  if (!syntaxCheck('electron/preload.cjs', path.join(SRC, 'electron-preload.cjs'))) syntaxOk = false;
  if (!syntaxOk) {
    console.error('语法自检未通过，已中止（未改动 app.asar）');
    process.exit(1);
  }
}

console.log('\n=== 4. 写出新 asar（临时文件） ===');
const jsonBuf = Buffer.from(JSON.stringify(parsed.json), 'utf8');
const padLen = align4(jsonBuf.length) - jsonBuf.length;
const headBuf = Buffer.alloc(16);
headBuf.writeUInt32LE(4, 0);
headBuf.writeUInt32LE(align4(jsonBuf.length) + 8, 4);
headBuf.writeUInt32LE(align4(jsonBuf.length) + 4, 8);
headBuf.writeUInt32LE(jsonBuf.length, 12);

const chunks = [headBuf, jsonBuf, Buffer.alloc(padLen), dataRegion];
let written = dataRegion.length;
for (const r of replacements) {
  const gap = r.offset - written;
  if (gap > 0) {
    chunks.push(Buffer.alloc(gap));
    written += gap;
  }
  chunks.push(r.buf);
  written += r.buf.length;
}
const output = Buffer.concat(chunks);
const tmpPath = ASAR + '.new';
fs.writeFileSync(tmpPath, output);
console.log('  临时文件 ' + tmpPath + '（' + output.length + ' 字节）');

console.log('\n=== 5. 自检 ===');
const check = parseAsar(tmpPath);
const checkEntries = collect(check.json);
const fd2 = fs.openSync(tmpPath, 'r');
let okCount = 0;
let badCount = 0;
const badList = [];
for (const [p, e] of checkEntries) {
  if (e.unpacked || !e.integrity || !e.integrity.hash) continue;
  if (e.size > (e.integrity.blockSize || 4194304)) continue; // 多块大文件按原样保留，跳过
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd2, buf, 0, e.size, check.dataStart + parseInt(e.offset, 10));
  if (sha256hex(buf) === e.integrity.hash) okCount++;
  else {
    badCount++;
    badList.push(p);
  }
}
console.log('  integrity 校验：通过 ' + okCount + '，失败 ' + badCount + (badList.length ? '（' + badList.slice(0, 5).join(', ') + '）' : ''));

// 替换文件内容比对
for (const r of replacements) {
  const e = checkEntries.get(r.key);
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd2, buf, 0, e.size, check.dataStart + parseInt(e.offset, 10));
  const same = Buffer.compare(buf, r.buf) === 0;
  console.log('  ' + (same ? '✓' : '✗') + ' 内容一致：' + r.key);
  if (!same) badCount++;
}

// 未修改文件抽样与原 asar 比对
const untouched = [...entries.keys()].filter((k) => !replacements.some((r) => r.key === k) && !entries.get(k).unpacked && entries.get(k).integrity);
const sample = untouched.filter((_, i) => i % Math.max(1, Math.floor(untouched.length / 30)) === 0).slice(0, 30);
const fdOld = fs.openSync(BASELINE, 'r');
let sampleDiff = 0;
for (const k of sample) {
  const e = entries.get(k);
  const a = Buffer.alloc(e.size);
  fs.readSync(fdOld, a, 0, e.size, parsed.dataStart + parseInt(e.offset, 10));
  const e2 = checkEntries.get(k);
  const b = Buffer.alloc(e2.size);
  fs.readSync(fd2, b, 0, e2.size, check.dataStart + parseInt(e2.offset, 10));
  if (Buffer.compare(a, b) !== 0) {
    sampleDiff++;
    console.log('  ✗ 未修改文件不一致：' + k);
  }
}
fs.closeSync(fdOld);
fs.closeSync(fd2);
console.log('  未修改文件抽样比对：' + sample.length + ' 个，不一致 ' + sampleDiff + ' 个');

if (badCount > 0 || sampleDiff > 0) {
  console.error('\n自检未通过，已放弃替换（临时文件保留：' + tmpPath + '）');
  process.exit(1);
}
console.log('  自检通过 ✓');

if (!APPLY) {
  console.log('\n[dry-run] 未替换 app.asar。确认无误后运行：node pack.cjs --apply');
  process.exit(0);
}

console.log('\n=== 6. 备份并替换 ===');
const backup = ASAR + '.bak-auto-pull-' + ts();
fs.copyFileSync(ASAR, backup);
console.log('  已备份：' + backup);
try {
  fs.renameSync(tmpPath, ASAR);
} catch (err) {
  console.error('  替换失败（墨记可能在运行中，请先完全退出墨记）：' + err.message);
  process.exit(1);
}
console.log('  已替换：' + ASAR);
console.log('\n完成。请启动墨记 InkNotes 确认工具栏为单个「导出」按钮。');
console.log('  自动拉取日志：%APPDATA%\\ink-notes\\auto-pull.log');
console.log('  回退：node restore.cjs    （还原到本次替换前的备份）');
