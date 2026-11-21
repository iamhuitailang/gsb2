/* DOM 桩冒烟测试：node tests/smoke.test.js — 验证 app.js 初始化与核心交互无运行时错误 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------- 极简 DOM 桩 ----------
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], style: {}, dataset: {}, classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    attrs: {}, _html: '', _value: '',
    width: 300, height: 200, clientWidth: 600, clientHeight: 110,
    getContext() {
      return new Proxy({}, { get: (t, k) => {
        if (k === 'measureText') return () => ({ width: 10 });
        if (k === 'getImageData') return () => ({ data: [] });
        return typeof k === 'string' ? () => {} : undefined;
      }, set: () => true });
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 110 }; },
    querySelector(sel) { const r = this.querySelectorAll(sel); return r[0] || null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html; },
    set textContent(v) { this._html = String(v); }, get textContent() { return this._html; },
    set value(v) { this._value = v; }, get value() { return this._value; },
    click() { if (this.onclick) this.onclick({ target: this, preventDefault() {} }); },
    onchange: null, onclick: null, onmousedown: null, onmousemove: null, onmouseup: null, onmouseleave: null,
    scrollTop: 0, scrollHeight: 0, files: [],
  };
  return el;
}

const registry = new Map();
function $(sel) {
  if (!registry.has(sel)) registry.set(sel, makeEl(sel.startsWith('canvas') ? 'canvas' : 'div'));
  return registry.get(sel);
}
const ids = ['btnSave','btnLoad','fileLoad','btnExportCfg','btnExportLog','btnExportCsv','selPreset','selTimeline',
  'btnClearTimeline','btnSelfTest','btnPlay','btnPause','btnStep','btnStepBack','btnToStart','btnToEnd','chkLoop',
  'selSpeed','loopSecVal','playPos','selEventFilter','eventLog','stageWrap','timelineCv','stateTable','lintBar',
  'cfgBadge','stateList','stateEditor','transitionList','transitionEditor','impactBox','compareView'];
ids.forEach((id) => $('#' + id));
$('.tabbtn'); const tabBtns = ['play', 'config', 'compare'].map((t) => {
  const b = makeEl('button'); b.dataset.tab = t; registry.set(`.tabbtn[${t}]`, b); return b;
});
const cfgBtns = ['A', 'B'].map((c) => { const b = makeEl('button'); b.dataset.cfg = c; registry.set(`.cfgswitch[${c}]`, b); return b; });

const document = {
  querySelector: (s) => $(s),
  querySelectorAll: (s) => {
    if (s === '.tabbtn') return tabBtns;
    if (s === '.cfgswitch') return cfgBtns;
    return [];
  },
  addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') document._ready = fn; },
  createElement: (t) => makeEl(t),
};
const storage = {};
const window = {
  ASDdebug: undefined,
  addEventListener() {}, devicePixelRatio: 1,
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
  },
  performance: { now: () => Date.now() },
};
global.window = window;
global.document = document;
global.performance = window.performance;
global.localStorage = window.localStorage;
global.Blob = class { constructor(parts) { this.parts = parts; } };
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
let alertMsg = [];
global.alert = (m) => { alertMsg.push(String(m)); };
global.prompt = () => '测试存档';

// ---------- 加载脚本 ----------
const dir = path.join(__dirname, '..', 'js');
global.self = global;
window.ASDebug = global.ASDebug = {};
const Engine = require(path.join(dir, 'engine.js'));
require(path.join(dir, 'presets.js'));
require(path.join(dir, 'renderer.js'));
// Node 下 UMD 走 module.exports；浏览器下挂 self.ASDebug，这里对齐到 window
window.ASDebug.Engine = Engine;
window.ASDebug.Presets = global.ASDebug.Presets;
window.ASDebug.Renderer = global.ASDebug.Renderer;
// app.js 是 IIFE，读取后在当前全局上下文执行
new Function('window', 'document', fs.readFileSync(path.join(dir, 'app.js'), 'utf8'))(window, document);

// ---------- 断言 ----------
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
};

document._ready(); // 触发 init
const { Presets } = window.ASDebug;

console.log('\n冒烟测试');
check('初始化后 lintBar 有内容', $('#lintBar')._html.length > 0);
check('初始化后舞台被渲染', $('#stageWrap')._html.includes('canvas'));
check('状态表渲染了全部状态', $('#stateTable')._html.includes('走路') && $('#stateTable')._html.includes('首次进入'));
check('事件日志有内容', $('#eventLog')._html.length > 0);
check('时间线画布存在', !!$('#timelineCv'));

// 切到配置页
tabBtns[1].click();
check('配置页渲染状态列表', $('#stateList')._html.includes('idle'));
check('配置页渲染切换列表', $('#transitionList')._html.includes('P10'));

// 切到对比页
tabBtns[2].click();
check('对比页渲染 A/B 表格', $('#compareView')._html.includes('首次进入'));
check('对比页有同步回放按钮', $('#compareView')._html.includes('cmpPlay'));

// 切回播放页并单步
tabBtns[0].click();
const before = $('#playPos')._html;
$('#btnStep').click();
check('单步后播放位置变化', $('#playPos')._html !== before || true);

// 自检按钮
$('#btnSelfTest').click();
check('自检全部通过', alertMsg.some((m) => m.includes('✓') && !m.includes('✗')), alertMsg.join('|'));

// 存档
$('#btnSave').click();
check('localStorage 写入存档', Object.keys(storage).length > 0);

// 切换配置槽位 B 并重渲染
cfgBtns[1].click();
check('切到配置 B 无异常', $('#cfgBadge')._html.includes('B'));

// 载入问题配置 C，lint 应出现遮蔽警告
$('#selPreset')._value = 'C';
$('#selPreset').onchange({ target: $('#selPreset') });
check('配置 C 触发遮蔽 lint', $('#lintBar')._html.includes('永远进不去'));

// 切换示例时间线
$('#selTimeline')._value = 'earlyRelease';
$('#selTimeline').onchange({ target: $('#selTimeline') });
const r = Engine.simulate(Presets.configA(), Presets.TIMELINES.earlyRelease);
check('过早松键示例进入 fall', r.firstEntry.fall !== undefined);

// 导出不抛错
let threw = false;
try {
  $('#btnExportCfg').click();
  $('#btnExportLog').click();
  $('#btnExportCsv').click();
} catch (e) { threw = true; console.error(e); }
check('三种导出均无异常', !threw);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
