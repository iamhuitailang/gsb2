/*
 * smoke.js — 通过 Chrome DevTools Protocol 驱动页面做端到端冒烟测试。
 * 用法：先以 --remote-debugging-port=9222 启动 Chrome 打开 index.html，
 *       再执行 node tests/smoke.js
 */
'use strict';

const HTTP = require('http');

function getJson(url) {
  return new Promise((resolve, reject) => {
    HTTP.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let msgId = 0;

async function main() {
  const tabs = await getJson('http://127.0.0.1:9222/json');
  const tab = tabs.find((t) => t.url.includes('index.html')) || tabs[0];
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXCEPTION: ' + msg.params.exceptionDetails.exception.description);
    }
  };

  function send(method, params) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    return r.result.value;
  }
  async function click(selector) {
    return evalJs(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function waitFor(selector, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok = await evalJs(`!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);
      if (ok) return true;
      await sleep(80);
    }
    throw new Error('等待元素超时: ' + selector);
  }
  async function waitForNoModal() {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const empty = await evalJs(`!document.querySelector('.modal')`).catch(() => false);
      if (empty) return true;
      await sleep(80);
    }
    throw new Error('弹窗未关闭');
  }
  async function waitForText(selector, text, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = await evalJs(
        `(document.querySelector(${JSON.stringify(selector)})||{}).textContent || ''`
      ).then((t) => t.includes(text)).catch(() => false);
      if (hit) return true;
      await sleep(80);
    }
    throw new Error('等待文案超时: ' + text);
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(800);

  const results = [];
  const check = (name, cond, extra) => {
    results.push({ name, ok: !!cond, extra: extra || '' });
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? ' — ' + extra : ''));
  };

  // 1. 初始渲染
  check('三个情境页签', await evalJs(`document.querySelectorAll('#contextTabs button').length`) === 3);
  check('绑定表行数=菜单情境 7 个操作', await evalJs(`document.querySelectorAll('#bindingTableBody tr').length`) === 7);
  check('无冲突提示', (await evalJs(`document.querySelector('#conflictSummary').textContent`)).includes('无冲突'));
  check('虚拟键盘已渲染', await evalJs(`document.querySelectorAll('.vk-key').length`) >= 20);
  check('虚拟手柄按钮已渲染', await evalJs(`document.querySelectorAll('.gp-btn').length`) >= 10);
  check('预览动作条有内容', await evalJs(`document.querySelectorAll('#actionBar .action-chip').length`) === 7);

  // 2. 切换到步行情境
  await evalJs(`[...document.querySelectorAll('#contextTabs button')].find(b=>b.textContent.includes('步行')).click()`);
  check('步行情境 13 个操作', await evalJs(`document.querySelectorAll('#bindingTableBody tr').length`) === 13);

  // 3. 模拟按键驱动预览：按住 W -> foot.forward 动作灯点亮
  await evalJs(`window.__busTest = (function(){ return null; })()`);
  // 通过虚拟键盘按钮的指针事件不可用（headless 无指针捕获），改为直接派发键盘事件
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',bubbles:true}))`);
  await sleep(150);
  const activeChips = await evalJs(`[...document.querySelectorAll('.action-chip.active')].map(e=>e.dataset.action)`);
  check('按住 W 激活 foot.forward', Array.isArray(activeChips) && activeChips.includes('foot.forward'), JSON.stringify(activeChips));
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',bubbles:true}))`);
  await sleep(150);
  check('松开 W 动作灯熄灭', await evalJs(`document.querySelectorAll('.action-chip.active').length`) === 0);

  // 4. 长按 repeat 不应产生重复 down（直接测 InputBus 计数）
  const repeatCount = await evalJs(`(function(){
    let downs = 0;
    const h = () => downs++;
    // bus 挂在闭包里，改用模拟面板按钮间接验证：直接构造事件序列检查 held 语义
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyR',bubbles:true}));
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyR',bubbles:true,repeat:true}));
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyR',bubbles:true,repeat:true}));
    window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyR',bubbles:true}));
    return document.querySelectorAll('.action-chip.active').length;
  })()`);
  check('repeat 事件后状态正常归零', repeatCount === 0);

  // 5. 捕获录入流程：点击“前进(foot.forward)”的副绑定“录入”，派发按键，检查写入
  await evalJs(`(function(){
    const row = [...document.querySelectorAll('#bindingTableBody tr')]
      .find(r => r.textContent.includes('foot.forward'));
    row.querySelectorAll('.cell-btns .btn-primary')[1].click();
  })()`);
  check('捕获条出现', await evalJs(`!document.getElementById('captureBar').hidden`));
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyT',bubbles:true}))`);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyT',bubbles:true}))`);
  await sleep(200);
  const forwardRow = await evalJs(`[...document.querySelectorAll('#bindingTableBody tr')].find(r=>r.textContent.includes('foot.forward')).textContent`);
  check('捕获后副绑定写入并显示 T', forwardRow.includes('T'));
  check('捕获条自动关闭', await evalJs(`document.getElementById('captureBar').hidden`));

  // 6. 捕获取消：开始捕获后按 Esc
  await evalJs(`(function(){
    const row = [...document.querySelectorAll('#bindingTableBody tr')]
      .find(r => r.textContent.includes('foot.forward'));
    row.querySelectorAll('.cell-btns .btn-primary')[1].click();
  })()`);
  check('再次进入捕获', await evalJs(`!document.getElementById('captureBar').hidden`));
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',bubbles:true}))`);
  await sleep(150);
  check('Esc 取消捕获', await evalJs(`document.getElementById('captureBar').hidden`));

  // 7. 制造冲突并检查三类提示
  //   把 foot.forward 的副绑定改成与主绑定相同的 KeyW -> duplicate
  await evalJs(`(function(){
    const row = [...document.querySelectorAll('#bindingTableBody tr')]
      .find(r => r.textContent.includes('foot.forward'));
    row.querySelectorAll('.cell-btns .btn-primary')[1].click();
  })()`);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',bubbles:true}))`);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',bubbles:true}))`);
  await sleep(200);
  const summary = await evalJs(`document.getElementById('conflictSummary').textContent`);
  check('出现重复冲突徽标', summary.includes('重复'), summary);
  check('冲突卡片存在', await evalJs(`document.querySelectorAll('.conflict-card.duplicate').length`) >= 1);

  // 标记为有意复用
  await evalJs(`document.querySelector('.conflict-card .btn').click()`);
  await sleep(100);
  check('确认后出现“已标记为有意复用”', (await evalJs(`document.querySelector('.conflict-card').textContent`)).includes('有意复用'));
  check('确认后摘要出现已确认计数', (await evalJs(`document.getElementById('conflictSummary').textContent`)).includes('已确认复用'));

  // 8. 手柄冲突：把另一操作的副绑定也录成同一个手柄按钮
  await evalJs(`[...document.querySelectorAll('#contextTabs button')].find(b=>b.textContent.includes('菜单')).click()`);
  await evalJs(`(function(){
    // menu.confirm 的副绑定是 gp:button:0；把 menu.back 的副绑定也录成 gp:button:0
    const rows = document.querySelectorAll('#bindingTableBody tr');
    const backRow = [...rows].find(r => r.textContent.includes('返回'));
    backRow.querySelectorAll('.cell-btns .btn-primary')[1].click();
  })()`);
  await evalJs(`(function(){
    // 直接通过输入总线的模拟通道录入手柄按钮（与虚拟手柄点击走同一路径）
    window.__inputBus.simPress('gp:button:0','gamepad');
    window.__inputBus.simRelease('gp:button:0','gamepad');
  })()`);
  await sleep(250);
  const gpSummary = await evalJs(`document.getElementById('conflictSummary').textContent`);
  check('出现手柄冲突徽标', gpSummary.includes('手柄'), gpSummary);

  // 9. 前缀冲突：给菜单情境新增一个 Ctrl 单键绑定 + Ctrl+G 组合键
  await evalJs(`(function(){
    const row = [...document.querySelectorAll('#bindingTableBody tr')]
      .find(r => r.textContent.includes('menu.up'));
    row.querySelectorAll('.cell-btns .btn-primary')[1].click(); // menu.up 副绑定
  })()`);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'ControlLeft',bubbles:true}))`);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'ControlLeft',bubbles:true}))`);
  await sleep(200);
  await evalJs(`(function(){
    const row = [...document.querySelectorAll('#bindingTableBody tr')]
      .find(r => r.textContent.includes('menu.down'));
    row.querySelectorAll('.cell-btns .btn-primary')[1].click(); // menu.down 副绑定
  })()`);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'ControlLeft',bubbles:true}))`);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyG',bubbles:true}))`);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyG',bubbles:true}))`);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'ControlLeft',bubbles:true}))`);
  await sleep(250);
  const prefixSummary = await evalJs(`document.getElementById('conflictSummary').textContent`);
  check('出现组合键前缀冲突徽标', prefixSummary.includes('前缀'), prefixSummary);

  // 10. 导入分析：构造一个包含新增/覆盖/无法识别三种条目的 JSON
  //   默认方案的每个槽位都有绑定，所以克隆一份并手动清空一个槽位来制造“新增”场景，
  //   analyzeImport 只读分析，不会写回存储。
  const importResult = await evalJs(`(function(){
    const profile = JSON.parse(localStorage.getItem('gimc.profileStore.v1'));
    const active = profile.profiles.find(p=>p.id===profile.activeProfileId);
    const clone = JSON.parse(JSON.stringify(active));
    clone.contexts.find(c=>c.id==='menu').actions.find(a=>a.id==='menu.pause').bindings.secondary = null;
    const payload = {
      app:'game-input-mapping-configurator', schemaVersion:1,
      profile:{ name:'外部方案', contexts:[
        { id:'menu', name:'菜单', actions:[
          { id:'menu.pause', name:'暂停', bindings:{
              primary:{type:'keyboard',code:'F9',modifiers:[]},
              secondary:{type:'keyboard',code:'F10',modifiers:[]}
          } },
          { id:'menu.ghost', bindings:{ primary:{type:'keyboard',code:'KeyZ',modifiers:[]} } },
          { id:'menu.confirm', bindings:{ primary:{type:'keyboard',code:'BogusKey',modifiers:[]} } }
        ]},
        { id:'flying', name:'飞行', actions:[] }
      ]}
    };
    return ImportExport.analyzeImport(JSON.stringify(payload), clone);
  })()`);
  check('导入分析成功', importResult.ok === true);
  check('含新增条目', importResult.counts.add >= 1, JSON.stringify(importResult.counts));
  check('含覆盖条目', importResult.counts.overwrite >= 1);
  check('含无法识别条目', importResult.counts.unknown >= 2);
  // analyzeImport 是只读分析，不应改动当前方案
  const untouched = await evalJs(`(function(){
    const profile = JSON.parse(localStorage.getItem('gimc.profileStore.v1'));
    const active = profile.profiles.find(p=>p.id===profile.activeProfileId);
    const pause = active.contexts.find(c=>c.id==='menu').actions.find(a=>a.id==='menu.pause');
    return pause.bindings.primary.code !== 'F9';
  })()`);
  check('分析过程不写回存储（只读）', untouched === true);

  // 11. 方案管理：新建/切换/恢复默认
  const beforeCount = await evalJs(`JSON.parse(localStorage.getItem('gimc.profileStore.v1')).profiles.length`);
  await click('#btnNewProfile');
  await waitFor('.modal input');
  await evalJs(`(function(){ const i=document.querySelector('.modal input'); i.value='测试玩家'; })()`);
  await evalJs(`document.querySelector('.modal-foot .btn-primary').click()`);
  // 第一个弹窗关闭后微任务内立即打开第二个（复制/默认），等待其特征文案出现
  await waitForText('.modal', '复制当前方案');
  await evalJs(`document.querySelector('.modal-foot .btn:not(.btn-primary)').click()`);
  await waitForNoModal();
  const afterCount = await evalJs(`JSON.parse(localStorage.getItem('gimc.profileStore.v1')).profiles.length`);
  check('新方案已创建', afterCount === beforeCount + 1);
  check('新方案为干净默认（菜单无冲突）', (await evalJs(`document.getElementById('conflictSummary').textContent`)).includes('无冲突'));

  // 恢复默认（危险确认的主按钮类名是 btn-danger，按文案定位）
  await click('#btnResetProfile');
  await waitFor('.modal-foot .btn');
  await evalJs(`[...document.querySelectorAll('.modal-foot button')].find(b=>b.textContent.trim()==='恢复默认').click()`);
  await waitForNoModal();
  check('恢复默认可用', (await evalJs(`document.getElementById('conflictSummary').textContent`)).includes('无冲突'));

  // 12. localStorage 持久化检查
  const persisted = await evalJs(`!!localStorage.getItem('gimc.profileStore.v1')`);
  check('配置已持久化到 localStorage', persisted);

  // 控制台错误
  check('控制台无 JS 错误', consoleErrors.length === 0, consoleErrors.join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  ws.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
