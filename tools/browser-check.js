// 真实浏览器冒烟（零依赖，走 Chrome DevTools Protocol；Node 24 内置 WebSocket）
// 用法：node tools/browser-check.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = path.join(
  process.env.HOME,
  'Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell',
);
const PORT = 8199;
const TARGET_URL = `http://localhost:${PORT}/index.html`;

function getJson(u) {
  return new Promise((resolve, reject) => {
    http.get(u, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const root = path.join(__dirname, '..');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(root, rel === '/' ? 'index.html' : rel);
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(PORT, r));

  const chrome = spawn(CHROME, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${PORT + 1}`,
    '--window-size=1700,1400',
    TARGET_URL,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  chrome.stderr.on('data', (d) => (stderr += d.toString()));
  const cdpPort = PORT + 1;

  let tabs;
  for (let i = 0; i < 40; i++) {
    try {
      tabs = await getJson(`http://localhost:${cdpPort}/json`);
      if (tabs.length) break;
    } catch {}
    await sleep(250);
  }
  const page = tabs.find((t) => t.type === 'page' && t.url.includes('index.html')) || tabs.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面 target: ' + stderr.slice(-500));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, rej) => {
    ws.onopen = r;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1200);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面执行失败: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push({ name, ok: !!cond, extra: String(extra) });
    console.log(`${cond ? '  ✓' : '  ✗'} ${name} ${extra}`);
  };

  // 1. 基础渲染
  check('画布元素已生成', await evalJs(`document.querySelectorAll('canvas').length >= 2`));
  check('三个预设按钮', await evalJs(`document.querySelectorAll('.preset-btn').length === 3`));
  check('三角形卡片已渲染', await evalJs(`document.querySelectorAll('.tri-card').length >= 1`));
  check('无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));
  check('无 console.error', consoleErrors.length === 0, consoleErrors.join(' | '));

  // 2. 点选像素 -> 检查器出现采样点
  const rect = await evalJs(`(() => { const c = document.querySelector('.view-canvas').getBoundingClientRect(); return {x:c.x,y:c.y,w:c.width,h:c.height}; })()`);
  const cx = rect.x + rect.w * 0.5;
  const cy = rect.y + rect.h * 0.5;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
  await sleep(200);
  check('点选后检查器出现采样块', await evalJs(`document.querySelectorAll('.sample-block').length > 0`));
  check('检查器展示两种混合', await evalJs(`document.querySelectorAll('.blend-item').length === 2`));

  // 3. 切到中心采样再切回，采样点数量应变化
  await evalJs(`(() => { const s = document.querySelectorAll('select')[0]; s.value='center'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(150);
  const centerCount = await evalJs(`document.querySelectorAll('.sample-block').length`);
  await evalJs(`(() => { const s = document.querySelectorAll('select')[0]; s.value='msaa4'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(150);
  const msaaCount = await evalJs(`document.querySelectorAll('.sample-block').length`);
  check('中心采样 1 点 / MSAA 4 点', centerCount === 1 && msaaCount === 4, `${centerCount} vs ${msaaCount}`);
  // 重新点选一次，保证截图时检查器处于填充状态
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
  await sleep(200);

  // 4. 切换混合模式不报错，状态条文案变化
  await evalJs(`(() => { const s = document.querySelectorAll('select')[1]; s.value='stored'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(150);
  check('存储值混合状态条', await evalJs(`document.getElementById('status').textContent.includes('存储值混合')`));

  // 5. 切预设：共享边，诊断面板出现共享边信息
  await evalJs(`[...document.querySelectorAll('.preset-btn')].find(b=>b.textContent==='共享边').click()`);
  await sleep(200);
  check('共享边分析出现', await evalJs(`document.body.textContent.includes('共享边：')`));
  check('共享边方向相反提示', await evalJs(`document.body.textContent.includes('不重不漏')`));

  // 6. 录制 + 逐小步平移 + 重放
  await evalJs(`[...document.querySelectorAll('.preset-btn')].find(b=>b.textContent==='薄三角').click()`);
  await sleep(150);
  await evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('开始录制')).click()`);
  // 通过第一张三角形卡片的 nudge 按钮制造 3 步
  for (let i = 0; i < 3; i++) {
    await evalJs(`document.querySelector('.tri-card .nudge-grid button:nth-child(6)').click()`); // →
    await sleep(60);
  }
  const replayPanel = `document.querySelectorAll('.panel')[3]`;
  const trackLen = await evalJs(`Number(${replayPanel}.querySelector('input[type=range]').max)`);
  check('录制产生 3 步轨迹', trackLen === 3, `max=${trackLen}`);
  // 拖滑块回放
  await evalJs(`(() => { const r = ${replayPanel}.querySelector('input[type=range]'); r.value='1'; r.dispatchEvent(new Event('input')); })()`);
  await sleep(150);
  check('回放定位到第 1 帧', await evalJs(`${replayPanel}.textContent.includes('回放帧 1 / 3')`));

  // 7. 回到薄三角并点选一个「有部分覆盖」的边缘像素，让截图展示检查器
  await evalJs(`[...document.querySelectorAll('.preset-btn')].find(b=>b.textContent==='薄三角').click()`);
  await sleep(200);
  const target = await evalJs(`(() => {
    const c = document.querySelector('.view-canvas').getBoundingClientRect();
    // 薄斜条穿过画布中部，沿对角线扫描找一个覆盖 1~3 个采样点的像素
    const S = window.SamplerLab;
    return { x: c.x, y: c.y, w: c.width, h: c.height };
  })()`);
  // 斜条从左下到右上，点在约 (45%, 55%) 的像素上
  const ex = target.x + target.w * 0.46;
  const ey = target.y + target.h * 0.52;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ex, y: ey, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex, y: ey, button: 'left', clickCount: 1 });
  await sleep(300);
  const covered = await evalJs(`document.querySelector('.inspector .kv span')?.textContent || ''`);
  check('截图前检查器有采样块', await evalJs(`document.querySelectorAll('.sample-block').length > 0`));
  console.log('    选中像素覆盖信息:', covered);

  // 8. 保存记录 -> 落盘 -> 通过文件输入框导入 -> 验证复现成功（完整端到端）
  // 切预设会清空选中，先重新点选当前像素
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ex, y: ey, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex, y: ey, button: 'left', clickCount: 1 });
  await sleep(200);
  await evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('保存像素')).click()`);
  await sleep(100);
  const recordJson = await evalJs(`JSON.stringify(globalThis.__lastRecord)`);
  check('保存产生完整记录', typeof recordJson === 'string' && recordJson.includes('sampling-lab-pixel'));
  const recordPath = path.join(root, 'tmp-record.json');
  fs.writeFileSync(recordPath, recordJson);

  const docResp = await send('DOM.getDocument', { depth: -1, pierce: true });
  const findFileInput = (node) => {
    if (node.nodeName === 'INPUT' && (node.attributes || []).includes('file')) return node.backendNodeId;
    for (const c of node.children || []) {
      const r = findFileInput(c);
      if (r) return r;
    }
    return 0;
  };
  const backendNodeId = findFileInput(docResp.root);
  check('找到文件输入框', backendNodeId > 0);
  await send('DOM.setFileInputFiles', { files: [recordPath], backendNodeId });
  await sleep(400);
  const toast = await evalJs(`document.getElementById('toast').textContent`);
  check('导入记录复现成功', toast.includes('复现成功'), toast);

  // 9. 截图
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(root, 'tmp-browser-check.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  check('截图已保存', fs.existsSync(shotPath), shotPath);

  ws.close();
  chrome.kill();
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\n浏览器冒烟全部通过 ✓' : `\n${failed.length} 项失败 ✗`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
