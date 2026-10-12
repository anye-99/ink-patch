// [ink-patch v2] 入口 bundle 的 UI 文本补丁
//
// 目标：把编辑器工具栏右侧的「导出 MD」「导出 Word」两个按钮，
// 改成单个「导出」按钮（点击弹出下拉菜单，见 src/export-menu.snippet.js）。
//
// 实现说明：
//   bundle 是压缩产物，一整行、无 JSX 语法。这里**不抄写**整段原文（易抄错），
//   而是用一对短锚点定位区间并整段替换：
//     start: 第一个按钮的开头（含 title 文案，唯一）
//     end:   第二个按钮的 children 收尾
//   替换前会验证区间内确实包含「导出 MD」「导出 Word」两个文案，且长度合理。
//   行不通时明确报错中止，绝不静默产出坏 bundle。

const START_ANCHOR = '(0,A.jsxs)(`button`,{className:`tool-btn`,title:`导出为 Markdown 文件`';
const END_ANCHOR = 'children:`导出 Word`})]})';

const REPLACEMENT =
  '(0,A.jsxs)(`button`,{className:`tool-btn`,title:`导出当前笔记（Markdown / Word）`,' +
  'onClick:e=>__inkExportMenu(e.currentTarget,ye,E,ee),' +
  'children:[(0,A.jsx)(Ze,{size:13}),(0,A.jsx)(`span`,{className:`btn-label`,children:`导出`})]})';

const MARKER = '__inkExportMenuInstalled';
const MAX_SPAN = 1000;

function countOf(hay, needle) {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** 定位被替换的区间 [start, end)，返回 null 表示定位失败（并给出原因）。 */
function locate(text) {
  const n = countOf(text, START_ANCHOR);
  if (n !== 1) return { error: `起始锚点命中 ${n} 次（预期 1 次），墨记版本可能已变化` };
  const start = text.indexOf(START_ANCHOR);
  const endStart = text.indexOf(END_ANCHOR, start + START_ANCHOR.length);
  if (endStart < 0) return { error: '未找到结束锚点（导出 Word 按钮收尾）' };
  const end = endStart + END_ANCHOR.length;
  const span = text.slice(start, end);
  if (span.length > MAX_SPAN) return { error: `区间长度异常（${span.length} 字节 > ${MAX_SPAN}）` };
  for (const must of ['导出 MD', '导出 Word', 'onClick:()=>E(ye)', 'onClick:()=>void ee(ye)']) {
    if (!span.includes(must)) return { error: `区间内缺少预期片段：${must}` };
  }
  return { start, end, span };
}

/**
 * 对 bundle 文本应用 UI 补丁。
 * @param {string} text bundle 源码文本
 * @param {(msg:string)=>void} [log]
 * @returns {{ok:true, text:string, span:string} | {ok:false, error:string}}
 */
function applyBundlePatches(text, log) {
  const say = typeof log === 'function' ? log : () => {};
  if (text.includes(MARKER)) return { ok: false, error: '已包含导出菜单补丁标记（' + MARKER + '），请勿重复打补丁' };
  const at = locate(text);
  if (at.error) return { ok: false, error: at.error };
  const out = text.slice(0, at.start) + REPLACEMENT + text.slice(at.end);
  say('  导出按钮合并：替换 ' + at.span.length + ' 字节 → ' + REPLACEMENT.length + ' 字节');
  // 替换后自检：新文本里不该再有「导出为 Markdown 文件」按钮，且必须出现调用点
  if (!out.includes('__inkExportMenu(e.currentTarget,ye,E,ee)')) {
    return { ok: false, error: '替换结果缺少 __inkExportMenu 调用点' };
  }
  if (countOf(out, START_ANCHOR) !== 0) {
    return { ok: false, error: '替换后仍能匹配到原始按钮锚点' };
  }
  return { ok: true, text: out, span: at.span };
}

// ===== 补丁 C：AI 助手侧边栏 =====
//
// 两处注入，都只动入口 bundle：
//   1) 编辑器 JSX 加 onCreateEditor:__inkAiOnEditor —— 拿到 @uiw/react-codemirror 的 EditorView
//      （官方 prop，见 bundle 内 $b 属性白名单；拿不到时 snippet 还会用 .cm-content 的 cmView 兜底）
//   2) 工具栏「导出」按钮后加一个「AI」按钮，onClick 调 __inkAiToggle()
//      这里的锚点就是补丁 B 的替换结果，因此补丁 C 必须在补丁 B 之后应用。
const AI_MARKER = '__inkAiToggle';
const CM_ANCHOR = '(0,A.jsx)(ex,{ref:r,value:e,onChange:t,';
const CM_REPLACEMENT = '(0,A.jsx)(ex,{ref:r,onCreateEditor:__inkAiOnEditor,value:e,onChange:t,';
const AI_BUTTON_JSX =
  ',(0,A.jsxs)(`button`,{className:`tool-btn ink-ai-toolbar-btn`,title:`AI 助手（Ctrl+Shift+A）`,' +
  'onClick:()=>__inkAiToggle(),children:[(0,A.jsx)(`span`,{className:`btn-label`,children:`AI`})]})';

function applyAiPatches(text, log) {
  const say = typeof log === 'function' ? log : () => {};
  if (text.includes(AI_MARKER)) {
    return { ok: false, error: '已包含 AI 助手补丁标记（' + AI_MARKER + '），请勿重复打补丁' };
  }
  const n1 = countOf(text, CM_ANCHOR);
  if (n1 !== 1) return { ok: false, error: `编辑器锚点命中 ${n1} 次（预期 1 次），墨记版本可能已变化` };
  let out = text.split(CM_ANCHOR).join(CM_REPLACEMENT);
  if (!out.includes('onCreateEditor:__inkAiOnEditor,value:e,onChange:t,')) {
    return { ok: false, error: '编辑器注入结果缺少 onCreateEditor' };
  }

  const n2 = countOf(out, REPLACEMENT);
  if (n2 !== 1) {
    return { ok: false, error: `工具栏锚点命中 ${n2} 次（预期 1 次；补丁 C 依赖补丁 B 的导出按钮）` };
  }
  out = out.split(REPLACEMENT).join(REPLACEMENT + AI_BUTTON_JSX);
  if (countOf(out, 'onClick:()=>__inkAiToggle()') !== 1) {
    return { ok: false, error: '工具栏注入结果缺少 __inkAiToggle 调用点' };
  }
  if (countOf(out, CM_ANCHOR) !== 0) {
    return { ok: false, error: '替换后仍能匹配到编辑器原始锚点' };
  }
  say('  AI 助手：编辑器 onCreateEditor 注入 + 工具栏「AI」按钮注入');
  return { ok: true, text: out };
}

// ===== 补丁 E：反向链接（Backlinks）面板 =====
const BACKLINKS_MARKER = '__inkBacklinksToggle';
const BACKLINKS_BUTTON_JSX =
  ',(__inkBacklinksSync(ye,l),(0,A.jsxs)(`button`,{className:`tool-btn ink-backlinks-toolbar-btn`,title:`反向链接（Ctrl+Shift+B）`,' +
  'onClick:()=>__inkBacklinksToggle(ye,l),children:[(0,A.jsx)(`span`,{className:`btn-label`,children:`反链`})]}))';

function applyBacklinksPatches(text, log) {
  const say = typeof log === 'function' ? log : () => {};
  if (text.includes(BACKLINKS_MARKER)) {
    return { ok: false, error: '已包含反向链接补丁标记（' + BACKLINKS_MARKER + '），请勿重复打补丁' };
  }
  const n = countOf(text, REPLACEMENT);
  if (n !== 1) {
    return { ok: false, error: `工具栏锚点命中 ${n} 次（预期 1 次；反向链接补丁依赖导出按钮）` };
  }
  const out = text.split(REPLACEMENT).join(REPLACEMENT + BACKLINKS_BUTTON_JSX);
  if (countOf(out, 'onClick:()=>__inkBacklinksToggle(ye,l)') !== 1) {
    return { ok: false, error: '工具栏注入结果缺少 __inkBacklinksToggle 调用点' };
  }
  say('  反向链接：工具栏「反链」按钮与实时同步钩子注入');
  return { ok: true, text: out };
}

module.exports = {
  applyBundlePatches,
  MARKER,
  START_ANCHOR,
  END_ANCHOR,
  REPLACEMENT,
  applyAiPatches,
  AI_MARKER,
  CM_ANCHOR,
  CM_REPLACEMENT,
  AI_BUTTON_JSX,
  applyBacklinksPatches,
  BACKLINKS_MARKER,
  BACKLINKS_BUTTON_JSX,
};
