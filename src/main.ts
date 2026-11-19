import './styles.css';

import type { AppState, Store } from './app/state.ts';
import { createInitialState, createStore } from './app/state.ts';
import { createPlayer, seekTime, stepTime } from './app/player.ts';
import { History } from './app/history.ts';
import { createPresetProject } from './core/presets.ts';
import { createSceneRenderer, computeViewTransform, screenToWorld } from './render/renderer.ts';
import { createInspector } from './ui/inspector.ts';
import { createSidebar } from './ui/sidebar.ts';
import { createTimeline, createStatusChips } from './ui/timeline.ts';
import { createTopBar, createHelpOverlay, downloadProject, downloadConfig } from './ui/topbar.ts';
import { button, field, slider } from './ui/controls.ts';
import { downloadBlob, h, pickFile, safeFilename, toast } from './ui/dom.ts';
import { parseProjectText, serializeProject, exportRuntimeConfig } from './core/serialization.ts';
import { normalizeProject } from './core/project.ts';
import { renderSpriteSheet } from './export/sprite-sheet.ts';
import { randomSeed } from './core/rng.ts';
import { STAGE_HEIGHT, STAGE_WIDTH } from './core/types.ts';
import { emitterPositionAt, simulateScene } from './core/simulation.ts';
import type { Project } from './core/types.ts';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('缺少 #app 挂载点');

const store: Store = createStore(createInitialState(createPresetProject('spark')));
const history = new History(store.state.project);
let historyTimer: number | null = null;
let historyBaseline = JSON.stringify(store.state.project);

/* ------------------------------------------------------------------ */
/* 组件                                                                */
/* ------------------------------------------------------------------ */

const canvas = h('canvas', { class: 'stage-canvas', attrs: { 'aria-label': '粒子预览' } });
const renderer = createSceneRenderer(canvas);

const statusChips = createStatusChips();
const timeline = createTimeline(store, { requestRender: () => player.requestRender() });
const player = createPlayer({ store, renderer });

function requestRender() {
  player.requestRender();
  timeline.update();
}

const inspector = createInspector({ store, requestRender });
const help = createHelpOverlay();

let sidebar!: ReturnType<typeof createSidebar>;

const sidebarDeps = {
  store,
  onProjectChanged: () => {
    requestRender();
  },
  loadProject: (project: Project) => loadProject(project, { markDirty: true }),
  saveProject: () => saveProject(),
  openProject: () => void openProject(),
  exportConfig: () => doExportConfig(),
  exportSheet: () => openSheetDialog(),
  randomizeSeed: () => {
    const seed = randomSeed();
    store.update((state) => {
      state.project.scene.seed = seed;
      state.dirty = true;
    }, 'project');
    requestRender();
    toast(`新种子：${seed}`);
  },
};

sidebar = createSidebar(sidebarDeps);

const topbar = createTopBar({
  store,
  loadProject: (project: Project) => loadProject(project, { markDirty: true }),
  saveProject: () => saveProject(),
  openProject: () => void openProject(),
  exportConfig: () => doExportConfig(),
  exportSheet: () => openSheetDialog(),
  undo: () => doUndo(),
  redo: () => doRedo(),
  canUndo: () => history.canUndo,
  canRedo: () => history.canRedo,
});

/* ------------------------------------------------------------------ */
/* 布局                                                                */
/* ------------------------------------------------------------------ */

const stageWrap = h(
  'div',
  { class: `stage-wrap stage-bg-${store.state.project.scene.background}` },
  canvas,
  h(
    'div',
    { class: 'stage-overlay' },
    statusChips.root,
    h('div', { class: 'stage-tools' }, button('帮助', () => help.show(), { variant: 'ghost' })),
  ),
  h('div', { class: 'stage-tip', text: '拖动青色圆点移动发射器' }),
);

const main = h(
  'div',
  { class: 'workspace' },
  sidebar.root,
  h('main', { class: 'stage-column' }, stageWrap, timeline.root),
  inspector.root,
);

app.append(topbar.root, main, help.root);

/* ------------------------------------------------------------------ */
/* 同步                                                                */
/* ------------------------------------------------------------------ */

let refreshQueued = false;

function refreshChrome(state: AppState) {
  sidebar.refresh(state);
  inspector.refresh(state);
  topbar.update(state);
  const bg = state.project.scene.background;
  stageWrap.className = `stage-wrap stage-bg-${bg}`;
}

function queueChromeRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    refreshChrome(store.state);
  });
}

/* 统计面板每帧都会刷新，DOM 重建需要节流，避免拖慢播放。 */
let statsThrottled = false;

store.subscribe((state, reason) => {
  if (reason === 'stats') {
    statusChips.update(state);
    if (!statsThrottled) {
      statsThrottled = true;
      window.setTimeout(() => {
        statsThrottled = false;
        sidebar.updateStats(store.state);
      }, 180);
    }
    return;
  }
  if (reason === 'playback') {
    timeline.update();
    requestRender();
    return;
  }
  if (reason === 'project') scheduleHistoryPush();
  queueChromeRefresh();
  requestRender();
});

/* ------------------------------------------------------------------ */
/* 撤销快照                                                            */
/* ------------------------------------------------------------------ */

/**
 * 参数编辑通常是一连串高频修改（拖动滑杆/曲线）。在停止修改后记录一次
 * 快照，避免每个像素都占一条撤销记录。
 */
function scheduleHistoryPush() {
  if (historyTimer !== null) window.clearTimeout(historyTimer);
  historyTimer = window.setTimeout(() => {
    historyTimer = null;
    pushSnapshot('编辑参数');
  }, 500);
}

/** 若当前工程与上一次快照不同，则压入一条撤销记录。 */
function pushSnapshot(label: string) {
  const snapshot = JSON.stringify(store.state.project);
  if (snapshot === historyBaseline) return;
  historyBaseline = snapshot;
  history.push(store.state.project, label);
  topbar.update(store.state);
}

/** 撤销/重做前落定尚未提交的编辑，使这一步也可以被撤销。 */
function commitPendingEdit() {
  if (historyTimer !== null) {
    window.clearTimeout(historyTimer);
    historyTimer = null;
  }
  pushSnapshot('编辑参数');
}

/* ------------------------------------------------------------------ */
/* 文件与导出                                                          */
/* ------------------------------------------------------------------ */

function loadProject(project: Project, options: { markDirty: boolean }) {
  if (historyTimer !== null) {
    window.clearTimeout(historyTimer);
    historyTimer = null;
  }
  const normalized = normalizeProject(project);
  store.replaceProject(normalized.project, { markDirty: options.markDirty, resetTime: true });
  history.reset(normalized.project);
  historyBaseline = JSON.stringify(normalized.project);
  requestRender();
  if (normalized.warnings.length > 0) {
    toast(normalized.warnings[0], 'warn');
  }
}

function saveProject() {
  const text = serializeProject(store.state.project);
  downloadProject(store.state.project, text);
  store.markSaved();
  toast('工程已保存为文件');
}

async function openProject() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    toast('文件超过 4 MB，已拒绝载入。', 'error');
    return;
  }
  const text = await file.text();
  const result = parseProjectText(text);
  if (!result.ok || !result.project) {
    toast(result.error ?? '无法读取工程文件', 'error');
    return;
  }
  loadProject(result.project, { markDirty: false });
  store.update((state) => {
    state.dirty = false;
  }, 'project');
  if (result.warnings.length > 0) {
    toast(`已打开工程；${result.warnings[0]}`, 'warn');
  } else {
    toast('已打开工程');
  }
}

function doExportConfig() {
  downloadConfig(store.state.project, exportRuntimeConfig(store.state.project));
}

/* ------------------------------------------------------------------ */
/* 撤销 / 重做                                                         */
/* ------------------------------------------------------------------ */

function applyHistoryProject(project: Project) {
  store.update((state) => {
    state.project = project;
    state.dirty = true;
    state.playback.time = Math.min(state.playback.time, project.scene.duration);
    if (!project.emitters.some((e) => e.id === state.view.selectedEmitterId)) {
      state.view.selectedEmitterId = project.emitters[0]?.id ?? null;
    }
    state.epoch += 1;
  }, 'reload');
  historyBaseline = JSON.stringify(project);
  requestRender();
}

function doUndo() {
  // 先把未提交的编辑落定，撤销时才能回到「编辑前」而不是吞掉一步。
  commitPendingEdit();
  const project = history.undo();
  if (!project) {
    toast('没有可撤销的操作');
    return;
  }
  applyHistoryProject(project);
}

function doRedo() {
  commitPendingEdit();
  const project = history.redo();
  if (!project) {
    toast('没有可重做的操作');
    return;
  }
  applyHistoryProject(project);
}

/* ------------------------------------------------------------------ */
/* 舞台拖拽                                                            */
/* ------------------------------------------------------------------ */

let dragging = false;
let dragOffset = { x: 0, y: 0 };
let draggedId: string | null = null;
let dragStartProject: Project | null = null;

canvas.addEventListener('pointerdown', (event) => {
  const state = store.state;
  const rect = canvas.getBoundingClientRect();
  const transform = computeViewTransform(canvas.width, canvas.height, 1);
  const world = screenToWorld(event.clientX, event.clientY, rect, transform);
  const hitRadius = 24 / (transform.scale / Math.max(1, globalThis.devicePixelRatio || 1));

  let best: { id: string; dist: number } | null = null;
  for (const emitter of state.project.emitters) {
    if (!emitter.enabled) continue;
    const pos = emitterPositionAt(emitter, state.playback.time);
    const dist = Math.hypot(world.x - pos.x, world.y - pos.y);
    const radius = Math.max(14, emitter.spawnRadius, hitRadius);
    if (dist <= radius && (!best || dist < best.dist)) best = { id: emitter.id, dist };
  }

  if (!best) return;

  store.update((app) => {
    app.view.selectedEmitterId = best!.id;
  }, 'selection');

  const emitter = state.project.emitters.find((e) => e.id === best!.id);
  if (!emitter) return;
  const pos = emitterPositionAt(emitter, state.playback.time);
  dragOffset = { x: pos.x - world.x, y: pos.y - world.y };
  draggedId = emitter.id;
  dragStartProject = structuredClone(state.project);
  dragging = true;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('is-dragging');
  event.preventDefault();
});

canvas.addEventListener('pointermove', (event) => {
  if (!dragging || !draggedId) return;
  const rect = canvas.getBoundingClientRect();
  const transform = computeViewTransform(canvas.width, canvas.height, 1);
  const world = screenToWorld(event.clientX, event.clientY, rect, transform);
  const emitter = store.state.project.emitters.find((e) => e.id === draggedId);
  if (!emitter) return;
  // 有运动时鼠标代表「当前位置」，换算成基准位置写回。
  const current = emitterPositionAt(emitter, store.state.playback.time);
  const deltaX = world.x + dragOffset.x - current.x;
  const deltaY = world.y + dragOffset.y - current.y;
  store.update((app) => {
    const target = app.project.emitters.find((e) => e.id === draggedId);
    if (!target) return;
    target.position = {
      x: clamp(target.position.x + deltaX, -200, STAGE_WIDTH + 200),
      y: clamp(target.position.y + deltaY, -200, STAGE_HEIGHT + 200),
    };
    app.dirty = true;
    if (app.playback.playing) app.playback.playing = false;
  }, 'project');
  requestRender();
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  draggedId = null;
  canvas.classList.remove('is-dragging');
  if (dragStartProject) {
    if (historyTimer !== null) {
      window.clearTimeout(historyTimer);
      historyTimer = null;
    }
    history.push(store.state.project, '移动发射器');
    historyBaseline = JSON.stringify(store.state.project);
    dragStartProject = null;
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ */
/* 序列图导出                                                          */
/* ------------------------------------------------------------------ */

let sheetDialog: HTMLElement | null = null;

function openSheetDialog() {
  if (sheetDialog) return;

  const preview = h('canvas', { class: 'sheet-preview' });
  const info = h('div', { class: 'sheet-info' });
  let frames = 12;
  let cellScale = 0.5;

  const framesSlider = slider({
    min: 4,
    max: 24,
    step: 1,
    value: frames,
    onChange: (v) => {
      frames = Math.round(v);
      updateInfo();
    },
    format: (v) => `${Math.round(v)} 帧`,
  });
  const scaleSlider = slider({
    min: 0.25,
    max: 1,
    step: 0.05,
    value: cellScale,
    onChange: (v) => {
      cellScale = v;
      updateInfo();
    },
    format: (v) => `${Math.round(v * 100)}%`,
  });

  function updateInfo() {
    const columns = Math.min(frames, 4);
    const rows = Math.ceil(frames / columns);
    const cellW = Math.round(STAGE_WIDTH * cellScale);
    const cellH = Math.round(STAGE_HEIGHT * cellScale);
    info.textContent = `输出 ${columns * cellW + (columns + 1) * 8} × ${
      rows * (cellH + 20) + (rows + 1) * 8
    } px · ${frames} 帧 · 使用与预览相同的种子离线渲染`;
  }

  const exportButton = button(
    '生成并下载 PNG',
    () => {
      exportButton.disabled = true;
      exportButton.textContent = '渲染中…';
      // 让浏览器先绘制按钮状态，再执行同步渲染。
      requestAnimationFrame(() => {
        try {
          void renderSpriteSheet(store.state.project, {
            frameCount: frames,
            cellScale,
            columns: Math.min(frames, 4),
          })
            .then((result) => {
              downloadBlob(result.blob, safeFilename(`${store.state.project.name}-sheet`, 'png'));
              preview.width = Math.min(720, result.width);
              preview.height = (preview.width / result.width) * result.height;
              const ctx = preview.getContext('2d');
              if (ctx) {
                createImageBitmap(result.blob).then((bitmap) => {
                  ctx.drawImage(bitmap, 0, 0, preview.width, preview.height);
                  bitmap.close();
                });
              }
              const avg = result.frameTimes.reduce((sum, v) => sum + v, 0) / Math.max(1, result.frameTimes.length);
              toast(
                `序列图已导出：${result.width}×${result.height}，${result.frameCount} 帧，平均仿真 ${avg.toFixed(
                  2,
                )}ms/帧`,
              );
            })
            .catch((error: unknown) => {
              toast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
            })
            .finally(() => {
              exportButton.disabled = false;
              exportButton.textContent = '生成并下载 PNG';
            });
        } catch (error) {
          exportButton.disabled = false;
          exportButton.textContent = '生成并下载 PNG';
          toast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
        }
      });
    },
    { variant: 'primary' },
  );

  const close = button('关闭', () => {
    sheetDialog?.remove();
    sheetDialog = null;
  });

  const overlay = h(
    'div',
    { class: 'dialog-overlay' },
    h(
      'div',
      { class: 'dialog' },
      h(
        'header',
        { class: 'dialog-header' },
        h('h2', { text: '导出粒子序列图' }),
        h('span', { class: 'muted small', text: '离线 · 与预览同一套无状态仿真' }),
      ),
      h('div', { class: 'dialog-body' }, field('帧数', framesSlider.root), field('单格缩放', scaleSlider.root), info, preview),
      h('div', { class: 'dialog-footer' }, close, exportButton),
    ),
  );
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close.click();
  });
  document.body.append(overlay);
  sheetDialog = overlay;
  updateInfo();
}

/* ------------------------------------------------------------------ */
/* 键盘                                                                */
/* ------------------------------------------------------------------ */

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const typing =
    !!target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'SELECT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable);

  const mod = event.metaKey || event.ctrlKey;

  if (mod && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveProject();
    return;
  }
  if (mod && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    void openProject();
    return;
  }
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) doRedo();
    else doUndo();
    return;
  }
  if (typing) return;
  // 焦点在时间轴滑杆上时，方向键/空格交给时间轴自己处理，避免重复触发。
  if (target instanceof HTMLElement && target.classList.contains('timeline-rail')) return;
  // 焦点在按钮上时，空格默认会「点击按钮」；播放等快捷键交给按钮自身。
  if (target instanceof HTMLButtonElement && event.code === 'Space') return;

  if (event.code === 'Space') {
    event.preventDefault();
    store.update((state) => {
      state.playback.playing = !state.playback.playing;
    }, 'playback');
    requestRender();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    stepTime(store, -1);
    requestRender();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    stepTime(store, 1);
    requestRender();
  } else if (event.key === 'Home') {
    event.preventDefault();
    seekTime(store, 0);
    requestRender();
  } else if (event.key === 'Escape') {
    help.hide();
    if (sheetDialog) {
      sheetDialog.remove();
      sheetDialog = null;
    }
  }
});

/* ------------------------------------------------------------------ */
/* 尺寸与启动                                                          */
/* ------------------------------------------------------------------ */

const resizeObserver = new ResizeObserver(() => {
  renderer.resize();
  requestRender();
});
resizeObserver.observe(stageWrap);

// 初始停在一个有内容的时刻，便于第一眼看到效果。
store.update((state) => {
  state.playback.time = Math.min(1.15, state.project.scene.duration);
  state.playback.playing = false;
}, 'playback');

historyBaseline = JSON.stringify(store.state.project);
inspector.refresh(store.state, { force: true });
refreshChrome(store.state);
statusChips.update(store.state);
timeline.update();
player.start();
requestRender();

/* ------------------------------------------------------------------ */
/* 调试接口（自动化测试用）                                            */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    __particleStudio?: {
      store: Store;
      seek(time: number): void;
      state(): AppState;
      simulate(time: number): ReturnType<typeof simulateScene>;
      setProject(project: Project): void;
      render(): void;
      history: History;
    };
  }
}

window.__particleStudio = {
  store,
  seek(time: number) {
    seekTime(store, time);
    requestRender();
  },
  state: () => store.state,
  simulate: (time: number) => simulateScene(store.state.project.scene, store.state.project.emitters, time),
  setProject(project: Project) {
    loadProject(project, { markDirty: true });
  },
  render: requestRender,
  history,
};
