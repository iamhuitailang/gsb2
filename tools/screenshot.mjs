// 截图验证：区域拾取、分屏、热力图三种视图状态。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchChrome() {
  const { spawn } = await import('node:child_process');
  const port = 9333 + Math.floor(Math.random() * 400);
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--no-sandbox', `--remote-debugging-port=${port}`, '--window-size=1680,1000', 'about:blank',
  ]);
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return { chrome, port }; } catch {}
    await sleep(250);
  }
  throw new Error('Chrome 启动超时');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const { writeFileSync } = await import('node:fs');
const { chrome, port } = await launchChrome();
try {
  const tab = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: process.argv[2] || 'http://127.0.0.1:8931/index.html' });
  await sleep(2000);
  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(name, Buffer.from(s.data, 'base64'));
    console.log('saved', name);
  };

  // 载入球体并生成候选
  await evalJs(`document.getElementById('btn-sample-sphere').click()`);
  await sleep(300);
  await evalJs(`document.getElementById('btn-generate').click()`);
  await sleep(1200);
  // 选 25% 候选（第 3 张卡）
  await evalJs(`document.querySelectorAll('.candidate-card')[2].click()`);
  await sleep(500);

  // 程序化触发区域拾取：直接调用 viewer 的区域逻辑（模拟 raycast 命中中心像素）
  const regionInfo = await evalJs(`(function(){
    const viewer = window.__viewer || null;
    // 通过合成事件让 raycaster 命中模型
    const cv = document.querySelector('#viewer canvas');
    const r = cv.getBoundingClientRect();
    const ev = new PointerEvent('pointerdown', {clientX: r.left + r.width/2, clientY: r.top + r.height/2, button:0, bubbles:true});
    const evUp = new PointerEvent('pointerup', {clientX: r.left + r.width/2, clientY: r.top + r.height/2, button:0, bubbles:true});
    cv.dispatchEvent(ev); window.dispatchEvent(evUp);
    return new Promise(res=>setTimeout(()=>res(document.getElementById('region-vcount')?.textContent || 'none'), 400));
  })()`);
  console.log('区域拾取顶点数:', regionInfo);
  await sleep(300);
  await shot('/tmp/lod-region.png');

  // 分屏模式
  await evalJs(`document.querySelector("#view-mode [data-mode='split']").click()`);
  await sleep(600);
  await shot('/tmp/lod-split.png');

  // 热力图（回到叠加）
  await evalJs(`document.querySelector("#view-mode [data-mode='overlay']").click()`);
  await evalJs(`document.getElementById('view-heatmap').click()`);
  await sleep(900);
  await shot('/tmp/lod-heatmap-on.png');
} finally {
  chrome.kill();
}
