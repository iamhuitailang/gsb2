import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './styles.css';

import { createDefaultProject } from './core/defaults';
import {
  downloadJson,
  loadPersistedProject,
  parseProjectJson,
  persistProject,
  timestampSlug,
  toRuntimeConfig,
} from './core/projectStore';
import { uid } from './core/easing';
import type { ProjectData, ResolvedCameraState } from './core/types';
import { RouteTimeline } from './route/RouteTimeline';
import { CameraRig } from './camera/CameraRig';
import { buildWorld, createFakeCharacter } from './scene/buildWorld';
import { Gizmos } from './scene/Gizmos';
import { LeftPanel } from './ui/LeftPanel';
import { Inspector } from './ui/Inspector';
import type { AppDeps } from './ui/deps';

// ---------------- 项目状态 ----------------
let project: ProjectData = loadPersistedProject() ?? createDefaultProject();
let selectedZoneId: string | null = project.zones[0]?.id ?? null;
let groundAddMode = false;

// ---------------- Three 基础 ----------------
const viewport = document.getElementById('viewport')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.id = 'three-canvas';
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141a24);
scene.fog = new THREE.Fog(0x141a24, 42, 85);

const debugCamera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
debugCamera.position.set(3, 19, 23);

const gameCamera = new THREE.PerspectiveCamera(58, 1, 0.1, 200);
scene.add(gameCamera);

const controls = new OrbitControls(debugCamera, renderer.domElement);
controls.target.set(-1, 1, -0.5);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 3;
controls.maxDistance = 60;

// 灯光
const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2f3a, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
sun.position.set(-10, 18, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -26;
sun.shadow.camera.right = 26;
sun.shadow.camera.top = 22;
sun.shadow.camera.bottom = -22;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 60;
sun.shadow.bias = -0.0004;
scene.add(sun);

// ---------------- 世界 / 角色 / Gizmos ----------------
const world = buildWorld();
scene.add(world.group);

const character = createFakeCharacter();
scene.add(character.group);

const gizmos = new Gizmos(gameCamera);
scene.add(gizmos.root);
gizmos.rebuildZones(project.zones);
gizmos.rebuildColliderHelpers(world.colliders);
gizmos.rebuildRoute(project);
gizmos.setSelectedZone(selectedZoneId);

const routeTimeline = new RouteTimeline(project.route.waypoints);
const rig = new CameraRig();
rig.snapNow();

// ---------------- 播放状态 ----------------
let playing = true;
let playSpeed = 1;
let currentTime = 0;
let viewMode: 'debug' | 'game' = 'debug';
const gizmoVisibility = { zones: true, bounds: true, route: true, occluders: true, rays: true };

// ---------------- UI ----------------
const inspector = new Inspector();
document.getElementById('panel-right')!.appendChild(inspector.el);

const deps: AppDeps = {
  project,
  get selectedZoneId() {
    return selectedZoneId;
  },
  selectZone(id) {
    selectedZoneId = id;
    gizmos.setSelectedZone(id);
  },
  addZone() {
    const c = character.group.position;
    const z = {
      id: uid('zone'),
      name: `新区域 ${project.zones.length + 1}`,
      color: randomZoneColor(),
      center: [round(c.x), 2.5, round(c.z)] as [number, number, number],
      size: [6, 5, 6] as [number, number, number],
      rotationY: 0,
      priority: 1,
      hysteresis: 0.3,
      transitionTime: 0.6,
      easing: 'easeInOutCubic' as const,
      params: { ...project.defaultParams },
      bounds: {
        enabled: false,
        min: [c.x - 4, 0.4, c.z - 4] as [number, number, number],
        max: [c.x + 4, 6, c.z + 4] as [number, number, number],
      },
    };
    project.zones.push(z);
    selectedZoneId = z.id;
    deps.notifyChange('zones');
  },
  removeZone(id) {
    project.zones = project.zones.filter((z) => z.id !== id);
    if (selectedZoneId === id) selectedZoneId = project.zones[0]?.id ?? null;
    deps.notifyChange('zones');
  },
  duplicateZone(id) {
    const src = project.zones.find((z) => z.id === id);
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src)) as (typeof project.zones)[number];
    copy.id = uid('zone');
    copy.name = `${src.name} 副本`;
    copy.center = [src.center[0] + 2, src.center[1], src.center[2] + 2];
    project.zones.push(copy);
    selectedZoneId = copy.id;
    deps.notifyChange('zones');
  },
  notifyChange(kind) {
    schedulePersist();
    if (kind === 'zones' || kind === 'all') {
      gizmos.rebuildZones(project.zones);
      gizmos.setSelectedZone(selectedZoneId);
      applyGizmoVisibility();
    }
    if (kind === 'route' || kind === 'all') {
      routeTimeline.rebuild(project.route.waypoints);
      gizmos.rebuildRoute(project);
      renderTimelineMarkers();
    }
  },
  get groundAddMode() {
    return groundAddMode;
  },
  setGroundAddMode(on) {
    groundAddMode = on;
    renderer.domElement.style.cursor = on ? 'crosshair' : '';
    leftPanel.rerender();
  },
  addWaypointAtCharacter() {
    const p = character.group.position;
    addWaypoint(p.x, p.y, p.z);
  },
  removeWaypoint(id) {
    project.route.waypoints = project.route.waypoints.filter((w) => w.id !== id);
    deps.notifyChange('route');
    leftPanel.rerender();
  },
  seekToWaypoint(id) {
    const t = arrivalTimeOf(id);
    currentTime = t;
    setPlaying(false);
    rig.snapNow();
    updateTimelineInput();
  },
};

const leftPanel = new LeftPanel(deps);
document.getElementById('panel-left')!.appendChild(leftPanel.el);

// ---------------- 顶部按钮 / 传输条 ----------------
const playBtn = document.getElementById('btn-play') as HTMLButtonElement;
const stopBtn = document.getElementById('btn-stop') as HTMLButtonElement;
const loopSelect = document.getElementById('select-loop') as HTMLSelectElement;
const speedSelect = document.getElementById('select-speed') as HTMLSelectElement;
const timeline = document.getElementById('timeline') as HTMLInputElement;
const timeLabel = document.getElementById('time-label')!;

loopSelect.value = project.route.loopMode;
loopSelect.addEventListener('change', () => {
  project.route.loopMode = loopSelect.value as ProjectData['route']['loopMode'];
  schedulePersist();
});
speedSelect.addEventListener('change', () => {
  playSpeed = parseFloat(speedSelect.value);
});

function setPlaying(v: boolean) {
  playing = v;
  playBtn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
  playBtn.classList.toggle('playing', playing);
}
setPlaying(true);
playBtn.addEventListener('click', () => setPlaying(!playing));
stopBtn.addEventListener('click', () => {
  currentTime = 0;
  rig.snapNow();
  setPlaying(true);
  updateTimelineInput();
});

window.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement | null;
  if (el && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(el.tagName)) return;
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!playing);
  }
});

let scrubbing = false;
timeline.addEventListener('pointerdown', () => {
  scrubbing = true;
  if (playing) setPlaying(false); // 拖动检查时暂停，避免与播放推进争抢
});
window.addEventListener('pointerup', () => (scrubbing = false));
timeline.addEventListener('input', () => {
  const d = routeTimeline.duration || 1;
  currentTime = (parseFloat(timeline.value) / 1000) * d;
  rig.snapNow();
  updateTimelineInput();
});

// 视角切换
const btnViewDebug = document.getElementById('view-debug')!;
const btnViewGame = document.getElementById('view-game')!;
btnViewDebug.addEventListener('click', () => setViewMode('debug'));
btnViewGame.addEventListener('click', () => setViewMode('game'));
function setViewMode(m: 'debug' | 'game') {
  viewMode = m;
  btnViewDebug.classList.toggle('active', m === 'debug');
  btnViewGame.classList.toggle('active', m === 'game');
  controls.enabled = m === 'debug';
  gizmos.root.visible = m === 'debug';
  world.labels.visible = m === 'debug';
}

// Gizmo 勾选
document.querySelectorAll<HTMLInputElement>('input[data-gizmo]').forEach((cb) => {
  const key = cb.dataset.gizmo as keyof typeof gizmoVisibility;
  cb.checked = gizmoVisibility[key];
  cb.addEventListener('change', () => {
    gizmoVisibility[key] = cb.checked;
    applyGizmoVisibility();
  });
});
function applyGizmoVisibility() {
  (Object.keys(gizmoVisibility) as (keyof typeof gizmoVisibility)[]).forEach((k) =>
    gizmos.setVisibility(k, gizmoVisibility[k]),
  );
}

// 项目按钮
document.getElementById('btn-save')!.addEventListener('click', () => {
  project.savedAt = new Date().toISOString();
  persistProject(project);
  downloadJson(`camera-debugger-project-${timestampSlug()}.json`, project);
  toast('项目已保存到本地存储，并下载了项目 JSON（含区域与路线）');
});
document.getElementById('btn-export-runtime')!.addEventListener('click', () => {
  downloadJson(`camera-config.runtime-${timestampSlug()}.json`, toRuntimeConfig(project));
  toast('已导出运行时镜头配置 tpc-camera-config v1');
});
const fileInput = document.getElementById('file-open') as HTMLInputElement;
document.getElementById('btn-open')!.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const loaded = parseProjectJson(await file.text());
    loadProject(loaded);
    toast(`已打开项目：${loaded.name}`);
  } catch (err) {
    console.error(err);
    toast(`打开失败：${(err as Error).message}`, true);
  } finally {
    fileInput.value = '';
  }
});
document.getElementById('btn-new')!.addEventListener('click', () => {
  if (!window.confirm('恢复为内置示例项目？当前未导出的修改会丢失（本地自动存档也会被覆盖）。')) return;
  loadProject(createDefaultProject());
  toast('已恢复内置示例项目');
});

function loadProject(p: ProjectData) {
  project = p;
  // deps 持有 project 引用，需要把属性内容替换而不是换对象
  deps.project = project;
  selectedZoneId = project.zones[0]?.id ?? null;
  loopSelect.value = project.route.loopMode;
  routeTimeline.rebuild(project.route.waypoints);
  gizmos.rebuildZones(project.zones);
  gizmos.rebuildRoute(project);
  gizmos.setSelectedZone(selectedZoneId);
  applyGizmoVisibility();
  leftPanel.rerender();
  renderTimelineMarkers();
  persistProject(project);
  currentTime = 0;
  rig.snapNow();
}

// ---------------- 地面点击加点 ----------------
const raycaster = new THREE.Raycaster();
const pointerDown = { x: 0, y: 0 };
renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDown.x = e.clientX;
  pointerDown.y = e.clientY;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!groundAddMode) return;
  if (Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 6) return; // 拖拽视角不算点击
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, viewMode === 'game' ? gameCamera : debugCamera);
  const hit = raycaster.intersectObject(world.ground, false)[0];
  if (hit) {
    addWaypoint(hit.point.x, 0, hit.point.z);
  }
});

function addWaypoint(x: number, y: number, z: number) {
  const wps = project.route.waypoints;
  const last = wps[wps.length - 1];
  wps.push({
    id: uid('wp'),
    name: `路径点 ${wps.length + 1}`,
    x: round(x, 2),
    y: round(y, 2),
    z: round(z, 2),
    moveTime: last ? 3 : 0,
    hold: 0,
  });
  deps.notifyChange('route');
  leftPanel.rerender();
  toast(`已在 (${x.toFixed(1)}, ${z.toFixed(1)}) 添加路径点`);
}

// ---------------- 时间轴刻度 ----------------
const markersEl = document.getElementById('timeline-markers')!;
function arrivalTimeOf(wpId: string): number {
  const idx = project.route.waypoints.findIndex((w) => w.id === wpId);
  if (idx <= 0) return 0;
  const hold = routeTimeline.intervals.find((it) => it.kind === 'hold' && it.wp === idx);
  if (hold && hold.kind === 'hold') return hold.t0;
  const move = routeTimeline.intervals.find((it) => it.kind === 'move' && it.to === idx);
  return move && move.kind === 'move' ? move.t1 : 0;
}
function renderTimelineMarkers() {
  markersEl.innerHTML = '';
  const d = routeTimeline.duration || 1;
  project.route.waypoints.forEach((w, i) => {
    const t = arrivalTimeOf(w.id);
    const tick = document.createElement('button');
    tick.className = 'tl-marker';
    tick.style.left = `${(t / d) * 100}%`;
    tick.title = `${i + 1}. ${w.name} · ${t.toFixed(2)}s`;
    tick.textContent = String(i + 1);
    tick.addEventListener('click', () => deps.seekToWaypoint(w.id));
    markersEl.appendChild(tick);
  });
}
function updateTimelineInput() {
  const d = routeTimeline.duration;
  if (!scrubbing) timeline.value = String(Math.round((currentTime / (d || 1)) * 1000));
  const mapped = routeTimeline.mapTime(currentTime, project.route.loopMode);
  timeLabel.textContent = `${mapped.time.toFixed(2)} / ${d.toFixed(2)} s`;
}

// ---------------- 自适应尺寸 ----------------
function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  debugCamera.aspect = w / h;
  debugCamera.updateProjectionMatrix();
  gameCamera.aspect = w / h;
  gameCamera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

// ---------------- Toast ----------------
let toastTimer: number | undefined;
const toastEl = document.getElementById('toast')!;
function toast(msg: string, error = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', error);
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 2600);
}

let persistTimer: number | undefined;
function schedulePersist() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => persistProject(project), 350);
}

function round(v: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}
function randomZoneColor(): string {
  const palette = ['#f472b6', '#facc15', '#4ade80', '#60a5fa', '#c084fc', '#fb923c'];
  return palette[project.zones.length % palette.length];
}

// ---------------- 测试 / 自动化钩子 ----------------
declare global {
  interface Window {
    __CD__?: unknown;
  }
}
window.__CD__ = {
  getState: () => rig.lastState,
  getProject: () => project,
  getTime: () => currentTime,
  setTime: (t: number, snap = true) => {
    currentTime = t;
    if (snap) rig.snapNow();
  },
  setPlaying,
  setViewMode,
  play: () => setPlaying(true),
  pause: () => setPlaying(false),
  seekWaypoint: (id: string) => deps.seekToWaypoint(id),
  /** 诊断：对碰撞体做一次射线，返回最近命中 */
  debugRay: (a: [number, number, number], b: [number, number, number]) => {
    const from = new THREE.Vector3(...a);
    const to = new THREE.Vector3(...b);
    const dir = to.clone().sub(from);
    const dist = dir.length();
    const rc = new THREE.Raycaster(from, dir.normalize(), 0, dist);
    const hits = rc.intersectObjects(world.colliders, false);
    if (!hits.length) return { hit: false };
    return {
      hit: true,
      name: (hits[0].object.userData.displayName as string) || hits[0].object.name,
      distance: hits[0].distance,
      point: [hits[0].point.x, hits[0].point.y, hits[0].point.z],
    };
  },
  /** 诊断：列出所有碰撞体的世界 AABB */
  colliderBoxes: () =>
    world.colliders.map((m) => {
      const box = new THREE.Box3().setFromObject(m);
      return {
        name: (m.userData.displayName as string) || m.name,
        min: [box.min.x, box.min.y, box.min.z].map((v) => +v.toFixed(2)),
        max: [box.max.x, box.max.y, box.max.z].map((v) => +v.toFixed(2)),
      };
    }),
};

// ---------------- 主循环 ----------------
const clock = new THREE.Clock();
let hudAccum = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (playing) {
    currentTime += dt * playSpeed;
    const mapped = routeTimeline.mapTime(currentTime, project.route.loopMode);
    if (mapped.finished) {
      setPlaying(false);
      currentTime = routeTimeline.duration;
    }
  }

  const sample = routeTimeline.sample(currentTime, project.route.loopMode);
  const state = rig.update(dt, project, sample, world.colliders, gameCamera);

  character.group.position.set(sample.position.x, sample.position.y, sample.position.z);
  character.group.rotation.y = state.targetYaw;
  character.setWalk(playing && sample.moving, dt);

  gizmos.updateDebug(state);
  inspector.update(state, project.zones.find((z) => z.id === state.zoneId)?.color);

  hudAccum += dt;
  if (hudAccum > 0.08) {
    hudAccum = 0;
    updateHud(state);
    updateTimelineInput();
  }

  controls.update();
  renderer.render(scene, viewMode === 'game' ? gameCamera : debugCamera);
}

const hudZone = document.getElementById('hud-zone')!;
const hudOcc = document.getElementById('hud-occ')!;
const hudOccReason = document.getElementById('hud-occ-reason')!;
function updateHud(state: ResolvedCameraState) {
  hudZone.textContent = state.zoneName;
  const color = project.zones.find((z) => z.id === state.zoneId)?.color ?? '#94a3b8';
  (hudZone as HTMLElement).style.background = `${color}2e`;
  (hudZone as HTMLElement).style.borderColor = color;
  (hudZone as HTMLElement).style.color = color;

  const blocked = state.occlusion.kind !== 'clear';
  hudOcc.textContent = blocked
    ? ({ 'pull-in': '前移避让', 'side-shift': '侧向避让', raise: '抬高避让', combined: '组合避让', forced: '强制贴近' } as Record<string, string>)[state.occlusion.kind] ?? '避让中'
    : '通畅';
  hudOcc.className = `occ-badge ${blocked ? 'warn' : 'ok'}`;
  hudOccReason.textContent = state.occlusion.reason;
}

renderTimelineMarkers();
updateTimelineInput();
frame();
