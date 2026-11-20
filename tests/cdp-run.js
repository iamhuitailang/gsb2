/* 零依赖 CDP 驱动：打开 smoke.html，等待 title 变化后抓取 toast 中的测试结果 */
'use strict';
const http = require('http');
const net = require('net');
const crypto = require('crypto');

function getJson(path, method) {
  return new Promise((resolve, reject) => {
    const req = http.request('http://127.0.0.1:9222' + path, { method: method || 'GET' }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// 最小 WebSocket 客户端（仅文本帧，足够 CDP 使用）
class WS {
  constructor(url) { this.url = url; this.buf = Buffer.alloc(0); this.id = 0; this.waits = new Map(); this.events = []; }
  connect() {
    const u = new URL(this.url);
    const key = crypto.randomBytes(16).toString('base64');
    return new Promise((resolve, reject) => {
      const sock = net.connect(u.port, u.hostname, () => {
        sock.write(
          `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      this.sock = sock;
      let handshake = '';
      sock.on('data', (chunk) => {
        if (!this.established) {
          handshake += chunk.toString('binary');
          if (handshake.includes('\r\n\r\n')) {
            this.established = true;
            const rest = handshake.slice(handshake.indexOf('\r\n\r\n') + 4);
            this.buf = Buffer.from(rest, 'binary');
            this._pump();
            resolve();
          }
          return;
        }
        this.buf = Buffer.concat([this.buf, chunk]);
        this._pump();
      });
      sock.on('error', reject);
    });
  }
  _pump() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const len0 = b1 & 0x7f;
      let len = len0, off = 2;
      if (len0 === 126) { len = this.buf.readUInt16BE(2); off = 4; }
      else if (len0 === 127) { len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) break;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      const msg = JSON.parse(payload.toString());
      if (msg.id && this.waits.has(msg.id)) this.waits.get(msg.id)(msg);
      else if (msg.method) this.events.push(msg);
    }
  }
  send(method, params) {
    const id = ++this.id;
    const json = JSON.stringify({ id, method, params: params || {} });
    const data = Buffer.from(json);
    const header = Buffer.alloc(data.length < 126 ? 2 : 4);
    header[0] = 0x81;
    if (data.length < 126) header[1] = 0x80 | data.length;
    else { header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
    return new Promise((res) => this.waits.set(id, res));
  }
  waitEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setInterval(() => {
        const i = this.events.findIndex((e) => e.method === method);
        if (i >= 0) { clearInterval(t); resolve(this.events.splice(i, 1)[0]); }
      }, 50);
      setTimeout(() => { clearInterval(t); reject(new Error('wait ' + method + ' timeout')); }, timeoutMs || 15000);
    });
  }
}
(async () => {
  // 关闭上一轮残留的 smoke 标签页，避免读到旧页面的全局变量
  const tabs = await getJson('/json/list');
  for (const t of tabs) {
    if (t.url.includes('tests/smoke.html')) await getJson('/json/close/' + t.id, 'PUT').catch(() => {});
  }
  const tab = await getJson('/json/new?' + encodeURIComponent('http://127.0.0.1:8128/tests/smoke.html?t=' + Date.now()), 'PUT');
  const ws = new WS(tab.webSocketDebuggerUrl);
  await ws.connect();
  await ws.send('Runtime.enable');
  await ws.send('Page.enable');
  // 等待测试脚本把 title 改成 SMOKE_DONE（轮询）
  const deadline = Date.now() + 20000;
  let result = null;
  while (Date.now() < deadline) {
    const r = await ws.send('Runtime.evaluate', {
      expression: 'document.title === "SMOKE_DONE" ? document.getElementById("toast").textContent : ""',
      returnByValue: true,
    });
    const val = r.result && r.result.result && r.result.result.value;
    if (val) { result = JSON.parse(val); break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!result) {
    // 超时：抓页面异常与正文长度辅助定位
    const errInfo = await ws.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ title: document.title, err: window.__smokeError || null, len: document.body.innerHTML.length })',
      returnByValue: true,
    });
    console.error('测试超时', JSON.stringify(errInfo.result.result.value));
    process.exit(1);
  }
  let fail = 0;
  result.forEach((r) => {
    console.log((r.pass ? '✓ ' : '✗ ') + r.msg);
    if (!r.pass) fail++;
  });
  console.log(`\n冒烟测试：${result.length - fail}/${result.length} 通过`);
  await getJson('/json/close/' + tab.id, 'PUT').catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
