/**
 * tools/browser-smoke.js — 无头浏览器端到端冒烟（需先启动 Chrome 远程调试与静态服务器）
 * 用法：
 *   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *     --headless=new --disable-gpu --remote-debugging-port=9222 about:blank &
 *   node tools/serve.js &
 *   node tools/browser-smoke.js
 */
const target = process.argv[2] || 'http://localhost:5173/index.html';
const failures = [];
function check(name, cond, detail) {
  console.log((cond ? '✔' : '✖') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!cond) failures.push(name);
}

(async () => {
  const ver = await (await fetch('http://localhost:9222/json/version')).json();
  const browserWs = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];
  const send = (method, params = {}, sessionId) => new Promise(resolve => {
    const mid = ++id; pending.set(mid, resolve);
    browserWs.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  let sessionId;
  browserWs.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push('EXCEPTION: ' + (e.exception?.description || e.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('console.error: ' + m.params.args.map(a => a.description || a.value).join(' '));
    }
  });
  await new Promise(r => browserWs.addEventListener('open', r, { once: true }));
  const t = await send('Target.createTarget', { url: 'about:blank' });
  sessionId = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: target }, sessionId);
  await new Promise(r => setTimeout(r, 1500));

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  // 1. 初始演示场景
  const init = await evalJs(`(() => {
    const a = window.__app;
    return {
      icons: a.scene.icons.length,
      bg: !!a.scene.bg,
      mode: a.state.mode,
      resultCards: document.querySelectorAll('#results .metric-card').length,
      listItems: document.querySelectorAll('#icon-list li').length,
      scanOpts: document.querySelectorAll('#scan-icon option').length,
    };
  })()`);
  check('初始加载两个演示提示并产出结果', init.icons === 2 && init.resultCards >= 3 && init.listItems === 2 && init.scanOpts === 2,
    JSON.stringify(init));

  // 2. 正常视图下红圆 vs 白底应有明显色差
  const normalMetrics = await evalJs(`(() => {
    const c = window.__app.state.resultCache.get('normal');
    const r = c.iconResults[0];
    return { fullMean: r.summary.full.mean, edgeMean: r.summary.edge.mean,
      edgeCount: r.summary.edge.count, transCount: r.summary.transparentCount,
      fullCount: r.summary.full.count, contrastMin: r.summary.contrastFull.min };
  })()`);
  check('不透明像素色差统计有效', normalMetrics.fullCount > 100 && normalMetrics.fullMean > 8,
    JSON.stringify(normalMetrics));
  check('半透明边缘被单独统计', normalMetrics.edgeCount > 5, 'edge=' + normalMetrics.edgeCount);
  check('全透明像素单独计数', normalMetrics.transCount > 0, 'transparent=' + normalMetrics.transCount);
  check('边缘色差小于不透明区（与背景更融合）', normalMetrics.edgeMean < normalMetrics.fullMean);
  check('WCAG 对比度已计算且大于 1:1', normalMetrics.contrastMin > 1.05, 'contrast=' + normalMetrics.contrastMin);

  // 3. 切换到绿色盲：位置尺寸不变，数值发生变化
  const before = await evalJs(`JSON.stringify(window.__app.scene.icons.map(i=>({x:i.x,y:i.y,w:i.w,h:i.h})))`);
  await evalJs(`document.querySelector('#mode-bar button[data-mode="deutan"]').click()`);
  await new Promise(r => setTimeout(r, 400));
  const after = await evalJs(`JSON.stringify(window.__app.scene.icons.map(i=>({x:i.x,y:i.y,w:i.w,h:i.h})))`);
  check('切换视图模式不改变图标位置尺寸', before === after);
  const deutan = await evalJs(`(() => {
    const c = window.__app.state.resultCache.get('deutan');
    const pair = c.pairResults[0];
    return { pairMean: pair.full.mean, pairMin: pair.full.min, overlap: pair.overlapCount };
  })()`);
  check('绿色盲下两提示仍有逐像素对比数据', deutan.overlap > 100, JSON.stringify(deutan));

  // 4. 灰度模式
  await evalJs(`document.querySelector('#mode-bar button[data-mode="gray"]').click()`);
  await new Promise(r => setTimeout(r, 300));
  const grayOk = await evalJs(`!!window.__app.state.resultCache.get('gray')`);
  check('灰度模式产出分析结果', grayOk);
  await evalJs(`document.querySelector('#mode-bar button[data-mode="normal"]').click()`);
  await new Promise(r => setTimeout(r, 300));

  // 5. 热力图与透明分类叠加
  await evalJs(`document.getElementById('btn-overlay-heat').click()`);
  const heatOverlay = await evalJs(`window.__app.scene.overlay?.type`);
  check('色差热力图叠加可开启', heatOverlay === 'heat');
  await evalJs(`document.getElementById('btn-overlay-alpha').click()`);
  const alphaOverlay = await evalJs(`window.__app.scene.overlay?.type`);
  check('透明区分类叠加可开启', alphaOverlay === 'alpha');
  await evalJs(`document.getElementById('btn-overlay-none').click()`);

  // 6. 最难位置扫描
  await evalJs(`document.getElementById('scan-step').value = 20`);
  await evalJs(`document.getElementById('btn-scan').click()`);
  // 扫描为异步任务，轮询完成
  let scan = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250));
    scan = await evalJs(`window.__app.state.lastScan ? {
      hardest: window.__app.state.lastScan.hardest,
      easiest: window.__app.state.lastScan.easiest,
      gridLen: window.__app.state.lastScan.grid.length,
      overlay: window.__app.scene.overlay?.type,
    } : null`);
    if (scan) break;
  }
  check('扫描完成并给出最难/最易位置', !!scan && scan.overlay === 'scan' &&
    scan.hardest.x !== scan.easiest.x, JSON.stringify(scan));
  check('扫描网格有完整数据', !!scan && scan.gridLen > 10);

  // 7. 快照并排比较
  await evalJs(`document.getElementById('btn-snap').click()`);
  const snapCount = await evalJs(`window.__app.state.snapshots.length`);
  check('快照可保存', snapCount === 1);

  // 8. 改色 + 加符号后再快照
  await evalJs(`(() => {
    const ic = window.__app.scene.icons[0];
    ic.tintHue = 140; ic.symbol = 'plus';
    document.getElementById('btn-snap').click();
  })()`);
  const snap2 = await evalJs(`window.__app.state.snapshots.length`);
  check('改色加符号后可再存快照对比', snap2 === 2);

  // 9. 报告 JSON 载荷可构建且含坐标
  const payload = await evalJs(`(() => {
    // 复用导出前的收集逻辑（直接调内部函数不可见，改用 Report 构建字符串）
    const p = window.__app;
    // 触发一次导出但拦截下载：覆盖 URL.createObjectURL
    let captured = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => { captured = b; return 'blob:x'; };
    URL.revokeObjectURL = () => {};
    document.getElementById('btn-export-json').click();
    URL.createObjectURL = orig;
    return captured.text();
  })()`);
  const report = JSON.parse(payload);
  check('JSON 报告含多视图结果', report.viewModes.length === 5);
  check('报告记录图标坐标尺寸', report.scene.icons[0].x >= 0 && report.scene.icons[0].width > 0);
  check('报告含最难位置扫描', report.worstPositionScans.length === 1 &&
    typeof report.worstPositionScans[0].hardest.x === 'number');
  check('报告含快照记录', report.snapshots.length === 2);
  check('报告区分半透明边缘与全透明',
    report.viewModes[0].iconVsBackground[0].semiTransparentEdge.count > 0 &&
    report.viewModes[0].iconVsBackground[0].fullyTransparentPixels > 0);

  // 10. 截图（当前画布）
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  require('node:fs').writeFileSync('/tmp/smoke-final.png', Buffer.from(shot.data, 'base64'));

  console.log('\n页面错误日志:', logs.length ? '\n' + logs.join('\n') : '(none)');
  console.log(`\n结果：${failures.length ? failures.length + ' 项失败' : '全部通过'}`);
  browserWs.close();
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('冒烟脚本异常:', e); process.exit(1); });
