/* 浏览器端到端冒烟（CDP）：node test/browser.e2e.cjs
   加载页面 → 切模式/精度 → 模拟导出读回 → 模拟坏文件 → 检查 DOM 与画布像素。 */
const BASE = 'http://localhost:8765/index.html';

async function cdpConnect() {
  const list = await (await fetch('http://localhost:9333/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return {
    send,
    eval: async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value,
    consoleErrors: () => events.filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map(e => e.params.args.map(a => a.value || a.description).join(' ')),
    exceptions: () => events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => e.params.exceptionDetails.text),
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); }
  else { failures++; console.error('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const c = await cdpConnect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.navigate', { url: BASE });
  await sleep(1500);

  // 1. 初始渲染
  const initial = await c.eval(`({
    blocks: MPC_APP.state.scene.blocks.length,
    seams: MPC_APP.state.scene.seams.length,
    verts: MPC_APP.state.scene.blocks.reduce((s,b)=>s+b.positions.length/3,0),
    seamRows: document.querySelectorAll('#seamRows tr').length,
    byteText: document.getElementById('byteTotal').textContent,
    canvasPainted: (()=>{ const cv=document.getElementById('canvasRest'); const x=cv.getContext('2d').getImageData(cv.width/2,cv.height/2,1,1).data; return Array.from(x); })(),
  })`);
  check('4 块、2 条接缝、905 顶点', initial.blocks === 4 && initial.seams === 2 && initial.verts === 905, initial);
  check('接缝表渲染 2 行', initial.seamRows === 2, initial);
  check('字节总数已显示', /字节/.test(initial.byteText), initial.byteText);
  check('还原画布有非背景像素', initial.canvasPainted.some((v, i) => i < 3 && v !== 16), initial.canvasPainted);

  // 2. 三种范围模式 + 四档精度切换，接缝错位符合预期
  const matrix = await c.eval(`(async () => {
    const out = [];
    for (const mode of ['global','perBlock','aligned']) {
      for (const bits of [8,10,12,16]) {
        document.getElementById('mode').value = mode;
        document.getElementById('mode').dispatchEvent(new Event('change'));
        document.getElementById('bits').value = String(bits);
        document.getElementById('bits').dispatchEvent(new Event('change'));
        await new Promise(r=>setTimeout(r,30));
        const p = MPC_APP.state.currentPack;
        out.push({ mode, bits, shared: p.seamReport.sharedMaxGap, tDelta: p.seamReport.tJunctionMaxDelta,
          ranges: p.ranges.length, overallMax: p.overall.max });
      }
    }
    return out;
  })()`);
  const aligned8 = matrix.find(m => m.mode === 'aligned' && m.bits === 8);
  check('对齐模式 8 位共享顶点零错位', aligned8.shared === 0, aligned8);
  check('对齐模式只有 2 个范围（ABC 分量 + D）', aligned8.ranges === 2, aligned8);
  const per8 = matrix.find(m => m.mode === 'perBlock' && m.bits === 8);
  check('逐块 8 位出现非零裂缝', per8.shared > 0, per8);
  check('全局模式只有 1 个范围', matrix.every(m => m.mode !== 'global' || m.ranges === 1));
  check('16 位误差小于 8 位（同模式）', (() => {
    const a = matrix.find(m => m.mode === 'perBlock' && m.bits === 16);
    const b = matrix.find(m => m.mode === 'perBlock' && m.bits === 8);
    return a.overallMax < b.overallMax;
  })());

  // 3. 二进制导出 → 读回：在页面里走真实 encode/decode + 复现校验
  const roundtrip = await c.eval(`(() => {
    const scene = MPC_APP.state.scene;
    const pack = MPC.quantize.packScene(scene, 'perBlock', 10, 0.01);
    const bytes = MPC.binary.encode(scene, pack, { threshold: 0.01 });
    const dec = MPC.binary.decode(bytes);
    const verify = MPC_APP.verifyRoundtrip(dec.scene, dec.mode, dec.bits, dec.codesPerBlock);
    return { size: bytes.length, mode: dec.mode, bits: dec.bits, warnings: dec.warnings, verify,
      head: Array.from(bytes.slice(0,4)).map(x=>String.fromCharCode(x)).join('') };
  })()`);
  check('导出文件以 MPCM 魔数开头', roundtrip.head === 'MPCM', roundtrip.head);
  check('读回参数一致（perBlock/10 位）', roundtrip.mode === 'perBlock' && roundtrip.bits === 10, roundtrip);
  check('无警告且复现校验通过', roundtrip.warnings.length === 0 && roundtrip.verify.ok &&
    roundtrip.verify.posMismatch === 0 && roundtrip.verify.codeMismatch === 0, roundtrip);

  // 4. 不完整文件：截断 → 具体错误提示，且原预览不变
  const corrupt = await c.eval(`(() => {
    const scene = MPC_APP.state.scene;
    const before = scene.blocks[0].positions[1];
    const pack = MPC.quantize.packScene(scene, 'global', 12, 0.01);
    const bytes = MPC.binary.encode(scene, pack, { threshold: 0.01 });
    const cut = bytes.slice(0, Math.floor(bytes.length * 0.4));
    let msg = '', offset = null;
    try { MPC.binary.decode(cut); } catch (e) { msg = e.message; offset = e.offset; }
    const after = MPC_APP.state.scene.blocks[0].positions[1];
    return { msg, offset, sceneUntouched: before === after };
  })()`);
  check('截断文件报"不完整/截断"具体信息且含偏移', /不完整|截断|MEND/.test(corrupt.msg) && corrupt.offset != null, corrupt);
  check('解码失败后原场景预览数据未被改动', corrupt.sceneUntouched, corrupt);

  // 5. 不支持版本
  const badVer = await c.eval(`(() => {
    const scene = MPC_APP.state.scene;
    const pack = MPC.quantize.packScene(scene, 'global', 12, 0.01);
    const bytes = MPC.binary.encode(scene, pack, { threshold: 0.01 });
    new DataView(bytes.buffer).setUint16(4, 7, true);
    let msg = ''; try { MPC.binary.decode(bytes); } catch (e) { msg = e.message; }
    return msg;
  })()`);
  check('版本 7 报不支持并指明 v1', /v7/.test(badVer) && /v1/.test(badVer), badVer);

  // 6. 页面上的"模拟截断文件"按钮：状态条变为 error 且文案具体
  const uiError = await c.eval(`(async () => {
    document.getElementById('importCorrupt').click();
    await new Promise(r=>setTimeout(r,200));
    const el = document.getElementById('fileStatus');
    return { cls: el.className, text: el.textContent.slice(0, 60) };
  })()`);
  check('UI 截断按钮给出 error 状态条与具体文案', uiError.cls.includes('error') && uiError.text.length > 10, uiError);

  // 7. 模式说明与对齐横幅
  const notes = await c.eval(`(() => {
    document.getElementById('mode').value = 'aligned';
    document.getElementById('mode').dispatchEvent(new Event('change'));
    return { banner: document.getElementById('alignedBanner').style.display,
      notes: document.querySelectorAll('#modeNotes .note').length,
      bannerText: document.getElementById('alignedBanner').textContent.includes('连通分量') };
  })()`);
  check('对齐模式显示连通分量横幅与 4 条块说明', notes.banner !== 'none' && notes.notes === 4 && notes.bannerText, notes);

  // 8. 控制台无 JS 错误
  const errs = c.consoleErrors().concat(c.exceptions());
  check('浏览器控制台无未捕获错误', errs.length === 0, errs);

  c.close();
  console.log(failures ? `\n${failures} 项浏览器检查失败` : '\n全部浏览器端到端检查通过');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
