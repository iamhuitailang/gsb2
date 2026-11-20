/**
 * ChromaDeck application shell.
 *
 * Architecture notes:
 *  - All working state lives in one mutable `state` object; mutations go
 *    through `commit()` so the preview, inspector, filmstrip and autosave all
 *    stay in sync.
 *  - Original files are only ever read. Adjustments are pure data, so no code
 *    path can write to a source file.
 *  - The live preview renders from a ≤1600 px upright working copy; export
 *    re-decodes the original at full resolution and runs the *same* pixel
 *    pipeline (`renderPixels`), which is why preview and export agree.
 */

import {
  ADJUSTMENT_GROUPS,
  GROUP_LABELS,
  adjustmentsAreDefault,
  cloneAdjustments,
  defaultAdjustments,
  describeAdjustments,
  isDefaultGroup,
  setGroup
} from './lib/adjustments.js';
import {
  CURVE_CHANNELS,
  addCurvePoint,
  createCurveSampler,
  moveCurvePoint,
  removeCurvePoint
} from './lib/curve.js';
import { renderPixels } from './lib/render.js';
import { describeOrientation, uprightSize } from './lib/orientation.js';
import {
  isPlausiblySupported,
  loadImageSource,
  renderFullResolution,
  suggestedExportName,
  SUPPORTED_INPUT_FORMATS
} from './lib/image-io.js';
import {
  COPY_GROUPS,
  createImageRecord,
  createProject,
  downloadFileNameForProject,
  fileRefFromFile,
  parseProjectText,
  readProjectFromStorage,
  recordFineTune,
  saveProjectToStorage,
  serializeProject
} from './lib/project.js';
import {
  getFileHandle,
  matchFilesToImages,
  pickImageFiles,
  putFileHandle,
  resolveHandle
} from './lib/file-store.js';
import { loadAllSamples, resolveBundledSamples } from './lib/samples.js';
import { createZip, uniqueNames } from './lib/zip.js';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset' && typeof value === 'object') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'checked') el.checked = Boolean(value);
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, kind = 'info', ttl = 4200) {
  const container = $('#toasts');
  const node = h('div', { class: `toast ${kind}` }, message);
  container.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 260);
  }, ttl);
  return node;
}

let curveErrorShownAt = 0;
function toastCurveError(message) {
  const now = Date.now();
  // Dragging can fire dozens of invalid positions per second; throttle the
  // message instead of spamming the toast stack.
  if (now - curveErrorShownAt < 1200) return;
  curveErrorShownAt = now;
  toast(message, 'error', 3200);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const VIEW_FIT = 'fit';
const MAX_COMPARE_PANES = 4;

const state = {
  project: null,
  activeImageId: null,
  selection: new Set(),
  sessions: new Map(), // imageId -> decoded working copy
  files: new Map(), // imageId -> File
  handles: new Map(), // imageId -> FileSystemFileHandle
  missing: new Set(), // imageId -> original needs re-linking
  view: 'single',
  compare: [], // version ids pinned into the compare grid
  showAdjusted: true,
  channel: 'master',
  selectedPoint: 0,
  viewport: { zoom: VIEW_FIT, panX: 0, panY: 0 },
  compareViewport: { zoom: VIEW_FIT, panX: 0, panY: 0 },
  showCurrentInCompare: true,
  autosaveTimer: null,
  lastSavedAt: null,
  lastValid: { exposure: 0, temperature: 0, tint: 0, saturation: 0 },
  renderScheduled: false,
  exporting: false
};

function activeImage() {
  return state.project?.images.find((image) => image.id === state.activeImageId) || null;
}

function imageById(id) {
  return state.project?.images.find((image) => image.id === id) || null;
}

function adjustmentsFor(image) {
  return image ? image.adjustments : defaultAdjustments();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function setSaveState(kind, text) {
  const node = $('#saveState');
  node.className = `save-state ${kind}`;
  node.textContent = text;
}

function markDirty() {
  setSaveState('saving', '有未保存更改');
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(autosave, 900);
}

function autosave() {
  if (!state.project) return;
  const result = saveProjectToStorage(state.project);
  if (result.ok) {
    state.lastSavedAt = new Date();
    setSaveState('saved', `已自动保存 ${formatTime(state.lastSavedAt)}`);
  } else {
    setSaveState('error', '自动保存失败');
    toast(result.error, 'error', 8000);
  }
}

function saveProjectNow(showToast = true) {
  if (!state.project) return false;
  const result = saveProjectToStorage(state.project);
  if (result.ok) {
    state.lastSavedAt = new Date();
    setSaveState('saved', `已保存 ${formatTime(state.lastSavedAt)}`);
    if (showToast) toast('项目已保存到本机浏览器存储。', 'ok');
    return true;
  }
  setSaveState('error', '保存失败');
  toast(result.error, 'error', 9000);
  return false;
}

function formatTime(date) {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function commit({ render = true, dirty = true } = {}) {
  if (dirty) markDirty();
  if (render) scheduleRender();
}

// The filmstrip rebuilds DOM nodes and re-decodes thumbnails; that is fine on
// its own but not at 60 fps while a slider is dragged, so it is debounced.
let filmstripTimer = null;
function scheduleFilmstrip() {
  clearTimeout(filmstripTimer);
  filmstripTimer = setTimeout(renderFilmstrip, 120);
}

// ---------------------------------------------------------------------------
// Preview rendering
// ---------------------------------------------------------------------------

function scheduleRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(() => {
    state.renderScheduled = false;
    drawAll();
  });
}

function drawAll() {
  const empty = !state.project || state.project.images.length === 0;
  $('#emptyState').classList.toggle('hidden', !empty);
  $('#btnExportAll').disabled = state.exporting || empty;
  $('#btnExportCurrent').disabled = state.exporting || empty;

  if (state.view === 'single') {
    $('#singlePane').classList.remove('hidden');
    $('#comparePane').classList.add('hidden');
    if (!empty) drawSingle();
  } else {
    $('#singlePane').classList.add('hidden');
    $('#comparePane').classList.remove('hidden');
    if (!empty) drawCompare();
  }
  // Inspector values must track the canvas frame-for-frame (the curve editor
  // is part of that). The filmstrip can lag a beat behind.
  updateInspector();
  updateImageInfo();
  scheduleFilmstrip();
}

function drawSingle() {
  const canvas = $('#previewCanvas');
  const image = activeImage();
  const session = image ? state.sessions.get(image.id) : null;
  if (!image || !session) {
    // No decoded pixels yet (e.g. the original needs re-linking). Clear rather
    // than leave a stale frame from the previously selected image on screen.
    if (canvas.width > 1) {
      canvas.width = 1;
      canvas.height = 1;
    }
    canvas.style.width = '0px';
    canvas.style.height = '0px';
    return;
  }
  const adjustments = state.showAdjusted ? image.adjustments : defaultAdjustments();
  const { width, height } = session.baseImageData;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const frame = ctx.createImageData(width, height);
  renderInto(session, adjustments, frame.data);
  ctx.putImageData(frame, 0, 0);
  applySingleTransform();
}
/**
 * Render an image with a given adjustment set into `target`.
 *
 * Only *stable* snapshots (saved versions shown in the compare grid) are
 * cached: while a slider is dragged the key changes every frame, so caching
 * those would copy several megabytes per animation frame for nothing.
 */
const frameCache = new Map();
const FRAMES_PER_IMAGE = 4;
const CACHED_IMAGES = 2;

function cacheEntriesFor(sessionId) {
  let entries = frameCache.get(sessionId);
  if (entries) {
    frameCache.delete(sessionId);
    frameCache.set(sessionId, entries);
    return entries;
  }
  entries = new Map();
  frameCache.set(sessionId, entries);
  while (frameCache.size > CACHED_IMAGES) frameCache.delete(frameCache.keys().next().value);
  return entries;
}

function renderInto(session, adjustments, target, { cache = false } = {}) {
  if (!cache) {
    renderPixels(session.baseImageData.data, adjustments, target);
    return;
  }
  const key = JSON.stringify(adjustments);
  const entries = cacheEntriesFor(session.id);
  const cached = entries.get(key);
  if (cached && cached.length === target.length) {
    entries.delete(key);
    entries.set(key, cached);
    target.set(cached);
    return;
  }
  renderPixels(session.baseImageData.data, adjustments, target);
  entries.set(key, new Uint8ClampedArray(target));
  while (entries.size > FRAMES_PER_IMAGE) entries.delete(entries.keys().next().value);
}

function applySingleTransform() {
  const canvas = $('#previewCanvas');
  const host = $('#singleCanvasHost');
  const rect = host.getBoundingClientRect();
  let scale;
  if (state.viewport.zoom === VIEW_FIT) {
    scale = Math.min((rect.width - 40) / canvas.width, (rect.height - 40) / canvas.height);
    if (!Number.isFinite(scale) || scale <= 0) scale = 0.2;
  } else {
    scale = state.viewport.zoom;
  }
  canvas.style.width = `${Math.round(canvas.width * scale)}px`;
  canvas.style.height = `${Math.round(canvas.height * scale)}px`;
  canvas.style.transform =
    state.viewport.zoom === VIEW_FIT
      ? ''
      : `translate(${state.viewport.panX}px, ${state.viewport.panY}px)`;
  $('#zoomLabel').textContent = `${Math.round(scale * 100)}%`;
  host.classList.toggle('pannable', state.viewport.zoom !== VIEW_FIT);
}

function drawCompare() {
  const grid = $('#compareGrid');
  const image = activeImage();
  const session = image ? state.sessions.get(image.id) : null;
  grid.innerHTML = '';
  if (!image || !session) {
    grid.dataset.count = '0';
    return;
  }
  const panes = buildComparePanes(image);
  grid.dataset.count = String(panes.length);
  if (!panes.length) {
    grid.append(
      h('div', { class: 'compare-empty' },
        h('p', {}, '还没有可比较的版本。'),
        h('p', { class: 'hint' }, '在右侧「版本」保存当前调整，并勾选要并排比较的版本。'))
    );
    return;
  }
  for (const pane of panes) grid.append(renderComparePane(image, session, pane));
  requestAnimationFrame(syncCompareTransforms);
}

function buildComparePanes(image) {
  const entries = [];
  if (state.showCurrentInCompare) {
    entries.push({ kind: 'current', id: 'current' });
  }
  for (const versionId of state.compare) {
    const version = image.versions.find((entry) => entry.id === versionId);
    if (version) entries.push({ kind: 'version', id: versionId, version });
  }
  if (entries.length < 2 && !state.compare.length && image.versions.length) {
    // Convenience: no explicit selection yet, compare current vs newest version.
    const version = image.versions[image.versions.length - 1];
    if (!entries.some((entry) => entry.id === version.id)) {
      entries.push({ kind: 'version', id: version.id, version });
    }
  }
  return entries.slice(0, MAX_COMPARE_PANES);
}

function renderComparePane(image, session, pane) {
  const adjustments = pane.kind === 'current' ? image.adjustments : pane.version.adjustments;
  const canvas = h('canvas', { class: 'pane-canvas' });
  canvas.width = session.baseImageData.width;
  canvas.height = session.baseImageData.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const frame = ctx.createImageData(canvas.width, canvas.height);
  renderInto(session, adjustments, frame.data, { cache: true });
  ctx.putImageData(frame, 0, 0);

  const host = h('div', { class: 'pane-canvas-host' }, canvas);
  const title = pane.kind === 'current' ? '当前调整' : pane.version.name;
  const description = describeAdjustments(adjustments);
  const paneEl = h('div', { class: `compare-pane ${pane.kind === 'current' ? 'pinned' : ''}` },
    h('div', { class: 'pane-head' },
      h('span', { class: 'pane-title' }, title),
      h('span', { class: 'pane-sub', title: description }, description),
      h('button', {
        class: 'pane-close',
        type: 'button',
        title: '从比较中移除',
        text: '×',
        onclick: () => {
          if (pane.kind === 'version') state.compare = state.compare.filter((id) => id !== pane.id);
          else {
            state.showCurrentInCompare = false;
            $('#showCurrentInCompare').checked = false;
          }
          // Keep the version-card checkboxes in sync with what is on screen.
          refreshVersionList();
          drawAll();
        }
      })),
    host);
  if (pane.kind === 'version') {
    paneEl.append(
      h('div', { class: 'pane-foot' },
        h('button', {
          class: 'btn small',
          type: 'button',
          text: '应用此版本',
          onclick: () => applyVersion(image, pane.version.id)
        }),
        h('button', {
          class: 'btn small ghost',
          type: 'button',
          text: '另存为新版本',
          onclick: () => saveVersionFrom(pane.version.adjustments)
        }))
    );
  }
  attachComparePan(host, canvas);
  return paneEl;
}

function applyCompareTransform(canvas, host) {
  const rect = host.getBoundingClientRect();
  let scale;
  if (state.compareViewport.zoom === VIEW_FIT) {
    scale = Math.min((rect.width - 16) / canvas.width, (rect.height - 16) / canvas.height);
    if (!Number.isFinite(scale) || scale <= 0) scale = 0.2;
  } else {
    scale = state.compareViewport.zoom;
  }
  canvas.style.width = `${Math.round(canvas.width * scale)}px`;
  canvas.style.height = `${Math.round(canvas.height * scale)}px`;
  canvas.style.transform =
    state.compareViewport.zoom === VIEW_FIT
      ? ''
      : `translate(${state.compareViewport.panX}px, ${state.compareViewport.panY}px)`;
  host.dataset.scale = String(scale);
}

function syncCompareTransforms() {
  for (const host of $$('.pane-canvas-host')) {
    const canvas = host.querySelector('canvas');
    if (canvas) applyCompareTransform(canvas, host);
  }
  const first = $('.pane-canvas-host');
  if (first && state.view === 'compare') {
    $('#zoomLabel').textContent = `${Math.round((Number(first.dataset.scale) || 0) * 100)}%`;
  }
}

function attachComparePan(host, canvas) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  host.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (state.compareViewport.zoom === VIEW_FIT) {
      // Freeze the fit scale as the starting zoom before panning.
      state.compareViewport.zoom = Number(host.dataset.scale) || 1;
    }
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    originX = state.compareViewport.panX;
    originY = state.compareViewport.panY;
    host.classList.add('dragging');
    host.setPointerCapture(event.pointerId);
  });
  host.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    state.compareViewport.panX = originX + (event.clientX - startX);
    state.compareViewport.panY = originY + (event.clientY - startY);
    syncCompareTransforms();
  });
  const end = () => {
    dragging = false;
    host.classList.remove('dragging');
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  host.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const base = state.compareViewport.zoom === VIEW_FIT
        ? Number(host.dataset.scale) || 1
        : state.compareViewport.zoom;
      state.compareViewport.zoom = clamp(base * (event.deltaY < 0 ? 1.12 : 1 / 1.12), 0.05, 12);
      syncCompareTransforms();
    },
    { passive: false }
  );
  applyCompareTransform(canvas, host);
}

// ---------------------------------------------------------------------------
// Zoom / pan (single view)
// ---------------------------------------------------------------------------

/** "Fit" scale for the single canvas, cached for the zoom buttons. */
function singleFitScale() {
  const canvas = $('#previewCanvas');
  const rect = $('#singleCanvasHost').getBoundingClientRect();
  if (!canvas.width || !canvas.height) return 0.2;
  const scale = Math.min((rect.width - 40) / canvas.width, (rect.height - 40) / canvas.height);
  return Number.isFinite(scale) && scale > 0 ? scale : 0.2;
}

function currentSingleScale() {
  return state.viewport.zoom === VIEW_FIT ? singleFitScale() : state.viewport.zoom;
}

function attachSinglePan() {
  const host = $('#singleCanvasHost');
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  host.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state.viewport.zoom === VIEW_FIT) return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    originX = state.viewport.panX;
    originY = state.viewport.panY;
    host.classList.add('dragging');
    host.setPointerCapture(event.pointerId);
  });
  host.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    state.viewport.panX = originX + (event.clientX - startX);
    state.viewport.panY = originY + (event.clientY - startY);
    applySingleTransform();
  });
  const end = () => {
    dragging = false;
    host.classList.remove('dragging');
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  host.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const base = currentSingleScale();
      state.viewport.zoom = clamp(base * (event.deltaY < 0 ? 1.12 : 1 / 1.12), 0.05, 12);
      applySingleTransform();
    },
    { passive: false }
  );
}

function setZoom(mode) {
  if (state.view === 'compare') {
    setCompareZoom(mode);
    return;
  }
  const current = currentSingleScale();
  if (mode === VIEW_FIT) state.viewport = { zoom: VIEW_FIT, panX: 0, panY: 0 };
  else if (mode === 'in') state.viewport = { ...state.viewport, zoom: clamp(current * 1.25, 0.05, 12) };
  else if (mode === 'out') state.viewport = { ...state.viewport, zoom: clamp(current / 1.25, 0.05, 12) };
  else if (mode === 'actual') state.viewport = { zoom: 1, panX: 0, panY: 0 };
  applySingleTransform();
}

function setCompareZoom(mode) {
  const host = $('.pane-canvas-host');
  const current = state.compareViewport.zoom === VIEW_FIT
    ? Number(host?.dataset.scale) || 0.5
    : state.compareViewport.zoom;
  if (mode === VIEW_FIT) state.compareViewport = { zoom: VIEW_FIT, panX: 0, panY: 0 };
  else if (mode === 'in') state.compareViewport = { ...state.compareViewport, zoom: clamp(current * 1.25, 0.05, 12) };
  else if (mode === 'out') state.compareViewport = { ...state.compareViewport, zoom: clamp(current / 1.25, 0.05, 12) };
  else if (mode === 'actual') state.compareViewport = { zoom: 1, panX: 0, panY: 0 };
  syncCompareTransforms();
  const hostNode = $('.pane-canvas-host');
  if (hostNode) $('#zoomLabel').textContent = `${Math.round((Number(hostNode.dataset.scale) || 0) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Filmstrip
// ---------------------------------------------------------------------------

function renderFilmstrip() {
  const list = $('#filmstrip');
  list.innerHTML = '';
  if (!state.project) return;
  $('#imageCount').textContent = String(state.project.images.length);
  $('#selectionCount').textContent = String(state.selection.size);

  for (const image of state.project.images) {
    const active = image.id === state.activeImageId;
    const badges = [];
    if (state.missing.has(image.id)) badges.push(h('span', { class: 'film-badge warn' }, '需关联'));
    if (image.batchBase) badges.push(h('span', { class: 'film-badge batch' }, '批量'));
    if (image.versions.length) badges.push(h('span', { class: 'film-badge versions' }, `v${image.versions.length}`));

    const thumb = image.thumbnail
      ? h('img', { class: 'thumb', src: image.thumbnail, alt: '' })
      : h('div', { class: 'thumb' });
    const size = uprightSize(
      image.fileRef.width || image.width || 0,
      image.fileRef.height || image.height || 0,
      image.orientation
    );
    const dims = size.width && size.height ? `${size.width}×${size.height}` : '尺寸未知';

    const item = h('li', {
      class: `film-item ${active ? 'active' : ''} ${state.missing.has(image.id) ? 'needs-relink' : ''}`,
      role: 'option',
      'aria-selected': String(active),
      tabindex: '0'
    },
      h('input', {
        class: 'film-check',
        type: 'checkbox',
        checked: state.selection.has(image.id),
        'aria-label': `选择 ${image.fileRef.name}`,
        onclick: (event) => {
          event.stopPropagation();
          if (event.target.checked) state.selection.add(image.id);
          else state.selection.delete(image.id);
          renderFilmstrip();
        }
      }),
      thumb,
      h('div', { class: 'film-meta' },
        h('div', { class: 'film-name', title: image.fileRef.name }, image.fileRef.name, ...badges),
        h('div', {
          class: 'film-sub',
          title: describeAdjustments(image.adjustments)
        }, `${dims} · ${describeAdjustments(image.adjustments)}`))
    );
    item.addEventListener('click', () => selectImage(image.id));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectImage(image.id);
      }
    });
    list.append(item);
  }
}

function selectImage(id) {
  if (!state.project || id === state.activeImageId) return;
  state.activeImageId = id;
  state.project.activeImageId = id;
  state.compare = [];
  state.selectedPoint = 0;
  state.viewport = { zoom: VIEW_FIT, panX: 0, panY: 0 };
  state.compareViewport = { zoom: VIEW_FIT, panX: 0, panY: 0 };
  // Drop the previous image's pixels immediately so the stage never shows a
  // stale frame while the new image decodes.
  const canvas = $('#previewCanvas');
  canvas.width = 1;
  canvas.height = 1;
  canvas.style.width = '0px';
  canvas.style.height = '0px';
  renderVersions();
  commit();
  ensureSession(id)
    .then(() => commit())
    .catch((error) => {
      state.missing.add(id);
      renderFilmstrip();
      toast(error.message, 'error', 8000);
    });
}

// ---------------------------------------------------------------------------
// Sessions / loading
// ---------------------------------------------------------------------------

async function ensureSession(imageId, { file, handle, interactive = false } = {}) {
  if (state.sessions.has(imageId)) return state.sessions.get(imageId);
  const image = imageById(imageId);
  if (!image) return null;

  let sourceFile = file || state.files.get(imageId) || null;
  let sourceHandle = handle || state.handles.get(imageId) || null;

  if (!sourceFile && sourceHandle) {
    // `interactive` is only true when we are inside a click handler; Chrome
    // requires a user gesture before it will show the permission prompt.
    const resolved = await resolveHandle(sourceHandle, { interactive });
    if (resolved.file) sourceFile = resolved.file;
  }
  if (!sourceFile) {
    state.missing.add(imageId);
    renderFilmstrip();
    $('#btnRelink').classList.remove('hidden');
    throw new Error(
      `「${image.fileRef.name}」的原文件需要重新关联后才能显示与导出。` +
        (sourceHandle ? '点击「重新关联原图」并允许访问即可。' : '')
    );
  }

  const loaded = await loadImageSource(sourceFile);
  const session = { id: imageId, ...loaded };
  state.sessions.set(imageId, session);
  state.files.set(imageId, sourceFile);
  if (sourceHandle) state.handles.set(imageId, sourceHandle);
  if (!image.thumbnail && loaded.thumbnail) image.thumbnail = loaded.thumbnail;

  // The file on disk is the source of truth for geometry. Re-syncing here is
  // what guarantees the exporter (which re-decodes the same file with
  // `image.orientation`) can never disagree with the preview.
  image.orientation = loaded.orientation;
  image.fileRef.width = loaded.rawWidth;
  image.fileRef.height = loaded.rawHeight;
  image.fileRef.orientation = loaded.orientation;
  image.width = loaded.fullWidth;
  image.height = loaded.fullHeight;

  state.missing.delete(imageId);
  if (!state.missing.size) $('#btnRelink').classList.add('hidden');
  renderFilmstrip();
  return session;
}

async function addFiles(picked, { selectFirst = false } = {}) {
  if (!state.project) state.project = createProject();
  const added = [];
  const failures = [];
  for (const entry of picked) {
    const file = entry.file;
    if (!file) continue;
    if (!isPlausiblySupported(file)) {
      failures.push(`${file.name}：不支持的格式。支持 ${SUPPORTED_INPUT_FORMATS.join('、')}。`);
      continue;
    }
    let loaded;
    try {
      loaded = await loadImageSource(file);
    } catch (error) {
      failures.push(`${file.name}：${error.message}`);
      continue;
    }
    const record = createImageRecord({
      fileRef: fileRefFromFile(file, {
        orientation: loaded.orientation,
        width: loaded.rawWidth,
        height: loaded.rawHeight
      }),
      contentType: file.type || '',
      width: loaded.fullWidth,
      height: loaded.fullHeight,
      orientation: loaded.orientation,
      adjustments: defaultAdjustments(),
      thumbnail: loaded.thumbnail
    });
    state.project.images.push(record);
    state.sessions.set(record.id, { id: record.id, ...loaded });
    state.files.set(record.id, file);
    if (entry.handle) {
      state.handles.set(record.id, entry.handle);
      await putFileHandle(record.id, entry.handle);
    }
    added.push(record);
  }

  if (added.length) {
    if (!state.activeImageId || selectFirst) {
      state.activeImageId = added[0].id;
      state.project.activeImageId = added[0].id;
    }
    state.selection = new Set(added.map((record) => record.id));
    saveProjectNow(false);
    // The versions panel and inspector are keyed to the active image; adding
    // the first image makes it active, so both need a refresh.
    renderVersions();
    commit();
  }
  for (const failure of failures) toast(failure, 'error', 7000);
  return { added, failures };
}

// ---------------------------------------------------------------------------
// Inspector sync
// ---------------------------------------------------------------------------

function updateInspector() {
  const image = activeImage();
  const adjustments = adjustmentsFor(image);
  const disabled = !image;

  const setPair = (sliderSel, numberSel, value, text) => {
    const slider = $(sliderSel);
    const number = $(numberSel);
    if (document.activeElement !== slider) slider.value = String(value);
    if (document.activeElement !== number) number.value = text;
    slider.disabled = disabled;
    number.disabled = disabled;
  };

  setPair('#exposureSlider', '#exposureNumber', adjustments.exposure.ev, adjustments.exposure.ev.toFixed(2));
  setPair('#tempSlider', '#tempNumber', adjustments.whiteBalance.temperature, String(adjustments.whiteBalance.temperature));
  setPair('#tintSlider', '#tintNumber', adjustments.whiteBalance.tint, String(adjustments.whiteBalance.tint));
  setPair('#satSlider', '#satNumber', adjustments.saturation.value, String(adjustments.saturation.value));

  // Keep the "last valid value" trackers aligned with the image on screen, so
  // switching images never restores a value that belongs to another photo.
  if (image) {
    state.lastValid.exposure = adjustments.exposure.ev;
    state.lastValid.temperature = adjustments.whiteBalance.temperature;
    state.lastValid.tint = adjustments.whiteBalance.tint;
    state.lastValid.saturation = adjustments.saturation.value;
  }

  for (const group of ADJUSTMENT_GROUPS) {
    const btn = document.querySelector(`[data-restore="${group.key}"]`);
    if (!btn) continue;
    const isDefault = isDefaultGroup(adjustments, group.key);
    btn.disabled = disabled || isDefault;
    btn.title = isDefault ? `${group.label}已是默认值` : `只把「${group.label}」恢复默认，其余参数保留`;
  }

  $('#btnResetAll').disabled = disabled || adjustmentsAreDefault(adjustments);
  $('#btnSaveVersion').disabled = disabled;
  $('#btnCopyToSelected').disabled = disabled;
  $('#btnRestoreBatch').disabled = disabled || !image?.batchBase;

  renderCurveEditor();
  updatePointEditor();
  markActiveVersion();
}

/**
 * Highlight the version card that matches the current adjustments without
 * rebuilding the list (rebuilding would drop focus and scroll position).
 */
function markActiveVersion() {
  const image = activeImage();
  const currentKey = image ? JSON.stringify(image.adjustments) : null;
  for (const card of $$('#versionList .version-card')) {
    card.classList.toggle('active', card.dataset.signature === currentKey);
  }
}

/**
 * Version list re-render, called only when versions actually change (not on
 * every slider tick) so dragging a slider cannot yank the list under the
 * pointer.
 */
function refreshVersionList() {
  renderVersions();
}

function updatePointEditor() {
  const image = activeImage();
  const points = adjustmentsFor(image).toneCurve[state.channel];
  const select = $('#pointSelect');
  state.selectedPoint = clamp(state.selectedPoint, 0, points.length - 1);

  // Rebuild the option list only when it actually changed; rewriting it while
  // the dropdown is focused would close it and steal the selection.
  const signature = points.map((point) => `${point[0].toFixed(3)},${point[1].toFixed(3)}`).join(';');
  if (select.dataset.signature !== signature) {
    select.innerHTML = '';
    points.forEach((point, index) => {
      select.append(
        h('option', { value: String(index) }, `${index + 1}. (${point[0].toFixed(2)}, ${point[1].toFixed(2)})`)
      );
    });
    select.dataset.signature = signature;
  }
  select.value = String(state.selectedPoint);
  select.disabled = !image;

  const point = points[state.selectedPoint];
  const xInput = $('#pointX');
  const yInput = $('#pointY');
  if (document.activeElement !== xInput) xInput.value = point ? point[0].toFixed(3) : '';
  if (document.activeElement !== yInput) yInput.value = point ? point[1].toFixed(3) : '';
  xInput.disabled = !image || state.selectedPoint === 0 || state.selectedPoint === points.length - 1;
  yInput.disabled = !image;
  $('#btnRemovePoint').disabled = !image || state.selectedPoint === 0 || state.selectedPoint === points.length - 1;
}

// ---------------------------------------------------------------------------
// Curve editor
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

function channelColor(channel) {
  return CURVE_CHANNELS.find((entry) => entry.key === channel)?.color || '#e9c46a';
}

function channelLabel() {
  return CURVE_CHANNELS.find((entry) => entry.key === state.channel)?.label || '亮度';
}

function isFlatCurve(points) {
  return points.length === 2 && Math.abs(points[0][1]) < 1e-6 && Math.abs(points[1][1] - 1) < 1e-6;
}

function renderCurveEditor() {
  const svg = $('#curveSvg');
  svg.innerHTML = '';
  const image = activeImage();
  const adjustments = adjustmentsFor(image);
  const points = adjustments.toneCurve[state.channel];

  svg.append(
    svgEl('line', {
      x1: 0, y1: 100, x2: 100, y2: 0,
      stroke: 'rgba(255,255,255,.16)', 'stroke-width': 0.5, 'vector-effect': 'non-scaling-stroke'
    })
  );

  // Muted overlays of the other RGB channels, so a master tweak stays legible.
  for (const channel of CURVE_CHANNELS) {
    if (channel.key === state.channel) continue;
    const curve = adjustments.toneCurve[channel.key];
    if (isFlatCurve(curve)) continue;
    svg.append(
      svgEl('path', {
        d: buildCurvePath(createCurveSampler(curve)),
        class: 'curve-line',
        stroke: channel.color,
        opacity: 0.22,
        'vector-effect': 'non-scaling-stroke'
      })
    );
  }

  svg.append(
    svgEl('path', {
      d: buildCurvePath(createCurveSampler(points)),
      class: 'curve-line',
      stroke: channelColor(state.channel)
    })
  );

  points.forEach(([x, y], index) => {
    const circle = svgEl('circle', {
      cx: x * 100,
      cy: (1 - y) * 100,
      r: 2.4,
      class: `curve-handle ${index === state.selectedPoint ? 'selected' : ''}`,
      stroke: channelColor(state.channel),
      'data-index': index
    });
    circle.addEventListener('pointerdown', (event) => startCurveDrag(event, index));
    svg.append(circle);
  });
}

function buildCurvePath(sampler) {
  const parts = [];
  for (let i = 0; i <= 96; i += 1) {
    const x = i / 96;
    parts.push(`${i === 0 ? 'M' : 'L'}${(x * 100).toFixed(2)},${((1 - sampler(x)) * 100).toFixed(2)}`);
  }
  return parts.join(' ');
}

function curveCoordsFromEvent(svg, event) {
  const rect = svg.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp(1 - (event.clientY - rect.top) / rect.height, 0, 1)
  };
}

function startCurveDrag(event, index) {
  event.preventDefault();
  event.stopPropagation();
  if (!activeImage()) return;
  state.selectedPoint = index;
  updatePointEditor();
  const svg = $('#curveSvg');
  svg.setPointerCapture?.(event.pointerId);
  const move = (moveEvent) => {
    const { x, y } = curveCoordsFromEvent(svg, moveEvent);
    applyCurveEdit((pts) => moveCurvePoint(pts, index, x, y, `色调曲线（${channelLabel()}）`), { quiet: true });
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    svg.removeEventListener('pointercancel', up);
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
}

/**
 * Apply a curve edit. On failure the previous valid curve is kept; the error is
 * surfaced instead of being swallowed.
 */
function applyCurveEdit(mutator, { quiet = false } = {}) {
  const image = activeImage();
  if (!image) return false;
  const current = image.adjustments.toneCurve[state.channel];
  const result = mutator(current);
  if (!result.ok) {
    if (quiet) toastCurveError(result.error);
    else toast(result.error, 'error', 5000);
    updatePointEditor();
    return false;
  }
  try {
    image.adjustments = setGroup(image.adjustments, 'toneCurve', {
      ...image.adjustments.toneCurve,
      [state.channel]: result.points
    });
  } catch (error) {
    toast(error.message, 'error', 5000);
    return false;
  }
  recordFineTuneIfNeeded(image, 'toneCurve');
  commit();
  return true;
}

function recordFineTuneIfNeeded(image, group) {
  if (!image.batchBase) return;
  image.fineTune = recordFineTune(image, group, image.adjustments);
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

function saveVersionFrom(adjustments, name) {
  const image = activeImage();
  if (!image) return;
  const version = {
    id: `ver_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: name || `版本 ${image.versions.length + 1}`,
    createdAt: new Date().toISOString(),
    adjustments: cloneAdjustments(adjustments)
  };
  image.versions.push(version);
  if (image.versions.length > 24) image.versions.shift();
  if (!state.compare.includes(version.id) && state.compare.length < MAX_COMPARE_PANES - 1) {
    state.compare.push(version.id);
  }
  refreshVersionList();
  commit();
  toast(`已保存版本「${version.name}」，可在「并排比较」中查看。`, 'ok');
}

function applyVersion(image, versionId) {
  const version = image.versions.find((entry) => entry.id === versionId);
  if (!version) return;
  image.adjustments = cloneAdjustments(version.adjustments);
  if (image.batchBase) image.fineTune = recordFineTune(image, '*', image.adjustments);
  refreshVersionList();
  commit();
  toast(`已应用版本「${version.name}」。`, 'ok');
}

function deleteVersion(image, versionId) {
  image.versions = image.versions.filter((entry) => entry.id !== versionId);
  state.compare = state.compare.filter((id) => id !== versionId);
  refreshVersionList();
  commit();
}

function renameVersion(image, versionId, name) {
  const version = image.versions.find((entry) => entry.id === versionId);
  if (!version) return;
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    toast('版本名称不能为空。', 'error');
    return;
  }
  version.name = trimmed.slice(0, 60);
  refreshVersionList();
  commit();
}

function renderVersions() {
  const list = $('#versionList');
  list.innerHTML = '';
  const image = activeImage();
  if (!image) {
    list.append(h('div', { class: 'version-empty' }, '选择图片后可保存版本。'));
    return;
  }
  if (!image.versions.length) {
    list.append(h('div', { class: 'version-empty' }, '还没有版本。调整好后点「保存当前为新版本」。'));
  }
  for (const version of image.versions) {
    list.append(
      h('div', {
        class: 'version-card',
        dataset: { versionId: version.id, signature: JSON.stringify(version.adjustments) }
      },
        h('input', {
          type: 'checkbox',
          checked: state.compare.includes(version.id),
          title: '加入并排比较',
          onchange: (event) => {
            if (event.target.checked) {
              if (state.compare.length >= MAX_COMPARE_PANES - 1) {
                toast(`最多同时比较 ${MAX_COMPARE_PANES - 1} 个版本（外加当前调整）。`, 'info');
                event.target.checked = false;
                return;
              }
              state.compare.push(version.id);
              state.view = 'compare';
              syncViewButtons();
            } else {
              state.compare = state.compare.filter((id) => id !== version.id);
            }
            drawAll();
          }
        }),
        h('div', { class: 'version-body' },
          h('div', { class: 'version-name', title: version.name }, version.name),
          h('div', {
            class: 'version-desc',
            title: describeAdjustments(version.adjustments)
          }, describeAdjustments(version.adjustments))),
        h('div', { class: 'version-actions-inline' },
          h('button', {
            class: 'link-btn',
            type: 'button',
            text: '应用',
            title: '把该版本的参数载入当前图片',
            onclick: () => {
              applyVersion(image, version.id);
              drawAll();
            }
          }),
          h('button', {
            class: 'link-btn',
            type: 'button',
            text: '改名',
            onclick: () => {
              const name = window.prompt('版本名称', version.name);
              if (name !== null) renameVersion(image, version.id, name);
            }
          }),
          h('button', {
            class: 'link-btn',
            type: 'button',
            text: '删除',
            onclick: () => deleteVersion(image, version.id)
          })))
    );
  }
  markActiveVersion();
}

// ---------------------------------------------------------------------------
// Info bar
// ---------------------------------------------------------------------------

function updateImageInfo() {
  const node = $('#imageInfo');
  const image = activeImage();
  if (!image) {
    node.textContent = '—';
    node.title = '';
    return;
  }
  const upright = uprightSize(
    image.fileRef.width || image.width || 0,
    image.fileRef.height || image.height || 0,
    image.orientation
  );
  const parts = [
    image.fileRef.name,
    `${upright.width}×${upright.height}`,
    describeOrientation(image.orientation),
    image.fileRef.size ? `${(image.fileRef.size / 1024).toFixed(0)} KB` : null,
    image.fileRef.type || null
  ].filter(Boolean);
  node.textContent = parts.join(' · ');
  node.title = node.textContent;
}

// ---------------------------------------------------------------------------
// Adjustment editing
// ---------------------------------------------------------------------------

function applyGroupEdit(groupKey, value, { quiet = false } = {}) {
  const image = activeImage();
  if (!image) return false;
  try {
    image.adjustments = setGroup(image.adjustments, groupKey, value);
    recordFineTuneIfNeeded(image, groupKey);
    commit();
    return true;
  } catch (error) {
    if (!quiet) toast(error.message, 'error', 5000);
    return false;
  }
}

function restoreGroup(groupKey) {
  const image = activeImage();
  if (!image) return;
  try {
    image.adjustments = setGroup(image.adjustments, groupKey, defaultAdjustments()[groupKey]);
    recordFineTuneIfNeeded(image, groupKey);
    if (groupKey === 'exposure') state.lastValid.exposure = 0;
    if (groupKey === 'whiteBalance') {
      state.lastValid.temperature = 0;
      state.lastValid.tint = 0;
    }
    if (groupKey === 'saturation') state.lastValid.saturation = 0;
    commit();
    toast(`已把「${GROUP_LABELS[groupKey]}」恢复默认，其他参数保持不变。`, 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/**
 * Shared wiring for a numeric field with a paired range slider. Invalid or
 * out-of-range input reverts to the last valid value and explains why.
 */
function bindNumberSlider({ numberSel, sliderSel, groupKey, field, validKey, digits, validLabel }) {
  const number = $(numberSel);
  const slider = $(sliderSel);

  const format = (value) => (digits ? value.toFixed(digits) : String(value));
  const revert = () => {
    number.value = format(state.lastValid[validKey]);
  };

  const commitNumber = () => {
    const image = activeImage();
    if (!image) return;
    const raw = number.value.trim();
    if (raw === '') {
      revert();
      toast(`${validLabel}不能为空，已恢复上一次有效值。`, 'error', 4500);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      revert();
      toast(`${validLabel}必须是数字，已恢复上一次有效值。`, 'error', 4500);
      return;
    }
    const next = { ...image.adjustments[groupKey], [field]: parsed };
    const ok = applyGroupEdit(groupKey, next);
    if (!ok) {
      revert();
      return;
    }
    state.lastValid[validKey] = parsed;
    number.value = format(parsed);
    slider.value = String(parsed);
  };

  number.addEventListener('change', commitNumber);
  number.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitNumber();
      number.blur();
    }
    if (event.key === 'Escape') {
      revert();
      number.blur();
    }
  });

  slider.addEventListener('input', () => {
    const image = activeImage();
    if (!image) return;
    const parsed = Number(slider.value);
    const next = { ...image.adjustments[groupKey], [field]: parsed };
    if (applyGroupEdit(groupKey, next, { quiet: true })) {
      state.lastValid[validKey] = parsed;
      number.value = format(parsed);
    }
  });
}

function bindSliders() {
  bindNumberSlider({
    numberSel: '#exposureNumber',
    sliderSel: '#exposureSlider',
    groupKey: 'exposure',
    field: 'ev',
    validKey: 'exposure',
    digits: 2,
    validLabel: '曝光'
  });
  bindNumberSlider({
    numberSel: '#tempNumber',
    sliderSel: '#tempSlider',
    groupKey: 'whiteBalance',
    field: 'temperature',
    validKey: 'temperature',
    digits: 0,
    validLabel: '色温'
  });
  bindNumberSlider({
    numberSel: '#tintNumber',
    sliderSel: '#tintSlider',
    groupKey: 'whiteBalance',
    field: 'tint',
    validKey: 'tint',
    digits: 0,
    validLabel: '色调'
  });
  bindNumberSlider({
    numberSel: '#satNumber',
    sliderSel: '#satSlider',
    groupKey: 'saturation',
    field: 'value',
    validKey: 'saturation',
    digits: 0,
    validLabel: '饱和度'
  });
}

// ---------------------------------------------------------------------------
// Batch copy
// ---------------------------------------------------------------------------

function copyCurrentAdjustmentsToSelected() {
  const source = activeImage();
  if (!source) return;
  const targets = Array.from(state.selection).filter((id) => id !== source.id && imageById(id));
  if (!targets.length) {
    toast('请先在左侧勾选要接收调整的图片（当前图片除外）。', 'info');
    return;
  }
  for (const id of targets) {
    const image = imageById(id);
    image.preBatch = image.preBatch || cloneAdjustments(image.adjustments);
    image.batchBase = cloneAdjustments(source.adjustments);
    image.adjustments = copyAdjustmentGroups(source.adjustments, image.adjustments, COPY_GROUPS);
    image.fineTune = [];
    image.recipeSource = source.fileRef.name;
  }
  commit();
  toast(`已把当前调整复制到 ${targets.length} 张图片。之后每张仍可单独微调。`, 'ok');
}

function restoreBatchForActive() {
  const image = activeImage();
  if (!image) return;
  if (!image.batchBase) {
    toast('当前图片没有批量调整记录。', 'info');
    return;
  }
  image.adjustments = image.preBatch ? cloneAdjustments(image.preBatch) : defaultAdjustments();
  image.batchBase = null;
  image.preBatch = null;
  image.fineTune = [];
  image.recipeSource = null;
  commit();
  toast('已撤销当前图片的批量调整，恢复到批量之前的参数。', 'ok');
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportOptions() {
  const format = $('#exportFormat').value;
  const quality = clamp(Number($('#exportQuality').value) || 92, 40, 100) / 100;
  return { format, quality };
}

async function exportImage(image, options, { download = true } = {}) {
  const file = state.files.get(image.id);
  if (!file) return { ok: false, error: '原文件不可用，请先重新关联原图' };
  try {
    const rendered = await renderFullResolution(file, image.adjustments, {
      format: options.format,
      quality: options.quality,
      orientation: image.orientation
    });
    const name = suggestedExportName(image.fileRef.name, { format: rendered.format });
    if (download) downloadBlob(rendered.blob, name);
    return { ok: true, name, blob: rendered.blob, width: rendered.width, height: rendered.height };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = h('a', { href: url, download: name });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportCurrent() {
  const image = activeImage();
  if (!image || state.exporting) return;
  state.exporting = true;
  $('#exportStatus').textContent = `正在导出 ${image.fileRef.name}…`;
  try {
    const result = await exportImage(image, exportOptions());
    if (result.ok) {
      $('#exportStatus').textContent = `已导出 ${result.name} · ${result.width}×${result.height}`;
      toast(`已导出「${result.name}」。原图未改动。`, 'ok');
    } else {
      $('#exportStatus').textContent = '导出失败，原图与项目配置已保留';
      toast(`导出失败：${result.error}。原图和项目配置仍然完好，可修正后重试。`, 'error', 8000);
      saveProjectNow(false);
    }
  } finally {
    state.exporting = false;
    // Re-enable the export buttons (drawAll is what owns their disabled state).
    scheduleRender();
  }
}

async function exportAll() {
  if (!state.project || state.exporting) return;
  const images = state.project.images;
  if (!images.length) return;
  state.exporting = true;
  const options = exportOptions();
  const results = [];
  try {
    for (let i = 0; i < images.length; i += 1) {
      const image = images[i];
      $('#exportStatus').textContent = `正在导出 ${i + 1}/${images.length}：${image.fileRef.name}…`;
      // Sequential on purpose: keeps memory bounded for big batches.
      const result = await exportImage(image, options, { download: false });
      results.push({ image, ...result });
    }
  } finally {
    state.exporting = false;
  }

  const succeeded = results.filter((entry) => entry.ok);
  const failed = results.filter((entry) => !entry.ok);
  let delivered = 'nothing';

  try {
    if (succeeded.length === 1 && !failed.length) {
      // One file: a plain download is friendlier than a ZIP.
      downloadBlob(succeeded[0].blob, succeeded[0].name);
      delivered = 'single';
    } else if (succeeded.length > 1) {
      // Browsers block the 2nd+ programmatic download in most configurations,
      // so multiple results are packaged into a single archive.
      const archive = await packageArchive(succeeded);
      downloadBlob(archive, buildArchiveName());
      delivered = 'archive';
    }
  } catch (error) {
    toast(`打包导出失败：${error.message}。原图与项目配置已保留。`, 'error', 8000);
  }

  $('#exportStatus').textContent = failed.length
    ? `导出完成：${succeeded.length} 成功，${failed.length} 失败（原图未改动）`
    : succeeded.length > 1
      ? `已把 ${succeeded.length} 张图片打包导出`
      : '导出完成';
  showExportReport(results, delivered);
  // Persist the state *after* export so a partial failure still leaves the
  // project intact and reopenable.
  saveProjectNow(false);
  // Restore the export buttons' enabled state.
  scheduleRender();
}

/**
 * Minimal ZIP writer is in lib/zip.js; this helper packages rendered blobs
 * into a single archive so batch export triggers exactly one download.
 */
async function packageArchive(entries) {
  const names = uniqueNames(entries.map((entry) => ({ name: entry.name })));
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    files.push({ name: names[i].name, bytes: new Uint8Array(await entries[i].blob.arrayBuffer()) });
  }
  return createZip(files);
}

function buildArchiveName() {
  const base = (state.project?.name || 'chromadeck')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'chromadeck';
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base}-导出-${stamp}.zip`;
}

function showExportReport(results, delivered = 'nothing') {
  const report = $('#exportReport');
  report.innerHTML = '';
  for (const entry of results) {
    report.append(
      h('div', { class: 'export-row-report' },
        h('span', { class: entry.ok ? 'ok' : 'fail' }, entry.ok ? '✓' : '✕'),
        h('span', { style: { flex: '1 1 auto' } },
          entry.image.fileRef.name,
          entry.ok ? ` → ${entry.name}（${entry.width}×${entry.height}）` : ` — ${entry.error}`))
    );
  }
  if (results.some((entry) => !entry.ok)) {
    report.append(
      h('p', { class: 'hint' }, '失败的图片没有写入任何文件；原图与项目配置均已保留，重新关联后可再次导出。')
    );
  }
  if (delivered === 'archive') {
    report.append(h('p', { class: 'hint' }, '多张图片已打包为一个 ZIP 下载，以避免浏览器拦截连续下载。'));
  }
  if (delivered === 'nothing' && results.some((entry) => entry.ok)) {
    report.append(
      h('p', { class: 'hint' }, '生成成功但打包下载失败；原图与项目配置未受影响，可重试导出。')
    );
  }
  const dialog = $('#exportDialog');
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

// ---------------------------------------------------------------------------
// Project file import / export
// ---------------------------------------------------------------------------

function exportProjectFile() {
  if (!state.project) return;
  const blob = new Blob([JSON.stringify(serializeProject(state.project), null, 2)], {
    type: 'application/json'
  });
  downloadBlob(blob, downloadFileNameForProject(state.project));
  toast('已导出项目文件（只含原图引用与参数，不含原图）。', 'ok');
}

async function importProjectFile() {
  const picked = await new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    document.body.append(input);
    const done = (value) => {
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => done(input.files?.[0] || null));
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
  if (!picked) return;
  const { project, messages } = parseProjectText(await picked.text());
  if (!project) {
    for (const message of messages) toast(message, 'error', 7000);
    return;
  }
  // Opening a project replaces the current workspace, so persist the current
  // one first; nothing is lost if the user opens the wrong file.
  if (state.project?.images.length) saveProjectNow(false);
  await adoptProject(project, { messages, fromFile: true });
}

async function adoptProject(project, { messages = [], fromFile = false } = {}) {
  state.project = project;
  state.activeImageId = project.activeImageId;
  state.selection = new Set();
  state.sessions.clear();
  state.files.clear();
  state.handles.clear();
  state.missing.clear();
  state.compare = [];
  state.view = 'single';
  syncViewButtons();
  frameCache.clear();
  state.viewport = { zoom: VIEW_FIT, panX: 0, panY: 0 };
  state.compareViewport = { zoom: VIEW_FIT, panX: 0, panY: 0 };
  $('#projectName').value = project.name;
  $('#exportStatus').textContent = '';

  // Re-attach persisted file handles when the File System Access API is in use,
  // then fall back to the bundled samples for projects built from samples.
  for (const image of project.images) {
    const handle = await getFileHandle(image.id);
    if (handle) state.handles.set(image.id, handle);
    else state.missing.add(image.id);
  }
  if (state.missing.size) {
    const sampleMatches = await resolveBundledSamples(
      project.images.filter((image) => state.missing.has(image.id))
    );
    for (const [imageId, entry] of sampleMatches) {
      state.files.set(imageId, entry.file);
      state.missing.delete(imageId);
    }
  }

  for (const message of messages) toast(message, 'info', 7500);
  $('#btnRelink').classList.toggle('hidden', state.missing.size === 0);
  if (state.missing.size) {
    toast(`有 ${state.missing.size} 张图片需要重新关联原图才能预览与导出。`, 'info', 7500);
  }
  if (fromFile) saveProjectNow(false);
  commit({ dirty: false });

  const active = project.images.find((image) => image.id === state.activeImageId) || project.images[0];
  if (active) {
    state.activeImageId = active.id;
    project.activeImageId = active.id;
    renderVersions();
    try {
      await ensureSession(active.id);
      commit({ dirty: false });
    } catch (error) {
      toast(error.message, 'error', 7000);
    }
  } else {
    renderVersions();
  }
}

// ---------------------------------------------------------------------------
// Re-link flow
// ---------------------------------------------------------------------------

async function startRelinkFlow() {
  if (!state.project) return;

  // First, try to re-use remembered file handles. This runs inside a click
  // handler, which is exactly the user gesture Chrome needs before it will
  // show the "allow access" prompt.
  for (const image of state.project.images) {
    if (state.files.has(image.id)) continue;
    const handle = state.handles.get(image.id) || (await getFileHandle(image.id));
    if (!handle) continue;
    const resolved = await resolveHandle(handle, { interactive: true });
    if (resolved.file) {
      state.files.set(image.id, resolved.file);
      state.handles.set(image.id, handle);
      state.missing.delete(image.id);
      image.status = 'ready';
    }
  }

  let needs = state.project.images.filter((image) => state.missing.has(image.id) || !state.files.has(image.id));
  if (!needs.length) {
    // Everything resolved through remembered handles.
    $('#btnRelink').classList.add('hidden');
    renderFilmstrip();
    const active = activeImage();
    if (active) {
      try {
        await ensureSession(active.id, { interactive: true });
        commit();
      } catch (error) {
        toast(error.message, 'error');
      }
    }
    toast('已重新获得原图访问权限。', 'ok');
    return;
  }

  const dialog = $('#relinkDialog');
  const list = $('#relinkList');
  const matchedNames = new Map();

  const paint = () => {
    list.innerHTML = '';
    for (const image of needs) {
      const matched = matchedNames.get(image.id);
      list.append(
        h('li', {},
          h('span', {}, image.fileRef.name),
          h('span', { class: matched ? '' : 'muted' },
            matched
              ? `已匹配 ${matched}`
              : `${(image.fileRef.size / 1024).toFixed(0)} KB · 待选择`))
      );
    }
  };
  paint();

  const pickAndMatch = async () => {
    const picked = await pickImageFiles({ multiple: true });
    if (!picked.length) return;
    const { matches, unmatchedFiles } = matchFilesToImages(
      needs.map((record) => ({ record, needsRelink: true })),
      picked
    );
    if (!matches.size) {
      toast('没有按「文件名 + 大小」匹配到原图。可以把这些文件作为新图片导入。', 'error', 7000);
      return;
    }
    for (const [imageId, entry] of matches) {
      const image = imageById(imageId);
      if (!image) continue;
      state.files.set(imageId, entry.file);
      if (entry.handle) {
        state.handles.set(imageId, entry.handle);
        await putFileHandle(imageId, entry.handle);
      }
      image.status = 'ready';
      state.missing.delete(imageId);
      matchedNames.set(imageId, entry.file.name);
    }
    paint();
    if (unmatchedFiles.length) {
      await addFiles(unmatchedFiles, { selectFirst: false });
    }
    const remaining = needs.filter((image) => state.missing.has(image.id));
    $('#btnRelink').classList.toggle('hidden', state.missing.size === 0);
    if (!remaining.length) {
      dialog.close();
      toast('所有图片已重新关联，可以继续调整和导出。', 'ok');
    } else {
      toast(`还有 ${remaining.length} 张图片未匹配，可再选择一次。`, 'info');
    }
    const active = activeImage();
    if (active) {
      try {
        // This click is a user gesture: allow Chrome to show its permission
        // prompt for a persisted file handle.
        await ensureSession(active.id, { interactive: true });
        commit();
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  };

  $('#btnRelinkPick').onclick = pickAndMatch;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

async function loadSamples() {
  try {
    const files = await loadAllSamples();
    const result = await addFiles(files, { selectFirst: true });
    if (result.added.length) {
      toast(`已载入 ${result.added.length} 张样例图片，可直接调整参数对比效果。`, 'ok');
    }
  } catch (error) {
    toast(error.message, 'error', 9000);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function syncViewButtons() {
  for (const seg of $$('.seg[data-view]')) seg.classList.toggle('active', seg.dataset.view === state.view);
}

function wireEvents() {
  $('#btnImport').addEventListener('click', importImages);
  $('#btnImportEmpty').addEventListener('click', importImages);
  $('#btnSamples').addEventListener('click', loadSamples);
  $('#btnSamplesEmpty').addEventListener('click', loadSamples);
  $('#btnRelink').addEventListener('click', startRelinkFlow);
  $('#btnSaveProject').addEventListener('click', () => saveProjectNow(true));
  $('#btnExportProject').addEventListener('click', exportProjectFile);
  $('#btnImportProject').addEventListener('click', importProjectFile);
  $('#btnExportAll').addEventListener('click', exportAll);
  $('#btnExportCurrent').addEventListener('click', exportCurrent);

  $('#btnCopyToSelected').addEventListener('click', copyCurrentAdjustmentsToSelected);
  $('#btnRestoreBatch').addEventListener('click', restoreBatchForActive);
  $('#btnSelectAll').addEventListener('click', () => {
    if (!state.project) return;
    if (state.selection.size === state.project.images.length) state.selection.clear();
    else state.selection = new Set(state.project.images.map((image) => image.id));
    renderFilmstrip();
  });

  for (const seg of $$('.seg[data-view]')) {
    seg.addEventListener('click', () => {
      state.view = seg.dataset.view;
      syncViewButtons();
      if (state.view === 'compare' && !state.compare.length) {
        const image = activeImage();
        const last = image?.versions[image.versions.length - 1];
        if (last) state.compare = [last.id];
      }
      drawAll();
    });
  }

  // Hold to view the unadjusted original.
  const originalBtn = $('#btnOriginal');
  const setOriginal = (on) => {
    if (state.showAdjusted === !on) return;
    state.showAdjusted = !on;
    scheduleRender();
  };
  originalBtn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    setOriginal(true);
  });
  originalBtn.addEventListener('pointerup', () => setOriginal(false));
  originalBtn.addEventListener('pointerleave', () => setOriginal(false));
  originalBtn.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.key === 'Enter') setOriginal(true);
  });
  originalBtn.addEventListener('keyup', () => setOriginal(false));

  $('#btnZoomIn').addEventListener('click', () => setZoom('in'));
  $('#btnZoomOut').addEventListener('click', () => setZoom('out'));
  $('#btnZoomFit').addEventListener('click', () => setZoom(VIEW_FIT));
  $('#btnZoomActual').addEventListener('click', () => setZoom('actual'));
  for (const tab of $$('.curve-tab')) {
    tab.addEventListener('click', () => {
      state.channel = tab.dataset.channel;
      state.selectedPoint = 0;
      for (const other of $$('.curve-tab')) other.classList.toggle('active', other === tab);
      renderCurveEditor();
      updatePointEditor();
    });
  }

  const svg = $('#curveSvg');
  svg.addEventListener('dblclick', (event) => {
    if (!activeImage()) return;
    const { x, y } = curveCoordsFromEvent(svg, event);
    applyCurveEdit((points) => addCurvePoint(points, x, y, `色调曲线（${channelLabel()}）`));
  });

  $('#pointSelect').addEventListener('change', (event) => {
    state.selectedPoint = Number(event.target.value);
    updatePointEditor();
    renderCurveEditor();
  });

  const commitPointField = (field, inputSel) => {
    const image = activeImage();
    if (!image) return;
    const raw = $(inputSel).value.trim();
    const value = raw === '' ? Number.NaN : Number(raw);
    const points = image.adjustments.toneCurve[state.channel];
    const current = points[state.selectedPoint];
    if (!current) return;
    const ok = applyCurveEdit((pts) =>
      moveCurvePoint(
        pts,
        state.selectedPoint,
        field === 'x' ? value : current[0],
        field === 'y' ? value : current[1],
        `色调曲线（${channelLabel()}）`
      )
    );
    if (!ok) {
      // Keep the last valid value visible even though the input has focus.
      $(inputSel).value = (field === 'x' ? current[0] : current[1]).toFixed(3);
      updatePointEditor();
    }
  };

  $('#pointX').addEventListener('change', () => commitPointField('x', '#pointX'));
  $('#pointY').addEventListener('change', () => commitPointField('y', '#pointY'));
  for (const sel of ['#pointX', '#pointY']) {
    $(sel).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        $(sel).blur();
      }
    });
  }

  $('#btnRemovePoint').addEventListener('click', () => {
    applyCurveEdit((points) => removeCurvePoint(points, state.selectedPoint, `色调曲线（${channelLabel()}）`));
  });

  $('#btnSaveVersion').addEventListener('click', () => saveVersionFrom(activeImage()?.adjustments));
  $('#btnClearCompare').addEventListener('click', () => {
    state.compare = [];
    state.showCurrentInCompare = true;
    $('#showCurrentInCompare').checked = true;
    drawAll();
  });
  $('#showCurrentInCompare').addEventListener('change', (event) => {
    state.showCurrentInCompare = event.target.checked;
    drawAll();
  });

  for (const btn of $$('[data-restore]')) {
    btn.addEventListener('click', () => restoreGroup(btn.dataset.restore));
  }

  $('#btnResetAll').addEventListener('click', () => {
    const image = activeImage();
    if (!image) return;
    image.adjustments = defaultAdjustments();
    state.lastValid = { exposure: 0, temperature: 0, tint: 0, saturation: 0 };
    recordFineTuneIfNeeded(image, '*');
    commit();
    toast('已重置所有参数。', 'ok');
  });

  bindSliders();

  $('#exportQuality').addEventListener('change', () => {
    const value = Number($('#exportQuality').value);
    if (!Number.isFinite(value) || value < 40 || value > 100) {
      $('#exportQuality').value = '92';
      toast('导出质量需在 40–100 之间，已恢复为 92。', 'error');
    }
  });

  window.addEventListener('resize', () => {
    if (state.view === 'single') applySingleTransform();
    else syncCompareTransforms();
  });

  window.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement;
    if (typing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveProjectNow(true);
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedPoint > 0) {
      event.preventDefault();
      applyCurveEdit((points) => removeCurvePoint(points, state.selectedPoint, `色调曲线（${channelLabel()}）`));
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.project) return;
    const result = saveProjectToStorage(state.project);
    if (!result.ok) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  $('#projectName').addEventListener('change', () => {
    if (!state.project) return;
    const name = $('#projectName').value.trim() || '未命名项目';
    state.project.name = name.slice(0, 80);
    $('#projectName').value = state.project.name;
    markDirty();
  });

  attachSinglePan();
}

async function importImages() {
  const picked = await pickImageFiles({ multiple: true });
  if (!picked.length) return;
  await addFiles(picked);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  wireEvents();
  const { project, messages } = readProjectFromStorage();
  if (project) {
    withToasts(messages);
    await adoptProject(project);
    if (project.images.length) setSaveState('saved', `已恢复上次项目 · ${formatTime(new Date())}`);
    else toast('已恢复上次的项目（暂无图片）。', 'info');
  } else {
    withToasts(messages);
    state.project = createProject();
    $('#projectName').value = state.project.name;
    commit({ dirty: false });
  }
}

function withToasts(messages = []) {
  for (const message of messages) toast(message, 'info', 7500);
}

boot().catch((error) => {
  console.error(error);
  toast(`启动失败：${error.message}`, 'error', 10000);
});
