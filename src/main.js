import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { World, CHUNK, chunkKey, worldToChunk } from './world.js';
import { ChunkManager } from './chunkManager.js';
import { raycastVoxel } from './picking.js';
import {
  PALETTE,
  buildSolidCube,
  buildColorWall,
  hollowOneMore,
} from './samples.js';
import {
  downloadProject,
  pickProjectFile,
  exportOBJ,
  exportGLB,
} from './exporters.js';

// ---------- 场景基础 ----------

const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);

const camera = new THREE.PerspectiveCamera(
  55,
  viewport.clientWidth / viewport.clientHeight,
  0.1,
  1000
);
camera.position.set(18, 16, 24);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.target.set(6, 4, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(20, 30, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const sunTarget = new THREE.Object3D();
scene.add(sun, sunTarget);
sun.target = sunTarget;
scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x30333a, 0.5));

// 地面参考网格(辅助对象, 不进导出)
const groundGrid = new THREE.GridHelper(64, 64, 0x3a4250, 0x242a33);
groundGrid.position.y = -0.01;
scene.add(groundGrid);

// ---------- 应用状态 ----------

let world = buildColorWall();
const chunks = new ChunkManager(world, scene);
let tool = 'add';
let selectedMaterial = 0;
let lastHit = null;

// 悬停高亮框(线框, 辅助对象)
const hoverBox = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0xffffff })
);
hoverBox.visible = false;
scene.add(hoverBox);

// 放置预览框(半透明实心)
const placeBox = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  })
);
placeBox.visible = false;
scene.add(placeBox);

// ---------- 拾取与编辑 ----------

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

function pickAt(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  if (raycaster.ray.direction.lengthSq() === 0) return null;
  return raycastVoxel(raycaster.ray.origin, raycaster.ray.direction, world);
}

/** 应用一次体素修改, 只重建受影响区块。 */
function applyEdit(x, y, z, id, label) {
  const affected = world.setVoxel(x, y, z, id);
  if (affected.size === 0) return;
  const now = performance.now() / 1000;
  const stats = chunks.remesh([...affected], now);
  afterRemesh(affected, label, stats, now);
}

function afterRemesh(affected, label, remeshStats, now = performance.now() / 1000) {
  updateStats();
  writeLog(
    `${label} · 重建 ${remeshStats.rebuilt} 区块` +
      (remeshStats.removed ? `, 移除空区块 ${remeshStats.removed}` : '') +
      ` · [${[...affected].join(' ')}]`
  );
  chunks.tick(now);
}

function addVoxel(hit) {
  const [x, y, z] = hit.voxel;
  const [nx, ny, nz] = hit.normal;
  // 法线为 0(相机在体素内部)时不允许放置
  if (nx === 0 && ny === 0 && nz === 0) return;
  const tx = x + nx;
  const ty = y + ny;
  const tz = z + nz;
  if (world.getVoxel(tx, ty, tz) !== 0) return;
  applyEdit(tx, ty, tz, world.materialId(selectedMaterial), '添加');
}

function removeVoxel(hit) {
  const [x, y, z] = hit.voxel;
  applyEdit(x, y, z, 0, '删除');
}

function deleteHitChunk(hit) {
  if (!hit) return;
  const { cx, cy, cz } = worldToChunk(...hit.voxel);
  const key = chunkKey(cx, cy, cz);
  const chunk = world.getChunk(cx, cy, cz);
  if (!chunk) return;

  // 先收集边缘邻居: 区块整体消失后, 邻居朝向本区块的表面会变成暴露面
  const affected = new Set([key]);
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        if (chunk.data[lx + CHUNK * (ly + CHUNK * lz)] === 0) continue;
        if (lx === 0) affected.add(chunkKey(cx - 1, cy, cz));
        if (lx === CHUNK - 1) affected.add(chunkKey(cx + 1, cy, cz));
        if (ly === 0) affected.add(chunkKey(cx, cy - 1, cz));
        if (ly === CHUNK - 1) affected.add(chunkKey(cx, cy + 1, cz));
        if (lz === 0) affected.add(chunkKey(cx, cy, cz - 1));
        if (lz === CHUNK - 1) affected.add(chunkKey(cx, cy, cz + 1));
      }
    }
  }
  world.chunks.delete(key);
  const now = performance.now() / 1000;
  const stats = chunks.remesh([...affected], now);
  afterRemesh(affected, `删除区块 (${key})`, stats, now);
}

// ---------- 指针交互(与轨道相机区分点击/拖拽) ----------

const rendererCanvas = renderer.domElement;
let downButton = null;
let downPos = null;
const DRAG_THRESHOLD = 5;

rendererCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

rendererCanvas.addEventListener('pointerdown', (e) => {
  downButton = e.button;
  downPos = { x: e.clientX, y: e.clientY };
});

rendererCanvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  const button = downButton;
  downButton = null;
  downPos = null;
  if (moved > DRAG_THRESHOLD) return; // 视为旋转镜头, 不做编辑

  const hit = pickAt(e);
  if (!hit) return;
  if (button === 0) {
    tool === 'add' ? addVoxel(hit) : removeVoxel(hit);
  } else if (button === 2) {
    tool === 'remove' ? removeVoxel(hit) : addVoxel(hit);
  }
});

// 记录最后的指针位置; 离开 canvas 也保留最后一次有效命中,
// 这样点击面板上的「删除区块」按钮时仍知道刚才悬停的是哪格
let lastPointer = null;
rendererCanvas.addEventListener('pointermove', (e) => {
  if (e.buttons !== 0) {
    lastPointer = null;
    hoverBox.visible = false;
    placeBox.visible = false;
    document.getElementById('hoverInfo').textContent = '拖拽旋转中…';
    return;
  }
  lastPointer = { clientX: e.clientX, clientY: e.clientY };
});

rendererCanvas.addEventListener('pointerleave', () => {
  lastPointer = null;
  hoverBox.visible = false;
  placeBox.visible = false;
  document.getElementById('hoverInfo').textContent =
    lastHit ? `已锁定 格(${lastHit.voxel.join(',')}) (移回画布更新)` : '未命中';
});

function updateHover() {
  if (!lastPointer) return;
  const hit = pickAt(lastPointer);
  lastHit = hit;
  const info = document.getElementById('hoverInfo');
  if (!hit) {
    hoverBox.visible = false;
    placeBox.visible = false;
    info.textContent = '未命中';
    return;
  }
  const [x, y, z] = hit.voxel;
  const { cx, cy, cz } = worldToChunk(x, y, z);
  const matId = world.getVoxel(x, y, z);
  const mat = PALETTE[world.paletteIndex(matId)];
  info.textContent =
    `格(${x},${y},${z}) 区块(${cx},${cy},${cz}) ` +
    `材质:${mat?.name || '?'} 法线:[${hit.normal.join(',')}]`;

  const showHover = document.getElementById('toggleHover').checked;
  hoverBox.visible = showHover;
  hoverBox.position.set(x + 0.5, y + 0.5, z + 0.5);

  if (tool === 'add' && !(hit.normal[0] === 0 && hit.normal[1] === 0 && hit.normal[2] === 0)) {
    placeBox.visible = showHover;
    placeBox.position.set(
      x + hit.normal[0] + 0.5,
      y + hit.normal[1] + 0.5,
      z + hit.normal[2] + 0.5
    );
    placeBox.material.color.set(PALETTE[selectedMaterial].color);
  } else {
    placeBox.visible = false;
  }
}

// ---------- UI 绑定 ----------

// 工具切换
document.querySelectorAll('.tool').forEach((btn) => {
  btn.addEventListener('click', () => {
    tool = btn.dataset.tool;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

// 调色板
const paletteEl = document.getElementById('palette');
function renderPalette() {
  paletteEl.innerHTML = '';
  PALETTE.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'swatch' + (i === selectedMaterial ? ' selected' : '');
    el.style.background = p.color;
    el.title = `${p.name} (快捷键 ${i + 1})`;
    el.textContent = i + 1;
    el.addEventListener('click', () => {
      selectedMaterial = i;
      renderPalette();
    });
    paletteEl.appendChild(el);
  });
}
renderPalette();

document.getElementById('toggleBoundary').addEventListener('change', (e) => {
  chunks.setShowBoundaries(e.target.checked);
});
document.getElementById('toggleGrid').addEventListener('change', (e) => {
  chunks.setShowGrid(e.target.checked);
});

document.getElementById('deleteChunkBtn').addEventListener('click', () => {
  if (lastHit) deleteHitChunk(lastHit);
});

// 工程存取 / 导出
document.getElementById('saveBtn').addEventListener('click', () => {
  downloadProject(world);
});

document.getElementById('loadBtn').addEventListener('click', async () => {
  try {
    const obj = await pickProjectFile();
    const loaded = World.deserialize(obj);
    world = loaded;
    chunks.setWorld(world);
    const now = performance.now() / 1000;
    const stats = chunks.rebuildAll(now);
    afterRemesh(new Set(world.chunks.keys()), '读取工程', stats, now);
  } catch (err) {
    alert('读取失败: ' + err.message);
  }
});

document.getElementById('exportObjBtn').addEventListener('click', () => {
  exportOBJ(chunks.collectExportGroup());
});
document.getElementById('exportGlbBtn').addEventListener('click', () => {
  exportGLB(chunks.collectExportGroup());
});

// 样例
function loadSample(builder, label) {
  world = builder();
  chunks.setWorld(world);
  const now = performance.now() / 1000;
  const stats = chunks.rebuildAll(now);
  afterRemesh(new Set(world.chunks.keys()), label, stats, now);
}

document.getElementById('sampleCubeBtn').addEventListener('click', () => {
  loadSample(buildSolidCube, '样例: 实心立方体');
});
document.getElementById('sampleWallBtn').addEventListener('click', () => {
  loadSample(buildColorWall, '样例: 跨区块彩色墙');
});
document.getElementById('hollowBtn').addEventListener('click', () => {
  const affected = hollowOneMore(world);
  if (affected.length === 0) {
    writeLog('没有可挖的边界方块, 请先载入彩色墙样例');
    return;
  }
  const now = performance.now() / 1000;
  const stats = chunks.remesh(affected, now);
  afterRemesh(new Set(affected), '边缘挖空', stats, now);
});
document.getElementById('clearBtn').addEventListener('click', () => {
  world.clear();
  const now = performance.now() / 1000;
  const stats = chunks.rebuildAll(now);
  afterRemesh(new Set(), '清空', stats, now);
});

// 快捷键
window.addEventListener('keydown', (e) => {
  if (e.key === '1') document.querySelector('[data-tool="add"]').click();
  if (e.key === '2') document.querySelector('[data-tool="remove"]').click();
  const n = Number(e.key);
  if (n >= 1 && n <= PALETTE.length) {
    selectedMaterial = n - 1;
    renderPalette();
  }
});

// ---------- 统计与日志 ----------

function updateStats() {
  const s = chunks.stats();
  document.getElementById('stVoxel').textContent = s.voxelCount;
  document.getElementById('stChunk').textContent = s.chunkCount;
  document.getElementById('stRawFace').textContent = s.rawFaceCount;
  document.getElementById('stQuad').textContent = s.quadCount;
  document.getElementById('stTri').textContent = s.triangleCount;
}

const logEl = document.getElementById('log');
function writeLog(text) {
  const li = document.createElement('li');
  li.className = 'hot';
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  li.textContent = `${time} ${text}`;
  logEl.prepend(li);
  while (logEl.children.length > 20) logEl.lastChild.remove();
  setTimeout(() => li.classList.remove('hot'), HIGHLIGHT_MS);
}
const HIGHLIGHT_MS = 1600;

// ---------- 渲染循环 ----------

function onResize() {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
}
window.addEventListener('resize', onResize);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateHover();
  chunks.tick(performance.now() / 1000);
  renderer.render(scene, camera);
}

const initStats = chunks.rebuildAll(performance.now() / 1000);
updateStats();
writeLog(
  `初始化彩色墙 · ${initStats.rebuilt} 个区块, 远处区块编辑时不会重新生成`
);
animate();
