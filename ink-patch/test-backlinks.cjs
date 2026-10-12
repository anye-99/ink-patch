// 「反向链接（Backlinks）面板」snippet 的行为单测（node:vm + 迷你 DOM，无外部依赖）
// 用法: node test-backlinks.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------- 迷你 DOM
class El {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this._listeners = {};
    this._text = '';
    this._html = '';
    this.id = '';
    this.className = '';
    this.title = '';
    this.value = '';
    this.offsetHeight = 40;
  }
  get textContent() {
    if (this.children.length) {
      return this.children.map((c) => (c.tagName === '#TEXT' ? c._text : c.textContent)).join('');
    }
    return this._text;
  }
  set textContent(v) {
    this.children.length = 0;
    this._text = String(v == null ? '' : v);
  }
  set innerHTML(v) {
    this.children.length = 0;
    this._text = '';
    this._html = String(v == null ? '' : v);
    // 粗粒度解析简单标签以支持 querySelector
    const regex = /<([a-z0-9-]+)([^>]*)>([\s\S]*?)<\/\1>|<([a-z0-9-]+)([^>]*)\/>/gi;
    let m;
    while ((m = regex.exec(this._html)) !== null) {
      const tag = m[1] || m[4];
      const attrStr = m[2] || m[5] || '';
      const child = new El(this.ownerDocument, tag);
      const clsM = /class=["']([^"']+)["']/.exec(attrStr);
      if (clsM) child.className = clsM[1];
      const idM = /id=["']([^"']+)["']/.exec(attrStr);
      if (idM) child.id = idM[1];
      const dataTabM = /data-tab=["']([^"']+)["']/.exec(attrStr);
      if (dataTabM) child.attrs['data-tab'] = dataTabM[1];
      const dataTitleM = /data-note-title=["']([^"']+)["']/.exec(attrStr);
      if (dataTitleM) child.attrs['data-note-title'] = dataTitleM[1];
      const dataIdM = /data-note-id=["']([^"']+)["']/.exec(attrStr);
      if (dataIdM) child.attrs['data-note-id'] = dataIdM[1];
      const dataActionM = /data-action=["']([^"']+)["']/.exec(attrStr);
      if (dataActionM) child.attrs['data-action'] = dataActionM[1];
      child.parentNode = this;
      if (m[3] && m[3].includes('<')) {
        child.innerHTML = m[3];
      } else {
        child.textContent = (m[3] || '').replace(/<[^>]+>/g, '');
      }
      this.children.push(child);
    }
  }
  get innerHTML() {
    return this._html || '';
  }
  appendChild(c) {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    if (k in this.attrs) return this.attrs[k];
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return null;
  }
  addEventListener(evt, fn) {
    (this._listeners[evt] = this._listeners[evt] || []).push(fn);
  }
  removeEventListener(evt, fn) {
    const arr = this._listeners[evt] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(evt) {
    evt.target = evt.target || this;
    evt.currentTarget = this;
    const fns = (this._listeners[evt.type] || []).slice();
    for (const f of fns) f.call(this, evt);
    if (!evt._stopped && this.parentNode && typeof this.parentNode.dispatchEvent === 'function') {
      this.parentNode.dispatchEvent(evt);
    }
  }
  focus() {}
  closest(sel) {
    let cur = this;
    while (cur) {
      if (matchesSel(cur, sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelector(sel) {
    return queryAll(this, sel)[0] || null;
  }
  querySelectorAll(sel) {
    return queryAll(this, sel);
  }
}

function matchesSel(el, sel) {
  if (!el || el.tagName === '#TEXT') return false;
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) {
    const cls = sel.slice(1);
    return (el.className || '').split(/\s+/).includes(cls);
  }
  if (sel.includes('[') && sel.includes('=')) {
    const m = /\[([a-z0-9-]+)=["']?([^"']+)["']?\]/i.exec(sel);
    if (m) return el.getAttribute(m[1]) === m[2];
  }
  return el.tagName === sel.toUpperCase();
}

function queryAll(root, sel) {
  const out = [];
  function walk(node) {
    for (const c of node.children) {
      if (matchesSel(c, sel)) out.push(c);
      walk(c);
    }
  }
  walk(root);
  return out;
}

class Doc {
  constructor() {
    this.head = new El(this, 'head');
    this.body = new El(this, 'body');
    this.documentElement = new El(this, 'html');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this._listeners = {};
  }
  createElement(tag) {
    return new El(this, tag);
  }
  createTextNode(text) {
    const t = new El(this, '#text');
    t._text = String(text);
    return t;
  }
  getElementById(id) {
    return this.querySelector('#' + id);
  }
  querySelector(sel) {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel) {
    return this.documentElement.querySelectorAll(sel);
  }
  addEventListener(evt, fn) {
    (this._listeners[evt] = this._listeners[evt] || []).push(fn);
  }
  removeEventListener(evt, fn) {
    const arr = this._listeners[evt] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(evt) {
    const fns = (this._listeners[evt.type] || []).slice();
    for (const f of fns) f.call(this, evt);
  }
}

// ---------------------------------------------------------------- 测试沙箱加载
function createEnv() {
  const doc = new Doc();
  const win = {
    document: doc,
    addEventListener: (evt, fn) => doc.addEventListener(evt, fn),
    removeEventListener: (evt, fn) => doc.removeEventListener(evt, fn),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    console: console,
    Map: Map,
    Set: Set,
    Promise: Promise,
    Array: Array,
    String: String,
    Math: Math,
    Date: Date,
  };

  const code = fs.readFileSync(path.join(__dirname, 'src', 'backlinks.snippet.js'), 'utf8');
  const ctx = vm.createContext({
    window: win,
    document: doc,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    console: console,
    Map: Map,
    Set: Set,
    Promise: Promise,
    Array: Array,
    String: String,
    Math: Math,
    Date: Date,
    _: null,
  });

  vm.runInContext(code, ctx);
  return { ctx, doc, win };
}

// ---------------------------------------------------------------- 测试用例
let total = 0;
let passed = 0;
let failed = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (err && err.stack ? err.stack : err));
  }
}

async function asyncTest(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (err && err.stack ? err.stack : err));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

console.log('=== 测试集 1：双链正则与摘录提取 ===');
{
  const { ctx } = createEnv();
  const api = ctx.__inkBacklinksApi;

  test('单行标准双链提取', () => {
    const text = '第一行\n参考 [[核心概念]] 的说明\n第三行';
    const exc = api.extractExcerpt(text, 8, 8, '[[核心概念]]');
    assert(exc.line === 2, '行号应为 2，实际: ' + exc.line);
    assert(exc.raw === '参考 [[核心概念]] 的说明', '摘录内容匹配');
  });

  test('长文本带省略号摘录', () => {
    const text = 'A'.repeat(80) + '[[目标笔记]]' + 'B'.repeat(80);
    const exc = api.extractExcerpt(text, 80, 8, '[[目标笔记]]');
    assert(exc.text.startsWith('…'), '前缀应带省略号');
    assert(exc.text.endsWith('…'), '后缀应带省略号');
    assert(exc.text.includes('[[目标笔记]]'), '摘录内含目标词');
  });
}

console.log('\n=== 测试集 2：核心扫描算法（已链接 + 未链接） ===');
{
  const { ctx } = createEnv();
  const api = ctx.__inkBacklinksApi;

  const targetNote = { id: 'n1', title: '深度学习' };
  const notes = [
    { id: 'n1', title: '深度学习', folderId: 'f1' },
    { id: 'n2', title: '人工智能导论', folderId: 'f1' },
    { id: 'n3', title: '机器学习实战', folderId: 'f2' },
    { id: 'n4', title: '阅读清单', folderId: null },
    { id: 'n5', title: '已废弃笔记', deletedAt: 123456 },
  ];
  const folders = [
    { id: 'f1', name: '计算机', parentId: null },
    { id: 'f2', name: '实战项目', parentId: 'f1' },
  ];
  const contents = [
    { noteId: 'n1', content: '自己引用自己 [[深度学习]] 不应计入' },
    { noteId: 'n2', content: '在第 3 章中讨论了 [[深度学习]] 的架构。\n另外也支持别名 [[深度学习|DL 框架]] 和锚点 [[深度学习#卷积网络]]。' },
    { noteId: 'n3', content: '这是一篇讨论深度学习应用的文章，但没有用双链符号。' },
    { noteId: 'n4', content: '请看示例代码：\n```python\nprint("深度学习")\n```\n这里有嵌入 ![[深度学习]]' },
    { noteId: 'n5', content: '已删除笔记引用 [[深度学习]]' },
  ];

  test('排除自身引用与已删除笔记', () => {
    const res = api.scanCore(targetNote, notes, contents, folders);
    const linkedIds = res.linked.map((x) => x.noteId);
    assert(!linkedIds.includes('n1'), '应排除自身 n1');
    assert(!linkedIds.includes('n5'), '应排除已删除笔记 n5');
  });

  test('正确提取已链接提及（含别名、锚点、嵌入）', () => {
    const res = api.scanCore(targetNote, notes, contents, folders);
    const n2 = res.linked.find((x) => x.noteId === 'n2');
    assert(n2, 'n2 应被识别为已链接');
    assert(n2.excerpts.length === 3, 'n2 应有 3 处引用，实际: ' + n2.excerpts.length);
    assert(n2.folderPath === '计算机', '目录路径应为 计算机');

    const n4 = res.linked.find((x) => x.noteId === 'n4');
    assert(n4, 'n4 应识别到嵌入 ![[深度学习]]');
  });

  test('正确提取未链接提及并忽略代码块', () => {
    const res = api.scanCore(targetNote, notes, contents, folders);
    const n3 = res.unlinked.find((x) => x.noteId === 'n3');
    assert(n3, 'n3 应被识别为未链接提及');
    assert(n3.excerpts.length === 1, 'n3 应有 1 处未链接提及');
    assert(n3.folderPath === '计算机 / 实战项目', '多级目录正确解析');

    const n4Unlinked = res.unlinked.find((x) => x.noteId === 'n4');
    assert(!n4Unlinked, 'n4 中的代码块深度学习不应作为未链接提及');
  });

  test('大小写不敏感匹配', () => {
    const engTarget = { id: 'e1', title: 'React Hooks' };
    const engNotes = [
      { id: 'e1', title: 'React Hooks' },
      { id: 'e2', title: '前端笔记' },
    ];
    const engContents = [
      { noteId: 'e2', content: '详细请见 [[react hooks|钩子函数]]' },
    ];
    const res = api.scanCore(engTarget, engNotes, engContents, []);
    assert(res.linked.length === 1, '应不区分大小写匹配到 react hooks');
  });
}

console.log('\n=== 测试集 3：DOM 交互与状态同步 ===');
(async () => {
  const { ctx, doc } = createEnv();
  const api = ctx.__inkBacklinksApi;

  // Mock Dexie 数据库
  const mockDb = {
    notes: {
      toArray: async () => [
        { id: 'n1', title: '目标笔记', folderId: null },
        { id: 'n2', title: '引用笔记', folderId: null },
      ],
      update: async () => {},
    },
    noteContent: {
      toArray: async () => [
        { noteId: 'n2', content: '这里引用了 [[目标笔记]]' },
      ],
      get: async (id) => ({ noteId: id, content: '这里包含未链接的 目标笔记 文本' }),
      put: async (item) => { mockDb.lastPut = item; },
    },
    folders: {
      toArray: async () => [],
    },
  };
  api.internals.setDb(mockDb);

  test('初始面板未创建，toggle 后打开', () => {
    assert(doc.getElementById('ink-backlinks-panel') === null, '初始无 panel');
    api.toggle(true, { id: 'n1', title: '目标笔记' });
    const p = doc.getElementById('ink-backlinks-panel');
    assert(p !== null, 'toggle 后 panel 已挂载');
    assert(p.className.includes('open'), 'panel 包含 open 类名');
    assert(api.internals.getState().open === true, '状态为 open');
  });

  await asyncTest('打开后异步渲染已链接项', async () => {
    // 等待 Promise.all 完成
    await new Promise((r) => setTimeout(r, 50));
    const cards = doc.querySelectorAll('.ink-bl-card');
    assert(cards.length === 1, '应渲染出 1 张引用卡片，实际: ' + cards.length);
    assert(doc.querySelector('.ink-bl-linked-count').textContent === '1', '计数应为 1');
  });

  test('跳转回调被正确调用', () => {
    let navigatedTo = null;
    api.sync({ id: 'n1', title: '目标笔记' }, (title) => {
      navigatedTo = title;
    });

    const cardHead = doc.querySelector('.ink-bl-card-head');
    assert(cardHead !== null, '存在卡片头部');
    cardHead.dispatchEvent({ type: 'click' });
    assert(navigatedTo === '引用笔记', '应跳转至 引用笔记，实际: ' + navigatedTo);
  });

  test('快捷键 Escape 关闭面板', () => {
    assert(api.internals.getState().open === true, '当前打开');
    doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert(api.internals.getState().open === false, 'Esc 后应关闭');
    assert(!doc.getElementById('ink-backlinks-panel').className.includes('open'), '样式已移除 open');
  });

  test('全局函数 __inkBacklinksSync 与 __inkBacklinksToggle 安全调用', () => {
    ctx.__inkBacklinksSync({ id: 'n1', title: '目标笔记' }, () => {});
    const toggled = ctx.__inkBacklinksToggle();
    assert(toggled === true, 'toggle 返回 true');
    ctx.__inkBacklinksToggle(false);
    assert(api.internals.getState().open === false, '再次关闭成功');
  });

  console.log('\n=======================================');
  console.log(`全部测试完成：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
})();
