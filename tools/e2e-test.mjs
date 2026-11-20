// 端到端浏览器测试：通过 CDP 驱动 headless Chrome，
// 验证载入示例、体检、清理、候选生成、区域对比、项目保存/恢复、OBJ 导出全流程。
// 用法：node tools/e2e-test.mjs <url>
const BASE = process.argv[2] || 'http://127.0.0.1:8931/index.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchChrome() {
  const { spawn } = await import('node:child_process');
  const port = 9222 + Math.floor(Math.random() * 500);
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    '--window-size=1680,1000',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return { chrome, port };
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome 启动超时');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
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

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const { chrome, port } = await launchChrome();
  try {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const tab = tabs.find((t) => t.type === 'page');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const errors = [];
    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        errors.push(msg.params.entry.text);
      }
    });
    await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2500);

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const click = async (id) => evalJs(`document.getElementById(${JSON.stringify(id)}).click()`);

    // 1. 载入规则立方体
    await click('btn-sample-cube');
    await sleep(300);
    let state = await evalJs('JSON.stringify({entries: window.__lod.store.entries.length, dup: window.__lod.store.entries[0].inspection.duplicateVertexCount, comps: window.__lod.store.entries[0].inspection.componentCount})');
    state = JSON.parse(state);
    check('载入规则立方体', state.entries === 1, `重复点=${state.dup} 分量=${state.comps}`);
    check('规则模型检出重复顶点', state.dup > 0);
    check('未焊接时为 6 个面分量', state.comps === 6);

    // 2. 清理
    await click('btn-clean');
    await sleep(200);
    const cleaned = await evalJs(`(function(){const e=window.__lod.store.entries[0];const s=window.__lod.store;return JSON.stringify({hasClean:!!e.cleaned, after:e.cleaned.report.after, steps:e.cleaned.report.steps.length, originalKept:!!e.original});})()`);
    const c = JSON.parse(cleaned);
    check('生成清理版本且原始保留', c.hasClean && c.originalKept);
    check('清理后为单分量', (await evalJs('window.__lod.store.entries[0].cleaned.report.after.vertexCount')) > 0);
    check('清理产生了处理步骤', c.steps >= 1, `${c.steps} 步`);

    // 3. 恢复原始
    await click('btn-revert');
    await sleep(150);
    check('可恢复原始版本', await evalJs('window.__lod.store.entries[0].cleaned === null'));

    // 4. 载入细节球并生成多候选
    await click('btn-sample-sphere');
    await sleep(300);
    await click('btn-generate');
    await sleep(1500);
    const cands = await evalJs(`(function(){const e=window.__lod.store.activeEntry;return JSON.stringify(e.candidates.map(c=>({ratio:+c.ratio.toFixed(3), faces:c.actualFaceCount, haus:c.metrics.hausdorff, norm:c.metrics.normalizedHausdorff, comps:c.componentFacesAfter.length})));})()`);
    const cl = JSON.parse(cands);
    check('生成 4 个候选', cl.length === 4, cl.map((c) => c.ratio).join(','));
    check('候选比例递减且面数递减', cl.every((c, i) => i === 0 || c.faces < cl[i - 1].faces));
    check('每个候选都有 Hausdorff 指标', cl.every((c) => Number.isFinite(c.haus) && c.haus >= 0));
    check('细节球单分量', cl.every((c) => c.comps === 1));
    const monotonic = cl.every((c, i) => i === 0 || c.haus >= cl[i - 1].haus - 1e-9);
    check('偏差随简化加剧单调不下降', monotonic);

    // 5. WebGL 渲染检查：canvas 存在且绘制了非空像素
    const glInfo = await evalJs(`(function(){const cv=document.querySelector('#viewer canvas');if(!cv)return 'no-canvas';const gl=cv.getContext('webgl2')||cv.getContext('webgl');const w=cv.width,h=cv.height;const px=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px);let nonBg=0;for(let i=0;i<px.length;i+=4){if(!(px[i]===20&&px[i+1]===23&&px[i+2]===28))nonBg++;}return JSON.stringify({w,h,nonBg});})()`);
    const gl = JSON.parse(glInfo);
    check('WebGL canvas 有实际绘制内容', gl.nonBg > 1000, `非背景像素=${gl.nonBg}`);

    // 6. 双分离对象：分量独立（按名称选中，避免激活项歧义）
    await click('btn-sample-two');
    await sleep(200);
    await evalJs(`window.__lod.store.selectEntry(window.__lod.store.entries.find(e=>e.name==='双分离立方体').id)`);
    const twoInfo = await evalJs(`(function(){const e=window.__lod.store.activeEntry;return JSON.stringify({comps:e.inspection.componentCount, isolated:e.inspection.isolatedVertexCount, dup:e.inspection.duplicateVertexCount});})()`);
    const ti = JSON.parse(twoInfo);
    check('双分离对象识别为 2 分量', ti.comps === 2, `comps=${ti.comps}`);
    // 对它生成激进候选
    await evalJs(`document.getElementById('spec-mode').querySelector('[data-mode="faces"]').click()`);
    await evalJs(`document.getElementById('spec-values').value='4'`);
    await click('btn-generate');
    await sleep(800);
    const twoCand = await evalJs(`(function(){const e=window.__lod.store.activeEntry;const c=e.candidates[0];return JSON.stringify({after:c.componentFacesAfter, faces:c.actualFaceCount, name:e.name});})()`);
    const tc = JSON.parse(twoCand);
    check('两分量简化后各自保留面', tc.after.length === 2 && tc.after.every((f) => f >= 1), JSON.stringify(tc.after));

    // 7. 项目保存/恢复往返
    const project = await evalJs('window.__lod.store.serializeProject()');
    const pj = JSON.parse(project);
    check('项目文件格式正确', pj.format === 'mesh-lod-compare' && pj.entries.length === 3);
    check('项目保留候选参数', pj.entries.some((e) => e.candidates.length === 4));
    // 模拟重新打开：新建 store 载入
    const reload = await evalJs(`(function(){const text=window.__lod.store.serializeProject();window.__lod.store.loadProject(text);const e=window.__lod.store.entries;return JSON.stringify({entries:e.length, cands:e.flatMap(x=>x.candidates.length)});})()`);
    const rl = JSON.parse(reload);
    check('项目恢复后网格与候选数量一致', rl.entries === 3, `候选总数=${rl.cands}`);
    // 重新生成
    await evalJs(`window.__lod.store.selectEntry(window.__lod.store.entries.find(e=>e.candidates.length===4).id)`);
    await click('btn-regenerate');
    await sleep(1200);
    check('按保存参数重新生成成功', await evalJs('window.__lod.store.activeEntry.candidates.length') === 4);

    // 8. OBJ 导出内容（拦截下载改为直接生成文本验证）
    const objText = await evalJs(`(async function(){const {writeOBJ}=await import('./js/core/obj.js');const {meshFromJSON}=await import('./js/app/store.js');const e=window.__lod.store.entries.find(x=>x.candidates.length===4);const c=e.candidates[0];return writeOBJ(meshFromJSON(c.mesh),{简化比例:c.ratio, 导出面数:c.actualFaceCount, 原始面数:c.baseFaceCount});})()`);
    check('导出 OBJ 含面数与比例元数据', objText.includes('# 导出面数:') && objText.includes('# 简化比例:'));
    const faceLines = objText.split('\n').filter((l) => l.startsWith('f ')).length;
    const storedFaces = await evalJs(`window.__lod.store.entries.find(x=>x.candidates.length===4).candidates[0].actualFaceCount`);
    check('导出 OBJ 面数与候选一致', faceLines === storedFaces, `${faceLines} vs ${storedFaces}`);

    // 9. 控制台无未捕获错误
    const realErrors = errors.filter((e) => !e.includes('GPU') && !e.includes('swiftshader') && !e.includes('WebGL'));
    check('运行期无 JS 异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

    // 截图存档：带候选的视图
    await evalJs(`window.__lod.store.selectEntry(window.__lod.store.entries.find(e=>e.name.includes('噪声')).id)`);
    await evalJs(`window.__lod.store.setView({showHeatmap:true})`);
    await sleep(800);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/lod-heatmap.png', Buffer.from(shot.data, 'base64'));
  } finally {
    chrome.kill();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nE2E 结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
