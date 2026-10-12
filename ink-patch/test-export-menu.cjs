// 「导出」下拉菜单 snippet 的行为单测（node:vm + 迷你 DOM，无外部依赖）
// 用法: node test-export-menu.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------- 迷你 DOM ----------
class El {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attrs = {};
    this._listeners = {};
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.offsetHeight = 40;
    this._rect = { top: 100, bottom: 130, left: 900, right: 990, width: 90, height: 30 };
  }
  appendChild(c) {
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
  contains(n) {
    if (!n) return false;
    if (n === this) return true;
    return this.children.some((c) => c.contains(n));
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getBoundingClientRect() {
    return this._rect;
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  fire(type, ev) {
    const event = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, ev || {});
    for (const fn of (this._listeners[type] || []).slice()) fn(event);
    return event;
  }
  dispatchTo(type, ev) {
    let node = this;
    while (node) {
      for (const fn of (node._listeners[type] || []).slice()) fn(Object.assign({ type, target: this }, ev || {}));
      node = node.parentNode;
    }
  }
  collect(pred, out = []) {
    if (pred(this)) out.push(this);
    for (const c of this.children) c.collect(pred, out);
    return out;
  }
}

function setup() {
  const doc = new El(null, 'document');
  const win = new El(null, 'window');
  win.innerWidth = 1440;
  win.innerHeight = 900;
  const head = new El(doc, 'head');
  const body = new El(doc, 'body');
  doc.head = head;
  doc.body = body;
  doc.documentElement = body;
  doc.defaultView = win;
  const all = [];
  doc.createElement = (tag) => {
    if (doc.__failCreate) throw new Error('模拟 createElement 失败');
    const el = new El(doc, tag);
    all.push(el);
    return el;
  };
  doc.getElementById = (id) => all.find((e) => e.id === id && e.parentNode) || null;
  doc.__all = all;
  doc.addEventListener = El.prototype.addEventListener.bind(doc);
  doc.removeEventListener = El.prototype.removeEventListener.bind(doc);
  doc.fire = El.prototype.fire.bind(doc);
  return { doc, win, head, body };
}

function loadSnippet(ctx) {
  const src = fs.readFileSync(path.join(__dirname, 'src', 'export-menu.snippet.js'), 'utf8');
  const console_ = { warns: [], log() {}, warn(...a) { this.warns.push(a.map(String).join(' ')); } };
  const sandbox = { document: ctx.doc, window: ctx.win, console: console_ };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'export-menu.snippet.js' }).runInContext(sandbox);
  return { sandbox, menu: sandbox.__inkExportMenu, console_ };
}

// ---------- 断言 ----------
let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fails.push(name + (extra ? ' — ' + extra : ''));
    console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''));
  }
}
const itemButtons = (doc) => {
  const menu = doc.getElementById('ink-export-menu');
  if (!menu) return [];
  return menu.collect((e) => e.tagName === 'BUTTON');
};
const menuCount = (doc) => doc.__all.filter((e) => e.id === 'ink-export-menu' && e.parentNode).length;

// ---------- 用例 ----------
console.log('用例 1：点击按钮弹出菜单，含 Markdown / Word 两项');
{
  const ctx = setup();
  const { doc, win } = ctx;
  const { menu, sandbox } = loadSnippet(ctx);
  ok(sandbox.__inkExportMenuInstalled === true, 'snippet 暴露补丁标记');

  const anchor = doc.createElement('button');
  doc.body.appendChild(anchor);
  const note = { id: 'n1', title: '第1章 绪论', content: '正文' };
  const calls = [];
  menu(anchor, note, (n) => calls.push(['md', n]), (n) => calls.push(['word', n]));

  ok(menuCount(doc) === 1, '菜单已挂载且只有一个');
  const items = itemButtons(doc);
  ok(items.length === 2, '菜单含 2 个选项', '实际 ' + items.length);
  const texts = items.map((b) => b.children.map((c) => c.textContent).join(' '));
  ok(texts[0].includes('Markdown') && texts[0].includes('.md'), '第一项是 Markdown', texts[0]);
  ok(texts[1].includes('Word') && texts[1].includes('.docx'), '第二项是 Word', texts[1]);
  ok(doc.getElementById('ink-export-menu-style') !== null, '样式只注入一次（<style> 已挂载）');

  // 锚点定位：按钮右边缘对齐，且在按钮下方
  const m = doc.getElementById('ink-export-menu');
  ok(parseInt(m.style.left, 10) === anchor.getBoundingClientRect().right - 196, '菜单右对齐按钮', m.style.left);
  ok(parseInt(m.style.top, 10) === anchor.getBoundingClientRect().bottom + 6, '菜单在按钮下方 6px', m.style.top);
  ok(calls.length === 0, '仅弹出菜单不触发导出');

  console.log('用例 2：再次点击同一按钮收起');
  menu(anchor, note, () => {}, () => {});
  ok(menuCount(doc) === 0, '菜单已收起');

  console.log('用例 3：打开状态下点另一个按钮 → 换锚点重开，不残留');
  const anchor2 = doc.createElement('button');
  doc.body.appendChild(anchor2);
  menu(anchor, note, () => {}, () => {});
  menu(anchor2, note, () => {}, () => {});
  ok(menuCount(doc) === 1, '仍然只有一个菜单');
  ok(doc.getElementById('ink-export-menu').__inkAnchor === anchor2, '菜单绑定到新锚点');

  console.log('用例 4：点击选项 → 调用对应导出并关闭菜单');
  {
    const c2 = [];
    doc.fire('keydown', { key: 'Escape' }); // 先收掉用例 3 留下的菜单
    menu(anchor2, note, (n) => c2.push(['md', n]), (n) => c2.push(['word', n]));
    itemButtons(doc)[0].dispatchTo('click');
    ok(c2.length === 1 && c2[0][0] === 'md', 'Markdown 回调被调用一次');
    ok(c2[0][1] === note, '回调收到笔记对象（含最新 title/content）');
    ok(menuCount(doc) === 0, '选择后菜单关闭');

    menu(anchor2, note, (n) => c2.push(['md', n]), (n) => c2.push(['word', n]));
    itemButtons(doc)[1].dispatchTo('click');
    ok(c2.length === 2 && c2[1][0] === 'word', 'Word 回调被调用一次');
    ok(menuCount(doc) === 0, '选择后菜单关闭');
  }

  console.log('用例 5：点击外部关闭；点击锚点内部（图标/文字）不关闭');
  menu(anchor, note, () => {}, () => {});
  const inside = doc.createElement('span');
  anchor.appendChild(inside);
  doc.fire('mousedown', { target: inside });
  ok(menuCount(doc) === 1, '点击按钮内部元素不关闭');
  const outside = doc.createElement('div');
  doc.body.appendChild(outside);
  doc.fire('mousedown', { target: outside });
  ok(menuCount(doc) === 0, '点击外部关闭');

  console.log('用例 6：Esc 关闭；关闭后监听已清理');
  menu(anchor, note, () => {}, () => {});
  doc.fire('keydown', { key: 'Escape' });
  ok(menuCount(doc) === 0, 'Esc 关闭菜单');
  const before = (doc._listeners.mousedown || []).length;
  menu(anchor, note, () => {}, () => {});
  const during = (doc._listeners.mousedown || []).length;
  doc.fire('keydown', { key: 'Escape' });
  const after = (doc._listeners.mousedown || []).length;
  ok(during === before + 1 && after === before, '事件监听随开关成对增删', `${before}/${during}/${after}`);

  console.log('用例 7：窗口 resize 关闭');
  menu(anchor, note, () => {}, () => {});
  win.fire('resize');
  ok(menuCount(doc) === 0, 'resize 关闭菜单');
}

console.log('用例 8：导出回调异常不影响菜单关闭与主流程');
{
  const ctx = setup();
  const { doc } = ctx;
  const { menu, console_ } = loadSnippet(ctx);
  const anchor = doc.createElement('button');
  doc.body.appendChild(anchor);
  const note = { id: 'n2' };

  menu(anchor, note, () => { throw new Error('md boom'); }, () => {});
  itemButtons(doc)[0].dispatchTo('click');
  ok(menuCount(doc) === 0, '同步异常后菜单仍关闭');
  ok(console_.warns.some((w) => w.includes('导出失败')), '同步异常被记录为警告');

  menu(anchor, note, () => {}, () => Promise.reject(new Error('word boom')));
  itemButtons(doc)[1].dispatchTo('click');
  ok(menuCount(doc) === 0, 'Promise 拒绝后菜单仍关闭');

  menu(anchor, note, undefined, undefined);
  let threw = null;
  try {
    itemButtons(doc)[0].dispatchTo('click');
  } catch (e) {
    threw = e;
  }
  ok(threw === null, '回掉为 undefined 时也不抛出');
}

console.log('用例 9：菜单创建失败 → 回退为直接导出 Markdown');
{
  const ctx = setup();
  const { doc } = ctx;
  const { menu, console_ } = loadSnippet(ctx);
  const anchor = doc.createElement('button');
  doc.body.appendChild(anchor);
  const calls = [];
  doc.__failCreate = true;
  menu(anchor, { id: 'n3' }, (n) => calls.push(n), () => calls.push('word'));
  ok(calls.length === 1 && calls[0].id === 'n3', '回退直接导出 Markdown');
  ok(console_.warns.some((w) => w.includes('导出菜单创建失败')), '记录了回退原因');
}

console.log('用例 10：重复调用不产生重复 <style>');
{
  const ctx = setup();
  const { doc } = ctx;
  const { menu } = loadSnippet(ctx);
  const anchor = doc.createElement('button');
  doc.body.appendChild(anchor);
  for (let i = 0; i < 3; i++) {
    menu(anchor, {}, () => {}, () => {});
    doc.getElementById('ink-export-menu').__inkClose();
  }
  const styles = doc.__all.filter((e) => e.id === 'ink-export-menu-style' && e.parentNode);
  ok(styles.length === 1, '<style> 仅一份', String(styles.length));
}

(async () => {
  await new Promise((r) => setTimeout(r, 20));
  console.log('\n结果：通过 ' + pass + '，失败 ' + fails.length);
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
})();
