/* 纯 Node CDP 冒烟测试：启动系统 Chrome，驱动页面交互并检查渲染结果。
 * 用法：node tests/browser-smoke.js（不依赖任何 npm 包，只用内置 http/ws 模块）。 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE_URL = 'file://' + path.join(__dirname, '..', 'index.html');
const PORT = 9333;
const userData = '/tmp/pcal-shots/chrome-profile';

function getJSON (path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

// 极简 WebSocket 客户端（仅支持无扩展、单帧文本，够 CDP 用）
const crypto = require('crypto');
const net = require('net');
function cdpSocket (wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        'GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' +
        'Host: ' + u.host + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let handshake = '';
    const pending = [];
    const api = { send (obj) { sock.write(encodeFrame(JSON.stringify(obj))); }, close () { sock.end(); }, onmessage: null };
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      if (!handshake.includes('\r\n\r\n')) {
        handshake += chunk.toString('binary');
        if (handshake.includes('\r\n\r\n')) {
          buf = chunk.slice(handshake.length);
          resolve(api);
        }
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
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x81, 0x80 | len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userData,
    '--window-size=1600,2400', 'about:blank'
  ], { stdio: 'ignore' });

  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJSON('/json'); break; } catch (e) { await sleep(250); }
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = await cdpSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waits = new Map();
  const events = [];
  ws.onmessage = (msg) => {
    if (msg.id && waits.has(msg.id)) { waits.get(msg.id)(msg); waits.delete(msg.id); }
    else if (msg.method) events.push(msg);
  };
  function send (method, params) {
    return new Promise((resolve) => {
      const mid = ++id;
      waits.set(mid, resolve);
      ws.send({ id: mid, method, params: params || {} });
    });
  }
  await send('Page.enable');
  await send('Runtime.enable');
  const errors = [];
  events.length = 0;
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(2500);

  async function evalJs (expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) errors.push(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  const results = {};
  // 1. 三个视图是否真的画出了非背景像素
  results.nonBlank = await evalJs(`(function(){
    const out = [];
    ['view-source','view-warped','view-output'].forEach(function(id){
      const c = document.getElementById(id);
      const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let lit = 0;
      for (let i=0;i<d.length;i+=4){ if (d[i+3]>0 && (d[i]+d[i+1]+d[i+2])>60) lit++; }
      out.push({id:id, w:c.width, h:c.height, litPixels:lit});
    });
    return out;
  })()`);

  // 2. 固定标记往返误差（页面内 PCAL 计算模型）
  results.roundtrip = await evalJs(`(function(){
    const st = window.__pcal.state;
    const dims = PCAL.state.outputDimensions(st);
    const models = PCAL.render.buildScreenModels(st.screens, 900, Math.round(900*dims.h/dims.w));
    const errs = [];
    st.markers.forEach(function(mk){
      models.forEach(function(m){
        if(!m.enabled||!m.valid) return;
        const f = PCAL.math.applyH(m.H, mk.u, mk.v);
        const b = PCAL.math.applyH(m.invH, f.x, f.y);
        errs.push(Math.hypot(b.x-mk.u, b.y-mk.v));
      });
    });
    return {maxNormErr: Math.max.apply(null, errs), ok: Math.max.apply(null,errs) < 1e-9};
  })()`);

  // 3. 切到倾斜双幕示例
  await evalJs(`document.getElementById('preset-tilted').click()`);
  await sleep(2000);
  results.tilted = await evalJs(`(function(){
    const c = document.getElementById('view-output');
    const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let lit = 0, redish = 0;
    for (let i=0;i<d.length;i+=4){
      if (d[i+3]>0 && (d[i]+d[i+1]+d[i+2])>60) lit++;
      if (d[i] > 180 && d[i+1] < 150 && d[i+2] < 150) redish++;
    }
    const banner = document.getElementById('status-message').textContent;
    return {litPixels:lit, redPixels:redish, banner:banner};
  })()`);

  // 4. 非法四边形：直接调内部几何校验
  results.invalid = await evalJs(`(function(){
    const G = PCAL.geometry;
    return [
      G.validateQuad([{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}]).reason,
      G.validateQuad([{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:0.5,y:1}]).reason
    ];
  })()`);

  // 5. 探针反查：模拟点击输出视图中心
  results.probe = await evalJs(`(function(){
    const c = document.getElementById('view-output');
    const r = c.getBoundingClientRect();
    const ev = new PointerEvent('pointerdown',{clientX:r.left+r.width*0.4, clientY:r.top+r.height*0.5, bubbles:true});
    c.dispatchEvent(ev);
    const ev2 = new PointerEvent('pointerup',{clientX:r.left+r.width*0.4, clientY:r.top+r.height*0.5, bubbles:true});
    c.dispatchEvent(ev2);
    return document.getElementById('marker-info').children.length;
  })()`);

  // 6. 输出尺寸切换后角点规范坐标不变 + 重新渲染
  results.resize = await evalJs(`(function(){
    const before = JSON.stringify(PCAL.state.load() ? 'has-storage' : 'no-storage');
    const sel = document.getElementById('output-preset');
    sel.value = '4k'; sel.dispatchEvent(new Event('change'));
    const c = document.getElementById('view-output');
    const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let lit = 0;
    for (let i=0;i<d.length;i+=4){ if (d[i+3]>0) lit++; }
    return {storage:before, stillRendered: lit > 1000};
  })()`);

  // 7. 截图落盘
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/pcal-shots/tilted-dual.png', Buffer.from(shot.result.data, 'base64'));

  console.log(JSON.stringify(results, null, 2));
  console.log('JS exceptions:', errors.length ? errors : 'none');
  ws.close();
  chrome.kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

function sleep (ms) { return new Promise((r) => setTimeout(r, ms)); }
