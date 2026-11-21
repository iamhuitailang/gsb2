/* 浏览器集成冒烟测试：用 stub 模拟 window/document/THREE，验证 app 初始化与重建链路。
   用法：node tests/browser-smoke.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- 极简 DOM stub ----
function makeEl(id) {
  return {
    id, value: '', checked: false, textContent: '', innerHTML: '',
    style: {}, className: '', files: [],
    listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    dispatch(ev, payload) { (this.listeners[ev] || []).forEach((fn) => fn(payload || { target: this })); },
    click() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 400 }; },
    appendChild() {}, removeChild() {},
    querySelector() { return makeEl('q'); },
  };
}
const ids = ['view3d', 'topCanvas', 'closed', 'addPoint', 'delPoint', 'showGrid', 'showCenter',
  'showShL', 'showShR', 'foldBtn', 'resetBtn', 'pWidth', 'pHeight', 'pCross', 'pWidthV', 'pHeightV',
  'pCrossV', 'selLabel', 'saveBtn', 'loadBtn', 'loadFile', 'exportObj', 'exportMeta',
  'fineStats', 'seamBox', 'issueList', 'topHint', 'stats3d'];
const elMap = {};
ids.forEach((id) => { elMap[id] = makeEl(id); });
// Canvas 2D context：用 Proxy 吞掉所有绘制调用并返回自身
const ctx2d = new Proxy({ canvas: null, measureText: () => ({ width: 0 }) }, {
  get(t, k) {
    if (k in t) return t[k];
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; },
});
elMap.topCanvas.getContext = () => ctx2d;
elMap.closed.checked = true;
['showGrid', 'showCenter', 'showShL', 'showShR'].forEach((k) => { elMap[k].checked = true; });
const radioCoarse = makeEl('radio-coarse'); radioCoarse.value = 'coarse';
const radioFine = makeEl('radio-fine'); radioFine.value = 'fine'; radioFine.checked = true;

const createdLi = [];
const documentStub = {
  getElementById: (id) => elMap[id] || makeEl(id),
  querySelectorAll: () => [radioCoarse, radioFine],
  querySelector: () => radioFine,
  createElement: (tag) => {
    const el = makeEl('li-' + createdLi.length);
    el.tagName = tag;
    createdLi.push(el);
    return el;
  },
  addEventListener(ev, fn) { (this._listeners = this._listeners || {})[ev] = fn; },
  body: { appendChild() {}, removeChild() {} },
};

// ---- THREE stub：只实现 app 实际调用的接口 ----
function Vector3(x, y, z) { this.x = x; this.y = y; this.z = z; }
Vector3.prototype.copy = function (v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; };
Vector3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
function Box3() { this.min = new Vector3(Infinity, Infinity, Infinity); this.max = new Vector3(-Infinity, -Infinity, -Infinity); }
Box3.prototype.expandByPoint = function (v) {
  this.min.x = Math.min(this.min.x, v.x); this.min.y = Math.min(this.min.y, v.y); this.min.z = Math.min(this.min.z, v.z);
  this.max.x = Math.max(this.max.x, v.x); this.max.y = Math.max(this.max.y, v.y); this.max.z = Math.max(this.max.z, v.z);
  return this;
};
Box3.prototype.getCenter = function () {
  return new Vector3((this.min.x + this.max.x) / 2, (this.min.y + this.max.y) / 2, (this.min.z + this.max.z) / 2);
};
Box3.prototype.getSize = function () {
  return new Vector3(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z);
};
function BufferGeometry() { this.attributes = {}; }
BufferGeometry.prototype.setAttribute = function (k, v) { this.attributes[k] = v; };
BufferGeometry.prototype.setIndex = function (i) { this.index = i; };
BufferGeometry.prototype.dispose = function () {};
function BufferAttribute(arr, n) { this.array = arr; this.itemSize = n; }
function Material() { this.dispose = function () {}; }
function Mesh(geo, mat) { this.geometry = geo; this.material = mat; this.position = new Vector3(0, 0, 0); this.visible = true; }
function Group() { this.children = []; }
Group.prototype.add = function (c) { this.children.push(c); };
function LineSegments(geo, mat) { this.geometry = geo || { dispose() {} }; this.material = mat; }
function SphereGeometry() { return { dispose() {} }; }
function PerspectiveCamera() {
  this.position = new Vector3(0, 0, 0); this.up = new Vector3(0, 1, 0);
  this.aspect = 1; this.near = 0.1; this.far = 1000;
  this.updateProjectionMatrix = function () {};
}
function WebGLRenderer() {
  this.domElement = { parentNode: null, addEventListener() {} };
  this.setPixelRatio = function () {}; this.setSize = function () {}; this.render = function () {};
  this.dispose = function () {};
}
function OrbitControls() { this.target = new Vector3(0, 0, 0); this.update = function () {}; this.enableDamping = false; }
function Color() {}
function Scene() { this.children = []; this.background = null; this.add = function (c) { this.children.push(c); }; }
function AmbientLight() {} function DirectionalLight() { this.position = new Vector3(0, 0, 0); }
function GridHelper() { this.position = new Vector3(0, 0, 0); }
function LineBasicMaterial() { return new Material(); }
function MeshStandardMaterial() { return new Material(); }

const THREEStub = {
  Vector3, Box3, BufferGeometry, BufferAttribute, Mesh, Group, LineSegments, SphereGeometry,
  PerspectiveCamera, WebGLRenderer, OrbitControls, Color, Scene, AmbientLight, DirectionalLight,
  GridHelper, LineBasicMaterial, MeshStandardMaterial, DoubleSide: 2,
};

const sandbox = {
  window: {}, document: documentStub, THREE: THREEStub,
  console, setTimeout, clearTimeout, Blob: class { constructor() {} },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  addEventListener() {}, removeEventListener() {},
  devicePixelRatio: 1, Math, JSON, Float32Array, Array, Object, isFinite, Infinity, NaN,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const load = (rel) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), sandbox, { filename: rel });
['src/vec3.js', 'src/spline.js', 'src/road.js', 'src/demo.js', 'src/view3d.js', 'src/topview.js', 'src/app.js']
  .forEach(load);

// 触发 DOMContentLoaded
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

documentStub._listeners.DOMContentLoaded();

const app = sandbox; // app.js 把状态闭包在 IIFE 内，通过 DOM 副作用验证
check('3D 视图已创建', !!app.RoadView3D);
check('顶视图已创建', !!app.RoadTopView);

// 初始诊断面板应渲染（无问题时出现 empty li）
const initialIssues = elMap.issueList.innerHTML + createdLi.map((l) => l.textContent).join('');
check('初始诊断已渲染', createdLi.length > 0);

// 接缝状态
check('闭合接缝显示接顺', /ok/.test(elMap.seamBox.className), elMap.seamBox.className);
check('接缝文案含误差数据', /误差|接顺/.test(elMap.seamBox.textContent), elMap.seamBox.textContent);

// 细度统计同时含粗/细
check('细度对比含两种网格', /粗/.test(elMap.fineStats.innerHTML) && /细/.test(elMap.fineStats.innerHTML));

// 应用折叠参数 → 诊断出现 error
createdLi.length = 0;
elMap.foldBtn.dispatch('click');
const foldText = createdLi.map((l) => (l.className || '') + l.textContent).join(' ');
check('折叠后出现 error 级诊断', /error/.test(foldText), foldText.slice(0, 80));

// 恢复正常 → 无 error
createdLi.length = 0;
elMap.resetBtn.dispatch('click');
const resetText = createdLi.map((l) => (l.className || '') + l.textContent).join(' ');
check('恢复后无 error 诊断', !/error/.test(resetText), resetText.slice(0, 80));

// 切换到粗细度不报错
radioCoarse.checked = true;
radioCoarse.dispatch('change', { target: radioCoarse });
check('粗细度切换正常', /粗/.test(elMap.fineStats.innerHTML));

// 切开口路线
elMap.closed.checked = false;
elMap.closed.dispatch('change', { target: elMap.closed });
check('开口路线接缝提示为 none', /none/.test(elMap.seamBox.className), elMap.seamBox.className);
elMap.closed.checked = true;
elMap.closed.dispatch('change', { target: elMap.closed });

// 段参数编辑（宽度滑杆）
const wBefore = elMap.pWidth.value;
elMap.pWidth.value = '14';
elMap.pWidth.dispatch('input');
check('宽度滑杆更新显示值', elMap.pWidthV.textContent === '14.0', elMap.pWidthV.textContent);

console.log(`\n浏览器集成冒烟：${pass} 通过 / ${fail} 失败${fail ? '（存在失败）' : ''}`);
process.exitCode = fail ? 1 : 0;
