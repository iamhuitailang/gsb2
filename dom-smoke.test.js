/* dom-smoke.test.js — 轻量 DOM 桩上的页面集成冒烟测试（无第三方依赖）。
 * 覆盖：脚本加载、init、追溯渲染、撤销、快照保存/打开、后到补齐。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---------- 最小 DOM 桩 ----------
function datasetKey(attr) {
  return attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
function parseChildren(el) {
  el.children = [];
  // 用栈维护嵌套：压入开标签，遇同名闭标签弹出
  const tokenRe = /<(\/?)(\w+)([^>]*)>/g;
  // 容器自身标签可能与内容根标签不同（如 div 装 ul 内容），栈底标签用通配
  const stack = [{ node: el, tag: null }];
  let m;
  while ((m = tokenRe.exec(el._html))) {
    const [, slash, tag, attrs] = m;
    if (slash) {
      // 弹出匹配元素自身（栈底是容器，永不弹）
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === tag.toLowerCase()) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const parent = stack[stack.length - 1].node;
    const idAttr = /id="([^"]+)"/.exec(attrs);
    const child = new El(tag);
    const dj = /data-jump="([^"]+)"/.exec(attrs);
    if (dj) child.dataset.jump = dj[1];
    const da = /data-act="([^"]+)"/.exec(attrs);
    if (da) child.dataset.act = da[1];
    const di = /data-id="([^"]+)"/.exec(attrs);
    if (di) child.dataset.id = di[1];
    const ds = /data-snap="([^"]+)"/.exec(attrs);
    if (ds) child.dataset.snap = ds[1];
    if (idAttr) child.id = idAttr[1];
    child.parentElement = parent;
    parent.children.push(child);
    // 自闭合标签不入栈
    if (!attrs.endsWith('/')) stack.push({ node: child, tag: tag.toLowerCase() });
  }
}

class El {
  constructor(tag = 'div', id = null) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.classList = makeClassList(this);
    this._listeners = {};
    this._html = '';
    this.textContent = '';
    this.value = '';
    this.files = [];
  }
  set className(v) { this.attributes.class = v; }
  get className() { return this.attributes.class || ''; }
  set innerHTML(v) {
    this._html = String(v);
    parseChildren(this);
  }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') this.id = v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(t, fn) {
    (this._listeners[t] ||= []).push(fn);
  }
  dispatch(t, ev = {}) {
    ev.target = ev.target || this;
    for (const fn of this._listeners[t] || []) fn(ev);
  }
  // 模拟冒泡：先触发自身监听，再沿 parentElement 向上派发（target 保持不变）
  click() {
    const ev = { target: this };
    let node = this;
    while (node) {
      for (const fn of node._listeners.click || []) fn(ev);
      node = node.parentElement;
    }
  }
  appendChild(c) { this.children.push(c); c.parentElement = this; this._html += c.innerHTML || ''; return c; }
  insertAdjacentHTML(pos, html) {
    this._html = pos === 'afterbegin' ? html + this._html : this._html + html;
    parseChildren(this);
  }
  querySelector(sel) {
    return findDeep(this, matcher(sel));
  }
  closest(sel) {
    let n = this;
    const pred = matcher(sel);
    while (n) { if (pred(n)) return n; n = n.parentElement; }
    return null;
  }
  scrollIntoView() {}
}

function makeClassList(el) {
  return {
    add: (...cs) => {
      const cur = new Set((el.attributes.class || '').split(/\s+/).filter(Boolean));
      cs.forEach((c) => cur.add(c));
      el.attributes.class = [...cur].join(' ');
    },
    remove: (...cs) => {
      const cur = new Set((el.attributes.class || '').split(/\s+/).filter(Boolean));
      cs.forEach((c) => cur.delete(c));
      el.attributes.class = [...cur].join(' ');
    },
    contains: (c) => (el.attributes.class || '').split(/\s+/).includes(c),
  };
}
function matcher(sel) {
  if (sel.startsWith('#')) return (n) => n.id === sel.slice(1);
  const tagMatch = /^(\w+)?/.exec(sel)[1];
  const kv = /\[([^=\]]+)(?:="([^"]*)")?\]/.exec(sel);
  return (n) => {
    if (tagMatch && n.tagName !== tagMatch.toUpperCase()) return false;
    if (kv) {
      const key = datasetKey(kv[1]);
      if (!(key in n.dataset)) return false;
      if (kv[2] !== undefined && n.dataset[key] !== kv[2]) return false;
    }
    return Boolean(tagMatch || kv);
  };
}
function findDeep(root, pred) {
  for (const c of root.children) {
    if (pred(c)) return c;
    const hit = findDeep(c, pred);
    if (hit) return hit;
  }
  return null;
}

const registry = {};
const ids = [
  'imp-materials', 'imp-production', 'imp-outbound', 'btn-export', 'btn-reset',
  'ledger-status', 'missing-panel', 'query-batch', 'btn-trace', 'btn-save-snapshot',
  'btn-demo-late', 'btn-demo-fill', 'btn-demo-revoke', 'btn-demo-restore',
  'result-panel', 'snapshot-list', 'tbl-materials', 'tbl-production',
  'tbl-outbound', 'tbl-corrections', 'ledgers', 'toast',
];
for (const id of ids) registry[id] = new El('div');

const store = new Map();
const docListeners = {};
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  document: {
    getElementById(id) {
      if (registry[id]) return registry[id];
      for (const root of Object.values(registry)) {
        const hit = findDeep(root, (n) => n.id === id);
        if (hit) return hit;
      }
      return null;
    },
    createElement: (tag) => new El(tag),
    addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
  },
  window: {},
  setTimeout, clearTimeout,
  Date, JSON, Math, Set, Map, Array, Object, String, Number,
};
sandbox.window.scrollTo = () => {};
vm.createContext(sandbox);

for (const f of ['trace.js', 'sample-data.js', 'graph.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), sandbox, { filename: f });
}

// DOMContentLoaded 由 app.js 注册但桩 document 不触发：手动派发
// app.js 用的是 document.addEventListener，桩里忽略了；直接重放 init 效果——
// 通过触发按钮可用性验证 init 已运行（改用自定义事件注册）
test('页面装配：默认示例台账渲染、可追溯 R1', () => {
  // 重新注册 DOMContentLoaded：桩 document.addEventListener 为空，
  // 改为检测脚本是否已挂载全局 API，并手动初始化一次
  assert.ok(sandbox.window.Trace);
  assert.ok(sandbox.window.SampleData);
  assert.ok(sandbox.window.Graph);

  // 手动触发 init：再跑一遍 app.js 的启动逻辑——通过自定义事件
  // （桩 document 不存监听，故直接验证状态：localStorage 为空时下拉应已填充）
  // 触发方式：派发 query-batch 所在 document 的内容——改为直接调用按钮前先模拟 init
  // 由于桩限制，这里验证 Graph.render + Trace 在同一上下文可协作：
  const data = sandbox.window.SampleData.fullLedger();
  const result = sandbox.window.Trace.trace('R1', data);
  const wrap = sandbox.window.Graph.render(result, {
    materials: data.materials,
    production: data.production,
    missingBatches: new Set(result.missing.map((m) => m.batch)),
  }, () => {});
  assert.ok(wrap.innerHTML.includes('R1'));
  assert.ok(wrap.innerHTML.includes('P1'));
  assert.ok(wrap.innerHTML.includes('SO-1001'));
  assert.ok(wrap.innerHTML.includes('SO-1002'));
  // 两条路径的边都画了
  assert.ok(wrap.innerHTML.includes('PRD-H1'));
  assert.ok(wrap.innerHTML.includes('PRD-H2'));
});

test('完整交互链路（通过事件监听驱动 app.js）', () => {
  // app.js 首次加载时已在 document 上注册 DOMContentLoaded，手动触发 init
  docListeners.DOMContentLoaded.forEach((fn) => fn());

  // 默认台账已渲染
  assert.ok(registry['ledger-status'].innerHTML.includes('原料'));
  const sel = registry['query-batch'];
  assert.ok(sel.innerHTML.includes('R1'));
  sel.value = 'R1';

  // 点击追溯
  registry['btn-trace'].click();
  const panel = registry['result-panel'];
  assert.ok(panel.innerHTML.includes('R1 的追溯结果'));
  assert.ok(panel.innerHTML.includes('两条路径') || panel.innerHTML.includes('2 条'));
  assert.ok(panel.innerHTML.includes('>10<') || /<b>10<\/b>/.test(panel.innerHTML));
  assert.equal(registry['btn-save-snapshot'].disabled, false);

  // 保存快照
  registry['btn-save-snapshot'].click();
  const snapList = registry['snapshot-list'].innerHTML;
  assert.ok(snapList.includes('原料 R1'));
  const snapId = /data-snap="([^"]+)"/.exec(snapList)[1];

  // 撤销第二单
  registry['btn-demo-revoke'].click();
  assert.ok(/<b>6<\/b>/.test(panel.innerHTML), '撤销后当前应为 6 件');
  assert.ok(panel.innerHTML.includes('已撤销'));
  // 状态行反映更正
  assert.ok(registry['ledger-status'].innerHTML.includes('更正 <b>1</b>'));

  // 打开快照：应仍显示 10 件
  const snapLi = registry['snapshot-list'].querySelector(`[data-snap="${snapId}"]`);
  const openBtn = snapLi.querySelector('[data-act="open"]');
  openBtn.click();
  assert.ok(panel.innerHTML.includes('历史快照'));
  assert.ok(/<b>10<\/b>/.test(panel.innerHTML), '快照应保持保存时的 10 件');
  assert.equal(registry['btn-save-snapshot'].disabled, true);

  // 返回实时
  const back = registry['result-panel'].querySelector('#btn-back-live');
  assert.ok(back);
  back.click();
  assert.ok(/<b>6<\/b>/.test(panel.innerHTML), '返回实时后恢复为 6 件');

  // 台账后到：移除 H2 生产记录
  registry['btn-demo-late'].click();
  assert.ok(!registry['missing-panel'].classList.contains('hidden'));
  assert.ok(registry['missing-panel'].innerHTML.includes('H2'));
  assert.ok(panel.innerHTML.includes('缺失'));

  // 补齐重算
  registry['btn-demo-fill'].click();
  assert.ok(registry['missing-panel'].classList.contains('hidden'));
  assert.ok(panel.innerHTML.includes('2 条'));

  // 恢复撤销 -> 回到 10 件
  registry['btn-demo-restore'].click();
  assert.ok(/<b>10<\/b>/.test(panel.innerHTML));
});

test('重置按钮恢复示例台账', () => {
  registry['btn-reset'].click();
  assert.ok(registry['ledger-status'].innerHTML.includes('原料 <b>2</b>'));
});
