// 把入口 bundle 补丁（锚点替换 + 追加 snippet）应用到 preview/dist 提取副本，
// 便于在浏览器里先看效果；也可还原。
//
// 用法：
//   node tools/preview-patch.cjs --check     只校验锚点能否命中（不改文件）
//   node tools/preview-patch.cjs --apply     应用补丁（首次会先备份 *.bak-ui）
//   node tools/preview-patch.cjs --restore   从备份还原
//
// 与 pack.cjs 一致：导出按钮合并（补丁 B）在前，AI 助手（补丁 D）在后 —— 后者的工具栏锚点
// 就是前者的替换结果；两者各自按标记去重，已在位则跳过。
const fs = require('fs');
const path = require('path');
const os = require('os');
const uiPatches = require('../src/ui-patches.cjs');

const PREVIEW_ASSETS = 'D:\\墨记笔记\\preview\\dist\\assets';
const AI_MARKER = '__inkAiInstalled'; // ai-panel.snippet.js 内的顶层标记

function findBundle() {
  const list = fs.readdirSync(PREVIEW_ASSETS).filter((f) => /^index-.*\.js$/.test(f) && !f.endsWith('.bak-ui'));
  if (list.length !== 1) throw new Error('预期 1 个 index-*.js，实际 ' + list.length + '：' + list.join(', '));
  return path.join(PREVIEW_ASSETS, list[0]);
}

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--restore') ? 'restore' : 'check';
const bundlePath = findBundle();
const backupPath = bundlePath + '.bak-ui';

if (mode === 'restore') {
  if (!fs.existsSync(backupPath)) {
    console.error('没有备份可还原：' + backupPath);
    process.exit(1);
  }
  fs.copyFileSync(backupPath, bundlePath);
  console.log('已还原 ' + path.basename(bundlePath) + '（来自 ' + path.basename(backupPath) + '）');
  process.exit(0);
}

let text = fs.readFileSync(bundlePath, 'utf8');
console.log('bundle: ' + path.basename(bundlePath) + '（' + text.length + ' 字节）');
const hasExportMenu = text.includes(uiPatches.MARKER);
const hasAiPanel = text.includes(uiPatches.AI_MARKER);
const hasAiSnippet = text.includes(AI_MARKER);
console.log('已含导出菜单补丁: ' + hasExportMenu);
console.log('已含 AI 助手按钮注入: ' + hasAiPanel);
console.log('已含 AI 助手运行时: ' + hasAiSnippet);

// 1) 补丁 B：导出按钮合并
if (!hasExportMenu) {
  const result = uiPatches.applyBundlePatches(text, (m) => console.log(m));
  if (!result.ok) {
    console.error('✗ 导出按钮补丁不可应用：' + result.error);
    process.exit(1);
  }
  console.log('✓ 导出按钮补丁可应用（替换 ' + result.span.length + ' 字节）');
  text = result.text;
} else {
  console.log('· 导出按钮补丁已在位，跳过');
}

// 2) 补丁 D：AI 助手（编辑器 onCreateEditor + 工具栏「AI」按钮）
if (!hasAiPanel) {
  const result = uiPatches.applyAiPatches(text, (m) => console.log(m));
  if (!result.ok) {
    console.error('✗ AI 助手补丁不可应用：' + result.error);
    process.exit(1);
  }
  console.log('✓ AI 助手补丁可应用');
  text = result.text;
} else {
  console.log('· AI 助手按钮注入已在位，跳过');
}

// 3) 追加运行时 snippet（导出菜单 + AI 助手）
const toAppend = [];
if (!hasExportMenu) toAppend.push(fs.readFileSync(path.join(__dirname, '..', 'src', 'export-menu.snippet.js'), 'utf8'));
if (!hasAiSnippet) toAppend.push(fs.readFileSync(path.join(__dirname, '..', 'src', 'ai-panel.snippet.js'), 'utf8'));

if (mode !== 'apply') {
  console.log('\n[check] 待追加 snippet：' + (toAppend.length ? toAppend.map((s) => s.length + ' 字节').join(' + ') : '（无）'));
  console.log('[check] 未改动文件。加 --apply 应用到 preview 副本。');
  process.exit(0);
}

const out = toAppend.length ? text + '\n' + toAppend.join('\n') : text;
const syntaxCheck = path.join(os.tmpdir(), 'ink-preview-bundle-check.mjs');
fs.writeFileSync(syntaxCheck, out);
require('child_process').execFileSync(process.execPath, ['--check', syntaxCheck], { stdio: 'inherit' });
console.log('✓ 语法自检通过');

if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(bundlePath, backupPath);
  console.log('已备份 ' + path.basename(backupPath));
}
fs.writeFileSync(bundlePath, out);
console.log('已应用补丁到 ' + bundlePath + '（' + out.length + ' 字节）');
console.log('预览：node preview\\serve-dist.cjs D:\\墨记笔记\\preview\\dist 8099');
