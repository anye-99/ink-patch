// 一次性探测：看看墨记 preview 页面当前的 DOM 结构（有哪些按钮、正文文本），
// 用于决定「怎么在空库里创建一篇笔记」。用法：node preview/_probe.cjs [cdpPort]
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
  const page = list.filter((t) => t.type === 'page' && String(t.url).includes('8099'))[0] || list.filter((t) => t.type === 'page')[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((res) => ws.addEventListener('open', res));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p(msg.result);
    }
  });
  const send = (method, params) => new Promise((res) => {
    id += 1;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) return '异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description);
    return r.result && r.result.value;
  };

  console.log('url: ' + page.url);
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await sleep(7000);
  console.log('\n--- AI 助手运行时 ---');
  console.log(await evaluate(`JSON.stringify({api: typeof window.__inkAiApi, toggle: typeof window.__inkAiToggle, panel: !!document.getElementById('ink-ai-panel')})`));
  console.log('\n--- 按钮 ---');
  console.log(await evaluate(`Array.from(document.querySelectorAll('button')).map((b, i) => i + '|' + (b.className||'') + '|' + (b.title||'') + '|' + b.textContent.trim().slice(0,20)).join('\\n')`));
  console.log('\n--- 可见文本（前 400 字）---');
  console.log(await evaluate(`(document.body.innerText||'').replace(/\\n{2,}/g,'\\n').slice(0,400)`));
  console.log('\n--- input/textarea ---');
  console.log(await evaluate(`Array.from(document.querySelectorAll('input,textarea,select')).map((e,i)=>i+'|'+e.tagName+'|'+(e.className||'')+'|'+(e.placeholder||'')).join('\\n')`));
  console.log('\n--- 布局 ---');
  console.log(await evaluate(`JSON.stringify({app:(document.querySelector('.app')||{}).className||'', sidebar:!!document.querySelector('.sidebar'), list:!!document.querySelector('.desktop-list-column'), editor:!!document.querySelector('.desktop-editor-column'), cm:!!document.querySelector('.cm-editor')})`));

  const r = await send('Page.captureScreenshot', { format: 'png' });
  const dir = path.join(__dirname, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'probe.png');
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('\n截图：' + file);
  ws.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
