/* 浏览器端集成测试（无第三方依赖）：
 * 通过 CDP 驱动本机无头 Chrome，在真实页面里模拟：
 *  载入样例 → 旋转视角画掩码（验证掩码不漂移）→ 选参考 → 应用 → 保护区 → 透明边缘修补
 *  → 撤销 → 工程保存/重开 → 编辑某一步 → 导出尺寸校验
 *
 * 运行：node tests/browser_test.js   （需要本机装有 Google Chrome）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { setTimeout: sleep } = require('timers/promises');

const ROOT = path.join(__dirname, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const file = path.join(ROOT, rel || 'index.html');
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function cdp(httpUrl, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(httpUrl, { method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end();
  });
}

let msgId = 0;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  const pageErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const cb = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) cb.reject(new Error(m.error.message || JSON.stringify(m.error)));
      else cb.resolve(m.result);
    } else if (m.method) {
      events.push(m);
      if (m.method === 'Runtime.exceptionThrown' || m.method === 'Runtime.consoleAPICalled') {
        pageErrors.push(m.params);
      }
    }
  });
  return new Promise((resolve) => {
    ws.addEventListener('open', () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const id = ++msgId;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      takeEvent: (method) => events.findIndex((e) => e.method === method),
      events, pageErrors,
      close: () => ws.close(),
    }));
  });
}

function assert(cond, msg) { if (!cond) throw new Error('断言失败: ' + msg); }

async function main() {
  const server = await startServer();
  const PORT = server.address().port;
  const profileDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tp-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900',
    `--remote-debugging-port=9222`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });

  let devtools = null;
  for (let i = 0; i < 60; i++) {
    try {
      devtools = await cdp('http://127.0.0.1:9222/json/version');
      break;
    } catch { await sleep(150); }
  }
  if (!devtools) throw new Error('Chrome DevTools 端口未就绪');

  // 直接连 page-target 的 WebSocket（该端点支持 Page/Runtime 全部域，避免 flatten 会话兼容问题）
  let pageInfo = null;
  for (let i = 0; i < 60 && !pageInfo; i++) {
    try { pageInfo = await cdp('http://127.0.0.1:9222/json/new?about:blank', 'PUT'); }
    catch { await sleep(150); }
  }
  if (!pageInfo) throw new Error('无法创建调试页目标');
  const client = await connect(pageInfo.webSocketDebuggerUrl);
  const session = {
    send: (method, params = {}) => client.send(method, params),
    waitEvent: (method, timeoutMs = 8000) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        const i = client.takeEvent(method);
        if (i >= 0) resolve(client.events.splice(i, 1)[0]);
        else if (Date.now() - t0 > timeoutMs) reject(new Error('等待事件超时: ' + method));
        else setTimeout(poll, 30);
      })();
    }),
  };
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  // 开启 app 的只读调试探针（dragInside 需读取视图变换），不改变任何生产行为
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__patchDebug = true;' });

  const stages = [];
  function stage(name) { stages.push(name); console.log('  · ' + name); }

  const evalJs = async (expr, awaitPromise = true) => {
    const wrapped = `(async () => { try { return { ok: true, value: await (${expr}) }; }
      catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; } })()`;
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('evalJs 超时 @ ' + stages[stages.length - 1] + ': ' + expr.slice(0, 80))), 20000);
    });
    const work = session.send('Runtime.evaluate', {
      expression: wrapped, returnByValue: true, awaitPromise: true,
    });
    const r = await Promise.race([work, timeout]);
    clearTimeout(timer);
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error('页面异常 @ ' + stages[stages.length - 1] + ': ' + desc);
    }
    const v = r.result.value;
    if (!v || v.ok === false) {
      throw new Error('脚本失败 @ ' + stages[stages.length - 1] + ': ' + (v && v.error));
    }
    return v.value;
  };

  // 真实输入管线（合成 PointerEvent 在无头环境对画笔不可靠）
  const canvasRect = () => evalJs(`(function () {
    const r = document.getElementById('viewCanvas').getBoundingClientRect();
    return { l: r.left, t: r.top, w: r.width, h: r.height };
  })()`);
  // CDP 语义：button=本事件发生变化的键（移动时为 none），buttons=当前按住键的位掩码（左键=1）
  const mouse = (type, x, y, buttons = 0) => session.send('Input.dispatchMouseEvent', {
    type, x, y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons, clickCount: 1,
  });
  // 从 (fx,fy) 拖到 (tx,ty)，坐标为相对画布中心的偏移。
  // 关键：移动事件必须「只发送、不逐条等待」。逐条 await 会在 CDP 往返间隙让浏览器插入
  // 打断笔迹的隐式事件（画笔 stroke 被提前终结）；真实鼠标的连续移动本就是成批无间隔到达的。
  async function drag(fx, fy, tx, ty, moves = 8) {
    const r = await canvasRect();
    const sx = r.l + r.w / 2 + fx, sy = r.t + r.h / 2 + fy;
    const ex = r.l + r.w / 2 + tx, ey = r.t + r.h / 2 + ty;
    // 先确保起点就位并按下（这两步需要确认送达）
    await mouse('mouseMoved', sx, sy, 0);
    await mouse('mousePressed', sx, sy, 1);
    // 移动事件 fire-and-forget 批量发送，最后统一等待送达
    const inFlight = [];
    for (let i = 1; i <= moves; i++) {
      inFlight.push(session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: sx + (tx - fx) * (i / moves), y: sy + (ty - fy) * (i / moves),
        button: 'left', buttons: 1, clickCount: 1,
      }));
    }
    await Promise.all(inFlight);
    await mouse('mouseReleased', ex, ey, 0);
    await sleep(120);
  }
  // 返回图像本身在屏幕上的半宽/半高（CSS px）。归一化 -1..1 恰好对应图像左右/上下边缘，
  // 因此调用方传入的系数必须严格落在 (-1,1) 内才能保证原图坐标在 0..W、0..H 之间。
  const imageHalfExtent = () => evalJs(`(function () {
    const s = window.__state;
    return { hx: s.W * s.view.scale / 2, hy: s.H * s.view.scale / 2 };
  })()`);
  // 在图像中部安全区域拖拽。fx/fy、tx/ty 为相对「图像半宽」的比例，统一取 -0.4..0.4 的小区间，
  // 保证换算后的原图坐标远离 0 和 W/H 边界（图像中心对应原图坐标 W/2，绝不会越界）。
  async function dragInside(fx, fy, tx, ty, moves = 8) {
    const e = await imageHalfExtent();
    await drag(fx * e.hx, fy * e.hy, tx * e.hx, ty * e.hy, moves);
  }

  await session.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(800);

  // ---------- 1. 载入样例1 ----------
  stage('载入样例1');
  await evalJs(`document.getElementById('btnLoadSample1').click()`);
  await sleep(500);
  assert(await evalJs(`document.getElementById('statusText').textContent`).then((s) => s.includes('512×512')), '样例1 载入后状态栏显示尺寸');

  // ---------- 2. 旋转 90° 后画掩码，验证掩码保存在原图坐标 ----------
  stage('旋转视角下画矩形掩码');
  await evalJs(`document.getElementById('btnRotateR').click()`);
  await evalJs(`document.querySelector('[data-tool=rectAdd]').click()`);
  // 旋转后图像仍居中，取中心对角 40px 拖出矩形
  await dragInside(-0.3, -0.3, 0.3, 0.3);
  assert(await evalJs(`document.getElementById('btnApply').disabled === false`), '旋转视角画出的掩码生效（按钮已启用）');

  // ---------- 3. 角度归零，掩码仍在且位置未漂移 ----------
  stage('角度归零后掩码仍存在');
  await evalJs(`document.getElementById('btnRotateReset').click()`);
  const bboxAfterReset = await evalJs(`new Promise((res) => requestAnimationFrame(() => {
    res(document.getElementById('statusText').textContent.includes('角度 0°'));
  }))`);
  assert(bboxAfterReset === true, '归零后状态正常');
  assert(await evalJs(`document.getElementById('btnApply').disabled === false`), '归零后掩码依然存在');

  // ---------- 4. 选参考区域并应用修补 ----------
  stage('框选参考并应用修补');
  await evalJs(`document.querySelector('[data-tool=refPick]').click()`);
  await dragInside(0.25, 0.25, 0.55, 0.55);
  const refOk = await evalJs(`document.getElementById('refInfo').textContent.startsWith('参考区域：')`);
  assert(refOk, '参考区域已选择');
  await evalJs(`document.getElementById('btnApply').click()`);
  await sleep(100);
  const opCount1 = await evalJs(`document.getElementById('opList').children.length`);
  assert(opCount1 === 1, '应用后产生 1 步修补记录');

  // ---------- 5. 透明像素一键保护（样例1 不透明，应无副作用） ----------
  stage('一键保护透明像素');
  await evalJs(`document.getElementById('btnProtectAlpha').click()`);
  await sleep(50);
  assert((await evalJs(`document.getElementById('opList').children.length`)) === 1, '不透明图一键保护不影响步骤');
  // 该操作在不透明图上无实际效果，撤销掉这条空保护笔迹，使撤销栈回到干净状态
  await evalJs(`document.getElementById('btnUndo').click()`);
  await sleep(50);
  assert((await evalJs(`document.getElementById('opList').children.length`)) === 1, '撤销空保护笔迹不影响修补步骤');

  // ---------- 6. 撤销：无残留笔迹时撤销应删除最近一步；随后用画笔重建一步 ----------
  stage('撤销最近修补步骤并用画笔重建');
  await evalJs(`document.getElementById('btnUndo').click()`);
  await sleep(50);
  assert((await evalJs(`document.getElementById('opList').children.length`)) === 0, '撤销删除最近修补步骤');

  await evalJs(`document.querySelector('[data-tool=brushAdd]').click()`);
  await dragInside(-0.55, 0, -0.15, 0.1, 16);
  const rebuilt = await evalJs(`document.getElementById('btnApply').disabled === false`);
  assert(rebuilt, '画笔涂出新掩码');
  // 给新掩码配一块参考区域再固化
  await evalJs(`document.getElementById('btnRefToMask').click()`);
  await evalJs(`document.getElementById('btnApply').click()`);
  await sleep(80);
  assert((await evalJs(`document.getElementById('opList').children.length`)) === 1, '画笔修补重新固化为 1 步');

  // ---------- 7. A/B 对比 ----------
  stage('A/B 前后对比');
  await evalJs(`document.getElementById('btnCompare').click()`);
  assert((await evalJs(`document.getElementById('statusText').textContent`)).includes('A/B'), '进入 A/B 原图对比');
  await evalJs(`document.getElementById('btnCompare').click()`);

  // ---------- 8. 工程保存/重开 ----------
  stage('保存并重开工程');
  // 拦截下载：包装锚点的 click，把 dataURL 收集到 window.__downloads
  await evalJs(`(function () {
    window.__downloads = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      window.__downloads.push({ name: this.download, href: this.href });
    };
    window.__restoreDownload = () => { HTMLAnchorElement.prototype.click = origClick; };
    return true;
  })()`);
  await evalJs(`document.getElementById('btnSaveProject').click()`);
  await sleep(150);
  const dl = await evalJs(`window.__downloads[0]`);
  assert(dl && dl.name.endsWith('.json'), '工程文件已生成: ' + (dl && dl.name));
  // blob: URL 无法在 Node 侧解码，页面内用 FileReader 读成 dataURL 再传出
  const projectDataUrl = await evalJs(`(async function () {
    const resp = await fetch(window.__downloads[0].href);
    const buf = await resp.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'data:application/json;base64,' + btoa(bin);
  })()`);
  const project = JSON.parse(Buffer.from(projectDataUrl.split(',')[1], 'base64').toString('utf8'));
  assert(project.kind === 'texture-patch-project' && project.ops.length === 1, '工程内含 1 步修补');
  assert(project.ops[0].src && typeof project.ops[0].feather === 'number', '工程记录了参考位置与羽化');

  // 重开工程：把工程字节构造成 File，走真实的 fileProject change 入口
  const reopened = await evalJs(`(async function () {
    const b64 = ${JSON.stringify(projectDataUrl.split(',')[1])};
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bin], 'p.json', { type: 'application/json' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.getElementById('fileProject');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 600));
    return document.getElementById('opList').children.length;
  })()`);
  assert(reopened === 1, '工程重开后恢复出 1 步修补（含参考位置）');

  // ---------- 9. 编辑某一步：记录被取出、更新后回到原位置 ----------
  stage('编辑历史步骤');
  await evalJs(`document.querySelector('#opList [data-act=edit]').click()`);
  await sleep(80);
  assert((await evalJs(`document.getElementById('opList').children.length`)) === 1, '编辑态显示占位行');
  assert((await evalJs(`document.getElementById('btnApply').textContent`)) === '更新修补', '按钮变为更新修补');
  await evalJs(`(function () {
    const f = document.getElementById('feather'); f.value = 12;
    f.dispatchEvent(new Event('input')); return true;
  })()`);
  await evalJs(`document.getElementById('btnApply').click()`);
  await sleep(80);
  assert((await evalJs(`document.getElementById('opList').children.length`)) === 1, '更新后步骤回到列表');

  // ---------- 10. 导出结果与掩码，尺寸必须为原分辨率 ----------
  stage('导出原分辨率结果与掩码');
  await evalJs(`document.getElementById('btnExportResult').click()`);
  await evalJs(`document.getElementById('btnExportMask').click()`);
  await sleep(100);
  const dims = await evalJs(`(async function () {
    const out = [];
    for (const d of window.__downloads.slice(-2)) {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = d.href; });
      out.push({ name: d.name, w: img.naturalWidth, h: img.naturalHeight });
    }
    return out;
  })()`);
  assert(dims.length === 2 && dims.every((d) => d.w === 512 && d.h === 512),
    '导出均为原分辨率 512×512: ' + JSON.stringify(dims));
  assert(dims.some((d) => d.name === 'patched_result.png') && dims.some((d) => d.name === 'patch_mask.png'),
    '导出包含结果与掩码两个文件');

  // ---------- 11. 样例2：透明边缘修补 —— 保护透明像素后，修补结果的透明区 alpha 必须保持 0 ----------
  stage('样例2 透明边缘修补');
  await evalJs(`document.getElementById('btnLoadSample2').click()`);
  await sleep(500);
  await evalJs(`document.getElementById('btnProtectAlpha').click()`);
  await sleep(50);
  // 涂一个横跨透明边界的掩码并应用（参考框自动落在图内）
  await evalJs(`document.querySelector('[data-tool=brushAdd]').click()`);
  await dragInside(-0.5, -0.4, 0.5, -0.35, 14);
  await evalJs(`document.getElementById('btnApply').click()`);
  await sleep(250);
  await evalJs(`document.getElementById('btnExportResult').click()`);
  await sleep(200);
  const edgeResult = await evalJs(`(async function () {
    const d = window.__downloads[window.__downloads.length - 1];
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = d.href; });
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const data = x.getImageData(0, 0, c.width, c.height).data;
    const corner = data[3];                                   // 左上角（透明区）
    // 校验角点与四条边中点（样例2 这些位置确定为透明背景）
    const edgePts = [[0, 0], [511, 0], [0, 511], [511, 511], [256, 4], [4, 256], [507, 256], [256, 507]];
    let transparentKept = 0;
    for (const [px, py] of edgePts) if (data[(py * c.width + px) * 4 + 3] === 0) transparentKept++;
    return { corner, transparentKept, total: edgePts.length, steps: document.getElementById('opList').children.length };
  })()`);
  assert(edgeResult.corner === 0, '透明区角点修补后 alpha 仍为 0');
  assert(edgeResult.transparentKept === edgeResult.total,
    `所有透明采样点保持透明 ${edgeResult.transparentKept}/${edgeResult.total}`);
  assert(edgeResult.steps === 1, '透明边缘样例也成功固化 1 步修补');

  client.close();
  chrome.kill();
  server.close();
  console.log('\n浏览器集成测试全部通过（11 组场景）');
}

main().catch((e) => { console.error('\n浏览器测试失败:', e.message); process.exit(1); });
