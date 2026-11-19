#!/usr/bin/env node
/** 纵向滚动对齐验证：多轨道下滚动后，左侧轨道头与右侧轨道内容保持齐平 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9344;
const profile = join(tmpdir(), `chrome-scroll-${process.pid}`);
mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1440,700',
  'http://127.0.0.1:4173/',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('4173'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* wait */ }
    await sleep(200);
  }
  throw new Error('Chrome 未就绪');
}

const ws = new WebSocket(await getWs());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let mid = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('EXC:', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++mid;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
await send('Runtime.enable');
await sleep(2200);

const result = await evalJs(`(async () => {
  const store = window.__store;
  for (let i = 0; i < 3; i++) store.addTrack();
  await new Promise((r) => setTimeout(r, 250));
  const tlScroll = document.getElementById('timeline-scroll');
  const hdScroll = document.getElementById('headers-scroll');
  const measure = (label) => {
    const headers = [...document.querySelectorAll('.track-header')];
    const h3 = headers[3]?.getBoundingClientRect();
    const canvas = document.getElementById('timeline-canvas').getBoundingClientRect();
    const expected = canvas.top + 3 * 96;
    return {
      label,
      scrollTop: Math.round(tlScroll.scrollTop),
      headerScrollTop: Math.round(hdScroll.scrollTop),
      header4Top: Math.round(h3?.top ?? -1),
      rightTrack4Top: Math.round(expected),
      aligned: Math.abs(Math.round(h3?.top ?? -1) - Math.round(expected)) <= 1,
    };
  };
  const at0 = measure('scroll=0');
  tlScroll.scrollTop = 120;
  tlScroll.dispatchEvent(new Event('scroll'));
  await new Promise((r) => setTimeout(r, 200));
  const at120 = measure('scroll=120');
  return {
    trackCount: store.project.tracks.length,
    synced: Math.abs(tlScroll.scrollTop - hdScroll.scrollTop) < 1,
    at0,
    at120,
  };
})()`);

console.log(JSON.stringify(result, null, 1));
const pass = result.synced && result.at0.aligned && result.at120.aligned && result.trackCount === 5;
console.log(pass ? '✅ 纵向滚动时左右轨道始终对齐且滚动同步' : '❌ 滚动对齐异常');
ws.close();
chrome.kill();
process.exit(pass ? 0 : 1);
