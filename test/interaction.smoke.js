/* 真实指针交互：编辑摆放 → 进破坏模式 → 框选批量 → 单步 → 撤回重破坏 */
/* 用法：先以 --remote-debugging-port=9222 启动 headless Chrome，再 node test/interaction.smoke.js */
const base = 'http://127.0.0.1:' + (process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => (ws.onopen = () => res()));
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  async function send(method, params = {}) {
    await ready;
    const myId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }
  return { send };
}

(async () => {
  const list = await (await fetch(base + '/json/list')).json();
  const { send } = cdp(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Page.navigate', { url: 'file://' + process.env.PWD + '/index.html' });
  await sleep(700);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      fail('JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  // 新空白地图
  await evalJs(`document.querySelector('#btn-new').click(); true`);
  await sleep(100);

  // 在格子中心派发 pointerdown/up（编辑：锚、砖、连接）
  const point = (x, y, type) =>
    evalJs(`
      (() => {
        const svg = document.querySelector('#board');
        const r = svg.getBoundingClientRect();
        const cx = r.left + (${x} + 0.5) * r.width / 11;
        const cy = r.top + (${y} + 0.5) * r.height / 9;
        svg.dispatchEvent(new PointerEvent('pointer${type}', {clientX:cx, clientY:cy, bubbles:true}));
        window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
        return true;
      })()`);

  // 锚 (1,1)，砖 (1,2)(1,3)，孤立砖 (4,4)
  await evalJs(`document.querySelector('[data-tool="anchor"]').click(); true`);
  await point(1, 1, 'down'); await point(1, 1, 'up');
  await evalJs(`document.querySelector('[data-tool="brick"]').click(); true`);
  await point(1, 2, 'down'); await point(1, 2, 'up');
  await point(1, 3, 'down'); await point(1, 3, 'up');
  await point(4, 4, 'down'); await point(4, 4, 'up');
  // 连接：(1,1)-(1,2)，(1,2)-(1,3)
  await evalJs(`document.querySelector('[data-tool="edge"]').click(); true`);
  await point(1, 1, 'down'); await point(1, 1, 'up');
  await point(1, 2, 'down'); await point(1, 2, 'up');
  await point(1, 2, 'down'); await point(1, 2, 'up');
  await point(1, 3, 'down'); await point(1, 3, 'up');

  const stats1 = await evalJs(`document.querySelector('#stats').textContent`);
  console.log('编辑后统计:', stats1.replace(/\s+/g, ' '));
  if (!stats1.includes('砖 3') || !stats1.includes('锚 1') || !stats1.includes('连接 2')) fail('摆放/连接结果不符');
  if (!stats1.includes('未连锚砖 1')) fail('孤立砖应被标为未连锚');

  // 进破坏模式，框选 (1,2)-(1,3) 两格批量
  await evalJs(`document.querySelector('#btn-destroy').click(); true`);
  await sleep(100);
  const drag = await evalJs(`
    (() => {
      const svg = document.querySelector('#board');
      const r = svg.getBoundingClientRect();
      const p = (x,y) => [r.left + (x+0.5)*r.width/11, r.top + (y+0.5)*r.height/9];
      const [x1,y1] = p(1,2); const [x2,y2] = p(1,3);
      svg.dispatchEvent(new PointerEvent('pointerdown',{clientX:x1,clientY:y1,bubbles:true}));
      svg.dispatchEvent(new PointerEvent('pointermove',{clientX:x2,clientY:y2,bubbles:true}));
      window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
      return document.querySelector('#btn-apply-destroy').disabled === false;
    })()`);
  console.log('框选后可结算:', drag);
  if (!drag) fail('框选未启用结算按钮');

  await evalJs(`document.querySelector('#btn-apply-destroy').click(); true`);
  await sleep(100);
  const types = await evalJs(`Array.from(document.querySelectorAll('.ev-type')).map(e=>e.textContent).join(',')`);
  console.log('批量破坏事件:', types);
  if (!types.includes('removal') || !types.includes('fall') || !types.includes('settle')) fail('批量破坏事件不全');
  // 孤立砖 (4,4) 应落到 (4,8)
  const landed = await evalJs(`!!document.querySelector('#board .cell-rect[data-key="4,8"]')`);
  console.log('孤立砖落地 (4,8):', landed);
  if (!landed) fail('孤立砖未落地');

  // 单步回退到 removal 时刻，再重做新破坏（截断未来）
  await evalJs(`document.querySelector('#btn-start').click(); true`);
  const pos0 = await evalJs(`document.querySelector('#timeline-pos').textContent`);
  // 直接在初始视图点掉孤立砖
  await point(4, 4, 'down'); await point(4, 4, 'up');
  await evalJs(`document.querySelector('#btn-apply-destroy').click(); true`);
  await sleep(100);
  const newTypes = await evalJs(`Array.from(document.querySelectorAll('.ev-type')).map(e=>e.textContent).join(',')`);
  console.log('撤回后新破坏事件:', newTypes);
  if (newTypes.includes('support-lost') === false) fail('撤回重破坏未正确结算');

  // 重跑校验
  await evalJs(`document.querySelector('#btn-verify').click(); true`);
  const verify = await evalJs(`document.querySelector('#verify-box').textContent`);
  console.log('校验:', verify.slice(0, 60));
  if (!verify.startsWith('✅')) fail('手动流程校验失败');

  console.log(process.exitCode ? '\n有失败项' : '\n交互冒烟全部通过');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
