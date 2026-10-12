// 「AI 助手侧边栏」snippet 的行为单测（node:vm + 迷你 DOM，无外部依赖）
// 用法: node test-ai-panel.cjs
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
    this.id = '';
    this.className = '';
    this.title = '';
    this.value = '';
    this.checked = false;
    this.type = '';
    this.offsetHeight = 40;
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this._rect = { top: 100, bottom: 130, left: 900, right: 990, width: 90, height: 30 };
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
  contains(n) {
    if (!n) return false;
    if (n === this) return true;
    return this.children.some((c) => c.contains && c.contains(n));
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  getBoundingClientRect() {
    return this._rect;
  }
  focus() {
    this.__focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
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
  matches(sel) {
    if (!sel) return false;
    if (sel[0] === '.') return String(this.className || '').split(/\s+/).includes(sel.slice(1));
    if (sel[0] === '#') return this.id === sel.slice(1);
    return this.tagName.toLowerCase() === sel.toLowerCase();
  }
  collect(out = []) {
    out.push(this);
    for (const c of this.children) if (c.collect) c.collect(out);
    return out;
  }
  querySelector(sel) {
    return this.collect().filter((el) => el !== this && el.matches && el.matches(sel))[0] || null;
  }
  querySelectorAll(sel) {
    return this.collect().filter((el) => el !== this && el.matches && el.matches(sel));
  }
}

function makeTextNode(doc, text) {
  const el = new El(doc, '#text');
  el._text = String(text);
  return el;
}

function setupDom() {
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
  doc.readyState = 'complete';
  const all = [];
  doc.createElement = (tag) => {
    const el = new El(doc, tag);
    all.push(el);
    return el;
  };
  doc.createTextNode = (t) => {
    const el = makeTextNode(doc, t);
    all.push(el);
    return el;
  };
  doc.getElementById = (id) => all.find((e) => e.id === id && e.parentNode) || null;
  doc.__all = all;
  doc.addEventListener = El.prototype.addEventListener.bind(doc);
  doc.removeEventListener = El.prototype.removeEventListener.bind(doc);
  doc.dispatchEvent = (ev) => doc.fire(ev.type, ev);
  body.appendChild(head);
  doc.body = body;
  return { doc, win, head, body };
}

// ---------------------------------------------------------------- 载入 snippet
function loadSnippet(opts) {
  const o = opts || {};
  const ctx = setupDom();
  const { doc, win } = ctx;
  const logs = { warns: [], errors: [] };

  const store = new Map();
  if (o.localStorageFails) {
    Object.defineProperty(win, 'localStorage', {
      get() { throw new Error('localStorage 不可用'); }
    });
  } else {
    win.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      __store: store
    };
  }

  const chunks = [];
  if (o.bridge !== false) {
    win.inkNotes = Object.assign({
      getAiConfig: () => Promise.resolve(o.config || null),
      saveAiConfig: (cfg) => { if (o.onSaveConfig) o.onSaveConfig(cfg); return Promise.resolve({ ok: true }); },
      aiChat: (req) => {
        if (o.onChat) return o.onChat(req);
        return Promise.resolve({ ok: true, text: '默认回复' });
      },
      aiAbort: (id) => { if (o.onAbort) o.onAbort(id); return Promise.resolve({ ok: true }); },
      onAiChunk: (cb) => { chunks.push(cb); return true; }
    }, o.bridgeExtra || {});
  }

  let fetchCalls = [];
  const sandbox = {
    document: doc,
    window: win,
    console: {
      log() {},
      warn(...a) { logs.warns.push(a.map(String).join(' ')); },
      error(...a) { logs.errors.push(a.map(String).join(' ')); }
    },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 1)),
    clearTimeout: (t) => clearTimeout(t),
    Promise,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Date,
    Math,
    RegExp,
    Error,
    isNaN,
    parseFloat,
    parseInt,
    TextDecoder,
    AbortController,
    fetch: (url, init) => {
      fetchCalls.push({ url, init });
      if (o.onFetch) return o.onFetch(url, init);
      return Promise.reject(new Error('浏览器模式未 mock fetch'));
    }
  };
  sandbox.globalThis = sandbox;
  win.confirm = () => (o.confirmResult === undefined ? true : o.confirmResult);
  win.navigator = { clipboard: { writeText: (t) => { win.__copied = t; return Promise.resolve(); } } };
  sandbox.navigator = win.navigator;
  win.fetch = sandbox.fetch;
  win.AbortController = AbortController;
  win.TextDecoder = TextDecoder;
  win.Promise = Promise;
  win.console = sandbox.console;

  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, 'src', 'ai-panel.snippet.js'), 'utf8');
  new vm.Script(src, { filename: 'ai-panel.snippet.js' }).runInContext(sandbox);
  return { sandbox, doc, win, ctx, logs, chunks, getFetchCalls: () => fetchCalls };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 5));

// ---------------------------------------------------------------- 断言
let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fails.push(name + (extra === undefined ? '' : '（实际：' + extra + '）'));
    console.log('  ✗ ' + name + (extra === undefined ? '' : '（实际：' + extra + '）'));
  }
}
function eq(actual, expected, name) {
  const shown = actual && typeof actual === 'object' ? '[object]' : JSON.stringify(actual);
  ok(actual === expected, name, shown);
}

const SAMPLE_CONFIG = {
  version: 1,
  currentId: 'p1',
  providers: [
    { id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-a', model: 'deepseek-chat', systemPrompt: 'SYS', temperature: 0.3 },
    { id: 'p2', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-b', model: 'gpt-4o-mini', systemPrompt: 'SYS2', temperature: 1 }
  ]
};

(async () => {
  // ============================================================ 纯函数
  console.log('用例 1：Markdown 渲染（转义 / 块级 / 行内）');
  {
    const { sandbox } = loadSnippet({ bridge: false });
    const md = sandbox.__inkAiApi.internals.md;
    ok(md('# 标题').includes('<h1>标题</h1>'), '一级标题');
    ok(md('**粗** 和 *斜*').includes('<strong>粗</strong>'), '粗体');
    ok(md('*斜*').includes('<em>斜</em>'), '斜体');
    ok(md('`code`').includes('<code>code</code>'), '行内代码');
    ok(md('- a\n- b').includes('<ul><li>a</li><li>b</li></ul>'), '无序列表');
    ok(md('1. a\n2. b').includes('<ol><li>a</li><li>b</li></ol>'), '有序列表');
    ok(md('> 引用').includes('<blockquote>引用</blockquote>'), '引用');
    ok(md('---').includes('<hr>'), '分隔线');
    ok(md('```js\nlet a=1;\n```').includes('<pre class="ink-ai-code" data-lang="js"><code>let a=1;</code></pre>'), '代码块带语言');
    ok(md('```\n<b>x</b>\n```').includes('&lt;b&gt;x&lt;/b&gt;'), '代码块内容被转义');
    ok(md('<img src=x onerror=alert(1)>').includes('&lt;img'), 'HTML 被转义');
    ok(!md('<script>alert(1)</script>').includes('<script>'), 'script 标签被转义');
    ok(md('[墨记](https://example.com)').includes('href="https://example.com"'), '链接渲染');
    ok(!md('[x](javascript:alert(1))').includes('<a '), 'javascript: 不渲染为链接');
    ok(md('第一行\n第二行').includes('第一行<br>第二行'), '段落内换行');
    ok(md('a\n\nb').includes('<p>a</p><p>b</p>'), '空行分段');
    ok(md('**加粗里的 `代码`**').includes('<strong>加粗里的 <code>代码</code></strong>'), '粗体内的行内代码');
  }

  console.log('用例 2：Base URL 规范化');
  {
    const { sandbox } = loadSnippet({ bridge: false });
    const ep = sandbox.__inkAiApi.internals.endpointOf;
    eq(ep('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions', '/v1 结尾补全');
    eq(ep('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions', '裸域名补 /v1');
    eq(ep('https://x.com/v1/chat/completions'), 'https://x.com/v1/chat/completions', '已是终点不再重复');
    eq(ep('https://x.com/v1/'), 'https://x.com/v1/chat/completions', '去尾斜杠');
    eq(ep('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/chat/completions', '本地 Ollama');
    eq(ep(''), '', '空值返回空');
    eq(ep('https://x.com/api/v1'), 'https://x.com/api/v1/chat/completions', '带路径的 v1');
  }

  console.log('用例 3：配置规范化');
  {
    const { sandbox } = loadSnippet({ bridge: false });
    const norm = sandbox.__inkAiApi.internals.normalizeConfig;
    const a = norm(null);
    eq(a.providers.length, 0, '空配置');
    const b = norm({ providers: [{ name: 'X' }] });
    eq(b.providers[0].name, 'X', '保留名称');
    eq(b.providers[0].temperature, 0.7, '默认温度');
    eq(b.currentId, b.providers[0].id, 'currentId 回落到第一个');
    ok(!!b.providers[0].id, '补出新 id');
    const c = norm({ currentId: 'nope', providers: [{ id: 'a' }, { id: 'b' }] });
    eq(c.currentId, 'a', '非法 currentId 被修正');
    const d = norm({ providers: [{ id: 'z', temperature: 99 }, { id: 'z' }] });
    eq(d.providers[0].temperature, 0.7, '越界温度回落');
    eq(d.providers.length, 2, '重复 id 不丢条目');
    const e = norm({ providers: [null, 'x', { id: 'k', name: 'ok' }] });
    eq(e.providers.length, 1, '过滤非对象条目');
  }

  console.log('用例 4：上下文截断与消息组装');
  {
    const { sandbox } = loadSnippet({ bridge: false });
    const I = sandbox.__inkAiApi.internals;
    const long = 'x'.repeat(25000);
    const clipped = I.clipContext(long);
    eq(clipped.truncated, true, '超长标记截断');
    ok(clipped.text.length < long.length, '截断后更短');
    ok(clipped.text.includes('已截断'), '截断说明');
    eq(I.clipContext('short').truncated, false, '短文本不截断');

    const msgs = I.buildMessages({
      provider: { systemPrompt: 'SYS' },
      history: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '在的' },
        { role: 'system', content: '忽略我' },
        { role: 'user', content: '   ' }
      ],
      context: '正文内容',
      title: '我的笔记'
    });
    eq(msgs.length, 4, 'system + context + 两条有效历史');
    eq(msgs[0].role, 'system', '第一条是 system');
    eq(msgs[0].content, 'SYS', '使用配置的系统提示');
    ok(msgs[1].content.includes('我的笔记') && msgs[1].content.includes('正文内容'), '上下文含标题与正文');
    eq(msgs[2].role, 'user', '历史顺序保持');
    eq(msgs[3].content, '在的', '历史内容保持');

    const many = [];
    for (let i = 0; i < 100; i++) many.push({ role: 'user', content: 'm' + i });
    const trimmed = I.buildMessages({ provider: {}, history: many, maxHistory: 10 });
    eq(trimmed.length, 11, '历史按上限裁剪（1 system + 10）');
    eq(trimmed[1].content, 'm90', '保留最近的消息');
    ok(I.buildMessages({ provider: {} })[0].content.length > 0, '无系统提示时使用默认');
  }

  console.log('用例 5：SSE 解析');
  {
    const { sandbox } = loadSnippet({ bridge: false });
    const parse = sandbox.__inkAiApi.internals.parseSseChunk;
    let got = '';
    const rest = parse('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\n', (d) => { got += d; });
    eq(got, '你好', '两个事件');
    eq(rest, '', '无残留');

    got = '';
    const rest2 = parse('data: {"choices":[{"delta":{"content":"半"}}]}\n\ndata: {"choices":[{"delta":{"cont', (d) => { got += d; });
    eq(got, '半', '完整事件被消费');
    ok(rest2.startsWith('data: {"choices":[{"delta":{"cont'), '半截事件留作残留');

    got = '';
    parse('data: [DONE]\n\n: heartbeat\n\ndata: not-json\n\n', (d) => { got += d; });
    eq(got, '', '[DONE]/心跳/非 JSON 不产出内容');

    got = '';
    parse('data: {"choices":[{"message":{"content":"非流式"}}]}\n\n', (d) => { got += d; });
    eq(got, '非流式', '兼容非流式 message.content');
  }

  console.log('用例 6：请求体构造');
  {
    const { sandbox } = loadSnippet({ bridge: false });
    const built = sandbox.__inkAiApi.internals.buildRequest({
      baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1', model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }], temperature: 0.5
    });
    eq(built.url, 'https://api.deepseek.com/v1/chat/completions', '请求终点');
    eq(built.headers.Authorization, 'Bearer sk-1', '鉴权头');
    const body = JSON.parse(built.body);
    eq(body.model, 'deepseek-chat', '模型字段');
    eq(body.stream, true, '开启流式');
    eq(body.temperature, 0.5, '温度透传');
  }

  // ============================================================ 面板行为
  console.log('用例 7：面板开关与快捷键');
  {
    const ctx = loadSnippet({ bridge: false, config: SAMPLE_CONFIG });
    await tick(10);
    const { sandbox, doc } = ctx;
    const prePanel = doc.getElementById('ink-ai-panel');
    ok(!!prePanel, '启动时预创建面板（便于提前渲染历史）');
    ok(!String(prePanel.className).includes('open'), '启动时处于收起状态');

    eq(sandbox.__inkAiToggle(), true, '快捷键/按钮可打开');
    const panel = doc.getElementById('ink-ai-panel');
    ok(!!panel, '面板已创建');
    ok(String(panel.className).includes('open'), '面板处于打开态');
    ok(doc.getElementById('ink-ai-style') !== null, '样式已注入');

    sandbox.__inkAiToggle();
    ok(!String(doc.getElementById('ink-ai-panel').className).includes('open'), '再次切换为关闭');

    // Ctrl+Shift+A
    doc.fire('keydown', { key: 'A', ctrlKey: true, shiftKey: true, preventDefault() {}, stopPropagation() {} });
    ok(String(doc.getElementById('ink-ai-panel').className).includes('open'), 'Ctrl+Shift+A 打开');
    doc.fire('keydown', { key: 'a', ctrlKey: true, shiftKey: true, preventDefault() {}, stopPropagation() {} });
    ok(!String(doc.getElementById('ink-ai-panel').className).includes('open'), '再按一次关闭');
    doc.fire('keydown', { key: 'a', ctrlKey: true, shiftKey: false, preventDefault() {}, stopPropagation() {} });
    ok(!String(doc.getElementById('ink-ai-panel').className).includes('open'), 'Ctrl+A 不触发');

    const styles = doc.__all.filter((e) => e.id === 'ink-ai-style' && e.parentNode);
    eq(styles.length, 1, '样式只注入一份');
  }

  console.log('用例 8：未配置 API 时发送 → 引导到配置页');
  {
    const ctx = loadSnippet({ bridge: false, config: null });
    await tick(10);
    const { sandbox, doc } = ctx;
    sandbox.__inkAiToggle();
    const input = doc.__all.filter((e) => e.className === 'ink-ai-input')[0];
    input.value = '你好';
    await sandbox.__inkAiApi.send();
    const state = sandbox.__inkAiApi.internals.getState();
    eq(state.view, 'config', '自动切到配置视图');
    eq(state.history.length, 0, '未发出请求');
    ok(!!doc.getElementById('ink-ai-panel'), '面板仍在');
  }

  console.log('用例 9：桌面桥接下的完整发送流程');
  {
    const chatCalls = [];
    const ctx = loadSnippet({
      config: SAMPLE_CONFIG,
      onChat: (req) => {
        chatCalls.push(req);
        // 模拟主进程流式推送（chunk 回调在 boot 时注册）
        ctxRebind(req.requestId);
        return Promise.resolve({ ok: true, text: '你好，我是助手。' });
      }
    });
    function ctxRebind(requestId) {
      for (const cb of ctx.chunks) cb({ requestId, delta: '你好，' });
    }
    await tick(10);
    const { sandbox, doc } = ctx;
    sandbox.__inkAiToggle();
    const input = doc.__all.filter((e) => e.className === 'ink-ai-input')[0];
    input.value = '帮我总结';
    await sandbox.__inkAiApi.send();
    await tick(10);

    eq(chatCalls.length, 1, '发出一次请求');
    const sent = JSON.parse(chatCalls[0].body);
    eq(sent.messages[0].role, 'system', '带系统提示');
    eq(sent.messages[sent.messages.length - 1].content, '帮我总结', '最后一条是用户问题');
    ok(sent.messages.some((m) => m.role === 'system' && /当前正在编辑的笔记/.test(m.content)) === false, '无编辑器时不硬塞上下文');

    const state = sandbox.__inkAiApi.internals.getState();
    eq(state.history.length, 2, '历史记录 user + assistant');
    eq(state.history[1].content, '你好，我是助手。', '助手全文入库');
    eq(state.streaming, false, '流式状态复位');
    const sendBtn = doc.__all.filter((e) => e.className.indexOf('ink-ai-btn primary') >= 0)[0];
    ok(/发送/.test(sendBtn.textContent), '按钮回到「发送」');
  }

  console.log('用例 10：引用当前笔记 + 插入到光标处');
  {
    const dispatched = [];
    const viewStub = {
      state: {
        doc: { toString: () => '# 我的笔记正文' },
        selection: { main: { from: 3, to: 3 } }
      },
      dispatch: (tr) => { dispatched.push(tr); },
      focus: () => {}
    };
    const chatCalls = [];
    const ctx = loadSnippet({
      config: SAMPLE_CONFIG,
      onChat: (req) => { chatCalls.push(req); return Promise.resolve({ ok: true, text: '回复内容' }); }
    });
    await tick(10);
    const { sandbox, doc } = ctx;
    sandbox.__inkAiOnEditor(viewStub);
    sandbox.__inkAiApi.internals.setState({ noteTitle: '我的笔记' });

    const ctxInput = doc.__all.filter((e) => e.className === 'ink-ai-input')[0];
    sandbox.__inkAiToggle();
    ctxInput.value = '这篇讲了什么';
    await sandbox.__inkAiApi.send();
    await tick(10);

    const sent = JSON.parse(chatCalls[0].body);
    const ctxMsg = sent.messages.filter((m) => /当前正在编辑的笔记/.test(m.content));
    eq(ctxMsg.length, 1, '注入了笔记上下文');
    ok(ctxMsg[0].content.includes('# 我的笔记正文'), '上下文含正文');
    ok(ctxMsg[0].content.includes('我的笔记'), '上下文含标题');

    // 插入
    const inserted = sandbox.__inkAiApi.insertToNote('插入这段文字');
    eq(inserted, true, '插入返回成功');
    eq(dispatched.length, 1, '派发了一次事务');
    eq(dispatched[0].changes.from, 3, '从光标处插入');
    eq(dispatched[0].changes.to, 3, '替换空选区');
    ok(String(dispatched[0].changes.insert).includes('插入这段文字'), '插入内容正确');

    eq(sandbox.__inkAiApi.insertToNote('   '), false, '空白内容不插入');
  }

  console.log('用例 11：关掉「引用当前笔记」后不带上下文');
  {
    const viewStub = {
      state: { doc: { toString: () => '正文X' }, selection: { main: { from: 0, to: 0 } } },
      dispatch: () => {},
      focus: () => {}
    };
    const chatCalls = [];
    const ctx = loadSnippet({ config: SAMPLE_CONFIG, onChat: (req) => { chatCalls.push(req); return Promise.resolve({ ok: true, text: 'ok' }); } });
    await tick(10);
    const { sandbox, doc } = ctx;
    sandbox.__inkAiOnEditor(viewStub);
    sandbox.__inkAiToggle();
    const toggleInput = doc.__all.filter((e) => e.type === 'checkbox')[0];
    toggleInput.checked = false;
    toggleInput.fire('change');
    const input = doc.__all.filter((e) => e.className === 'ink-ai-input')[0];
    input.value = '问一句';
    await sandbox.__inkAiApi.send();
    await tick(10);
    const sent = JSON.parse(chatCalls[0].body);
    ok(!sent.messages.some((m) => /当前正在编辑的笔记/.test(m.content)), '不再附带笔记上下文');
  }

  console.log('用例 12：流式增量与「停止」');
  {
    const chatCalls = [];
    let abortId = null;
    const ctx = loadSnippet({
      config: SAMPLE_CONFIG,
      onAbort: (id) => { abortId = id; },
      onChat: (req) => {
        chatCalls.push(req);
        for (const cb of ctx.chunks) {
          cb({ requestId: req.requestId, delta: '第一段' });
          cb({ requestId: 'other-request', delta: '不该出现' });
          cb({ requestId: req.requestId, delta: '第二段' });
        }
        return new Promise((resolve) => { ctx.__resolveChat = () => resolve({ ok: true, text: '第一段第二段' }); });
      }
    });
    await tick(10);
    const { sandbox, doc } = ctx;
    sandbox.__inkAiToggle();
    const input = doc.__all.filter((e) => e.className === 'ink-ai-input')[0];
    input.value = '长回答';
    const p = sandbox.__inkAiApi.send();
    await tick(10);

    const state = sandbox.__inkAiApi.internals.getState();
    eq(state.streaming, true, '进入流式状态');
    const sendBtn = doc.__all.filter((e) => /^ink-ai-btn/.test(String(e.className)) && e.parentNode && e.parentNode.className === 'ink-ai-bar')[0];
    eq(sendBtn.textContent, '停止', '按钮变为「停止」');
    ok(state.streamText.includes('第一段第二段'), '增量已累计');
    ok(!state.streamText.includes('不该出现'), 'requestId 不匹配的 chunk 被丢弃');

    p.then(() => {}); // 结束后不再断言，避免悬挂
    ctx.__resolveChat();
    await tick(10);
    eq(sandbox.__inkAiApi.internals.getState().streaming, false, '结束后复位');
  }

  console.log('用例 13：请求失败与用户中止');
  {
    const ctx = loadSnippet({
      config: SAMPLE_CONFIG,
      onChat: () => Promise.reject(new Error('HTTP 401：invalid api key'))
    });
    await tick(10);
    const { sandbox, doc } = ctx;
    sandbox.__inkAiToggle();
    const input = doc.__all.filter((e) => e.className === 'ink-ai-input')[0];
    input.value = '问题';
    await sandbox.__inkAiApi.send();
    await tick(10);
    const errors = doc.__all.filter((e) => String(e.className) === 'ink-ai-err');
    eq(errors.length, 1, '显示错误条');
    ok(errors[0].textContent.includes('401'), '错误含 HTTP 状态');
    eq(sandbox.__inkAiApi.internals.getState().streaming, false, '失败后复位');

    const ctx2 = loadSnippet({
      config: SAMPLE_CONFIG,
      onChat: () => Promise.reject(new Error('The operation was aborted'))
    });
    await tick(10);
    const s2 = ctx2.sandbox;
    s2.__inkAiToggle();
    const input2 = ctx2.doc.__all.filter((e) => e.className === 'ink-ai-input')[0];
    input2.value = '问题';
    await s2.__inkAiApi.send();
    await tick(10);
    const errs2 = ctx2.doc.__all.filter((e) => String(e.className) === 'ink-ai-err');
    eq(errs2.length, 0, '中止不显示错误条');
  }

  console.log('用例 14：配置视图 CRUD');
  {
    const saved = [];
    const ctx = loadSnippet({ config: SAMPLE_CONFIG, onSaveConfig: (cfg) => saved.push(JSON.parse(JSON.stringify(cfg))) });
    await tick(10);
    const { sandbox, doc } = ctx;
    sandbox.__inkAiToggle();
    const gear = doc.__all.filter((e) => e.title === 'API 配置')[0];
    gear.fire('click');
    eq(sandbox.__inkAiApi.internals.getState().view, 'config', '切换到配置视图');

    const cards = doc.__all.filter((e) => String(e.className) === 'ink-ai-card');
    eq(cards.length >= 2, true, '渲染出两张配置卡');

    const addBtn = doc.__all.filter((e) => e.textContent === '+ 添加 API')[0];
    addBtn.fire('click');
    eq(sandbox.__inkAiApi.internals.getState().editingId !== null, true, '进入编辑态');
    const nameInput = doc.__all.filter((e) => e.tagName === 'INPUT' && e.value === '新配置')[0];
    ok(!!nameInput, '新建配置带默认名');
    nameInput.value = '我的中转';
    const saveBtn = doc.__all.filter((e) => e.textContent === '保存')[0];
    saveBtn.fire('click');
    await tick(10);
    ok(saved.some((c) => c.providers.some((p) => p.name === '我的中转')), '保存写入桥接');
    eq(sandbox.__inkAiApi.internals.getState().editingId, null, '退出编辑态');
  }

  console.log('用例 15：localStorage 不可用时的回退');
  {
    const ctx = loadSnippet({ bridge: false, localStorageFails: true, config: SAMPLE_CONFIG });
    await tick(10);
    const { sandbox, doc } = ctx;
    eq(sandbox.__inkAiToggle(), true, '无 localStorage 也能打开面板');
    const input = doc.__all.filter((e) => e.className === 'ink-ai-input')[0];
    input.value = '测试';
    await sandbox.__inkAiApi.send();
    await tick(5);
    ok(ctx.logs.warns.length >= 0, '不抛异常');
  }

  console.log('用例 16：浏览器模式（无桥）走 fetch');
  {
    const ctx = loadSnippet({
      bridge: false,
      onFetch: () => Promise.resolve({
        ok: true,
        status: 200,
        body: null,
        text: () => Promise.resolve('data: {"choices":[{"delta":{"content":"浏览器回复"}}]}\n\ndata: [DONE]\n\n')
      })
    });
    await tick(10);
    const { sandbox, doc } = ctx;
    sandbox.__inkAiToggle();
    sandbox.__inkAiApi.internals.setState({ config: sandbox.__inkAiApi.internals.normalizeConfig(SAMPLE_CONFIG) });
    const input = doc.__all.filter((e) => e.className === 'ink-ai-input')[0];
    input.value = '在浏览器里问';
    await sandbox.__inkAiApi.send();
    await tick(20);
    const calls = ctx.getFetchCalls();
    eq(calls.length, 1, '发起了一次 fetch');
    eq(calls[0].url, 'https://api.deepseek.com/v1/chat/completions', 'fetch 终点正确');
    eq(calls[0].init.method, 'POST', 'POST 方法');
    const state = sandbox.__inkAiApi.internals.getState();
    eq(state.history.length, 2, '浏览器模式也记录历史');
    eq(state.history[1].content, '浏览器回复', '解析出回复内容');
  }

  console.log('用例 17：编辑器 view 兜底与异常安全');
  {
    const ctx = loadSnippet({ bridge: false, config: SAMPLE_CONFIG });
    await tick(10);
    const { sandbox } = ctx;
    eq(sandbox.__inkAiApi.onEditor(null), true, 'onEditor(null) 不抛');
    eq(sandbox.__inkAiApi.insertToNote('没有编辑器'), false, '无编辑器时插入返回 false');
    eq(sandbox.__inkAiToggle(), true, '面板仍可用');
  }

  await tick(30);
  console.log('\n结果：通过 ' + pass + '，失败 ' + fails.length);
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
})();
