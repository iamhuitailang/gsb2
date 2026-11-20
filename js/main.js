// 三维布光工作台 —— 主程序
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { MATERIAL_LIBRARY, materialName } from './materials.js';
import { buildScene, defaultLights } from './scene.js';
import {
  state, snapshotScheme, applySchemeToState,
  serializeProject, loadProject, diffSchemes,
} from './store.js';

// ============================================================ 渲染器 / 场景
const canvas = document.getElementById('gl');
const wrap = document.getElementById('viewport-wrap');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

// 室内环境贴图：让金属 / 玻璃等 PBR 材质有反射内容（纯本地生成，无外部资源）
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

const objects = buildScene(scene);
for (const o of objects) { o.appliedKey = null; o.appliedColor = null; }
const objById = new Map(objects.map(o => [o.oid, o]));

const ambientLight = new THREE.AmbientLight('#404654', 0.6);
scene.add(ambientLight);

// ============================================================ 灯光运行时
const lightRuntimes = new Map(); // id -> { desc, light, helper }
let lastLightSig = '';

function makePointHelper() {
  const g = new THREE.Group();
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true })
  );
  const range = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.15 })
  );
  g.add(marker, range);
  g.userData = { marker, range };
  return g;
}

function disposeRuntime(rt) {
  scene.remove(rt.light);
  if (rt.light.target) scene.remove(rt.light.target);
  if (rt.helper) {
    scene.remove(rt.helper);
    if (rt.helper.dispose) rt.helper.dispose();
    rt.helper.traverse?.(c => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
  }
  rt.light.dispose?.();
}

function createRuntime(desc) {
  let light;
  if (desc.type === 'point') {
    light = new THREE.PointLight(desc.color, desc.intensity, desc.distance, desc.decay);
  } else if (desc.type === 'spot') {
    light = new THREE.SpotLight(
      desc.color, desc.intensity, Math.max(desc.distance, 1),
      THREE.MathUtils.degToRad(desc.angle), desc.penumbra, desc.decay
    );
  } else {
    light = new THREE.DirectionalLight(desc.color, desc.intensity);
  }
  light.position.set(...desc.position);
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.bias = -0.0004;
  if (desc.type !== 'point') {
    light.target.position.set(...desc.target);
    scene.add(light.target);
  }
  if (desc.type === 'spot') {
    light.shadow.camera.near = 0.5;
    light.shadow.camera.far = Math.max(desc.distance, 1);
  }
  scene.add(light);

  let helper = null;
  if (desc.type === 'point') helper = makePointHelper();
  else if (desc.type === 'spot') helper = new THREE.SpotLightHelper(light);
  else helper = new THREE.DirectionalLightHelper(light, 2);
  scene.add(helper);

  return { desc, light, helper };
}

function lightSignature() {
  return state.lights.map(l => l.id + ':' + l.type).join('|');
}

// 结构同步：灯光增删或类型变化时重建
function rebuildLights() {
  for (const rt of lightRuntimes.values()) disposeRuntime(rt);
  lightRuntimes.clear();
  for (const desc of state.lights) lightRuntimes.set(desc.id, createRuntime(desc));
  lastLightSig = lightSignature();
}

// 参数同步：每帧可调用，开销小
function updateLightRuntimes() {
  if (lightSignature() !== lastLightSig) rebuildLights();
  for (const d of state.lights) {
    const rt = lightRuntimes.get(d.id);
    if (!rt) continue;
    rt.desc = d; // 方案应用后 state.lights 是新对象，运行时必须重新绑定
    const l = rt.light;
    l.color.set(d.color);
    l.intensity = d.intensity;
    l.visible = d.visible;
    l.position.set(...d.position);
    l.castShadow = d.castShadow && state.shadows;
    if (d.type !== 'point') l.target.position.set(...d.target);
    if (d.type === 'point' || d.type === 'spot') { l.distance = d.distance; l.decay = d.decay; }
    if (d.type === 'spot') {
      l.angle = THREE.MathUtils.degToRad(d.angle);
      l.penumbra = d.penumbra;
      l.shadow.camera.far = Math.max(d.distance, 1);
    }
    // 辅助线（灯光覆盖范围）
    const hp = rt.helper;
    hp.visible = state.showHelpers && d.visible;
    if (d.type === 'point') {
      hp.position.copy(l.position);
      hp.userData.marker.material.color.set(d.color);
      hp.userData.range.material.color.set(d.color);
      hp.userData.range.visible = d.distance > 0;
      if (d.distance > 0) hp.userData.range.scale.setScalar(d.distance);
    } else {
      hp.update();
    }
  }
}

// ============================================================ 状态 → 场景
function applyShadows() {
  renderer.shadowMap.enabled = state.shadows;
  // 切换阴影开关需要刷新材质着色器（仅重编译，不改动任何几何数据）
  scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
}

function applyAmbient() {
  ambientLight.visible = state.ambient.enabled;
  ambientLight.color.set(state.ambient.color);
  ambientLight.intensity = state.ambient.intensity;
}

function applyOverrides() {
  for (const obj of objects) {
    const o = state.overrides[obj.oid] || {};
    obj.mesh.visible = !o.hidden;
    const key = o.materialKey || null;
    const color = key ? (o.color || MATERIAL_LIBRARY[key].defaultColor) : null;
    if (obj.appliedKey !== key || (key && obj.appliedColor !== color)) {
      if (obj.overrideMaterial) { obj.overrideMaterial.dispose(); obj.overrideMaterial = null; }
      if (key) {
        obj.overrideMaterial = MATERIAL_LIBRARY[key].make(color);
        obj.mesh.material = obj.overrideMaterial;
      } else {
        obj.mesh.material = obj.baseMaterial;
      }
      obj.appliedKey = key;
      obj.appliedColor = color;
    }
  }
}

function applyStateToScene() {
  updateLightRuntimes();
  applyAmbient();
  applyOverrides();
}

// ============================================================ 对比模式
let mode = 'edit';            // 'edit' | 'compare'
let workingSnapshot = null;   // 进入对比时保存的编辑状态
let compareA = '__current';
let compareB = null;

function compareSources() {
  const list = [{ id: '__current', name: '当前编辑状态', scheme: workingSnapshot }];
  for (const s of state.schemes) list.push({ id: s.name, name: s.name, scheme: s });
  return list;
}

function getComparePair() {
  const src = compareSources();
  const find = id => (src.find(s => s.id === id) || src[0]).scheme;
  return [find(compareA), find(compareB)];
}

function objectLabel(oid) {
  const o = objById.get(oid);
  return o ? `${o.name} (${oid})` : oid;
}

function updateDiffPanel() {
  const panel = document.getElementById('diff-panel');
  if (mode !== 'compare') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const [a, b] = getComparePair();
  const diff = diffSchemes(a, b, objectLabel);
  document.getElementById('label-left').textContent = 'A：' + (compareSources().find(s => s.id === compareA)?.name || '');
  document.getElementById('label-right').textContent = 'B：' + (compareSources().find(s => s.id === compareB)?.name || '');
  const box = document.getElementById('diff-content');
  box.innerHTML = '';
  const mk = (title, cls, items) => {
    const h4 = document.createElement('h4');
    h4.className = cls;
    h4.textContent = `${title}（${items.length}）`;
    box.appendChild(h4);
    if (!items.length) {
      const p = document.createElement('div'); p.className = 'none'; p.textContent = '无差异';
      box.appendChild(p);
    } else {
      const ul = document.createElement('ul');
      for (const t of items) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }
      box.appendChild(ul);
    }
  };
  mk('灯光差异', 'lights', diff.lights);
  mk('材质 / 对象差异', 'materials', diff.materials);
}

function setMode(m) {
  if (m === mode) return;
  mode = m;
  if (m === 'compare') {
    workingSnapshot = snapshotScheme('当前编辑状态');
    compareA = '__current';
    compareB = state.schemes.length ? state.schemes[0].name : '__current';
    wrap.classList.add('compare');
  } else {
    // 退出对比：恢复进入前的编辑状态
    if (workingSnapshot) {
      applySchemeToState(workingSnapshot);
      rebuildLights();
      applyStateToScene();
    }
    workingSnapshot = null;
    wrap.classList.remove('compare');
  }
  renderPanel();
  updateDiffPanel();
}

// ============================================================ 渲染循环
function resize() {
  const w = wrap.clientWidth, hgt = wrap.clientHeight;
  renderer.setSize(w, hgt, false);
}
new ResizeObserver(resize).observe(wrap);

function renderFrame() {
  const w = wrap.clientWidth, hgt = wrap.clientHeight;
  // 对比模式下单个视口宽度减半，相机宽高比需按视口计算
  const viewW = mode === 'compare' ? w / 2 : w;
  const aspect = viewW / hgt;
  if (Math.abs(camera.aspect - aspect) > 1e-6) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }
  if (mode === 'edit') {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, hgt);
    renderer.render(scene, camera);
  } else {
    const [schA, schB] = getComparePair();
    renderer.setScissorTest(true);
    // 左视口 = 方案 A，右视口 = 方案 B；同一相机渲染，保证视角一致
    applySchemeToState(schA); applyStateToScene();
    renderer.setViewport(0, 0, w / 2, hgt);
    renderer.setScissor(0, 0, w / 2, hgt);
    renderer.render(scene, camera);
    applySchemeToState(schB); applyStateToScene();
    renderer.setViewport(w / 2, 0, w / 2, hgt);
    renderer.setScissor(w / 2, 0, w / 2, hgt);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
  }
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderFrame();
}

// ============================================================ UI 构建
const panel = document.getElementById('panel');

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = h('div', { class: 'toast' }); wrap.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 1800);
}

// 数字滑杆 + 输入框组合
function numRow(label, value, min, max, step, onChange) {
  const num = h('input', { type: 'number', value, min, max, step });
  const range = h('input', { type: 'range', value, min, max, step });
  const sync = v => {
    v = Math.min(max, Math.max(min, parseFloat(v) || 0));
    num.value = v; range.value = v;
    onChange(v);
  };
  num.addEventListener('input', () => sync(num.value));
  range.addEventListener('input', () => sync(range.value));
  return h('div', { class: 'row' }, h('label', {}, label), range, num);
}

function colorRow(label, value, onChange) {
  const input = h('input', { type: 'color', value });
  input.addEventListener('input', () => onChange(input.value));
  return h('div', { class: 'row' }, h('label', {}, label), input, h('span', { class: 'val' }, value));
}

function checkRow(label, checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('div', { class: 'row' }, h('label', { class: 'auto' }, label), input);
}

function xyzRow(label, arr, onChange) {
  const inputs = arr.map((v, i) => {
    const inp = h('input', { type: 'number', step: 0.5, value: v });
    inp.addEventListener('input', () => { arr[i] = parseFloat(inp.value) || 0; onChange(); });
    return inp;
  });
  return h('div', { class: 'row' }, h('label', {}, label),
    h('div', { class: 'xyz' },
      h('span', {}, 'X'), inputs[0], h('span', {}, 'Y'), inputs[1], h('span', {}, 'Z'), inputs[2]));
}

const TYPE_NAMES = { point: '点光', spot: '聚光', directional: '方向光' };
let selectedLightId = null;

// ---------- 灯光区块 ----------
function lightEditor(desc) {
  const box = h('div', { class: 'editor' });
  const refresh = () => applyStateToScene();

  const nameInput = h('input', { type: 'text', value: desc.name });
  nameInput.addEventListener('input', () => { desc.name = nameInput.value; });
  box.appendChild(h('div', { class: 'row' }, h('label', {}, '名称'), nameInput));

  box.appendChild(colorRow('颜色', desc.color, v => { desc.color = v; refresh(); }));

  const isDir = desc.type === 'directional';
  box.appendChild(numRow('强度', desc.intensity, 0, isDir ? 10 : 600, isDir ? 0.05 : 1,
    v => { desc.intensity = v; refresh(); }));

  box.appendChild(xyzRow('位置', desc.position, refresh));
  if (desc.type !== 'point') box.appendChild(xyzRow('目标点', desc.target, refresh));

  if (desc.type === 'point') {
    box.appendChild(numRow('范围', desc.distance, 0, 80, 0.5, v => { desc.distance = v; refresh(); }));
    box.appendChild(h('div', { class: 'row' }, h('span', { class: 'val' }, '范围 0 = 无限远')));
  }
  if (desc.type === 'spot') {
    box.appendChild(numRow('范围', desc.distance, 1, 100, 0.5, v => { desc.distance = v; refresh(); }));
    box.appendChild(numRow('角度°', desc.angle, 1, 89, 1, v => { desc.angle = v; refresh(); }));
    box.appendChild(numRow('半影', desc.penumbra, 0, 1, 0.01, v => { desc.penumbra = v; refresh(); }));
  }
  box.appendChild(numRow('衰减', desc.decay, 0, 4, 0.1, v => { desc.decay = v; refresh(); }));
  box.appendChild(checkRow('投射阴影', desc.castShadow, v => { desc.castShadow = v; refresh(); }));
  return box;
}

function lightsSection() {
  const body = h('div', { class: 'body' });
  body.appendChild(h('div', { class: 'row' },
    h('button', { class: 'mini', onclick: () => addLight('point') }, '+ 点光'),
    h('button', { class: 'mini', onclick: () => addLight('directional') }, '+ 方向光'),
    h('button', { class: 'mini', onclick: () => addLight('spot') }, '+ 聚光'),
  ));
  for (const desc of state.lights) {
    const eye = h('button', { class: 'mini' }, desc.visible ? '👁' : '–');
    eye.addEventListener('click', () => { desc.visible = !desc.visible; applyStateToScene(); renderPanel(); });
    const del = h('button', { class: 'mini danger' }, '✕');
    del.addEventListener('click', () => {
      state.lights = state.lights.filter(l => l.id !== desc.id);
      rebuildLights(); applyStateToScene(); renderPanel();
    });
    const head = h('div', { class: 'item-head' },
      eye,
      h('span', { class: 'name', onclick: () => { selectedLightId = selectedLightId === desc.id ? null : desc.id; renderPanel(); } }, desc.name),
      h('span', { class: 'badge ' + desc.type }, TYPE_NAMES[desc.type]),
      del,
    );
    const item = h('div', { class: 'light-item' + (selectedLightId === desc.id ? ' sel' : '') }, head);
    if (selectedLightId === desc.id) item.appendChild(lightEditor(desc));
    body.appendChild(item);
  }
  return h('section', { class: 'block' }, h('h2', {}, '灯光'), body);
}

function addLight(type) {
  const id = 'light-' + (state.nextLightId++);
  const base = {
    id, type, color: '#ffffff', target: [0, 1, 0], distance: 25,
    angle: 35, penumbra: 0.3, decay: 2, castShadow: true, visible: true,
  };
  if (type === 'point') Object.assign(base, { name: '点光', intensity: 50, position: [0, 6, 4], distance: 0 });
  if (type === 'spot') Object.assign(base, { name: '聚光', intensity: 200, position: [5, 9, 5] });
  if (type === 'directional') Object.assign(base, { name: '方向光', intensity: 1.5, position: [5, 10, -5], distance: 0 });
  state.lights.push(base);
  selectedLightId = id;
  rebuildLights(); applyStateToScene(); renderPanel();
}

// ---------- 全局设置区块 ----------
function globalsSection() {
  const body = h('div', { class: 'body' });
  body.appendChild(checkRow('启用阴影（不改变几何）', state.shadows, v => { state.shadows = v; applyShadows(); applyStateToScene(); }));
  body.appendChild(checkRow('启用环境光', state.ambient.enabled, v => { state.ambient.enabled = v; applyStateToScene(); }));
  body.appendChild(colorRow('环境光色', state.ambient.color, v => { state.ambient.color = v; applyStateToScene(); }));
  body.appendChild(numRow('环境强度', state.ambient.intensity, 0, 3, 0.05, v => { state.ambient.intensity = v; applyStateToScene(); }));
  body.appendChild(checkRow('显示灯光范围', state.showHelpers, v => { state.showHelpers = v; applyStateToScene(); }));
  return h('section', { class: 'block' }, h('h2', {}, '全局设置'), body);
}

// ---------- 场景对象区块 ----------
function objectsSection() {
  const body = h('div', { class: 'body' });
  for (const obj of objects) {
    const ov = state.overrides[obj.oid] || {};
    const eye = h('input', { type: 'checkbox', title: '显示 / 隐藏' });
    eye.checked = !ov.hidden;
    eye.addEventListener('change', () => {
      setOverride(obj.oid, { hidden: !eye.checked });
    });
    const sel = h('select', {});
    sel.appendChild(h('option', { value: '' }, '原始材质'));
    for (const key of Object.keys(MATERIAL_LIBRARY)) {
      sel.appendChild(h('option', { value: key }, MATERIAL_LIBRARY[key].name));
    }
    sel.value = ov.materialKey || '';
    sel.addEventListener('change', () => setOverride(obj.oid, { materialKey: sel.value || null }));

    const row2 = h('div', { class: 'row' }, h('label', {}, '材质'), sel);
    if (ov.materialKey) {
      const colorInp = h('input', { type: 'color', value: ov.color || MATERIAL_LIBRARY[ov.materialKey].defaultColor });
      colorInp.addEventListener('input', () => setOverride(obj.oid, { color: colorInp.value }));
      row2.appendChild(colorInp);
    }
    body.appendChild(h('div', { class: 'obj-item' },
      h('div', { class: 'item-head' }, eye,
        h('span', { class: 'name' }, obj.name),
        h('span', { class: 'oid' }, obj.oid)),
      row2,
    ));
  }
  return h('section', { class: 'block' }, h('h2', {}, '场景对象（可单独隐藏 / 替换材质）'), body);
}

function setOverride(oid, patch) {
  const cur = state.overrides[oid] || {};
  const next = { ...cur, ...patch };
  if (!next.hidden && !next.materialKey) delete state.overrides[oid];
  else state.overrides[oid] = next;
  applyStateToScene();
  if ('materialKey' in patch) renderPanel(); // 材质下拉变化需刷新颜色选择器
}

// ---------- 方案区块 ----------
function schemesSection() {
  const body = h('div', { class: 'body' });
  if (mode === 'edit') {
    const nameInput = h('input', { type: 'text', placeholder: '方案名称', value: '方案 ' + (state.schemes.length + 1) });
    const saveBtn = h('button', { class: 'mini primary' }, '保存当前为方案');
    saveBtn.addEventListener('click', () => {
      const name = nameInput.value.trim() || '方案 ' + (state.schemes.length + 1);
      const existing = state.schemes.findIndex(s => s.name === name);
      const snap = snapshotScheme(name);
      if (existing >= 0) state.schemes[existing] = snap; else state.schemes.push(snap);
      toast('已保存方案「' + name + '」');
      renderPanel();
    });
    body.appendChild(h('div', { class: 'row' }, nameInput, saveBtn));
  }

  for (const sch of state.schemes) {
    const applyBtn = h('button', { class: 'mini' }, '应用');
    applyBtn.addEventListener('click', () => {
      if (mode === 'compare') {
        // 对比模式下“应用”= 以该方案作为新的编辑状态并切回编辑模式
        applySchemeToState(sch);
        workingSnapshot = snapshotScheme('当前编辑状态');
        setMode('edit');
      } else {
        applySchemeToState(sch);
        rebuildLights(); applyStateToScene(); renderPanel();
      }
      toast('已应用方案「' + sch.name + '」');
    });
    const aBtn = h('button', { class: 'mini' + (compareA === sch.name && mode === 'compare' ? ' active' : '') }, 'A');
    const bBtn = h('button', { class: 'mini' + (compareB === sch.name && mode === 'compare' ? ' active' : '') }, 'B');
    aBtn.addEventListener('click', () => { compareA = sch.name; if (mode !== 'compare') setMode('compare'); else { renderPanel(); updateDiffPanel(); } });
    bBtn.addEventListener('click', () => { compareB = sch.name; if (mode !== 'compare') setMode('compare'); else { renderPanel(); updateDiffPanel(); } });
    const del = h('button', { class: 'mini danger' }, '✕');
    del.addEventListener('click', () => {
      state.schemes = state.schemes.filter(s => s !== sch);
      renderPanel(); updateDiffPanel();
    });
    body.appendChild(h('div', { class: 'scheme-item' },
      h('div', { class: 'item-head' },
        h('span', { class: 'name' }, sch.name),
        applyBtn,
        h('span', { class: 'val' }, '对比:'),
        aBtn, bBtn, del),
    ));
  }
  if (!state.schemes.length) body.appendChild(h('div', { class: 'row' }, h('span', { class: 'val' }, '暂无方案，先保存一个')));
  return h('section', { class: 'block' }, h('h2', {}, '布光方案'), body);
}

// ---------- 对比控制 ----------
function compareSection() {
  const body = h('div', { class: 'body' });
  const src = compareSources();
  const mkSelect = (val, onCh) => {
    const sel = h('select', {});
    for (const s of src) sel.appendChild(h('option', { value: s.id }, s.name));
    sel.value = val;
    sel.addEventListener('change', () => onCh(sel.value));
    return sel;
  };
  body.appendChild(h('div', { class: 'row' }, h('label', {}, '视口 A'),
    mkSelect(compareA, v => { compareA = v; updateDiffPanel(); })));
  body.appendChild(h('div', { class: 'row' }, h('label', {}, '视口 B'),
    mkSelect(compareB, v => { compareB = v; updateDiffPanel(); })));
  body.appendChild(h('div', { class: 'row' },
    h('span', { class: 'val' }, '两个视口共用同一相机，拖动可同步旋转视角；差异列表见画面右侧。')));
  return h('section', { class: 'block' }, h('h2', {}, '方案对比'), body);
}

// ---------- 项目区块 ----------
const LS_KEY = 'lighting-workbench-project';

function captureCamera() {
  state.camera = {
    position: camera.position.toArray(),
    target: controls.target.toArray(),
  };
}

function restoreCamera() {
  camera.position.set(...state.camera.position);
  controls.target.set(...state.camera.target);
  controls.update();
}

function download(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function projectSection() {
  const body = h('div', { class: 'body' });
  body.appendChild(h('div', { class: 'toolbar' },
    h('button', {
      class: 'mini', onclick: () => {
        captureCamera();
        localStorage.setItem(LS_KEY, JSON.stringify(serializeProject()));
        toast('项目已保存到浏览器');
      },
    }, '保存到浏览器'),
    h('button', {
      class: 'mini', onclick: () => {
        captureCamera();
        download('布光项目.json', JSON.stringify(serializeProject(), null, 2));
      },
    }, '下载项目文件'),
    h('button', {
      class: 'mini', onclick: () => {
        const inp = h('input', { type: 'file', accept: '.json' });
        inp.addEventListener('change', () => {
          const f = inp.files[0];
          if (!f) return;
          f.text().then(text => { loadProject(JSON.parse(text)); fullRefresh(); toast('项目已加载'); })
            .catch(e => alert('加载失败：' + e.message));
        });
        inp.click();
      },
    }, '加载项目文件'),
  ));
  body.appendChild(h('div', { class: 'toolbar', style: 'margin-top:6px' },
    h('button', {
      class: 'mini', onclick: () => {
        renderFrame();
        canvas.toBlob(b => download('布光画面.png', b), 'image/png');
      },
    }, '导出画面 PNG'),
    h('button', {
      class: 'mini', onclick: () => {
        download('布光方案参数.json', JSON.stringify({ exportedAt: new Date().toISOString(), schemes: state.schemes }, null, 2));
      },
    }, '导出方案参数'),
  ));
  return h('section', { class: 'block' }, h('h2', {}, '项目'), body);
}

// ---------- 模式切换 ----------
function modeSection() {
  const editBtn = h('button', { class: mode === 'edit' ? 'active' : '' }, '编辑模式');
  const cmpBtn = h('button', { class: mode === 'compare' ? 'active' : '' }, '对比模式');
  editBtn.addEventListener('click', () => setMode('edit'));
  cmpBtn.addEventListener('click', () => setMode('compare'));
  return h('section', { class: 'block' },
    h('div', { class: 'body' },
      h('div', { class: 'mode-switch' }, editBtn, cmpBtn)));
}

function renderPanel() {
  panel.innerHTML = '';
  panel.appendChild(modeSection());
  if (mode === 'edit') {
    panel.appendChild(globalsSection());
    panel.appendChild(lightsSection());
    panel.appendChild(objectsSection());
    panel.appendChild(schemesSection());
  } else {
    panel.appendChild(compareSection());
    panel.appendChild(schemesSection());
  }
  panel.appendChild(projectSection());
}

function fullRefresh() {
  rebuildLights();
  applyShadows();
  applyStateToScene();
  restoreCamera();
  renderPanel();
  updateDiffPanel();
}

// ============================================================ 初始化
function initDefault() {
  state.lights = defaultLights();
  state.ambient = { enabled: true, color: '#404654', intensity: 0.6 };
  state.shadows = true;

  // 预置两套示例方案，便于立即体验对比功能
  state.schemes.push(snapshotScheme('三点布光（示例）'));

  // 夜晚氛围：调暗环境、暖色聚光、冷色轮廓
  state.lights.find(l => l.name === '主聚光').intensity = 120;
  state.lights.find(l => l.name === '主聚光').color = '#ffb066';
  state.lights.find(l => l.name === '冷补光').intensity = 12;
  state.lights.find(l => l.name === '冷补光').color = '#4a6cff';
  state.lights.find(l => l.name === '轮廓方向光').intensity = 0.25;
  state.lights.find(l => l.name === '轮廓方向光').color = '#8fa8ff';
  state.ambient = { enabled: true, color: '#1c2440', intensity: 0.35 };
  state.schemes.push(snapshotScheme('夜晚氛围（示例）'));

  // 工作状态恢复为 daytime 方案
  applySchemeToState(state.schemes[0]);
}

const saved = localStorage.getItem(LS_KEY);
if (saved) {
  try { loadProject(JSON.parse(saved)); }
  catch (e) { console.warn('本地项目损坏，使用默认场景', e); initDefault(); }
} else {
  initDefault();
}

fullRefresh();
resize();
animate();

// 支持 ?mode=compare&a=方案名&b=方案名 直接进入对比（便于测试与分享链接）
{
  const q = new URLSearchParams(location.search);
  if (q.get('mode') === 'compare') {
    setMode('compare');
    const src = compareSources();
    if (src.some(s => s.name === q.get('a'))) { compareA = q.get('a'); }
    if (src.some(s => s.name === q.get('b'))) { compareB = q.get('b'); }
    renderPanel();
    updateDiffPanel();
  }
}
