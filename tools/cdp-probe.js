/** 临时 CDP 探针：打开页面，收集 console 与页面异常，执行回调检查 window 状态 */
const target = process.argv[2] || 'http://localhost:5173/index.html';
(async () => {
  const ver = await (await fetch('http://localhost:9222/json/version')).json();
  const browserWs = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise(resolve => {
    const mid = ++id; pending.set(mid, resolve);
    browserWs.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  const logs = [];
  let pageSession;
  browserWs.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push('console.' + m.params.type + ': ' + m.params.args.map(a => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push('EXCEPTION: ' + (e.exception?.description || e.text) +
        ' @line ' + (e.lineNumber + 1) + ':' + (e.columnNumber + 1));
    }
  });
  await new Promise(r => browserWs.addEventListener('open', r, { once: true }));
  const t = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  pageSession = attached.sessionId;
  await send('Runtime.enable', {}, pageSession);
  await send('Page.enable', {}, pageSession);
  await send('Page.navigate', { url: target }, pageSession);
  await new Promise(r => setTimeout(r, 2500));
  const state = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      hasApp: !!window.__app,
      iconCount: window.__app?.scene.icons.length,
      hasBg: !!window.__app?.scene.bg,
      mode: window.__app?.state.mode,
      cacheKeys: Array.from(window.__app?.state.resultCache.keys() || []),
      resultsChildren: document.getElementById('results').children.length,
      iconListChildren: document.getElementById('icon-list').children.length,
      scanOptions: document.getElementById('scan-icon').options.length,
    })`,
    returnByValue: true,
  }, pageSession);
  console.log('LOGS:\n' + (logs.join('\n') || '(none)'));
  console.log('STATE:', state.result.value);
  browserWs.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
