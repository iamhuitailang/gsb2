// 用 Chrome DevTools Protocol 做无第三方依赖的冒烟测试：
// 加载页面 → 收集 console / 页面错误 → 检查面板是否被运行时代码填充 → 模拟一次工具切换。
// 用法：node tools/browser-smoke.mjs
const BASE = process.env.BASE_URL || 'http://localhost:5173/';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getWsUrl() {
  const res = await fetch('http://127.0.0.1:9222/json/new?' + encodeURIComponent(BASE), { method: 'PUT' });
  const tab = await res.json();
  return tab.webSocketDebuggerUrl;
}

// 极简 WebSocket 客户端（Node 24 内置 WebSocket）
async function main() {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await sleep(2500);

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  const errors = events
    .filter((m) => m.method === 'Runtime.exceptionThrown'
      || (m.method === 'Log.entryAdded' && m.params.entry.level === 'error'))
    .map((m) => (m.params.exceptionDetails?.exception?.description) || m.params.entry?.text)
    .filter(Boolean);

  const summary = await evalJs(`document.getElementById('pathSummary').textContent`);
  const banner = await evalJs(`document.getElementById('statusBanner').textContent`);
  const compRows = await evalJs(`document.querySelectorAll('#componentList .comp-row').length`);
  const sampleBtns = await evalJs(`document.querySelectorAll('#sampleList button').length`);
  const annotations = await evalJs(`document.querySelectorAll('#annotationList li').length`);
  const canvasOk = await evalJs(`(() => {
    const c = document.getElementById('mainCanvas');
    return c.width > 0 && c.height > 0;
  })()`);

  // 模拟切换到 isolated 样例（不可达场景）
  await evalJs(`[...document.querySelectorAll('#sampleList button')].find(b => b.textContent.includes('孤立区域')).click()`);
  await sleep(300);
  const isolatedBanner = await evalJs(`document.getElementById('statusBanner').textContent`);
  const isolatedComps = await evalJs(`document.querySelectorAll('#componentList .comp-row').length`);

  // 模拟涂障碍：切到障碍工具，在画布中心触发 pointerdown（在综合演示图上）
  await evalJs(`[...document.querySelectorAll('#sampleList button')].find(b => b.textContent.includes('综合演示')).click()`);
  await sleep(300);
  await evalJs(`window.__app._selectTool('block')`);
  const paintOk = await evalJs(`(() => {
    const app = window.__app;
    const e = app.state.engine;
    const before = e.cells[2*e.w+2];
    app._applyPaint(2, 2);
    const after = e.cells[2*e.w+2];
    return { before, after, dirtyRect: !!app.state.dirtyRect };
  })()`);

  // 切换权重预设（当前样例可达，应显示三段代价）
  await evalJs(`document.querySelector('input[name=preset][value=safe]').click()`);
  await sleep(300);
  const safeBreakdown = await evalJs(`document.getElementById('pathBreakdown').textContent`);
  const safeWallPart = await evalJs(`document.querySelectorAll('#pathBreakdown b').length`);

  // 对比模式：应出现青色最短路线摘要
  await evalJs(`document.getElementById('compareToggle').click()`);
  await sleep(300);
  const compareText = await evalJs(`document.getElementById('compareSummary').textContent`);

  // 保存/载入往返：用页面内的序列化函数生成工程，再反序列化重建引擎
  const roundTrip = await evalJs(`(async () => {
    const { serializeProject, deserializeProject } = await import('/src/core/serialize.js');
    const app = window.__app;
    const json = serializeProject(app.state.engine, { weights: app.weights });
    const { engine: rebuilt } = deserializeProject(JSON.parse(JSON.stringify(json)));
    const sameCells = rebuilt.cells.length === app.state.engine.cells.length
      && rebuilt.cells.every((v, i) => v === app.state.engine.cells[i]);
    return {
      annotationsBefore: app.state.engine.annotations.length,
      annotationsAfter: rebuilt.annotations.length,
      sameCells,
      sameComponents: rebuilt.componentCount === app.state.engine.componentCount,
      sameRadius: rebuilt.agentRadius === app.state.engine.agentRadius,
    };
  })()`);

  const result = {
    errors,
    canvasOk,
    summary,
    banner,
    compRows,
    sampleBtns,
    annotations,
    isolatedBanner,
    isolatedComps,
    paintOk,
    safeBreakdown,
    safeWallPart,
    compareText,
    roundTrip,
  };
  console.log(JSON.stringify(result, null, 2));
  ws.close();

  const fail = errors.length > 0 || !canvasOk || compRows === 0 || sampleBtns !== 4
    || !isolatedBanner.includes('不可达') || isolatedComps !== 4
    || paintOk.after !== 1 || !paintOk.dirtyRect || safeWallPart !== 4
    || !compareText.includes('最短距离')
    || roundTrip.annotationsBefore < 1
    || roundTrip.annotationsAfter !== roundTrip.annotationsBefore
    || !roundTrip.sameCells || !roundTrip.sameComponents || !roundTrip.sameRadius;
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke test failed:', err);
  process.exit(1);
});
