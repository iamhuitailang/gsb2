// run-browser.js —— 用 CDP 驱动无头 Chrome 跑浏览器冒烟测试，零外部依赖
// 运行：node tests/run-browser.js
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5175/';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=9333', '--user-data-dir=/tmp/cdp-profile',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://localhost:9333/json/new?' + URL, { method: 'PUT' });
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* 重试 */ }
    await sleep(250);
  }
  throw new Error('无法连接 Chrome CDP');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  return (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

try {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL });
  await sleep(2500); // 等 ESM 加载与首次渲染

  const smokeSrc = await readFile(join(HERE, 'browser-smoke.js'), 'utf8');
  const evalRes = await send('Runtime.evaluate', {
    expression: `(async () => { ${smokeSrc} })()`,
    awaitPromise: true, returnByValue: true,
  });
  if (evalRes.exceptionDetails) {
    console.error('页面脚本异常：', evalRes.exceptionDetails.text, evalRes.exceptionDetails.exception?.description);
    process.exit(1);
  }
  const results = evalRes.result.result.value;
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.ok) { console.log(`  ✓ ${r.name}${r.extra ? '（' + r.extra + '）' : ''}`); pass++; }
    else { console.error(`  ✗ ${r.name}${r.extra ? '：' + r.extra : ''}`); fail++; }
  }
  console.log(`\n浏览器冒烟：${pass} 通过，${fail} 失败`);

  // 顺带截一张图存证
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(ROOT, 'tmp-screenshot.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('截图已存：tmp-screenshot.png');

  ws.close();
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('CDP 驱动失败：', e.message);
  process.exit(1);
} finally {
  chrome.kill('SIGKILL');
}
