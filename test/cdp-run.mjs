// 纯 CDP 驱动(无第三方依赖):打开页面 -> 等待全局完成标志 -> 读取结果。
// 用法:node test/cdp-run.mjs <url> <globalFlag> <resultExpr> [timeoutMs]
const base = 'http://localhost:9222';
const [url, flag, resultExpr, timeoutMs = 30000] = process.argv.slice(2);

const http = await import('node:http');
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(base + path, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

const list = await get('/json/list');
const tab = list.find((t) => t.type === 'page');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });

const deadline = Date.now() + timeoutMs;
let result = null;
while (Date.now() < deadline) {
  const r = await send('Runtime.evaluate', {
    expression: `[window.${flag}, ${resultExpr}]`,
    returnByValue: true,
  });
  if (r.result.value && r.result.value[0] === true) {
    result = r.result.value[1];
    break;
  }
  await new Promise((r) => setTimeout(r, 200));
}
if (result === null) {
  console.error(`TIMEOUT 等待 ${flag}`);
  process.exit(1);
}
console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
ws.close();
