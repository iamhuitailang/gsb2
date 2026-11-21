// 贴花预览器主程序
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TransformControls } from '../vendor/TransformControls.js';
import { computeDecalGeometry } from './decal.js';
import { makePatternTexture } from './textures.js';
import { serializeProject, deserializeProject, STORAGE_KEY } from './store.js';

// ---------------------------------------------------------------- 基础场景
const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10131a);
scene.fog = new THREE.Fog(0x10131a, 25, 60);

const camera = new THREE.PerspectiveCamera(50, viewport.clientWidth / viewport.clientHeight, 0.1, 200);
camera.position.set(5.5, 4.2, 7.5);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;

const tc = new TransformControls(camera, renderer.domElement);
tc.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
scene.add(tc);

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2620, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(6, 10, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -12;
sun.shadow.camera.right = sun.shadow.camera.top = 12;
scene.add(sun);

const grid = new THREE.GridHelper(24, 24, 0x3a4353, 0x262c38);
scene.add(grid);

// ---------------------------------------------------------------- 状态
const objects = new Map();   // id -> {id,name,type,params,receivesDecal,mesh}
const decals = new Map();    // id -> cfg
const decalRT = new Map();   // id -> {mesh,potential,rejected,box}
let selectedObjectId = null;
let selectedDecalId = null;
let editProjector = false;
const debug = { showBox: true, showClipped: false, showRejected: false };

const uid = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------- 物体
const OBJECT_COLORS = { box: 0xb08d57, cylinder: 0x7d9bb3, sphere: 0x9b7db3, plane: 0x3f4550 };

function buildGeometry(type, p) {
  switch (type) {
    case 'box': return new THREE.BoxGeometry(p.w, p.h, p.d);
    case 'cylinder': return new THREE.CylinderGeometry(p.rt, p.rb, p.h, p.seg || 32);
    case 'sphere': return new THREE.SphereGeometry(p.r, p.seg || 32, 16);
    case 'plane': return new THREE.PlaneGeometry(p.w, p.h);
    default: throw new Error('未知几何体: ' + type);
  }
}

function createObject(data) {
  const id = data.id || uid();
  const mesh = new THREE.Mesh(
    buildGeometry(data.type, data.params),
    new THREE.MeshStandardMaterial({
      color: data.color ?? OBJECT_COLORS[data.type] ?? 0x999999,
      roughness: 0.9, metalness: 0.02,
    }));
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.position.fromArray(data.position || [0, 0.5, 0]);
  if (data.rotation) mesh.rotation.set(...data.rotation);
  if (data.scale) mesh.scale.fromArray(data.scale);
  mesh.userData.oid = id;
  scene.add(mesh);
  const rec = {
    id, mesh,
    name: data.name || data.type,
    type: data.type,
    params: data.params,
    receivesDecal: data.receivesDecal !== false,
  };
  objects.set(id, rec);
  return rec;
}

function deleteObject(id) {
  const rec = objects.get(id);
  if (!rec) return;
  for (const d of [...decals.values()]) {
    if (d.targetId === id) deleteDecal(d.id);
  }
  if (selectedObjectId === id) selectObject(null);
  scene.remove(rec.mesh);
  rec.mesh.geometry.dispose();
  rec.mesh.material.dispose();
  objects.delete(id);
  renderObjectList();
  refreshGizmo();
}

// ---------------------------------------------------------------- 贴花
function disposeDeep(obj) {
  obj.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) { (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose()); }
  });
}

function buildDecalMesh(cfg, res) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(res.positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(res.normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(res.uvs, 2));
  // polygonOffset 防 z-fighting；order 越大的贴花偏移越多、绘制越靠后
  const m = new THREE.MeshStandardMaterial({
    map: makePatternTexture(cfg.pattern, cfg.text),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -(2 + cfg.order * 2),
    polygonOffsetUnits: -(2 + cfg.order * 2),
    roughness: 0.85, metalness: 0,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 100 + cfg.order;
  mesh.userData.decalId = cfg.id;
  return mesh;
}

function buildDebugMesh(positions, color, offsetFactor, renderOrder) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const m = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.35, depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: offsetFactor, polygonOffsetUnits: offsetFactor,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = renderOrder;
  return mesh;
}

function buildBoxHelper(cfg) {
  const group = new THREE.Group();
  group.position.fromArray(cfg.projPos);
  group.quaternion.fromArray(cfg.projQuat);
  // 投影盒从投影器位置向前（-Z）延伸 depth
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(cfg.width, cfg.height, cfg.depth)),
    new THREE.LineBasicMaterial({ color: 0x4da3ff }));
  edges.position.z = -cfg.depth / 2;
  group.add(edges);
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 0),
    cfg.depth, 0x4da3ff, 0.18, 0.1);
  group.add(arrow);
  group.userData.isProjectorBox = true;
  return group;
}

function rebuildDecal(id) {
  const cfg = decals.get(id);
  if (!cfg) return;
  const old = decalRT.get(id);
  if (old) {
    for (const k of ['mesh', 'potential', 'rejected', 'box']) {
      if (old[k]) { scene.remove(old[k]); disposeDeep(old[k]); }
    }
  }
  const rt = {};
  const target = objects.get(cfg.targetId);
  if (target && target.receivesDecal) {
    target.mesh.updateWorldMatrix(true, false);
    const res = computeDecalGeometry(target.mesh, cfg, 1);
    if (res.positions.length) {
      rt.mesh = buildDecalMesh(cfg, res);
      scene.add(rt.mesh);
    }
    if (debug.showClipped) {
      const pot = computeDecalGeometry(target.mesh, cfg, 3);
      if (pot.positions.length) {
        rt.potential = buildDebugMesh(pot.positions, 0xff4444, -1, 90);
        rt.potential.visible = id === selectedDecalId;
        scene.add(rt.potential);
      }
    }
    if (debug.showRejected && res.rejected.length) {
      rt.rejected = buildDebugMesh(res.rejected, 0xffcc22, -0.5, 80);
      rt.rejected.visible = id === selectedDecalId;
      scene.add(rt.rejected);
    }
    rt.box = buildBoxHelper(cfg);
    rt.box.visible = id === selectedDecalId && (debug.showBox || editProjector);
    scene.add(rt.box);
  }
  decalRT.set(id, rt);
  if (editProjector && id === selectedDecalId) refreshGizmo();
}

function rebuildAllDecals() {
  for (const id of decals.keys()) rebuildDecal(id);
}

function rebuildDecalsForObject(oid) {
  for (const d of decals.values()) if (d.targetId === oid) rebuildDecal(d.id);
}

function createDecal(cfg) {
  const id = cfg.id || uid();
  decals.set(id, { ...cfg, id });
  rebuildDecal(id);
  renderDecalList();
  return id;
}

function deleteDecal(id) {
  decals.delete(id);
  const rt = decalRT.get(id);
  if (rt) {
    for (const k of ['mesh', 'potential', 'rejected', 'box']) {
      if (rt[k]) { scene.remove(rt[k]); disposeDeep(rt[k]); }
    }
    decalRT.delete(id);
  }
  if (selectedDecalId === id) selectDecal(null);
  renderDecalList();
}

function maxOrder() {
  let m = -1;
  for (const d of decals.values()) m = Math.max(m, d.order);
  return m;
}

// 从相机视角新建贴花，依附到当前选中物体（否则第一个接收贴花的物体）
function addDecalFromCamera() {
  let target = objects.get(selectedObjectId);
  if (!target || !target.receivesDecal) {
    target = [...objects.values()].find((o) => o.receivesDecal);
  }
  if (!target) { setStatus('场景里没有可接收贴花的物体'); return; }
  // 深度取相机到观察目标距离的两倍，保证投影盒够到画面中心附近的表面
  const depth = Math.min(30, Math.max(2, camera.position.distanceTo(orbit.target) * 2));
  const id = createDecal({
    name: '贴花 ' + (decals.size + 1),
    targetId: target.id,
    pattern: 'plate',
    text: 'A-' + String(decals.size + 1).padStart(2, '0'),
    width: 1.2, height: 0.8, depth,
    roll: 0, maxAngle: 75,
    order: maxOrder() + 1,
    projPos: camera.position.toArray(),
    projQuat: camera.quaternion.toArray(),
  });
  selectDecal(id);
  setStatus('已按当前相机视角创建贴花，可勾选“用 gizmo 编辑投影器”微调');
}

// ---------------------------------------------------------------- 选择 & gizmo
function selectObject(id) {
  if (selectedObjectId && objects.get(selectedObjectId)) {
    objects.get(selectedObjectId).mesh.material.emissive.setHex(0);
  }
  selectedObjectId = id;
  if (id && objects.get(id)) {
    objects.get(id).mesh.material.emissive.setHex(0x1a2c44);
  }
  renderObjectList();
  refreshGizmo();
}

function selectDecal(id) {
  selectedDecalId = id;
  renderDecalList();
  renderDecalEditor();
  for (const [did, rt] of decalRT) {
    const sel = did === id;
    if (rt.box) rt.box.visible = sel && (debug.showBox || editProjector);
    if (rt.potential) rt.potential.visible = sel;
    if (rt.rejected) rt.rejected.visible = sel;
  }
  refreshGizmo();
}

function refreshGizmo() {
  const rt = selectedDecalId ? decalRT.get(selectedDecalId) : null;
  if (editProjector && rt && rt.box) {
    tc.attach(rt.box);
  } else if (selectedObjectId && objects.get(selectedObjectId)) {
    tc.attach(objects.get(selectedObjectId).mesh);
  } else {
    tc.detach();
  }
}

tc.addEventListener('objectChange', () => {
  const obj = tc.object;
  if (!obj) return;
  if (obj.userData.isProjectorBox) {
    // gizmo 写回投影器位姿
    const cfg = decals.get(selectedDecalId);
    if (!cfg) return;
    cfg.projPos = obj.position.toArray();
    cfg.projQuat = obj.quaternion.toArray();
    obj.scale.set(1, 1, 1);
    rebuildDecal(cfg.id);
  } else if (obj.userData.oid) {
    // 物体变换 -> 依附其上的贴花实时跟随重建
    rebuildDecalsForObject(obj.userData.oid);
  }
});

// 点击拾取
const raycaster = new THREE.Raycaster();
let downPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 5 || tc.dragging) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const pickables = [];
  for (const rt of decalRT.values()) if (rt.mesh) pickables.push(rt.mesh);
  for (const o of objects.values()) pickables.push(o.mesh);
  const hits = raycaster.intersectObjects(pickables, false);
  if (!hits.length) { selectObject(null); return; }
  const hit = hits[0].object;
  if (hit.userData.decalId) {
    const cfg = decals.get(hit.userData.decalId);
    selectDecal(cfg.id);
    selectObject(cfg.targetId);
  } else {
    selectObject(hit.userData.oid);
  }
});

// ---------------------------------------------------------------- UI
const $ = (id) => document.getElementById(id);
const statusEl = $('save-status');
let statusTimer = null;
function setStatus(msg) {
  statusEl.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 4000);
}

function renderObjectList() {
  const ul = $('object-list');
  ul.innerHTML = '';
  for (const o of objects.values()) {
    const li = document.createElement('li');
    if (o.id === selectedObjectId) li.classList.add('selected');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = o.name;
    name.onclick = () => selectObject(o.id);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = o.type;
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = o.receivesDecal;
    chk.title = '接收贴花';
    chk.onchange = () => {
      o.receivesDecal = chk.checked;
      rebuildDecalsForObject(o.id);
      renderDecalList();
    };
    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'danger';
    del.onclick = () => deleteObject(o.id);
    li.append(chk, name, tag, del);
    ul.appendChild(li);
  }
}

function sortedDecals() {
  return [...decals.values()].sort((a, b) => a.order - b.order);
}

function renderDecalList() {
  const ul = $('decal-list');
  ul.innerHTML = '';
  for (const d of sortedDecals()) {
    const li = document.createElement('li');
    if (d.id === selectedDecalId) li.classList.add('selected');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = d.name;
    name.onclick = () => selectDecal(d.id);
    const target = objects.get(d.targetId);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = target ? (target.receivesDecal ? target.name : target.name + '·已排除') : '目标缺失';
    const up = document.createElement('button');
    up.textContent = '↑';
    up.title = '绘制顺序前移（更靠上层）';
    up.onclick = () => moveOrder(d.id, +1);
    const down = document.createElement('button');
    down.textContent = '↓';
    down.title = '绘制顺序后移';
    down.onclick = () => moveOrder(d.id, -1);
    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'danger';
    del.onclick = () => deleteDecal(d.id);
    li.append(name, tag, up, down, del);
    ul.appendChild(li);
  }
}

// order 越大越靠上层；↑ 表示向上提一层
function moveOrder(id, dir) {
  const list = sortedDecals();
  const i = list.findIndex((d) => d.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const tmp = list[i].order;
  list[i].order = list[j].order;
  list[j].order = tmp;
  rebuildAllDecals();
  renderDecalList();
}

function fillTargetSelect(sel, current) {
  sel.innerHTML = '';
  for (const o of objects.values()) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.name + (o.receivesDecal ? '' : '（不接收）');
    sel.appendChild(opt);
  }
  sel.value = current;
}

function renderDecalEditor() {
  const ed = $('decal-editor');
  const cfg = selectedDecalId ? decals.get(selectedDecalId) : null;
  ed.hidden = !cfg;
  if (!cfg) return;
  $('dec-name').value = cfg.name;
  fillTargetSelect($('dec-target'), cfg.targetId);
  fillTargetSelect($('dec-copy-target'), cfg.targetId);
  $('dec-pattern').value = cfg.pattern;
  $('dec-text').value = cfg.text || '';
  $('dec-width').value = cfg.width;
  $('dec-height').value = cfg.height;
  $('dec-depth').value = cfg.depth;
  $('dec-roll').value = cfg.roll;
  $('dec-angle').value = cfg.maxAngle;
  updateEditorLabels(cfg);
  $('dec-edit-projector').checked = editProjector;
}

function updateEditorLabels(cfg) {
  $('dec-width-v').textContent = cfg.width.toFixed(2);
  $('dec-height-v').textContent = cfg.height.toFixed(2);
  $('dec-depth-v').textContent = cfg.depth.toFixed(1);
  $('dec-roll-v').textContent = cfg.roll + '°';
  $('dec-angle-v').textContent = cfg.maxAngle + '°';
}

function withSelectedDecal(fn) {
  const cfg = selectedDecalId ? decals.get(selectedDecalId) : null;
  if (cfg) { fn(cfg); rebuildDecal(cfg.id); }
}

$('dec-name').addEventListener('input', (e) => withSelectedDecal((c) => { c.name = e.target.value; renderDecalList(); }));
$('dec-target').addEventListener('change', (e) => withSelectedDecal((c) => { c.targetId = e.target.value; renderDecalList(); }));
$('dec-pattern').addEventListener('change', (e) => withSelectedDecal((c) => { c.pattern = e.target.value; }));
$('dec-text').addEventListener('input', (e) => withSelectedDecal((c) => { c.text = e.target.value; }));
for (const [id, key, isInt] of [
  ['dec-width', 'width'], ['dec-height', 'height'], ['dec-depth', 'depth'],
  ['dec-roll', 'roll', true], ['dec-angle', 'maxAngle', true],
]) {
  $(id).addEventListener('input', (e) => withSelectedDecal((c) => {
    c[key] = isInt ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
    updateEditorLabels(c);
  }));
}

$('dec-from-camera').onclick = () => withSelectedDecal((c) => {
  c.projPos = camera.position.toArray();
  c.projQuat = camera.quaternion.toArray();
});

$('dec-look-target').onclick = () => withSelectedDecal((c) => {
  const t = objects.get(c.targetId);
  if (!t) return;
  const center = new THREE.Box3().setFromObject(t.mesh).getCenter(new THREE.Vector3());
  const eye = new THREE.Vector3().fromArray(c.projPos);
  const m = new THREE.Matrix4().lookAt(eye, center, new THREE.Vector3(0, 1, 0));
  c.projQuat = new THREE.Quaternion().setFromRotationMatrix(m).toArray();
});

$('dec-edit-projector').addEventListener('change', (e) => {
  editProjector = e.target.checked;
  selectDecal(selectedDecalId); // 刷新盒显隐与 gizmo
});

$('dec-copy').onclick = () => {
  const cfg = selectedDecalId ? decals.get(selectedDecalId) : null;
  if (!cfg) return;
  const targetId = $('dec-copy-target').value;
  if (!targetId) return;
  // 深拷贝配置、换新 id、换依附对象：两个副本之后互不影响
  const id = createDecal({
    ...JSON.parse(JSON.stringify(cfg)),
    id: undefined,
    name: cfg.name + ' 副本',
    targetId,
    order: maxOrder() + 1,
  });
  selectDecal(id);
  setStatus('已复制到「' + (objects.get(targetId)?.name || '?') + '」，副本可独立调整');
};

// 工程按钮
$('btn-save').onclick = () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeProject([...objects.values()], [...decals.values()])));
  setStatus('已保存到浏览器本地存储');
};
$('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(serializeProject([...objects.values()], [...decals.values()]), null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'decal-project.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
$('btn-import').onclick = () => $('file-import').click();
$('file-import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    applyProject(deserializeProject(await f.text()));
    setStatus('导入成功');
  } catch (err) {
    setStatus('导入失败：' + err.message);
  }
  e.target.value = '';
});
$('btn-load').onclick = () => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) { setStatus('本地没有已保存的工程'); return; }
  try {
    applyProject(deserializeProject(raw));
    setStatus('已载入');
  } catch (err) {
    setStatus('载入失败：' + err.message);
  }
};
$('btn-reset').onclick = () => { applyProject(demoProject()); setStatus('已重置为演示场景'); };

// 物体添加 / 变换模式
let addCounter = 0;
$('btn-add-box').onclick = () => createObject({
  name: '箱体 ' + (++addCounter), type: 'box', params: { w: 1.2, h: 1.2, d: 1.2 },
  position: [Math.random() * 4 - 2, 0.6, Math.random() * 4 - 2],
}) && renderObjectList();
$('btn-add-cylinder').onclick = () => createObject({
  name: '圆柱 ' + (++addCounter), type: 'cylinder', params: { rt: 0.6, rb: 0.6, h: 1.4, seg: 32 },
  position: [Math.random() * 4 - 2, 0.7, Math.random() * 4 - 2],
}) && renderObjectList();
$('btn-add-sphere').onclick = () => createObject({
  name: '球体 ' + (++addCounter), type: 'sphere', params: { r: 0.7, seg: 32 },
  position: [Math.random() * 4 - 2, 0.7, Math.random() * 4 - 2],
}) && renderObjectList();

function setMode(mode) {
  tc.setMode(mode);
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}
document.querySelectorAll('.mode-btn').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
window.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'w' || e.key === 'W') setMode('translate');
  if (e.key === 'e' || e.key === 'E') setMode('rotate');
  if (e.key === 'r' || e.key === 'R') setMode('scale');
});
setMode('translate');

$('btn-add-decal').onclick = addDecalFromCamera;

// 检查视图开关
$('dbg-box').addEventListener('change', (e) => { debug.showBox = e.target.checked; selectDecal(selectedDecalId); });
$('dbg-clipped').addEventListener('change', (e) => { debug.showClipped = e.target.checked; rebuildAllDecals(); });
$('dbg-rejected').addEventListener('change', (e) => { debug.showRejected = e.target.checked; rebuildAllDecals(); });

// 支持 ?debug=clipped,rejected&decal=d1 直接打开检查视图（便于核对与截图）
let pendingSelectDecal = null;
{
  const q = new URLSearchParams(location.search);
  const dbg = (q.get('debug') || '').split(',').filter(Boolean);
  if (dbg.includes('clipped')) { debug.showClipped = true; $('dbg-clipped').checked = true; }
  if (dbg.includes('rejected')) { debug.showRejected = true; $('dbg-rejected').checked = true; }
  if (q.get('decal')) pendingSelectDecal = q.get('decal');
}

// ---------------------------------------------------------------- 工程应用 / 演示场景
function clearProject() {
  for (const id of [...decals.keys()]) deleteDecal(id);
  for (const id of [...objects.keys()]) deleteObject(id);
  selectObject(null);
  selectDecal(null);
}

function applyProject(data) {
  clearProject();
  for (const o of data.objects) createObject(o);
  for (const d of data.decals) createDecal(d);
  renderObjectList();
  renderDecalList();
  renderDecalEditor();
}

function lookAtQuat(eye, target) {
  const m = new THREE.Matrix4().lookAt(
    new THREE.Vector3().fromArray(eye),
    new THREE.Vector3().fromArray(target),
    new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(m).toArray();
}

function demoProject() {
  return {
    version: 1,
    objects: [
      { id: 'ground', name: '地面', type: 'plane', params: { w: 24, h: 24 }, color: 0x3f4550,
        position: [0, 0, 0], rotation: [-Math.PI / 2, 0, 0], receivesDecal: true },
      { id: 'crate', name: '木箱', type: 'box', params: { w: 1.6, h: 1.6, d: 1.6 }, color: 0xb08d57,
        position: [-1.7, 0.8, 0.3], rotation: [0, 0.35, 0], receivesDecal: true },
      { id: 'wall', name: '斜墙', type: 'box', params: { w: 3.2, h: 2.2, d: 0.15 }, color: 0x8a94a6,
        position: [1.6, 1.05, -0.9], rotation: [-0.32, 0, 0], receivesDecal: true },
      { id: 'door', name: '门板（不接收）', type: 'box', params: { w: 1.1, h: 2.1, d: 0.06 }, color: 0x7a5a3a,
        position: [1.7, 1.05, 0.55], rotation: [0, 0, 0], receivesDecal: false },
      { id: 'backwall', name: '后墙', type: 'box', params: { w: 7, h: 2.8, d: 0.2 }, color: 0x707a88,
        position: [0, 1.4, -2.6], rotation: [0, 0, 0], receivesDecal: true },
    ],
    decals: [
      { id: 'd1', name: '箱顶编号 A-07', targetId: 'crate', pattern: 'plate', text: 'A-07',
        width: 1.3, height: 0.7, depth: 4, roll: 0, maxAngle: 80, order: 0,
        projPos: [-1.7, 3.0, 2.6], projQuat: lookAtQuat([-1.7, 3.0, 2.6], [-1.7, 1.15, 0.85]) },
      { id: 'd2', name: '斜墙警示条纹', targetId: 'wall', pattern: 'stripes', text: '',
        width: 2.0, height: 1.2, depth: 5, roll: 0, maxAngle: 75, order: 1,
        projPos: [1.6, 1.7, 2.4], projQuat: lookAtQuat([1.6, 1.7, 2.4], [1.6, 1.0, -0.9]) },
      { id: 'd3', name: '地面箭头', targetId: 'ground', pattern: 'arrow', text: '',
        width: 1.4, height: 1.4, depth: 5, roll: 0, maxAngle: 85, order: 2,
        projPos: [0.4, 3.5, 1.8], projQuat: lookAtQuat([0.4, 3.5, 1.8], [0.4, 0, 1.8]) },
      { id: 'd4', name: '复检标记', targetId: 'crate', pattern: 'roundel', text: 'OK',
        width: 0.8, height: 0.8, depth: 4, roll: 0, maxAngle: 80, order: 3,
        projPos: [-1.3, 2.2, 2.6], projQuat: lookAtQuat([-1.3, 2.2, 2.6], [-1.55, 1.3, 0.7]) },
    ],
  };
}

// ---------------------------------------------------------------- 启动
window.addEventListener('resize', () => {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
});

const saved = localStorage.getItem(STORAGE_KEY);
if (saved) {
  try { applyProject(deserializeProject(saved)); }
  catch { applyProject(demoProject()); }
} else {
  applyProject(demoProject());
}
renderObjectList();
if (pendingSelectDecal && decals.has(pendingSelectDecal)) selectDecal(pendingSelectDecal);

renderer.setAnimationLoop(() => {
  orbit.update();
  renderer.render(scene, camera);
});
