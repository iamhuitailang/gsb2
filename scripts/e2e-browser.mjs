// 通过 Chrome DevTools Protocol 驱动真实页面，验证工作台交互无运行时错误。
// 仅用于本地测试，测试结束即关闭浏览器。
const BASE = 'http://127.0.0.1:5179/';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cdp(ws, method, params = {}) {
  const id = ++cdp.seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMsg);
  });
}
cdp.seq = 0;

async function evalJs(ws, expression) {
  const r = await cdp(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

const list = await (await fetch('http://127.0.0.1:9222/json/new?' + BASE, { method: 'PUT' })).json();
const ws = new WebSocket(list.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
await cdp(ws, 'Runtime.enable');
await sleep(800);

// 收集页面运行时错误
await evalJs(ws, `window.__errors = [];
  window.addEventListener('error', e => window.__errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => window.__errors.push(String(e.reason)));`);

// 1. 初始空状态
const empty = await evalJs(ws, `document.querySelector('#policy-list').textContent.includes('暂无策略')`);
if (!empty) throw new Error('初始空状态不正确');

// 2. 载入演示数据（window.confirm 自动通过）
await evalJs(ws, 'window.confirm = () => true');
await evalJs(ws, `document.querySelector('#btn-load-demo').click()`);
await sleep(200);
const count = await evalJs(ws, `Number(document.querySelector('#policy-count').textContent)`);
if (count !== 6) throw new Error('演示策略应载入 6 条，实际 ' + count);

// 3. 切到检查结果标签并渲染
await evalJs(ws, `document.querySelector('.tab[data-tab="check"]').click()`);
await sleep(100);
const issueCards = await evalJs(ws, `document.querySelectorAll('#check-issues .issue-card').length`);
if (issueCards < 1) throw new Error('检查结果未渲染');

// 4. 切到覆盖分析
await evalJs(ws, `document.querySelector('.tab[data-tab="coverage"]').click()`);
await sleep(100);
const covCards = await evalJs(ws, `document.querySelectorAll('#coverage-view .coverage-card').length`);
if (covCards < 10) throw new Error('覆盖卡片数量不足: ' + covCards);

// 5. 样例验证：切到验证页，直接运行（默认选中全部策略、script 类型）
await evalJs(ws, `document.querySelector('.tab[data-tab="verify"]').click()`);
await sleep(100);
await evalJs(ws, `document.querySelector('#verify-url').value = 'https://evil.test/x.js'`);
await evalJs(ws, `document.querySelector('#btn-run-verify').click()`);
await sleep(100);
const verdict = await evalJs(ws, `document.querySelector('#verify-result .verdict-title').textContent`);
if (!verdict) throw new Error('验证结果未渲染');

// 6. 策略比较
await evalJs(ws, `document.querySelector('.tab[data-tab="compare"]').click()`);
await sleep(100);
await evalJs(ws, `document.querySelector('#btn-run-compare').click()`);
await sleep(100);
const compareRows = await evalJs(ws, `document.querySelectorAll('#compare-view table tr, #compare-view .issue-card').length`);
if (compareRows < 1) throw new Error('比较结果未渲染');

// 7. localStorage 持久化检查
const stored = await evalJs(ws, `JSON.parse(localStorage.getItem('csp-workbench.policies.v1')).length`);
if (stored !== 6) throw new Error('本地存储数量不正确: ' + stored);

// 8. 控制台错误收集
const logs = await evalJs(ws, `window.__errors || []`);
ws.close();
if (Array.isArray(logs) && logs.length) {
  console.error('页面存在运行时错误:', logs);
  process.exit(1);
}
console.log(JSON.stringify({
  演示策略数: count,
  检查问题卡片: issueCards,
  覆盖卡片: covCards,
  验证判定标题: verdict,
  比较行数: compareRows,
  本地存储条数: stored,
}, null, 2));
console.log('浏览器端到端交互测试通过');
process.exit(0);
