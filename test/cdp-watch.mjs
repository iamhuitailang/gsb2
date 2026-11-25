// 重载标签并收集 console 与异常,等待标志后输出。
// 用法:node cdp-watch.mjs [完整URL](默认当前标签原地重载)
const targetUrl = process.argv[2];
const http = await import('node:http');
function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9222' + path, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
const list = await get('/json/list');
const tab = list.find((t) => t.type === 'page');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id; pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown') {
    logs.push(m.method === 'Runtime.exceptionThrown'
      ? 'EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      : m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
};
await send('Runtime.enable');
await send('Page.enable');
if (targetUrl) {
  await send('Page.navigate', { url: targetUrl });
  await new Promise((r) => setTimeout(r, 800));
} else {
  await send('Page.reload', { ignoreCache: true });
}
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  const r = await send('Runtime.evaluate', { expression: 'window.__done === true', returnByValue: true });
  if (r.result.value) break;
  await new Promise((r) => setTimeout(r, 300));
}
const out = await send('Runtime.evaluate', {
  expression: 'document.getElementById("out") ? document.getElementById("out").textContent : "no-out"',
  returnByValue: true,
});
console.log('=== RESULT ===');
console.log(out.result.value);
console.log('=== CONSOLE/EXCEPTIONS ===');
console.log(logs.join('\n') || '(none)');
ws.close();
