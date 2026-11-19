/* 像素级往返验证：浏览器真实排版导出 atlas+manifest，
 * 再由本脚本落盘，交由 test/pixel_verify.py 按 README 步骤重建并逐像素比对。
 * 运行：node test/pixel_verify.cjs   （需要本机 Chrome，完全离线）
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8932;
const ROOT = path.join(__dirname, '..', 'public');
const OUT = path.join(os.tmpdir(), 'atlas-pixel-verify');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  const dir = path.join(os.homedir(), '.cache/puppeteer/chrome-headless-shell');
  if (fs.existsSync(dir)) {
    const found = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'chrome-headless-shell') found.push(p);
      }
    })(dir);
    if (found.length) return found[0];
  }
  throw new Error('未找到 Chrome');
}

const getJson = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let msgId = 0;
function cdp(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const onMsg = (event) => {
      const m = JSON.parse(event.data.toString());
      if (m.id === id) {
        ws.removeEventListener('message', onMsg);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = (ws, expr) =>
  cdp(ws, 'Runtime.evaluate', {
    expression: `(async()=>{ ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  }).then((r) => {
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  });

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'sources'), { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-px-'));
  const port = 9400 + Math.floor(Math.random() * 100);
  const chrome = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + userDir, '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let targets;
    for (let i = 0; i < 40; i++) {
      try {
        targets = await getJson(`http://127.0.0.1:${port}/json/list`);
        if (targets.some((t) => t.type === 'page')) break;
      } catch {}
      await sleep(250);
    }
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    await cdp(ws, 'Page.enable');
    await cdp(ws, 'Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await sleep(1000);

    // 构造两张已知图案：A 正向超宽放不进窄画布、旋转后可放入；B 不旋转
    const payload = await evaluate(ws, `
      // 内容 60x50 → 单元格 64x54：正向宽 64 > 58 放不进；旋转后 54x64 可放入
      const setNum = (id,v) => { const el=document.getElementById(id); el.value=v;
        el.dispatchEvent(new Event('input',{bubbles:true})); };
      setNum('setWidth', 58); setNum('setHeight', 400);
      setNum('setPadding', 0); setNum('setExtrude', 2);
      await new Promise(r=>setTimeout(r,200));

      function makePng(w,h,draw){ const c=document.createElement('canvas'); c.width=w; c.height=h;
        draw(c.getContext('2d')); return new Promise(res=>c.toBlob(res,'image/png')); }
      // A：80x70 源图，内容位于 (10,10) 尺寸 60x50，四角颜色不同以便识别旋转
      const blobA = await makePng(80,70,ctx=>{
        ctx.fillStyle='#ff0000'; ctx.fillRect(10,10,12,12);           // 内容左上 红
        ctx.fillStyle='#00aa00'; ctx.fillRect(58,10,12,12);           // 内容右上 绿
        ctx.fillStyle='#0000ff'; ctx.fillRect(10,48,12,12);           // 内容左下 蓝
        ctx.fillStyle='#ffdd00'; ctx.fillRect(58,48,12,12);           // 内容右下 黄
        ctx.fillStyle='#aa00ff'; ctx.fillRect(33,28,14,14);           // 中心 紫
      });
      // B：40x40 源图，内容 (5,5) 30x30 灰色
      const blobB = await makePng(40,40,ctx=>{
        ctx.fillStyle='#808080'; ctx.fillRect(5,5,30,30);
        ctx.fillStyle='#000000'; ctx.fillRect(5,5,30,2); ctx.fillRect(5,33,30,2);
      });
      const dt = new DataTransfer();
      dt.items.add(new File([blobA],'mark_rot.png',{type:'image/png'}));
      dt.items.add(new File([blobB],'mark_flat.png',{type:'image/png'}));
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,500));

      window.__cap = [];
      URL.createObjectURL = (b)=>{ window.__cap.push(b); return 'blob:x'; };
      HTMLAnchorElement.prototype.click = function(){};
      document.getElementById('btnExportPng').click();
      document.getElementById('btnExportManifest').click();
      for (let i = 0; i < 40 && window.__cap.length < 2; i++) await new Promise(r=>setTimeout(r,50));
      await new Promise(r=>setTimeout(r,200));
      const read = async (b) => new Promise((res,rej)=>{
        const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(b);
      });
      // toBlob 是异步的，捕获顺序不保证；按 MIME 类型区分 PNG 与 JSON
      const pngBlob = window.__cap.find((b) => b.type === 'image/png');
      const jsonBlob = window.__cap.find((b) => b.type.includes('json'));
      return {
        atlasB64: (await read(pngBlob)).split(',')[1],
        manifest: await jsonBlob.text(),
        sourceA: (await read(blobA)).split(',')[1],
        sourceB: (await read(blobB)).split(',')[1],
        summary: document.getElementById('changeSummary').textContent,
      };
    `);

    fs.writeFileSync(path.join(OUT, 'atlas.png'), Buffer.from(payload.atlasB64, 'base64'));
    fs.writeFileSync(path.join(OUT, 'manifest.json'), payload.manifest);
    fs.writeFileSync(path.join(OUT, 'sources/mark_rot.png'), Buffer.from(payload.sourceA, 'base64'));
    fs.writeFileSync(path.join(OUT, 'sources/mark_flat.png'), Buffer.from(payload.sourceB, 'base64'));
    ws.close();
    console.log('浏览器产物已落盘:', OUT);
  } finally {
    chrome.kill();
    server.close();
    try {
      fs.rmSync(userDir, { recursive: true, force: true });
    } catch {
      // Chrome 进程可能仍持有文件句柄，忽略清理失败（系统会回收临时目录）
    }
  }
}

main().catch((e) => {
  console.error('像素验证产物生成失败:', e);
  process.exit(1);
});
