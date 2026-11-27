/* 无依赖 CDP 巡检：启动本机 Chrome，点击主要流程，收集 console 错误并截图。 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const URL = `file://${process.cwd()}/index.html`;
mkdirSync('tmp/ui', { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.cwd()}/tmp/cdp-profile`,
  '--window-size=1440,1600',
  URL,
], { stdio: 'ignore' });

const errors = [];
let msgId = 0;
let ws;
const pending = new Map();

async function waitEndpoint() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error('CDP endpoint not ready');
}

const wsUrl = await waitEndpoint();
ws = new WebSocket(wsUrl);
await new Promise((res) => (ws.onopen = res));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push(`exception: ${d.exception?.description ?? d.text}`);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(`console.error: ${m.params.args.map((a) => a.description ?? a.value ?? '').join(' ')}`);
  }
};

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) errors.push(`eval exception: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
  return r.result?.result?.value;
}
async function shot(name, full = true) {
  let params = { format: 'png' };
  if (full) {
    const h = await ev('document.documentElement.scrollHeight');
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: 1440, height: Math.min(h, 6000), scale: 1 };
  }
  const r = await send('Page.captureScreenshot', params);
  writeFileSync(`tmp/ui/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
}

await send('Runtime.enable');
await send('Page.enable');
await sleep(800);

// 1) 牌组页：切到五张炎刃牌组看错误态
await ev(`[...document.querySelectorAll('.deck-list-item')].find(b=>b.textContent.includes('五张炎刃'))?.click()`);
await sleep(200);
await shot('01-deck-printcap');

// 2) 交换页：选四印轮转
await ev(`document.querySelector('[data-tab=exchange]').click()`);
await sleep(200);
await ev(`(() => { const s=document.querySelector('.tab-exchange .deck-picker select'); s.value='deck-cycle'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
await sleep(300);
await shot('02-exchange-cycle');
const cycleVerdict = await ev(`document.querySelector('.batch-panel .verdict-badge')?.textContent`);
console.log('cycle batch verdict:', cycleVerdict);

// 直接整批应用预置方案，验证状态变化
await ev(`[...document.querySelectorAll('.preset-card button')].find(b=>b.textContent.includes('直接整批应用'))?.click()`);
await sleep(300);
const afterApply = await ev(`document.querySelector('.ok-banner')?.textContent ?? ''`);
console.log('apply banner:', afterApply.slice(0, 60));
await shot('03-exchange-applied');

// 3) 起手页：勾两张牌并换手
await ev(`document.querySelector('[data-tab=opening]').click()`);
await sleep(300);
await ev(`document.querySelectorAll('.tile-check')[0]?.click(); document.querySelectorAll('.tile-check')[2]?.click();`);
await sleep(150);
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('换手一次'))?.click()`);
await sleep(300);
await shot('04-opening-mulligan');

// 4) 种子对比：打开失败样本弹窗
await ev(`document.querySelector('[data-tab=simulate]').click()`);
await sleep(600);
await ev(`[...document.querySelectorAll('.rate-labels .link-btn')].find(b=>b.textContent.includes('调度后失败例') && !b.disabled)?.click()`);
await sleep(400);
const modalExists = await ev(`!!document.querySelector('.modal-backdrop')`);
console.log('failure modal open:', modalExists);
await shot('05-failure-modal');
await ev(`document.querySelector('.modal-head .icon-btn')?.click()`);
await sleep(200);

// 5) IO：填入示例并生成预览
await ev(`document.querySelector('[data-tab=io]').click()`);
await sleep(200);
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('填入内置'))?.click()`);
await sleep(150);
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='生成差异预览')?.click()`);
await sleep(300);
const previewRows = await ev(`document.querySelectorAll('.preview-row').length`);
console.log('preview rows:', previewRows);
await shot('06-import-preview');

// 6) 导入确认 → 应跳到牌组页且新牌组带 unresolved 错误
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('按以上选择确认导入'))?.click()`);
await sleep(300);
await ev(`[...document.querySelectorAll('.preview-confirm .link-btn')].find(b=>b.textContent.includes('前往牌组校验'))?.click()`);
await sleep(300);
const importedIllegal = await ev(`document.querySelector('.validation-panel .verdict-badge')?.textContent ?? ''`);
console.log('imported deck verdict:', importedIllegal);
const unresolvedHits = await ev(`[...document.querySelectorAll('.hit-error')].filter(e=>e.textContent.includes('不存在')).length`);
console.log('unresolved error blocks:', unresolvedHits);
await shot('07-imported-deck');

console.log('\nJS errors:', errors.length ? '\n' + errors.join('\n') : 'none');
ws.close();
chrome.kill();
process.exit(errors.length ? 1 : 0);
