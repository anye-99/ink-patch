// 用 CDP 在真实 Edge 里验证墨记 preview 页面的 AI 助手补丁（本机 Node 自带 WebSocket，无需依赖）
//
// 用法：node preview/verify-ai-panel.cjs [cdpPort] [urlMatch]
//   前置：静态服务器已跑在 url 上，Edge 已用 --remote-debugging-port=<cdpPort> 启动并打开了该 url
//
// 覆盖：运行时加载 / 打开笔记后的编辑器绑定 / 工具栏按钮 / 插入到光标处 /
//       面板开合与快捷键 / 配置 CRUD 表单 / Markdown 渲染 / 发送失败时的可见反馈；并留下三张截图
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || '9333';
const URL_MATCH = process.argv[3] || '127.0.0.1:8099';
const SHOT_DIR = path.join(__dirname, 'shots');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function listTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json');
      const list = await res.json();
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pages.length) return pages;
    } catch (err) {
      /* CDP 还没起来 */
    }
    await sleep(400);
  }
  throw new Error('CDP 未就绪（端口 ' + PORT + '）');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        id += 1;
        const msgId = id;
        ws.send(JSON.stringify({ method, id: msgId, params: params || {} }));
        return new Promise((res, rej) => pending.set(msgId, { res, rej }));
      },
      close() { try { ws.close(); } catch (err) { /* ignore */ } }
    }));
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')));
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (err) { return; }
      if (!msg.id || !pending.has(msg.id)) return;
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.res(msg.result);
    });
  });
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (r.exceptionDetails) {
    throw new Error('页面内异常：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  }
  return r.result && r.result.value;
}

async function jget(client, expression) {
  const raw = await evaluate(client, 'JSON.stringify(' + expression + ')');
  return JSON.parse(raw);
}

async function shot(client, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOT_DIR, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('  截图：' + file);
  return file;
}

const DEMO_CONFIG = {
  version: 1,
  currentId: 'p1',
  providers: [
    { id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-demo', model: 'deepseek-chat', systemPrompt: '你是墨记里的写作助手。', temperature: 0.7 },
    { id: 'p2', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen2.5:7b', systemPrompt: '你是墨记里的写作助手。', temperature: 0.7 }
  ]
};
const DEMO_HISTORY = [
  { role: 'user', content: '帮我把这段小结改成三条要点', at: Date.now() - 60000 },
  {
    role: 'assistant',
    content: '好的，整理成三条：\n\n1. **补丁 A**：本机 Obsidian 变化时自动增量拉取\n2. **补丁 B**：导出按钮合并成下拉菜单\n3. `AI 助手`：右侧对话面板，可自定义 API\n\n> 需要更细的话我可以展开任意一条。',
    at: Date.now() - 30000
  }
];

(async () => {
  const results = [];
  const check = (cond, name, extra) => {
    results.push({ ok: !!cond, name });
    console.log('  ' + (cond ? '✓' : '✗') + ' ' + name + (cond ? '' : '（实际：' + extra + '）'));
  };

  const targets = await listTargets();
  const page = targets.find((t) => String(t.url).includes(URL_MATCH)) || targets[0];
  console.log('目标页面：' + page.url);
  const client = await connect(page.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  // ---------------------------------------------------------------- 1. 注入演示数据后重载
  console.log('\n[1] 注入演示配置与历史，重载页面');
  await evaluate(client, `(() => {
    localStorage.setItem('ink-ai-config-v1', ${JSON.stringify(JSON.stringify(DEMO_CONFIG))});
    localStorage.setItem('ink-ai-history-v1', ${JSON.stringify(JSON.stringify(DEMO_HISTORY))});
    return 'ok';
  })()`);
  await client.send('Page.reload', { ignoreCache: true });
  await sleep(7000);

  const base = await jget(client, `(() => {
    const r = {};
    r.title = document.title;
    r.hasApi = !!window.__inkAiApi;
    r.hasToggle = typeof window.__inkAiToggle === 'function';
    r.hasOnEditor = typeof window.__inkAiOnEditor === 'function';
    r.panel = !!document.getElementById('ink-ai-panel');
    r.panelOpen = !!document.getElementById('ink-ai-panel') && String(document.getElementById('ink-ai-panel').className).includes('open');
    r.style = !!document.getElementById('ink-ai-style');
    r.rootChildren = document.getElementById('root') ? document.getElementById('root').children.length : -1;
    r.version = (window.__inkAiApi && window.__inkAiApi.internals && window.__inkAiApi.internals.version) || 0;
    return r;
  })()`);
  console.log('  页面状态：' + JSON.stringify(base));
  check(base.hasApi, 'AI 助手运行时已加载', JSON.stringify(base));
  check(base.hasToggle && base.hasOnEditor, '模块内入口已暴露到 window', JSON.stringify(base));
  check(base.panel && base.style, '面板与样式已就绪', JSON.stringify(base));
  check(base.panelOpen === false, '启动时面板为收起态', String(base.panelOpen));
  check(base.version === 1, '运行时版本号正确', String(base.version));
  check(base.rootChildren > 0, '墨记主界面正常渲染', String(base.rootChildren));

  // ---------------------------------------------------------------- 2. 打开一篇笔记 → 工具栏按钮 + 编辑器绑定
  console.log('\n[2] 打开一篇笔记，验证编辑器注入与工具栏按钮');
  const opened = await evaluate(client, `(() => {
    const tile = document.querySelector('.note-tile');
    if (tile) { tile.click(); return 'tile'; }
    const hero = Array.from(document.querySelectorAll('button.hero-action'))[0];
    if (hero) { hero.click(); return 'hero'; }
    return 'none';
  })()`);
  console.log('  打开方式：' + opened);
  await sleep(3000);

  const ed = await jget(client, `(() => {
    const state = window.__inkAiApi.internals.getState();
    const view = state.editorView;
    return {
      cm: !!document.querySelector('.cm-editor'),
      toolbarBtn: !!document.querySelector('.ink-ai-toolbar-btn'),
      toolbarBtnTitle: (document.querySelector('.ink-ai-toolbar-btn') || {}).title || '',
      toolbarBtnText: ((document.querySelector('.ink-ai-toolbar-btn') || {}).textContent || '').trim(),
      viewBound: !!view,
      docLen: view && view.state ? view.state.doc.toString().length : -1,
      exportBtn: !!Array.from(document.querySelectorAll('button.tool-btn')).find((b) => /导出/.test(b.textContent))
    };
  })()`);
  console.log('  编辑器：' + JSON.stringify(ed));
  check(ed.cm, 'CodeMirror 编辑器已打开', JSON.stringify(ed));
  check(ed.toolbarBtn, '工具栏出现「AI」按钮', JSON.stringify(ed));
  check(/AI 助手/.test(ed.toolbarBtnTitle), '按钮提示含快捷键', ed.toolbarBtnTitle);
  check(ed.viewBound, 'onCreateEditor 已把 EditorView 交给补丁', JSON.stringify(ed));
  check(ed.docLen > 0, '能读到当前笔记全文', String(ed.docLen));
  check(ed.exportBtn, '补丁 B 的「导出」按钮仍在（未互相破坏）', JSON.stringify(ed));

  // ---------------------------------------------------------------- 3. 插入到光标处（真改编辑器，随后还原）
  console.log('\n[3] 插入到光标处');
  const ins = await jget(client, `(() => {
    const api = window.__inkAiApi;
    const view = api.internals.getState().editorView;
    const before = view.state.doc.toString();
    const okInsert = api.insertToNote('【AI 助手插入测试】');
    const after = view.state.doc.toString();
    // 还原，不在 preview 数据里留痕
    view.dispatch({ changes: { from: 0, to: after.length, insert: before } });
    const restored = view.state.doc.toString();
    return { okInsert, grew: after.length > before.length, contains: after.includes('【AI 助手插入测试】'), restored: restored === before };
  })()`);
  console.log('  插入结果：' + JSON.stringify(ins));
  check(ins.okInsert === true, 'insertToNote 返回成功', JSON.stringify(ins));
  check(ins.grew && ins.contains, '正文里真的出现了插入内容', JSON.stringify(ins));
  check(ins.restored, '还原后与原文一致（未污染演示数据）', JSON.stringify(ins));

  // ---------------------------------------------------------------- 4. 工具栏按钮打开面板
  console.log('\n[4] 点击工具栏「AI」按钮');
  await evaluate(client, `document.querySelector('.ink-ai-toolbar-btn').click(); 'ok'`);
  await sleep(1200);
  const panel = await jget(client, `(() => {
    const p = document.getElementById('ink-ai-panel');
    const rect = p ? p.getBoundingClientRect() : null;
    return {
      open: !!p && String(p.className).includes('open'),
      width: rect ? Math.round(rect.width) : -1,
      right: rect ? Math.round(rect.right) : -1,
      viewport: window.innerWidth,
      provider: (document.querySelector('#ink-ai-panel select.ink-ai-provider') || {}).value || '',
      msgs: document.querySelectorAll('#ink-ai-panel .ink-ai-msg').length,
      bold: !!document.querySelector('#ink-ai-panel .ink-ai-bubble strong'),
      ordered: !!document.querySelector('#ink-ai-panel .ink-ai-bubble ol'),
      inlineCode: !!document.querySelector('#ink-ai-panel .ink-ai-bubble code:not(pre code)'),
      quote: !!document.querySelector('#ink-ai-panel .ink-ai-bubble blockquote'),
      insertBtn: !!Array.from(document.querySelectorAll('#ink-ai-panel .ink-ai-mini')).find((b) => b.textContent === '插入到笔记'),
      composer: (() => { const c = document.querySelector('#ink-ai-panel .ink-ai-composer'); return !!c && c.style.display !== 'none'; })()
    };
  })()`);
  console.log('  面板：' + JSON.stringify(panel));
  check(panel.open, '面板已打开', JSON.stringify(panel));
  check(panel.width >= 380 && panel.width <= 460, '宽度为设计值（420px 抽屉）', String(panel.width));
  check(panel.right >= panel.viewport - 2, '贴着窗口右侧', JSON.stringify(panel));
  check(panel.provider === 'p1', '下拉选中当前配置', panel.provider);
  check(panel.msgs === 2, '历史两条消息已渲染', String(panel.msgs));
  check(panel.bold && panel.ordered && panel.inlineCode && panel.quote, 'Markdown 渲染（粗体/有序列表/行内代码/引用）', JSON.stringify(panel));
  check(panel.insertBtn, '助手消息带「插入到笔记」', JSON.stringify(panel));
  check(panel.composer, '输入区可见', JSON.stringify(panel));
  await shot(client, 'ai-chat.png');

  // ---------------------------------------------------------------- 5. 配置视图
  console.log('\n[5] 配置视图');
  await evaluate(client, `(() => {
    const gear = Array.from(document.querySelectorAll('#ink-ai-panel .ink-ai-icon-btn')).find((b) => b.title === 'API 配置');
    if (gear) gear.click();
    return 'ok';
  })()`);
  await sleep(800);
  const cfg = await jget(client, `(() => {
    const composer = document.querySelector('#ink-ai-panel .ink-ai-composer');
    return {
      cards: document.querySelectorAll('#ink-ai-panel .ink-ai-card').length,
      badge: !!document.querySelector('#ink-ai-panel .ink-ai-badge'),
      addBtn: !!Array.from(document.querySelectorAll('#ink-ai-panel button')).find((b) => b.textContent === '+ 添加 API'),
      composerHidden: !!composer && composer.style.display === 'none',
      metas: Array.from(document.querySelectorAll('#ink-ai-panel .ink-ai-card-meta')).map((e) => e.textContent)
    };
  })()`);
  console.log('  配置视图：' + JSON.stringify(cfg));
  check(cfg.cards === 2, '两套配置各一张卡片', String(cfg.cards));
  check(cfg.badge, '当前配置带「当前」徽标', JSON.stringify(cfg));
  check(cfg.addBtn, '有「+ 添加 API」入口', JSON.stringify(cfg));
  check(cfg.composerHidden, '配置视图隐藏输入区', JSON.stringify(cfg));
  check(cfg.metas.some((m) => /deepseek-chat/.test(m)), '卡片显示模型与地址', JSON.stringify(cfg.metas));
  await shot(client, 'ai-config.png');

  // ---------------------------------------------------------------- 6. 新增配置表单
  console.log('\n[6] 新增 API 表单');
  await evaluate(client, `Array.from(document.querySelectorAll('#ink-ai-panel button')).find((b) => b.textContent === '+ 添加 API').click(); 'ok'`);
  await sleep(600);
  const form = await jget(client, `(() => ({
    labels: Array.from(document.querySelectorAll('#ink-ai-panel .ink-ai-field > span')).map((s) => s.textContent),
    presets: Array.from(document.querySelectorAll('#ink-ai-panel .ink-ai-presets button')).map((b) => b.textContent),
    hint: Array.from(document.querySelectorAll('#ink-ai-panel .ink-ai-hint')).map((h) => h.textContent).join(' | '),
    passwordField: !!document.querySelector('#ink-ai-panel .ink-ai-field input[type=password]')
  }))()`);
  console.log('  表单：' + JSON.stringify(form));
  check(form.labels.length === 6, '六个字段', JSON.stringify(form.labels));
  check(form.presets.length >= 5, '预设服务商按钮', JSON.stringify(form.presets));
  check(form.passwordField, 'API Key 用密码框', JSON.stringify(form));

  // 点一个预设，确认能回填 Base URL
  const presetFill = await jget(client, `(() => {
    const btn = Array.from(document.querySelectorAll('#ink-ai-panel .ink-ai-presets button')).find((b) => b.textContent === 'DeepSeek');
    if (!btn) return { found: false };
    btn.click();
    const inputs = Array.from(document.querySelectorAll('#ink-ai-panel .ink-ai-field input'));
    return { found: true, name: inputs[0].value, baseUrl: inputs[1].value, model: inputs[3].value };
  })()`);
  console.log('  预设回填：' + JSON.stringify(presetFill));
  check(presetFill.found && /api\.deepseek\.com\/v1/.test(presetFill.baseUrl), '预设按钮自动填 Base URL', JSON.stringify(presetFill));
  check(presetFill.model === 'deepseek-chat', '预设按钮自动填模型', JSON.stringify(presetFill));
  const hintAfter = await evaluate(client, `(document.querySelector('#ink-ai-panel .ink-ai-hint') || {}).textContent || ''`);
  check(/api\.deepseek\.com\/v1\/chat\/completions/.test(hintAfter), '预设回填后实时算出请求终点', hintAfter);
  await shot(client, 'ai-config-form.png');

  // 取消编辑，回到对话视图
  await evaluate(client, `(() => {
    const cancel = Array.from(document.querySelectorAll('#ink-ai-panel button')).find((b) => b.textContent === '取消');
    if (cancel) cancel.click();
    const gear = Array.from(document.querySelectorAll('#ink-ai-panel .ink-ai-icon-btn')).find((b) => b.title === 'API 配置');
    if (gear) gear.click();
    return 'ok';
  })()`);
  await sleep(500);

  // ---------------------------------------------------------------- 7. 快捷键收起
  console.log('\n[7] 快捷键');
  await evaluate(client, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, shiftKey: true, bubbles: true })); 'ok'`);
  await sleep(600);
  const cls = await evaluate(client, `String((document.getElementById('ink-ai-panel') || {}).className || '')`);
  check(!cls.includes('open'), 'Ctrl+Shift+A 收起面板', cls);
  await evaluate(client, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, shiftKey: true, bubbles: true })); 'ok'`);
  await sleep(600);
  const cls2 = await evaluate(client, `String((document.getElementById('ink-ai-panel') || {}).className || '')`);
  check(cls2.includes('open'), '再按一次重新打开', cls2);

  // ---------------------------------------------------------------- 8. 发送一次（假 Key 必然失败，验证反馈可见）
  console.log('\n[8] 发送链路（浏览器模式，假 Key）');
  await evaluate(client, `(() => {
    const ta = document.querySelector('#ink-ai-panel textarea.ink-ai-input');
    ta.value = '连通性测试';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const send = Array.from(document.querySelectorAll('#ink-ai-panel button')).find((b) => /发送/.test(b.textContent));
    send.click();
    return 'sent';
  })()`);
  await sleep(8000);
  const sent = await jget(client, `(() => ({
    userMsgs: document.querySelectorAll('#ink-ai-panel .ink-ai-msg.user').length,
    err: document.querySelectorAll('#ink-ai-panel .ink-ai-err').length,
    errText: (document.querySelector('#ink-ai-panel .ink-ai-err') || {}).textContent || '',
    streaming: window.__inkAiApi.internals.getState().streaming
  }))()`);
  console.log('  发送后：' + JSON.stringify(sent));
  check(sent.userMsgs >= 1, '用户消息已上屏', JSON.stringify(sent));
  check(sent.err >= 1 || sent.streaming === false, '失败有可见反馈（错误条或已结束）', JSON.stringify(sent));
  check(sent.streaming === false, '请求结束后未卡在生成态', JSON.stringify(sent));

  const failed = results.filter((r) => !r.ok);
  console.log('\n结果：通过 ' + (results.length - failed.length) + '，失败 ' + failed.length);
  if (failed.length) {
    for (const f of failed) console.log('  ✗ ' + f.name);
  }
  client.close();
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('验证失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
