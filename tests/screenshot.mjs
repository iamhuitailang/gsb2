#!/usr/bin/env node
/** 截图：渲染页面并保存 PNG，用于人工检查布局（标尺/轨道头/时间线对齐） */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9339;
const profile = join(tmpdir(), `chrome-shot-${process.pid}`);
mkdirSync(profile, { recursive: true });
const outPath = new URL('./timeline-screenshot.png', import.meta.url).pathname;

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1440,900',
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
await sleep(2500);
// 等资源解码与波形绘制
await evalJs('window.__engine.loadProject(window.__store.project)');
await sleep(1200);
// 缩放到能看到整个工程
await evalJs(`(() => {
  const tl = window.__timeline;
  const store = window.__store;
  const width = document.getElementById('timeline-scroll').clientWidth;
  store.view.pxPerSecond = Math.min(600, (width - 40) / Math.max(4, store.project.length));
  store.view.scrollTime = 0;
  store.commit();
  tl.refresh();
})()`);
await sleep(600);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
console.log('截图已保存:', outPath);
ws.close();
chrome.kill();
process.exit(0);
