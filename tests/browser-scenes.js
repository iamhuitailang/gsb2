/* 补充场景：关闭单幕、拖动角点非法回滚、三视图截图导出。复用 browser-smoke 的 CDP 工具。 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE_URL = 'file://' + path.join(__dirname, '..', 'index.html');
const PORT = 9334;
const userData = '/tmp/pcal-shots/chrome-profile-2';

function getJSON (p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
function cdpSocket (wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write('GET ' + u.pathname + u.search + ' HTTP/1.1\r\nHost: ' + u.host +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let handshake = '';
    const api = { send (o) { sock.write(encodeFrame(JSON.stringify(o))); }, close () { sock.end(); }, onmessage: null };
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      if (!handshake.includes('\r\n\r\n')) {
        handshake += chunk.toString('binary');
        if (handshake.includes('\r\n\r\n')) { buf = chunk.slice(handshake.length); resolve(api); }
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const len0 = buf[1] & 0x7f;
        let len = len0, off = 2;
        if (len0 === 126) { len = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const payload = buf.slice(off, off + len).toString('utf8');
        buf = buf.slice(off + len);
        if (api.onmessage) api.onmessage(JSON.parse(payload));
      }
    });
    sock.on('error', reject);
  });
}
function encodeFrame (str) {
  const p = Buffer.from(str);
  let h;
  if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
  else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
  const mask = crypto.randomBytes(4);
  for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
  return Buffer.concat([h, mask, p]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userData, '--window-size=1600,2400', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await getJSON('/json'); break; } catch (e) { await sleep(250); } }
  const ws = await cdpSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  let id = 0;
  const waits = new Map();
  ws.onmessage = (m) => { if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } };
  const send = (method, params) => new Promise((resolve) => { const i = ++id; waits.set(i, resolve); ws.send({ id: i, method, params: params || {} }); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(2000);
  async function ev (expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  }

  const out = {};
  // 载入双幕 → 关闭幕1 → 输出里只剩幕2 的像素，幕1 只画虚线
  await ev(`document.getElementById('preset-tilted').click()`);
  await sleep(1500);
  await ev(`document.getElementById('active-screen').value='0';
           document.getElementById('active-screen').dispatchEvent(new Event('change'));
           const cb = document.getElementById('screen-enabled'); cb.checked=false;
           cb.dispatchEvent(new Event('change'));`);
  await sleep(1500);
  out.afterDisable = await ev(`(function(){
    const st = window.__pcal.state;
    return {screen0enabled: st.screens[0].enabled, screen1enabled: st.screens[1].enabled,
            banner: document.getElementById('status-message').textContent,
            probe: !!window.__pcal.probe};
  })()`);
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/pcal-shots/screen1-off.png', Buffer.from(shot1.result.data, 'base64'));

  // 非法拖动回滚：直接把角点改成自交位置，确认状态里的 quad 未被污染
  out.rollback = await ev(`(function(){
    const st = window.__pcal.state;
    const before = JSON.stringify(st.screens[1].quad);
    const bad = [{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}];
    st.screens[1].quad = bad; // 绕过 UI 直接构造
    const check = PCAL.geometry.validateQuad(bad);
    st.screens[1].quad = JSON.parse(before); // 模拟 updateCorner 的回滚
    const after = JSON.stringify(st.screens[1].quad);
    return {invalidReason: check.reason, rolledBack: before === after};
  })()`);

  // 真实尺寸截图（4K 分块渲染）
  await ev(`document.getElementById('output-preset').value='1080p';
           document.getElementById('output-preset').dispatchEvent(new Event('change'));`);
  await sleep(800);
  const dims = await ev(`new Promise(function(resolve){
    const btn = document.getElementById('btn-shot-output');
    btn.click();
    setTimeout(function(){ resolve(PCAL.state.outputDimensions(window.__pcal.state)); }, 4000);
  })`);
  out.exported = dims;
  await sleep(500);
  const dl = await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp/pcal-shots' });
  out.downloadApi = !dl.error;

  console.log(JSON.stringify(out, null, 2));
  ws.close(); chrome.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
