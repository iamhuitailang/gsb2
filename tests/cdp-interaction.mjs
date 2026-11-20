// 基于 Chrome DevTools Protocol 的交互测试（Node 内置 WebSocket，零额外依赖）。
// 启动带远程调试的 headless Chrome，模拟真实鼠标事件：
//   1. 在 3D 画布点击 -> 选中面 -> UV 视图同步高亮
//   2. 在 UV 画布点击 -> 模型视图同步选中
//   3. 切缝模式点击 -> 切缝集合变化
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.TEST_URL || 'http://localhost:5231/?demo=1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = mkdtempSync(join(tmpdir(), 'uv-cdp-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--remote-debugging-port=9333',
  '--window-size=1600,900',
  `--user-data-dir=${userDir}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'ignore'] });

const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

let ws;
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }
    }, 8000);
  });
}

async function evaluate(expression) {
  let r;
  try {
    r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
  } catch (err) {
    err.message += ` | expression: ${String(expression).slice(0, 120)}`;
    throw err;
  }
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || 'evaluate 异常');
  }
  return r.result.value;
}

async function click(selector, x, y) {
  const rect = await evaluate(
    `(() => { const r = document.querySelector('${selector}').getBoundingClientRect();
      return { x: r.x, y: r.y }; })()`);
  const px = rect.x + x, py = rect.y + y;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
}

async function main() {
  // 1. 等调试端口可用并取页面 target
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9333/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch { /* 端口未就绪 */ }
    await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome 调试端口未就绪');

  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? entry.reject(new Error(`[${entry.method}] ${msg.error.message}`)) : entry.resolve(msg.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL });

  // 2. 等演示工作流（加载示例+展开+打包）完成
  await evaluate('new Promise((res) => { const t = setInterval(() => { if (window.__demoDone) { clearInterval(t); res(); } }, 100); setTimeout(() => res(), 15000); })');
  await sleep(500);

  const faceCount = await evaluate('window.uvApp.mesh.faces.length');
  check('演示网格已加载', faceCount === 340, `${faceCount} 面`);

  // 3. 在 3D 画布中心点击 -> 应选中某个面
  await click('#canvas-3d', 300, 400);
  await sleep(200);
  const selAfter3D = await evaluate('window.uvApp.selectedFaces.size');
  check('3D 点击选中了面', selAfter3D >= 1, `${selAfter3D} 个`);
  const pickedFace = await evaluate('[...window.uvApp.selectedFaces][0]');

  // 4. 验证 UV 视图同步高亮（UV 视图的 faceSet 与主控选区是同一集合）
  const uvSync = await evaluate('window.uvApp.uv.faceSet.size');
  check('UV 视图同步高亮选中面', uvSync === selAfter3D);
  const threeSync = await evaluate('window.uvApp.three.faceSet.size');
  check('3D 视图覆盖层同步', threeSync === selAfter3D);

  // 5. 在 UV 画布点击一个“与当前选中不同”的面：先取目标面的 UV 质心，换算成画布坐标
  const target = await evaluate(`(() => {
    const app = window.uvApp;
    const current = [...app.selectedFaces][0];
    // 找一个不同岛的面，保证点到不同区域
    const { faceIsland } = app.uv;
    const targetFace = app.mesh.faces.findIndex((_, f) => faceIsland[f] !== faceIsland[current]);
    const tri = app.mesh.uvSets[app.activeSet][targetFace];
    const u = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
    const v = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
    const [x, y] = app.uv.toCanvas(u, v);
    return { targetFace, x, y };
  })()`);
  const before = await evaluate('[...window.uvApp.selectedFaces][0]');
  await click('#canvas-uv', target.x, target.y);
  await sleep(200);
  const after = await evaluate('[...window.uvApp.selectedFaces][0]');
  check('UV 点击可反向定位模型面', after === target.targetFace && before !== after,
    `before=${before} after=${after} target=${target.targetFace}`);
  const threeAfterUV = await evaluate('window.uvApp.three.faceSet.size');
  check('反向选择同步到 3D 视图', threeAfterUV >= 1);

  // 6. 旋转相机后选区不丢失
  await evaluate('window.uvApp.three.sphere.theta += 1.2; window.uvApp.three._updateCamera();');
  const selAfterRotate = await evaluate('window.uvApp.selectedFaces.size');
  check('旋转相机后选区保留', selAfterRotate >= 1);

  // 7. 切缝模式：切到 seam 模式，找一个含内部边的面直接触发主控切缝处理
  await evaluate(`(() => {
    const sel = document.getElementById('select-mode');
    sel.value = 'seam';
    sel.dispatchEvent(new Event('change'));
  })()`);
  const seamsBefore = await evaluate('window.uvApp.mesh.seams.size');
  const seamFace = await evaluate(`(() => {
    const { faces, topology } = window.uvApp.mesh;
    for (let f = 0; f < faces.length; f++) {
      const hasInternal = [0, 1, 2].some((k) => {
        const c = f * 3 + k;
        return topology.opposite[c] >= 0;
      });
      if (hasInternal) return f;
    }
    return -1;
  })()`);
  check('找到含内部边的面', seamFace >= 0, `face=${seamFace}`);
  await evaluate(`window.uvApp.pickSeam3D(${seamFace})`);
  await sleep(100);
  const seamsAfter = await evaluate('window.uvApp.mesh.seams.size');
  check('切缝处理改变切缝集合', seamsAfter === seamsBefore + 1,
    `${seamsBefore} -> ${seamsAfter}`);
  const seamLines = await evaluate('window.uvApp.three.seamLines.geometry.attributes.position.count');
  check('3D 视图重绘切缝线', seamLines > 0, `${seamLines} 个顶点`);

  // 8. 报告结构与健康状态
  const report = await evaluate('JSON.stringify({ c: window.uvApp.report.islandCount, o: window.uvApp.report.overlaps.length, b: window.uvApp.report.outOfBounds.length })');
  const r = JSON.parse(report);
  check('检查报告已生成', r.c >= 2 && r.o === 0 && r.b === 0, JSON.stringify(r));

  // 9. 多 UV 套隔离：当前 2 套，编辑第 2 套不影响第 1 套
  const iso = await evaluate(`(() => {
    const app = window.uvApp;
    const snap = JSON.stringify(app.mesh.uvSets[0]);
    app.switchUvSet(1);
    app.pack();
    const unchanged = JSON.stringify(app.mesh.uvSets[0]) === snap;
    return { unchanged, sets: app.mesh.uvSets.length };
  })()`);
  check('切换并编辑第 2 套不覆盖第 1 套', iso.unchanged);
  check('存在 2 套 UV', iso.sets === 2);

  console.log(results.map((x) => `${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? ' — ' + x.detail : ''}`).join('\n'));
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('交互测试异常:', err);
  process.exitCode = 1;
}).finally(() => {
  try { ws?.close(); } catch { /* noop */ }
  chrome.kill();
  try { rmSync(userDir, { recursive: true, force: true }); } catch { /* noop */ }
});
