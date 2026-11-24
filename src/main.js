import { buildScene, DEFAULT_DOOR_STATES } from './scene.js';
import { Renderer } from './renderer.js';
import { FirstPersonControls } from './controls.js';
import { TopView } from './topview.js';
import { computeVisibility, getDrawList, summarizeDrawList } from './visibility.js';
import { PRESETS, presetCamera } from './presets.js';
import { detailHTML } from './detail.js';

const scene = buildScene();
const initialPreset = PRESETS.find((p) => p.id === window.location.hash.slice(1));
const camera = initialPreset ? presetCamera(initialPreset) : {
  position: [0, 1.62, 2.7],
  yaw: 0,
  pitch: -0.035,
  fovY: Math.PI / 180 * 70,
};
const doorOpen = { ...(initialPreset ? initialPreset.doors() : DEFAULT_DOOR_STATES) };
let selectedMode = 'partition';
let activeMode = 'partition';
let selection = null;
let activePresetId = initialPreset?.id || 'vista';
let lastTrace = null;
let lastPartitionStats = null;
let lastRenderStats = null;
let toastTimer = null;

const fullStats = summarizeDrawList(scene.meshes);

const $ = (selector) => document.querySelector(selector);
const canvas = $('#glCanvas');
let renderer = null;
let initError = null;
try {
  renderer = new Renderer(canvas);
} catch (error) {
  initError = error;
  const fallback = $('#webglFallback');
  fallback.hidden = false;
  fallback.textContent = `WebGL 初始化失败：${error.message}。俯视图和判定逻辑仍可使用。`;
}

const controls = new FirstPersonControls(canvas, camera, scene, doorOpen, (id) => toggleDoor(id, true));
const topView = new TopView($('#topview'), scene, {
  onSelect: (next) => {
    selection = next;
    renderDetail();
  },
});

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function setMode(mode) {
  selectedMode = mode;
  activeMode = mode;
  $('#modePartition').classList.toggle('active', mode === 'partition');
  $('#modeFull').classList.toggle('active', mode === 'full');
  $('#modePartition').setAttribute('aria-pressed', String(mode === 'partition'));
  $('#modeFull').setAttribute('aria-pressed', String(mode === 'full'));
}

function portalPlayerDistance(id) {
  const p = scene.portals.find((x) => x.id === id);
  if (!p) return Infinity;
  const [x, , z] = camera.position;
  const vx = p.x2 - p.x1;
  const vz = p.z2 - p.z1;
  const t = Math.max(0, Math.min(1, ((x - p.x1) * vx + (z - p.z1) * vz) / (vx * vx + vz * vz)));
  const px = p.x1 + vx * t;
  const pz = p.z1 + vz * t;
  return Math.hypot(x - px, z - pz);
}

function setDoorOpen(id, open, announce = false) {
  if (!open && portalPlayerDistance(id) < 0.42) {
    showToast('你正站在这个门洞内，请先走开再关门');
    return false;
  }
  doorOpen[id] = open;
  renderDoorList();
  renderDetail();
  if (announce) {
    const p = scene.portals.find((x) => x.id === id);
    showToast(`${p?.short || id} 已${open ? '打开' : '关闭'}`);
  }
  return true;
}

function toggleDoor(id, announce = false) {
  const nextOpen = doorOpen[id] === false;
  return setDoorOpen(id, nextOpen, announce);
}

function renderDoorList() {
  const host = $('#doorList');
  host.innerHTML = scene.portals.map((p) => `
    <button class="door-chip ${doorOpen[p.id] === false ? 'closed' : 'open'}" data-door="${p.id}">
      <span class="door-dot"></span>${p.short}
      <b>${doorOpen[p.id] === false ? '关' : '开'}</b>
    </button>
  `).join('');
}

function currentAspect() {
  return renderer?.resize() || 1.25;
}

function measurePreset(preset) {
  const presetCam = presetCamera(preset);
  const doors = preset.doors();
  const trace = computeVisibility(scene, presetCam, { aspect: currentAspect(), doorOpen: doors });
  const stats = summarizeDrawList(getDrawList(scene, 'partition', trace));
  return { trace, stats, calls: stats.meshes, fullCalls: scene.meshes.length };
}

function renderPresetTable() {
  const tbody = $('#presetRows');
  tbody.innerHTML = PRESETS.map((p) => {
    const m = measurePreset(p);
    return `
      <tr data-preset-row="${p.id}" class="${p.id === activePresetId ? 'active' : ''}">
        <td>
          <button class="preset-go" data-preset="${p.id}">${p.name}</button>
          <small>${p.description}</small>
        </td>
        <td class="num">${scene.meshes.length}</td>
        <td class="num" data-calls="${p.id}">${m.calls}</td>
        <td class="num" data-props="${p.id}">${m.stats.propCount}/${scene.propIds.length}</td>
        <td class="num check-cell" data-check="${p.id}">—</td>
      </tr>
    `;
  }).join('');
}

function applyPreset(presetOrId) {
  const preset = typeof presetOrId === 'string' ? PRESETS.find((p) => p.id === presetOrId) : presetOrId;
  if (!preset) return;
  const pc = presetCamera(preset);
  camera.position = [...pc.position];
  camera.yaw = pc.yaw;
  camera.pitch = pc.pitch;
  camera.fovY = pc.fovY;
  for (const key of Object.keys(doorOpen)) delete doorOpen[key];
  Object.assign(doorOpen, preset.doors());
  activePresetId = preset.id;
  selection = null;
  if (window.location.hash !== `#${preset.id}`) {
    window.history.replaceState(null, '', `#${preset.id}`);
  }
  document.querySelectorAll('[data-preset-row]').forEach((row) => {
    row.classList.toggle('active', row.dataset.presetRow === preset.id);
  });
  renderDoorList();
  renderDetail();
  showToast(`已定位：${preset.name}`);
}

function updateHud(stats, trace, partitionStats) {
  const preset = PRESETS.find((p) => p.id === activePresetId);
  const roomNames = trace.cameraRoomIds
    .map((id) => scene.rooms.find((r) => r.id === id)?.name || id).join(' / ');
  const yawDeg = ((camera.yaw * 180 / Math.PI) % 360).toFixed(0);
  const actualCalls = stats?.drawCalls ?? '—';
  const actualProps = stats ? stats.propCount : '—';
  const actualMeshes = stats?.meshes ?? '—';

  $('#hudStats').innerHTML = `
    <div class="hud-title">${preset ? preset.name : '自由漫游机位'}</div>
    <div class="hud-grid">
      <span>位置</span><b>${camera.position[0].toFixed(2)}, ${camera.position[2].toFixed(2)}</b>
      <span>朝向</span><b>${yawDeg}° / pitch ${(camera.pitch || 0).toFixed(2)}</b>
      <span>相机房间</span><b>${trace.cameraRoomIds.join('+')} · ${roomNames}</b>
      <span>可见房间</span><b>${trace.visibleRoomIds.length}/6：${trace.visibleRoomIds.join(' ')}</b>
      <span>当前实际 Draw Calls</span><b class="em">${actualCalls} / ${scene.meshes.length}</b>
      <span>当前实际摆件</span><b class="em">${actualProps} / ${scene.propIds.length} 组</b>
      <span>当前提交几何块</span><b>${actualMeshes} / ${scene.meshes.length}</b>
      <span>同机位分区预测</span><b>${partitionStats.meshes} calls · ${partitionStats.propCount} 组摆件</b>
    </div>
  `;
}

function renderDetail() {
  const panel = $('#detailPanel');
  const scrollTop = panel.scrollTop;
  panel.innerHTML = detailHTML(selection, lastTrace || {
    cameraRoomIds: [], visibleRoomIds: [], evaluations: [],
  }, scene, doorOpen, lastPartitionStats);
  panel.scrollTop = scrollTop;
}

function comparePixels(a, b) {
  let differentPixels = 0;
  let maxChannelDelta = 0;
  let sumChannelDelta = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 4) {
    let pixelDelta = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      maxChannelDelta = Math.max(maxChannelDelta, d);
      sumChannelDelta += d;
      pixelDelta = Math.max(pixelDelta, d);
    }
    if (pixelDelta > 4) differentPixels++;
  }
  return {
    differentPixels,
    maxChannelDelta,
    meanChannelDelta: +(sumChannelDelta / (n * 0.75)).toFixed(4),
    totalPixels: a.length / 4,
  };
}

async function verifyAllPresets() {
  if (!renderer) {
    showToast('WebGL 不可用，无法做像素核对');
    return;
  }
  const button = $('#verifyAll');
  button.disabled = true;
  button.textContent = '核对中…';
  const savedCamera = {
    position: [...camera.position], yaw: camera.yaw, pitch: camera.pitch, fovY: camera.fovY,
  };
  const savedDoors = { ...doorOpen };
  const savedPreset = activePresetId;
  const results = [];

  try {
    for (const preset of PRESETS) {
      const pc = presetCamera(preset);
      camera.position = pc.position;
      camera.yaw = pc.yaw;
      camera.pitch = pc.pitch;
      camera.fovY = pc.fovY;
      for (const key of Object.keys(doorOpen)) delete doorOpen[key];
      Object.assign(doorOpen, preset.doors());

      renderer.resize();
      const trace = computeVisibility(scene, camera, { aspect: renderer.aspect, doorOpen });
      renderer.render(scene, camera, 'full', trace, doorOpen);
      const fullPixels = renderer.readFrame();
      renderer.render(scene, camera, 'partition', trace, doorOpen);
      const partitionPixels = renderer.readFrame();
      const diff = comparePixels(fullPixels, partitionPixels);
      const counts = measurePreset(preset).stats;
      results.push({ preset, diff, counts });

      const cell = document.querySelector(`[data-check="${preset.id}"]`);
      if (cell) {
        const pass = diff.differentPixels === 0;
        cell.innerHTML = `<span class="check-badge ${pass ? 'pass' : 'fail'}">${pass ? '✓ 0' : `✗ ${diff.differentPixels}`}</span>`;
        cell.title = `最大通道差 ${diff.maxChannelDelta}，平均 ${diff.meanChannelDelta}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const failed = results.filter((r) => r.diff.differentPixels > 0);
    $('#pixelResult').innerHTML = failed.length === 0
      ? `✓ ${results.length} 个固定机位的全量/分区画面逐像素一致；裁剪只减少绘制，没有删掉可见表面。`
      : `⚠ ${failed.length} 个机位存在像素差异，请查看表中红色标记。`;
    $('#pixelResult').className = `pixel-result ${failed.length === 0 ? 'pass' : 'fail'}`;
  } finally {
    camera.position = savedCamera.position;
    camera.yaw = savedCamera.yaw;
    camera.pitch = savedCamera.pitch;
    camera.fovY = savedCamera.fovY;
    for (const key of Object.keys(doorOpen)) delete doorOpen[key];
    Object.assign(doorOpen, savedDoors);
    activePresetId = savedPreset;
    button.disabled = false;
    button.textContent = '逐机位像素核对';
    document.querySelectorAll('[data-preset-row]').forEach((row) => {
      row.classList.toggle('active', row.dataset.presetRow === savedPreset);
    });
    renderDoorList();
  }
}

// UI events.
$('#modePartition').addEventListener('click', () => setMode('partition'));
$('#modeFull').addEventListener('click', () => setMode('full'));
const holdButton = $('#holdFull');
const startHold = (e) => { e.preventDefault(); activeMode = 'full'; holdButton.classList.add('active'); };
const endHold = () => { activeMode = selectedMode; holdButton.classList.remove('active'); };
holdButton.addEventListener('pointerdown', startHold);
window.addEventListener('pointerup', endHold);
holdButton.addEventListener('pointerleave', endHold);

$('#presetRows').addEventListener('click', (e) => {
  const button = e.target.closest('[data-preset]');
  if (button) applyPreset(button.dataset.preset);
});
$('#doorList').addEventListener('click', (e) => {
  const button = e.target.closest('[data-door]');
  if (button) toggleDoor(button.dataset.door);
});
$('#allDoorsOpen').addEventListener('click', () => {
  Object.assign(doorOpen, DEFAULT_DOOR_STATES);
  renderDoorList(); renderDetail(); showToast('所有门已打开');
});
$('#allDoorsClosed').addEventListener('click', () => {
  let skipped = 0;
  for (const id of Object.keys(doorOpen)) {
    if (doorOpen[id] === false) continue;
    if (portalPlayerDistance(id) < 0.42) {
      skipped++;
    } else {
      doorOpen[id] = false;
    }
  }
  renderDoorList();
  renderDetail();
  showToast(skipped ? `已关闭其他门；${skipped} 扇你正站着的门未关闭` : '所有门已关闭');
});
$('#resetDoors').addEventListener('click', () => applyPreset(activePresetId));
$('#verifyAll').addEventListener('click', verifyAllPresets);

$('#detailPanel').addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle-portal]');
  if (toggle) {
    toggleDoor(toggle.dataset.togglePortal);
    return;
  }
  const roomButton = e.target.closest('[data-select-room]');
  if (roomButton) {
    selection = { type: 'room', id: roomButton.dataset.selectRoom };
    renderDetail();
    topView.update({ trace: lastTrace, camera, selection, aspect: currentAspect(), doorOpen });
    return;
  }
  const reset = e.target.closest('[data-select="null"]');
  if (reset) {
    selection = null;
    renderDetail();
    topView.update({ trace: lastTrace, camera, selection, aspect: currentAspect(), doorOpen });
  }
});

window.addEventListener('resize', () => {
  if (renderer) renderer.resize();
  // Horizontal FOV/aspect changes the on-screen counts.
  clearTimeout(window.__presetMeasureTimer);
  window.__presetMeasureTimer = setTimeout(renderPresetTable, 180);
});

// Convenient runtime handle for browser automation / DevTools checks.
window.__portalDemo = {
  scene,
  camera,
  doorOpen,
  presets: PRESETS,
  applyPreset,
  computeVisibility: (options = {}) => computeVisibility(scene, camera, {
    aspect: currentAspect(), doorOpen, ...options,
  }),
  verifyAllPresets,
  getRenderer: () => renderer,
};

// Hidden browser self-check: index.html?verify=1 renders and compares every
// fixed position, then writes a machine-readable result to <html data-auto-verify>.
if (new URLSearchParams(window.location.search).get('verify') === '1') {
  setTimeout(async () => {
    try {
      await verifyAllPresets();
      const failed = [...document.querySelectorAll('[data-check] .check-badge.fail')].length;
      document.documentElement.dataset.autoVerify = failed === 0 ? 'pass' : `fail:${failed}`;
    } catch (error) {
      document.documentElement.dataset.autoVerify = `error:${error.message}`;
    }
  }, 250);
}

window.addEventListener('hashchange', () => {
  const preset = PRESETS.find((p) => p.id === window.location.hash.slice(1));
  if (preset) applyPreset(preset);
});

renderDoorList();
renderPresetTable();
setMode('partition');
lastTrace = computeVisibility(scene, camera, { aspect: currentAspect(), doorOpen });
lastPartitionStats = summarizeDrawList(getDrawList(scene, 'partition', lastTrace));
renderDetail();
topView.update({ trace: lastTrace, camera, selection, aspect: currentAspect(), doorOpen });

let lastTime = performance.now();
let detailAccumulator = 0;

function frame(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  controls.update(dt);
  const aspect = currentAspect();
  const trace = computeVisibility(scene, camera, { aspect, doorOpen });
  lastTrace = trace;
  lastPartitionStats = summarizeDrawList(getDrawList(scene, 'partition', trace));

  if (renderer) {
    lastRenderStats = renderer.render(scene, camera, activeMode, trace, doorOpen);
  } else {
    lastRenderStats = { drawCalls: 0, meshes: 0, propCount: 0, triangles: 0 };
  }

  topView.update({ trace, camera, selection, aspect, doorOpen });
  updateHud(lastRenderStats, trace, lastPartitionStats);

  detailAccumulator += dt;
  if (detailAccumulator > 0.5) {
    detailAccumulator = 0;
    const panel = $('#detailPanel');
    const selectingText = window.getSelection && String(window.getSelection()).length > 0;
    const pressingControl = panel.matches(':active') || Boolean(panel.querySelector(':active'));
    // Preserve scroll in renderDetail. Do not replace a button mid-click or
    // while the user is selecting explanation text.
    if (!selectingText && !pressingControl) renderDetail();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
