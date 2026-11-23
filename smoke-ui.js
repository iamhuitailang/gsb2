/* 浏览器层冒烟测试：最小 DOM 桩跑通 app.js 启动、切场景、步进、点击、导出。
   node smoke-ui.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl(id) {
  const listeners = {};
  return {
    id, value: '', textContent: '', innerHTML: '', className: '',
    disabled: false, max: 0, checked: true,
    style: {}, dataset: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    dispatch(t, ev = {}) { (listeners[t] || []).forEach(fn => fn(ev)); },
    getContext() {
      return new Proxy({}, { get: (t, p) => {
        if (p === 'measureText') return () => ({ width: 0 });
        return typeof p === 'string' ? () => {} : undefined;
      }, set: () => true });
    },
    getBoundingClientRect() { return { left: 0, top: 0 }; },
    click() {},
  };
}

const ids = ['scenario','retention','cv','scnName','scnDesc','stepLabel','slider','log',
  'inspector','btnReset','btnBack','btnPlay','btnNext','expA','expB','expLog','verify','hashResult'];
const els = Object.fromEntries(ids.map(id => [id, makeEl(id)]));
const tabButtons = ['A','B','admin'].map(v => { const b = makeEl('tab' + v); b.dataset.view = v; return b; });

const downloads = [];
const sandbox = {
  console,
  document: {
    getElementById: id => els[id] || makeEl(id),
    querySelectorAll: sel => sel === '.view-tabs button' ? tabButtons : [],
    addEventListener: () => {},
    createElement: () => makeEl('a'),
  },
  window: { devicePixelRatio: 1 },
  Blob: class { constructor(parts) { this.parts = parts; } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  setInterval: () => 0, clearInterval: () => {},
  URLSearchParams,
  location: { search: '' },
  module: { exports: {} },
  exports: {},
  __downloads: downloads,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const engineSrc = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8')
  .replace(/a\.click\(\);/, 'globalThis.__downloads.push(a.download);')
  .replace(/URL\.revokeObjectURL\(a\.href\);/, '');

vm.runInContext(engineSrc, sandbox);
vm.runInContext(appSrc, sandbox);
console.log('✔ app.js 启动无异常，默认场景已渲染');

// 遍历所有场景 + 走完全部步
const { SCENARIOS, compileScenario } = sandbox.module.exports;
for (let i = 0; i < SCENARIOS.length; i++) {
  els.scenario.value = String(i);
  els.scenario.dispatch('change', { target: { value: String(i) } });
  const total = compileScenario(SCENARIOS[i]).length;
  for (let n = 1; n <= total; n++) {
    els.btnNext.dispatch('click');
  }
  console.log(`✔ 场景「${SCENARIOS[i].name}」连走 ${total} 步无异常`);
  // 三个视角各渲染一次
  for (const b of tabButtons) { b.dispatch('click'); }
  tabButtons[0].dispatch('click');
  // 点击地图选格（含墙、门、边界）
  const sc = SCENARIOS[i];
  for (const [x, y] of [[0, 0], [sc.w - 1, sc.h - 1], [1, 1], [3, 3]]) {
    els.cv.dispatch('click', { clientX: x * 42 + 5, clientY: y * 42 + 5 });
  }
  // 回退到 0
  for (let n = 0; n < total; n++) els.btnBack.dispatch('click');
  // 滑块跳转
  els.slider.value = String(Math.min(2, total));
  els.slider.dispatch('input', { target: { value: String(Math.min(2, total)) } });
  // 导出
  els.expA.dispatch('click');
  els.expB.dispatch('click');
  els.expLog.dispatch('click');
  // 确定性校验按钮
  els.verify.dispatch('click');
  if (!els.hashResult.className.includes('ok')) throw new Error('场景 ' + sc.id + ' 校验未通过: ' + els.hashResult.textContent.slice(0, 200));
  console.log(`  ✔ 视角切换/选格/回退/滑块/三个导出/确定性校验均正常`);
}

// retention 开关
els.retention.checked = false;
els.retention.dispatch('change', { target: { checked: false } });
els.retention.checked = true;
els.retention.dispatch('change', { target: { checked: true } });
console.log('✔ 保留开关切换无异常');

if (downloads.length !== SCENARIOS.length * 3) throw new Error('导出次数不对: ' + downloads.length);
console.log(`\n全部冒烟检查通过，触发 ${downloads.length} 次导出下载。`);
