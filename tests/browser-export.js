/* 验证真实尺寸离屏渲染（导出截图的同一管线），不依赖浏览器下载行为。 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE_URL = 'file://' + path.join(__dirname, '..', 'index.html');
const PORT = 9335;
const userData = '/tmp/pcal-shots/chrome-profile-3';

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
    const api = { send (o) { sock.write(enc(JSON.stringify(o))); }, close () { sock.end(); }, onmessage: null };
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      if (!handshake.includes('\r\n\r\n')) {
        handshake += chunk.toString('binary');
        if (handshake.includes('\r\n\r\n')) { buf = chunk.slice(handshake.length); resolve(api); }
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const l0 = buf[1] & 0x7f;
        let len = l0, off = 2;
        if (l0 === 126) { len = buf.readUInt16BE(2); off = 4; }
        else if (l0 === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const payload = buf.slice(off, off + len).toString('utf8');
        buf = buf.slice(off + len);
        if (api.onmessage) api.onmessage(JSON.parse(payload));
      }
    });
    sock.on('error', reject);
  });
}
function enc (str) {
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
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userData, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await getJSON('/json'); break; } catch (e) { await sleep(250); } }
  const ws = await cdpSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  let id = 0;
  const waits = new Map();
  ws.onmessage = (m) => { if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } };
  const send = (method, params) => new Promise((resolve) => { const i = ++id; waits.set(i, resolve); ws.send({ id: i, method, params: params || {} }); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(1800);
  async function ev (expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  }

  // 直接走 renderComposite 真实尺寸管线：4K 双幕 + 720p 单幕
  const result = await ev(`(async function(){
    const st = window.__pcal.state;
    document.getElementById('preset-tilted').click();
    await new Promise(r=>setTimeout(r,600));
    // 用与导出截图完全相同的 renderComposite 管线，在离屏画布上按真实尺寸渲染
    const src = document.createElement('canvas');
    PCAL.render.renderSourceCanvas(src, st.patternType, null);
    async function go(w,h){
      const c = document.createElement('canvas');
      const models = PCAL.render.buildScreenModels(st.screens, w, h);
      const t0 = performance.now();
      let lastP = 0;
      await PCAL.render.renderComposite(c, src, models, w, h, {showOverflow:true, onProgress:function(p){lastP=p;}});
      const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let opaque = 0, redish = 0;
      for (let i=0;i<d.length;i+=4){
        if (d[i+3]>0) opaque++;
        if (d[i]>180 && d[i+1]<150 && d[i+2]<150) redish++;
      }
      return {w:c.width,h:c.height,ms:Math.round(performance.now()-t0),progress:lastP,opaque:opaque,redish:redish};
    }
    const r4k = await go(3840,2160);
    // 切回单幕 720p
    document.querySelector('input[name="screencount"][value="1"]').checked = true;
    document.querySelector('input[name="screencount"][value="1"]').dispatchEvent(new Event('change'));
    await new Promise(r=>setTimeout(r,400));
    const r720 = await go(1280,720);
    return {r4k:r4k, r720:r720};
  })()`);
  console.log(JSON.stringify(result, null, 2));
  ws.close(); chrome.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
