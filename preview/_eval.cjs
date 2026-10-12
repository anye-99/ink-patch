// 通用 CDP 求值小工具（不 reload，保持当前页面状态）
// 用法：node preview/_eval.cjs "<表达式>" [cdpPort]
const PORT = process.argv[3] || '9333';
const EXPR = process.argv[2];
if (!EXPR) {
  console.error('用法: node preview/_eval.cjs "<表达式>" [cdpPort]');
  process.exit(2);
}

(async () => {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const page = pages.filter((t) => String(t.url).includes('8099'))[0] || pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  let id = 0;
  const pending = new Map();
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
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) {
    console.error('异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    process.exit(1);
  }
  const v = r.result && r.result.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  ws.close();
})().catch((e) => {
  console.error(String(e && e.stack || e));
  process.exit(1);
});
