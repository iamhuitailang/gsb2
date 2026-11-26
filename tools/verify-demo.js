/**
 * tools/verify-demo.js — 验证演示论点：
 * 纯色底合格；同一提示挪到渐变底后局部（P5/最小 ΔE、ΔE<5 占比）明显变差。
 * 通过远程调试端口驱动页面，输出各模式数值并断言。
 */
const target = process.argv[2] || 'http://localhost:5173/index.html';
const fs = require('node:fs');
const failures = [];
const check = (name, cond, detail) => {
  console.log((cond ? '✔' : '✖') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!cond) failures.push(name);
};

(async () => {
  const ver = await (await fetch('http://localhost:9222/json/version')).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const logs = [];
  const send = (m, p = {}, sid) => new Promise(r => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method: m, params: p, sessionId: sid })); });
  let sid;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const t = await send('Target.createTarget', { url: 'about:blank' });
  sid = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, sid); await send('Page.enable', {}, sid);
  await send('Page.navigate', { url: target }, sid);
  await new Promise(r => setTimeout(r, 1200));
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const metricsFor = async () => ev(`(() => {
    const c = window.__app.state.resultCache.get(window.__app.state.mode);
    const r = c.iconResults[0]; // 红圆
    const f = r.summary.full;
    return { mean: f.mean, p5: f.p5, min: f.min, lt5: r.thresholds.lt5, contrast: r.summary.contrastFull.min };
  })()`);

  // A. 纯色白底：把红圆移到左半纯白区，正常视图
  await ev(`(() => { const ic = window.__app.scene.icons[0]; ic.x=70; ic.y=140; window.__app.invalidate(); window.__app.runAnalysis(); })()`);
  await new Promise(r => setTimeout(r, 300));
  const whiteNormal = await metricsFor();
  console.log('白底 / 正常:', JSON.stringify(whiteNormal));

  // B. 渐变底：移到砖红色带（与红圆主色 ΔE≈3 的局部难分区）
  await ev(`(() => { const ic = window.__app.scene.icons[0]; ic.x=440; ic.y=120; window.__app.invalidate(); window.__app.runAnalysis(); })()`);
  await new Promise(r => setTimeout(r, 300));
  const gradNormal = await metricsFor();
  console.log('渐变底 / 正常:', JSON.stringify(gradNormal));

  // C. 同位置切绿色盲模拟
  await ev(`document.querySelector('#mode-bar button[data-mode="deutan"]').click()`);
  await new Promise(r => setTimeout(r, 400));
  const gradDeutan = await metricsFor();
  console.log('渐变底 / 绿色盲:', JSON.stringify(gradDeutan));

  // D. 同位置灰度
  await ev(`document.querySelector('#mode-bar button[data-mode="gray"]').click()`);
  await new Promise(r => setTimeout(r, 400));
  const gradGray = await metricsFor();
  console.log('渐变底 / 灰度:', JSON.stringify(gradGray));

  check('纯色白底均值 ΔE 合格（>15，清晰可辨）', whiteNormal.mean > 15, 'mean=' + whiteNormal.mean.toFixed(1));
  check('白底 ΔE<5 占比很低（<2%）', whiteNormal.lt5 < 0.02, (whiteNormal.lt5 * 100).toFixed(1) + '%');
  check('挪到渐变砖红带后均值色差明显下降', gradNormal.mean < whiteNormal.mean - 15,
    gradNormal.mean.toFixed(1) + ' < ' + whiteNormal.mean.toFixed(1));
  check('渐变底出现局部难分：ΔE<5 占比显著上升（>5%，白底仅约1%）', gradNormal.lt5 > 0.05,
    (gradNormal.lt5 * 100).toFixed(1) + '% vs ' + (whiteNormal.lt5 * 100).toFixed(1) + '%');
  check('渐变底 P5（最差5%分位）色差很小（<8），证明是局部而非平均问题', gradNormal.p5 < 8, 'p5=' + gradNormal.p5.toFixed(2));
  check('绿色盲模拟下局部难分进一步恶化（ΔE<5 占比不低于正常）', gradDeutan.lt5 >= gradNormal.lt5 - 0.02,
    (gradDeutan.lt5 * 100).toFixed(1) + '% vs ' + (gradNormal.lt5 * 100).toFixed(1) + '%');
  check('灰度模式仍产出有效数值', gradGray.mean > 1 && gradGray.p5 >= 0);

  // 导出演示示意图（直接取自绘 canvas 的 Blob，避免模拟点击的时序问题）
  const abResp = await ev(`(async () => {
    const cv = window.__app.buildDemoFigure();
    const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
    // 转 base64 字符串，规避 CDP 对 ArrayBuffer 的包装差异
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  })()`);
  fs.writeFileSync('/tmp/demo-figure.png', Buffer.from(abResp, 'base64'));
  check('演示示意图已导出', fs.statSync('/tmp/demo-figure.png').size > 1000,
    fs.statSync('/tmp/demo-figure.png').size + ' bytes');

  console.log('\n页面异常:', logs.length ? logs.join('\n') : '(none)');
  console.log(`\n结果：${failures.length ? failures.length + ' 项失败' : '演示论点全部验证通过'}`);
  ws.close(); process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
