// 加载真实 index.html,单步到指定帧并可选切模式,然后 CDP 截图。
const http = await import('node:http');
import fs from 'node:fs';
function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9222' + path, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
const [, , frame, mode, outPath] = process.argv;
const list = await get('/json/list');
const tab = list.find((t) => t.type === 'page');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
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
  }
};
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 1180, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: 'http://localhost:8717/index.html' });
await new Promise((r) => setTimeout(r, 1800));
// 单步到目标帧
await send('Runtime.evaluate', {
  expression: `(() => {
    const d = document;
    for (let i = 0; i < ${frame}; i++) d.getElementById('btn-step').click();
    if (${mode} >= 0) d.querySelector('[data-mode="${mode}"]').click();
    return document.getElementById('seek-frame').value;
  })()`,
  returnByValue: true,
});
await new Promise((r) => setTimeout(r, 500));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
console.log('saved', outPath);
ws.close();
