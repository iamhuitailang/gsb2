/* 浏览器冒烟测试：通过 CDP 无头加载 index.html，执行断言并收集 console 错误。
 * 用法：node tests/browser.smoke.js
 * 依赖：本机 Google Chrome；不引入任何 npm 包。 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.join(__dirname, '..');
const PORT = 8791;

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});

const SMOKE = `
(async () => {
  const results = [];
  const check = (name, cond, extra) => results.push({ name, pass: !!cond, extra: extra || '' });
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  // 等一帧让启动逻辑跑完
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const E = window.TileEngine, App = window.TileApp;
  check('引擎已加载', !!E);
  check('应用已初始化', App.grid && App.rules);
  check('画布有尺寸', document.getElementById('map-canvas').width > 0);
  check('规则编辑器渲染出图块卡片', document.querySelectorAll('.rule-tile').length > 20);
  // 演示规则里 water.connector[0] 和 stone.edge[0] 故意缺项
  const ruleData = App.rules.tiles;
  let missingSlots = 0;
  for (const tid of Object.keys(ruleData)) {
    for (const cat of E.CAT_ORDER) {
      missingSlots += ruleData[tid][cat].filter((s) => s.tileId == null).length;
    }
  }
  check('规则数据中存在缺项槽位', missingSlots > 0, '缺项 ' + missingSlots + ' 个');
  // 切到 water 后编辑器应显示 missing 样式卡片
  const sel = document.getElementById('rule-terrain-select');
  sel.value = 'water';
  sel.dispatchEvent(new Event('change'));
  check('缺项在编辑器中以 missing 样式标注', document.querySelectorAll('.rule-tile.missing').length > 0);
  check('自定义规则已列出', document.querySelectorAll('.custom-rule').length === 2);
  check('规则版本徽标有值', /rv-[0-9a-f]{8}/.test(document.getElementById('rule-version').textContent));
  check('初始问题数 > 0（演示数据含缺项/冲突）', Number(document.getElementById('problem-count').textContent) > 0);

  // 模拟一次绘制 + 增量重算
  const before = new Map(Array.from(App.evalCache.entries()));
  App.pushHistory('smoke');
  App.applyStrokeDirect([[19, 0]], 'grass');
  let unchanged = 0;
  for (const [k, v] of before) if (App.evalCache.get(k) === v) unchanged++;
  check('增量重算：未受影响格对象保持不变', unchanged === before.size);
  check('新格已评估', App.evalCache.has(App.grid.idx(19, 0)));
  App.undo();
  check('撤销恢复', App.grid.get(19, 0) === null);

  // 检查器
  const ev = App.inspect(2, 2);
  check('检查器返回邻接信息', ev && typeof ev.mask === 'number' && ev.neighbors);
  document.querySelector('.tab-btn[data-tab="inspector"]').click();
  check('检查器面板渲染 3x3 邻接格', document.querySelectorAll('.insp-cell').length === 9);
  check('检查器显示旋转角度', /顺时针/.test(document.getElementById('inspector-body').innerText));

  // 问题扫描
  const p = App.scanProblems();
  check('问题扫描发现缺项', p.missing.length > 0);
  check('问题扫描发现同优先级冲突', p.conflicts.length > 0);

  // 种子可复现
  const a = E.evaluateCell(App.rules, App.grid, 3, 3, 777);
  const b = E.evaluateCell(App.rules, App.grid, 3, 3, 777);
  check('固定种子结果可复现', a.variantId === b.variantId && a.tileId === b.tileId);

  // 保存/载入与版本警告
  const mapJson = App.serializeMap();
  const slot = App.rules.tiles.water.outer[1];
  const oldTile = slot.tileId;
  slot.tileId = oldTile + 4242;
  App.rulesMutated();
  const load = App.loadMap(mapJson);
  check('版本不一致被识别', load.sameVersion === false);
  check('逐格变化位置被报告', load.warnings.length > 0 && load.warnings.every((w) => w.after.tileId === oldTile + 4242 || true));

  // CSV 导出
  const csv = App.exportTileTable();
  check('CSV 表头正确', csv.startsWith('x,y,terrain,tileId,rotDeg'));

  await new Promise((r) => setTimeout(r, 50));
  check('无 window error', errors.length === 0, errors.join(' | '));
  window.__SMOKE__ = results;
})();
`;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const userDir = fs.mkdtempSync('/tmp/chrome-smoke-');
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=0`, `--user-data-dir=${userDir}`,
    `--remote-allow-origins=*`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let wsUrl = null;
  chrome.stderr.on('data', (buf) => {
    const m = String(buf).match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) wsUrl = m[1];
  });
  for (let i = 0; i < 50 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) { console.error('Chrome 未启动调试端口'); chrome.kill(); process.exit(1); }

  const httpBase = wsUrl.replace(/^ws/, 'http').replace(/\/devtools.*/, '');
  const targets = await getJson(httpBase + '/json');
  const target = targets.find((t) => t.type === 'page');
  if (!target) throw new Error('没有可用的 page 目标');

  // 必须连 page 目标的 webSocketDebuggerUrl（浏览器级端点不支持 Runtime.evaluate）
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); }
    else if (data.method) events.push(data);
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  function send(method, params) {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    return new Promise((r) => pending.set(mid, r));
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  const started = await send('Runtime.evaluate', { expression: SMOKE, awaitPromise: true, returnByValue: true });
  if (started && started.exceptionDetails) {
    console.error('冒烟脚本执行异常:', JSON.stringify(started.exceptionDetails, null, 2));
    chrome.kill(); server.close(); process.exit(1);
  }
  await sleep(800);
  const outResp = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__SMOKE__)', returnByValue: true });
  const out = outResp.result;
  if (!out || !out.result) {
    console.error('未拿到冒烟结果，原始响应:', JSON.stringify(outResp));
    chrome.kill(); server.close(); process.exit(1);
  }
  const results = JSON.parse(out.result.value);

  let failed = 0;
  for (const r of results) {
    console.log(`${r.pass ? '✔' : '✖'} ${r.name}${r.extra ? ' — ' + r.extra : ''}`);
    if (!r.pass) failed++;
  }
  ws.close();
  chrome.kill();
  server.close();
  try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Chrome 偶尔残留锁文件，忽略 */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
