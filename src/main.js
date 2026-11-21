/** 主界面：状态、交互、Worker 调度、指标展示与导出。 */

import {
  PALETTE_PRESETS,
  generatePaletteFromModel,
  createSourceModel,
  addImageToModel,
} from './palette.js';
import { DITHER_MODES, ditherModeInfo, imageTransparencyStats, quantizeImage } from './quantize.js';
import { computeMetrics, computeSSIM } from './metrics.js';
import { parsePaletteText, rgbToHex, dedupePalette } from './color.js';
import {
  DEFAULT_SETTINGS,
  DEFAULT_PREVIEW,
  BUILTIN_PRESETS,
  normalizeSettings,
  normalizePreview,
  mergeSettings,
  paletteHash,
  serializeProject,
  deserializeProject,
  loadStoredPresets,
  saveStoredPresets,
  paletteTextFromId,
  fixedPaletteFromSettings,
} from './state.js';
import { PreviewRenderer } from './renderer.js';
import { decodeImageFile } from './png-browser.js';
import { encodeRgbaPng } from './png.js';
import { SAMPLE_DEFINITIONS, sampleManifest } from './samples.js';
import {
  encodeResult,
  OUTPUT_FORMATS,
  outputFormatInfo,
  exportFilename,
  paletteToGpl,
  paletteToAct,
  paletteToHexText,
  paletteToJson,
  metricsToCsv,
  paletteFilename,
} from './exporters.js';
import { createZip } from './zip.js';
import {
  downloadBytes,
  formatBytes,
  formatPercent,
  debounce,
  sanitizeFilename,
  dataUrlToBytes,
  bytesToDataUrl,
  textBytes,
  uid,
  clamp,
} from './utils.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  fileInput: $('#fileInput'),
  sampleRow: $('#sampleRow'),
  dropZone: $('#dropZone'),
  imageList: $('#imageList'),
  imageCount: $('#imageCount'),
  clearImages: $('#clearImages'),

  scopeTabs: $$('.scope-tab'),
  scopeNote: $('#scopeNote'),
  colorCount: $('#colorCount'),
  colorCountValue: $('#colorCountValue'),
  paletteSource: $('#paletteSource'),
  paletteMethod: $('#paletteMethod'),
  fixedPaletteSection: $('#fixedPaletteSection'),
  fixedPalettePreset: $('#fixedPalettePreset'),
  fixedPaletteText: $('#fixedPaletteText'),
  fixedPaletteSwatches: $('#fixedPaletteSwatches'),
  fixedPaletteCount: $('#fixedPaletteCount'),
  applyPaletteToAll: $('#applyPaletteToAll'),
  generateBatch: $('#generateBatch'),
  batchPaletteStatus: $('#batchPaletteStatus'),
  batchPaletteSwatches: $('#batchPaletteSwatches'),
  batchPaletteActions: $('#batchPaletteActions'),
  batchPaletteUse: $('#batchPaletteUse'),
  batchPaletteExportGpl: $('#batchPaletteExportGpl'),

  dither: $('#dither'),
  ditherHelp: $('#ditherHelp'),
  strength: $('#strength'),
  strengthValue: $('#strengthValue'),
  serpentine: $('#serpentine'),
  distance: $('#distance'),
  perceptual: $('#perceptual'),
  alphaCutoff: $('#alphaCutoff'),
  alphaCutoffValue: $('#alphaCutoffValue'),
  alphaMode: $('#alphaMode'),

  presetSelect: $('#presetSelect'),
  applyPreset: $('#applyPreset'),
  savePreset: $('#savePreset'),
  deletePreset: $('#deletePreset'),
  presetName: $('#presetName'),

  previewCanvas: $('#previewCanvas'),
  previewWrap: $('#previewWrap'),
  previewViewport: $('#previewViewport'),
  gridOverlay: $('#gridOverlay'),
  splitHandle: $('#splitHandle'),
  emptyState: $('#emptyState'),
  previewImageName: $('#previewImageName'),
  previewMeta: $('#previewMeta'),

  modeButtons: $$('.seg-btn[data-mode]'),
  bgButtons: $$('.seg-btn[data-bg]'),
  pixelGridToggle: $('#pixelGridToggle'),
  zoomIn: $('#zoomIn'),
  zoomOut: $('#zoomOut'),
  zoomActual: $('#zoomActual'),
  zoomFit: $('#zoomFit'),
  zoomValue: $('#zoomValue'),

  statColors: $('#statColors'),
  statPaletteColors: $('#statPaletteColors'),
  statFileSize: $('#statFileSize'),
  statOriginalSize: $('#statOriginalSize'),
  statMae: $('#statMae'),
  statPsnr: $('#statPsnr'),
  statDeltaE: $('#statDeltaE'),
  statSsim: $('#statSsim'),
  statTransparent: $('#statTransparent'),
  statTime: $('#statTime'),
  metricsTable: $('#metricsTable'),
  metricDetailToggle: $('#metricDetailToggle'),
  metricDetails: $('#metricDetails'),
  paletteList: $('#paletteList'),
  paletteExportFormat: $('#paletteExportFormat'),
  exportPalette: $('#exportPalette'),

  hoverInfo: $('#hoverInfo'),
  hoverSwatch: $('#hoverSwatch'),
  hoverCoords: $('#hoverCoords'),
  hoverValues: $('#hoverValues'),

  outputFormat: $('#outputFormat'),
  exportCurrent: $('#exportCurrent'),
  exportAll: $('#exportAll'),
  exportCsv: $('#exportCsv'),
  exportProject: $('#exportProject'),
  openProject: $('#openProject'),
  projectInput: $('#projectInput'),
  projectName: $('#projectName'),
  newProject: $('#newProject'),

  toast: $('#toast'),
  busy: $('#busy'),
  busyText: $('#busyText'),
};

const state = {
  project: null,
  activeId: null,
  selection: new Set(),
  scope: 'group',
  results: new Map(),
  paletteCache: new Map(),
  renderToken: 0,
  emptyPaletteWarned: false,
  dirty: false,
};

const renderer = new PreviewRenderer({
  canvas: els.previewCanvas,
  wrap: els.previewWrap,
  gridOverlay: els.gridOverlay,
  splitHandle: els.splitHandle,
  emptyState: els.emptyState,
});

/* ------------------------------------------------------------------ */
/* Worker 管理                                                         */
/* ------------------------------------------------------------------ */

/** 与 src/worker.js 的 MAX_PIXELS 保持一致。 */
const MAX_WORKER_PIXELS = 24_000_000;

const workerBridge = {
  worker: null,
  ready: false,
  seq: 0,
  pending: new Map(),
  registered: new Set(),

  init() {
    try {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event) => this.onMessage(event.data);
      this.worker.onerror = (event) => {
        console.warn('Worker 不可用，改用主线程处理：', event.message || event);
        this.ready = false;
        this.failAll(new Error('Worker 错误，已切换到主线程'));
      };
      this.ready = true;
    } catch (err) {
      console.warn('无法创建 Worker，使用主线程', err);
      this.ready = false;
    }
  },

  onMessage(msg) {
    if (msg.type === 'error') {
      const entry = msg.requestId ? this.pending.get(msg.requestId) : null;
      if (entry) {
        this.pending.delete(msg.requestId);
        entry.reject(new Error(msg.message));
      } else {
        showToast(`处理失败：${msg.message}`, 'error');
      }
      return;
    }
    if (!msg.requestId) return;
    const entry = this.pending.get(msg.requestId);
    if (!entry) return;
    this.pending.delete(msg.requestId);
    entry.resolve(msg);
  },

  failAll(error) {
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
    this.registered.clear();
  },

  register(image) {
    if (!this.ready || !image.rgba) return;
    if (this.registered.has(image.id)) return;
    // 超过 Worker 上限的图只在主线程处理，避免每次预览都让 Worker 抛错再回退。
    if (image.width * image.height > MAX_WORKER_PIXELS) {
      console.info(`「${image.name}」超过 Worker 处理上限，将在主线程处理`);
      return;
    }
    const copy = new Uint8ClampedArray(image.rgba);
    this.worker.postMessage(
      {
        type: 'register',
        image: { id: image.id, width: image.width, height: image.height, rgba: copy },
      },
      [copy.buffer],
    );
    this.registered.add(image.id);
  },

  unregister(ids) {
    if (!this.ready) return;
    this.worker.postMessage({ type: 'unregister', ids });
    for (const id of ids) this.registered.delete(id);
  },

  clear() {
    if (!this.ready) return;
    this.worker.postMessage({ type: 'clear' });
    this.registered.clear();
  },

  process(image, spec) {
    if (!this.ready) return Promise.reject(new Error('Worker 不可用'));
    const requestId = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ type: 'process', requestId, imageId: image.id, spec });
    });
  },
};

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

function init() {
  buildOptions();
  bindEvents();
  workerBridge.init();
  createNewProject();
  loadSampleChips();

  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => renderer.draw());
    ro.observe(els.previewViewport);
    ro.observe(els.previewWrap);
  }
}

function buildOptions() {
  els.dither.innerHTML = DITHER_MODES.map(
    (m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`,
  ).join('');
  els.paletteSource.innerHTML = [
    ['auto', '自动生成（每张图各自一版）'],
    ['fixed', '固定调色板（全组一致）'],
    ['batch', '整组共享调色板（从整组图片提取）'],
  ]
    .map(([v, t]) => `<option value="${v}">${t}</option>`)
    .join('');
  els.outputFormat.innerHTML = OUTPUT_FORMATS.map(
    (f) => `<option value="${f.id}">${escapeHtml(f.name)}</option>`,
  ).join('');
  els.fixedPalettePreset.innerHTML =
    '<option value="custom">自定义</option>' +
    PALETTE_PRESETS.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}（${p.colors.length} 色）</option>`).join('');
  els.alphaMode.innerHTML = [
    ['binary', '二值化（阈值切分）'],
    ['preserve', '保留原始 alpha'],
  ]
    .map(([v, t]) => `<option value="${v}">${t}</option>`)
    .join('');
  buildPresetOptions();
}

function buildPresetOptions() {
  const stored = loadStoredPresets();
  const selected = els.presetSelect.value;
  els.presetSelect.innerHTML =
    '<option value="">— 选择预设 —</option>' +
    '<optgroup label="内置">' +
    BUILTIN_PRESETS.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('') +
    '</optgroup>' +
    (stored.length
      ? '<optgroup label="我的预设">' +
        stored.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('') +
        '</optgroup>'
      : '');
  if (selected) els.presetSelect.value = selected;
  // 内置预设不可删除，只有选中的自定义预设可以删。
  els.deletePreset.disabled = !stored.some((p) => p.id === els.presetSelect.value);
}

/* ------------------------------------------------------------------ */
/* 工程与图片                                                          */
/* ------------------------------------------------------------------ */

function createNewProject() {
  state.results.clear();
  state.paletteCache.clear();
  state.selection.clear();
  state.activeId = null;
  state.scope = 'group';
  state.emptyPaletteWarned = false;
  state.dirty = false;
  state.project = {
    id: uid('proj'),
    name: '未命名工程',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: normalizeSettings(DEFAULT_SETTINGS),
    preview: normalizePreview(DEFAULT_PREVIEW),
    images: [],
    batchPalette: null,
    batchPaletteHash: null,
    presets: loadStoredPresets(),
  };
  workerBridge.clear();
  els.projectName.value = state.project.name;
  syncControls();
  renderImageList();
  renderer.setImage(null);
  renderStats(null, null);
  renderPaletteList(null, null);
  renderBatchPalette();
  els.previewImageName.textContent = '尚未选择图片';
  els.previewMeta.textContent = '拖入图片、粘贴截图，或点击左侧示例';
  applyPreviewView();
}

function activeImage() {
  return state.project.images.find((img) => img.id === state.activeId) || null;
}

/** 整组调色板的取样范围：有勾选就用勾选，否则用全部。 */
function batchSourceIds() {
  return state.selection.size ? [...state.selection] : state.project.images.map((img) => img.id);
}

function settingsFor(image) {
  if (!image) return normalizeSettings(state.project.settings);
  if (image.overrideEnabled && image.overrides) {
    return mergeSettings(state.project.settings, image.overrides);
  }
  return normalizeSettings(state.project.settings);
}

function isEditingImage() {
  return state.scope === 'image' && !!activeImage()?.overrideEnabled;
}

/**
 * 控件当前应该显示/编辑的参数。
 * 作用域是“整组”时，即使当前图片有单独覆盖，控件也必须显示整组参数，
 * 否则用户会误以为在改整组、实际却在改单张。
 */
function controlSettings() {
  if (isEditingImage()) return settingsFor(activeImage());
  return normalizeSettings(state.project.settings);
}

/* ---------------- 载入新文件 ---------------- */

async function addFiles(files) {
  const list = Array.from(files).filter(
    (f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name),
  );
  if (!list.length) {
    showToast('没有可识别的图片文件', 'error');
    return;
  }
  setBusy(true, `正在解码 ${list.length} 张图片…`);
  let firstAdded = null;
  try {
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      els.busyText.textContent = `正在解码 ${file.name}（${i + 1}/${list.length}）`;
      try {
        const decoded = await decodeImageFile(file);
        // 非 PNG 来源统一转成 PNG 存进工程，保证工程文件自洽、可移植。
        const embedBytes =
          decoded.source === 'png'
            ? decoded.bytes
            : await encodeRgbaPng(decoded.rgba, decoded.width, decoded.height);
        const record = {
          id: uid('img'),
          name: file.name,
          width: decoded.width,
          height: decoded.height,
          rgba: decoded.rgba,
          dataUrl: bytesToDataUrl(embedBytes, 'image/png'),
          sourceBytes: decoded.bytes.length,
          sourceInfo: decoded.pngInfo,
          overrideEnabled: false,
          overrides: null,
          paletteSnapshot: null,
        };
        state.project.images.push(record);
        state.selection.add(record.id);
        state.dirty = true;
        workerBridge.register(record);
        if (!firstAdded) firstAdded = record;
      } catch (err) {
        console.error(err);
        showToast(`无法读取 ${file.name}：${err.message}`, 'error');
      }
    }
    renderImageList();
    const target = state.activeId || firstAdded?.id;
    if (target) await selectImage(target, { silent: true });
    await renderNow();
  } finally {
    setBusy(false);
    // 即使中途有失败，也刷新一次列表状态。
    renderImageList();
  }
}

const sampleBytesCache = new Map();

/** 读取示例 PNG：优先用预生成文件，缺失时用 src/samples.js 现场编码。 */
async function resolveSampleBytes(sample) {
  if (sampleBytesCache.has(sample.file)) return sampleBytesCache.get(sample.file);
  let bytes = null;
  try {
    const res = await fetch(`./samples/${sample.file}`, { cache: 'no-cache' });
    if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    bytes = null;
  }
  if (!bytes) {
    const def = SAMPLE_DEFINITIONS.find((d) => d.file === sample.file);
    if (!def) throw new Error(`未知示例 ${sample.file}`);
    const image = def.build();
    bytes = await encodeRgbaPng(image.rgba, image.width, image.height);
  }
  sampleBytesCache.set(sample.file, bytes);
  return bytes;
}

/**
 * 示例素材是生成产物，可能还没被 `npm run generate:samples` 写出。
 * 浏览器端直接用 src/samples.js 现场编码生成缩略图与点击素材，
 * 因此无论静态文件在不在，示例区都能用。
 */
async function loadSampleChips() {
  els.sampleRow.innerHTML = '';
  const manifest = sampleManifest();
  for (const sample of manifest.samples) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sample-chip';
    button.title = `${sample.description}\n推荐：${sample.recommended.colorCount} 色 · ${ditherModeInfo(sample.recommended.dither).name}`;
    button.innerHTML = '<img alt=""><span></span>';
    button.querySelector('span').textContent = sample.name;
    button.addEventListener('click', () => void loadSample(sample));
    els.sampleRow.appendChild(button);
    try {
      const bytes = await resolveSampleBytes(sample);
      button.querySelector('img').src = bytesToDataUrl(bytes, 'image/png');
    } catch (err) {
      console.warn('示例生成失败', sample.file, err);
    }
  }
}

async function loadSample(sample) {
  try {
    const bytes = await resolveSampleBytes(sample);
    const file = new File([bytes], sample.file, { type: 'image/png' });
    await addFiles([file]);
    // 应用推荐参数（addFiles 之后 activeImage 已确定）
    if (sample.recommended) {
      const draft = {
        colorCount: sample.recommended.colorCount,
        dither: sample.recommended.dither,
      };
      if (isEditingImage()) {
        const img = activeImage();
        img.overrides = normalizeSettings({ ...img.overrides, ...draft });
        img.paletteSnapshot = null;
        state.results.delete(img.id);
      } else {
        state.project.settings = normalizeSettings({ ...state.project.settings, ...draft });
        state.paletteCache.clear();
        const img = activeImage();
        if (img) img.paletteSnapshot = null;
      }
      syncControls();
      await renderNow();
    }
    showToast(`已载入「${sample.name}」`);
  } catch (err) {
    showToast(`载入示例失败：${err.message}`, 'error');
  }
}

/* ---------------- 图片列表 ---------------- */

function renderImageList() {
  const images = state.project.images;
  els.imageCount.textContent = `${images.length} 张`;
  els.imageList.innerHTML = '';
  if (!images.length) {
    els.imageList.innerHTML = '<p class="hint">这里会列出已载入的图片。</p>';
    updateSelectionActions();
    return;
  }
  for (const img of images) {
    const item = document.createElement('div');
    item.className = 'image-item';
    item.dataset.id = img.id;
    item.tabIndex = 0;
    if (img.id === state.activeId) item.classList.add('active');
    if (state.selection.has(img.id)) item.classList.add('selected');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'image-check';
    check.checked = state.selection.has(img.id);
    check.title = '选中后参与批量导出与整组调色板';
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => {
      if (check.checked) state.selection.add(img.id);
      else state.selection.delete(img.id);
      item.classList.toggle('selected', check.checked);
      updateSelectionActions();
    });

    const thumb = document.createElement('img');
    thumb.src = img.dataUrl;
    thumb.alt = img.name;
    thumb.loading = 'lazy';

    const meta = document.createElement('div');
    meta.className = 'image-meta';
    const result = state.results.get(img.id);
    const summary = result
      ? `${result.usedColors} 色 · ${formatBytes(result.outputBytes.length)}`
      : '未预览';
    meta.innerHTML = `
      <div class="image-name" title="${escapeHtml(img.name)}">${escapeHtml(img.name)}</div>
      <div class="image-sub">${img.width}×${img.height} · ${summary}</div>
    `;

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'override-badge';
    badge.textContent = img.overrideEnabled ? '单张' : '跟随';
    badge.title = img.overrideEnabled ? '该图使用单独参数，点击恢复跟随整组' : '点击为该图开启单独参数';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleOverride(img, !img.overrideEnabled);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn danger';
    remove.title = '移除';
    remove.textContent = '✕';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      removeImage(img.id);
    });

    item.append(check, thumb, meta, badge, remove);
    item.addEventListener('click', () => selectImage(img.id));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectImage(img.id);
      }
    });
    els.imageList.appendChild(item);
  }
  updateSelectionActions();
}

function updateSelectionActions() {
  const hasImages = state.project.images.length > 0;
  els.clearImages.disabled = !hasImages;
  // 没有勾选时批量操作作用于全部图片，因此只要还有图片就应可用。
  els.exportAll.disabled = !hasImages;
  els.generateBatch.disabled = !hasImages;
  els.exportCsv.disabled = state.results.size === 0;
}

function toggleOverride(image, enabled) {
  image.overrideEnabled = enabled;
  image.paletteSnapshot = null;
  state.results.delete(image.id);
  image.overrides = enabled ? normalizeSettings(state.project.settings) : null;
  // 只有切换的是当前图片时才改变作用域，避免“点了列表里的别的图，
  // 右侧控件却悄悄切到单张模式”。
  if (image.id === state.activeId) {
    state.scope = enabled ? 'image' : 'group';
  }
  state.dirty = true;
  showToast(enabled ? `「${image.name}」已改为单独调整` : `「${image.name}」恢复跟随整组参数`);
  syncControls();
  renderImageList();
  scheduleRender();
}

function removeImage(id) {
  const index = state.project.images.findIndex((i) => i.id === id);
  if (index < 0) return;
  const [removed] = state.project.images.splice(index, 1);
  state.selection.delete(id);
  state.results.delete(id);
  state.dirty = true;
  workerBridge.unregister([id]);
  if (state.activeId === id) {
    const next = state.project.images[Math.min(index, state.project.images.length - 1)] || null;
    state.activeId = next ? next.id : null;
    if (next) {
      void selectImage(next.id, { silent: true }).then(() => scheduleRender());
    } else {
      renderer.setImage(null);
      renderStats(null, null);
      renderPaletteList(null, null);
      els.previewImageName.textContent = '尚未选择图片';
      els.previewMeta.textContent = '';
      state.scope = 'group';
      syncControls();
    }
  }
  renderImageList();
  showToast(`已移除「${removed.name}」`);
}

async function selectImage(id, { silent = false } = {}) {
  const image = state.project.images.find((i) => i.id === id);
  if (!image) return;
  state.activeId = id;
  // 选择图片 ≠ 勾选批量：批量选择只通过列表里的复选框改变。

  if (!image.rgba) {
    try {
      const decoded = await decodeImageFile(
        new File([dataUrlToBytes(image.dataUrl)], image.name, { type: 'image/png' }),
      );
      image.rgba = decoded.rgba;
      image.width = decoded.width;
      image.height = decoded.height;
      workerBridge.register(image);
    } catch (err) {
      console.error(err);
      showToast(`无法解码「${image.name}」：${err.message}`, 'error');
      return;
    }
  }

  if (image.overrideEnabled) state.scope = 'image';
  else if (state.scope === 'image') state.scope = 'group';
  syncControls();
  renderImageList();
  const result = state.results.get(id) || null;
  renderer.setImage({
    key: image.id,
    width: image.width,
    height: image.height,
    originalRGBA: image.rgba,
    resultRGBA: result ? result.rgba : null,
    alphaCutoff: settingsFor(image).alphaCutoff,
  });
  applyPreviewView();
  els.previewImageName.textContent = image.name;
  els.previewMeta.textContent = `${image.width}×${image.height} · 源文件 ${formatBytes(image.sourceBytes || 0)}`;
  renderStats(result, image);
  renderPaletteList(result ? result.palette : null, result);
  if (!silent) scheduleRender();
}

/* ------------------------------------------------------------------ */
/* 控件同步与提交                                                      */
/* ------------------------------------------------------------------ */

function syncControls() {
  const image = activeImage();
  const settings = controlSettings();
  const imageScoped = isEditingImage();

  for (const tab of els.scopeTabs) {
    const scope = tab.dataset.scope;
    tab.classList.toggle('active', scope === (imageScoped ? 'image' : 'group'));
    tab.disabled = scope === 'image' && !image;
  }
  els.scopeNote.textContent = imageScoped
    ? `正在单独调整「${image.name}」的参数；整组其他图片不受影响。`
    : '正在调整整组参数，所有标记为“跟随”的图片都会应用。';
  els.scopeNote.classList.toggle('image-scope', imageScoped);

  els.colorCount.value = String(settings.colorCount);
  els.colorCountValue.textContent = String(settings.colorCount);
  els.paletteSource.value = settings.paletteSource;
  els.paletteMethod.value = settings.paletteMethod;
  els.dither.value = settings.dither;
  els.strength.value = String(settings.strength);
  els.strengthValue.textContent = formatNumber(settings.strength);
  els.serpentine.checked = settings.serpentine;
  els.distance.value = settings.distance;
  els.perceptual.checked = settings.perceptual;
  els.alphaCutoff.value = String(settings.alphaCutoff);
  els.alphaCutoffValue.textContent = String(settings.alphaCutoff);
  els.alphaMode.value = settings.alphaMode;
  els.outputFormat.value = settings.outputFormat;
  if (document.activeElement !== els.fixedPaletteText) {
    els.fixedPaletteText.value = settings.fixedPaletteText;
  }
  els.fixedPalettePreset.value = settings.fixedPalettePreset || 'custom';
  els.serpentine.disabled = ditherModeInfo(settings.dither).kind !== 'diffusion';
  // 固定调色板时色数与自动算法都无效，禁用以免误以为它们仍起作用。
  const fixed = settings.paletteSource === 'fixed';
  els.colorCount.disabled = fixed;
  els.paletteMethod.disabled = fixed;
  updateDitherHelp(settings.dither);
  updateFixedPaletteUi(settings);
  updateBatchPaletteUi(settings);
}

function updateDitherHelp(id) {
  const info = ditherModeInfo(id);
  if (info.kind === 'none') {
    els.ditherHelp.textContent = '取最近的调色板颜色，不引入噪点。线稿与像素画通常选它。';
  } else if (info.kind === 'ordered') {
    els.ditherHelp.textContent = '固定阈值矩阵，网点规则、可复现；三通道共用阈值，避免彩色噪点。';
  } else {
    els.ditherHelp.textContent = '把量化误差按核权重分配给右侧/下方邻居；透明像素不收误差，边缘处权重归一化。';
  }
}

function updateFixedPaletteUi(settings) {
  const show = settings.paletteSource === 'fixed';
  els.fixedPaletteSection.hidden = !show;
  if (!show) return;
  const colors = dedupePalette(parsePaletteText(els.fixedPaletteText.value));
  els.fixedPaletteCount.textContent = `${colors.length} 色`;
  if (colors.length) {
    renderSwatches(els.fixedPaletteSwatches, colors);
  } else {
    els.fixedPaletteSwatches.innerHTML = '<span class="hint error">没有解析到有效颜色</span>';
  }
}

function updateBatchPaletteUi(settings) {
  const show = settings.paletteSource === 'batch';
  const hasPalette = !!state.project.batchPalette?.length;
  els.generateBatch.hidden = !show;
  els.batchPaletteStatus.hidden = !show;
  els.batchPaletteActions.hidden = !show;
  els.batchPaletteUse.hidden = !show || !hasPalette;
  els.batchPaletteExportGpl.hidden = !show || !hasPalette;
  els.generateBatch.textContent = hasPalette ? '重新生成整组调色板' : '生成整组调色板';
}

/** 不能用 toFixed().replace(/0+$/)：那会把 10 变成 1、把 100 变成 1。 */
function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function readControlsIntoSettings() {
  return normalizeSettings({
    ...controlSettings(),
    colorCount: Number(els.colorCount.value),
    paletteSource: els.paletteSource.value,
    paletteMethod: els.paletteMethod.value,
    dither: els.dither.value,
    strength: Number(els.strength.value),
    serpentine: els.serpentine.checked,
    distance: els.distance.value,
    perceptual: els.perceptual.checked,
    alphaCutoff: Number(els.alphaCutoff.value),
    alphaMode: els.alphaMode.value,
    fixedPalettePreset: els.fixedPalettePreset.value,
    fixedPaletteText: els.fixedPaletteText.value,
    outputFormat: els.outputFormat.value,
  });
}

/**
 * 把当前控件值提交到作用域（整组 / 单张）。
 * 自动调色板与整组调色板会因参数变化而失效，因此清掉相关快照与缓存。
 */
function commitSettings(overrides = {}) {
  const next = normalizeSettings({ ...readControlsIntoSettings(), ...overrides });
  state.dirty = true;
  if (isEditingImage()) {
    const image = activeImage();
    image.overrides = next;
    image.paletteSnapshot = null;
    state.results.delete(image.id);
    scheduleRender();
    return;
  }
  state.project.settings = next;
  for (const img of state.project.images) {
    if (!img.overrideEnabled) {
      img.paletteSnapshot = null;
      state.results.delete(img.id);
    }
  }
  if (state.project.batchPaletteHash) state.project.batchPaletteHash = null;
  state.paletteCache.clear();
  // 整组共享调色板依赖这些参数：直接重新提取，避免先闪一帧旧调色板。
  if (next.paletteSource === 'batch' && state.project.images.length) {
    scheduleBatchRegen();
    return;
  }
  scheduleRender();
}

function bindEvents() {
  els.fileInput.addEventListener('change', (e) => {
    if (e.target.files?.length) void addFiles(e.target.files);
    e.target.value = '';
  });
  els.dropZone.addEventListener('click', () => els.fileInput.click());
  els.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  for (const type of ['dragenter', 'dragover']) {
    els.dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropZone.classList.add('dragging');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    els.dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      if (type === 'dragleave' && e.relatedTarget && els.dropZone.contains(e.relatedTarget)) return;
      els.dropZone.classList.remove('dragging');
    });
  }
  els.dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
  });
  // 页面任意位置的拖放也给到工作区
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (e.target.closest?.('#dropZone')) return;
    e.preventDefault();
    if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length) void addFiles(files);
  });

  els.clearImages.addEventListener('click', () => {
    if (!state.project.images.length) return;
    if (!confirm('移除全部图片？')) return;
    state.project.images = [];
    state.selection.clear();
    state.activeId = null;
    state.results.clear();
    state.paletteCache.clear();
    state.project.batchPalette = null;
    state.project.batchPaletteHash = null;
    state.dirty = true;
    state.scope = 'group';
    workerBridge.clear();
    renderImageList();
    renderer.setImage(null);
    renderStats(null, null);
    renderPaletteList(null, null);
    renderBatchPalette();
    syncControls();
    els.previewImageName.textContent = '尚未选择图片';
    els.previewMeta.textContent = '';
  });

  for (const tab of els.scopeTabs) {
    tab.addEventListener('click', () => {
      const scope = tab.dataset.scope;
      if (scope === 'image' && !activeImage()) return;
      if (scope === 'image') {
        const img = activeImage();
        if (!img.overrideEnabled) {
          img.overrideEnabled = true;
          img.overrides = normalizeSettings(state.project.settings);
          img.paletteSnapshot = null;
          state.results.delete(img.id);
          state.dirty = true;
          renderImageList();
          scheduleRender();
        }
      }
      state.scope = scope;
      syncControls();
    });
  }

  const applyInput = debounce(() => {
    commitSettings();
    syncControls();
  }, 170);

  els.colorCount.addEventListener('input', () => {
    els.colorCountValue.textContent = els.colorCount.value;
    applyInput();
  });
  els.strength.addEventListener('input', () => {
    els.strengthValue.textContent = formatNumber(els.strength.value);
    applyInput();
  });
  els.alphaCutoff.addEventListener('input', () => {
    els.alphaCutoffValue.textContent = els.alphaCutoff.value;
    applyInput();
  });
  els.paletteSource.addEventListener('change', () => {
    const value = els.paletteSource.value;
    const overrides = { paletteSource: value };
    if (value === 'fixed' && !els.fixedPaletteText.value.trim()) {
      const preset = els.fixedPalettePreset.value;
      const text = paletteTextFromId(preset === 'custom' ? 'gameboy' : preset);
      if (preset === 'custom') els.fixedPalettePreset.value = 'gameboy';
      els.fixedPaletteText.value = text;
      overrides.fixedPaletteText = text;
      overrides.fixedPalettePreset = els.fixedPalettePreset.value;
    }
    commitSettings(overrides);
    syncControls();
  });
  els.paletteMethod.addEventListener('change', () =>
    commitSettings({ paletteMethod: els.paletteMethod.value }),
  );
  els.dither.addEventListener('change', () => {
    updateDitherHelp(els.dither.value);
    els.serpentine.disabled = ditherModeInfo(els.dither.value).kind !== 'diffusion';
    commitSettings({ dither: els.dither.value });
  });
  els.serpentine.addEventListener('change', () => commitSettings({ serpentine: els.serpentine.checked }));
  els.distance.addEventListener('change', () => commitSettings({ distance: els.distance.value }));
  els.perceptual.addEventListener('change', () => commitSettings({ perceptual: els.perceptual.checked }));
  els.alphaMode.addEventListener('change', () => commitSettings({ alphaMode: els.alphaMode.value }));
  els.outputFormat.addEventListener('change', () => commitSettings({ outputFormat: els.outputFormat.value }));

  els.fixedPalettePreset.addEventListener('change', () => {
    if (els.fixedPalettePreset.value === 'custom') return;
    const text = paletteTextFromId(els.fixedPalettePreset.value);
    els.fixedPaletteText.value = text;
    commitSettings({ fixedPalettePreset: els.fixedPalettePreset.value, fixedPaletteText: text });
    updateFixedPaletteUi(readControlsIntoSettings());
  });
  const paletteTyping = debounce(() => {
    commitSettings({ fixedPalettePreset: 'custom' });
    updateFixedPaletteUi(readControlsIntoSettings());
  }, 300);
  els.fixedPaletteText.addEventListener('input', paletteTyping);

  els.applyPaletteToAll.addEventListener('click', () => {
    const settings = readControlsIntoSettings();
    const colors = fixedPaletteFromSettings(settings);
    if (!colors.length) {
      showToast('固定调色板为空', 'error');
      return;
    }
    // 作用在整组参数上，并为所有单独调整的图片写入相同的固定调色板。
    state.project.settings = normalizeSettings({
      ...state.project.settings,
      paletteSource: 'fixed',
      fixedPalettePreset: settings.fixedPalettePreset,
      fixedPaletteText: settings.fixedPaletteText,
    });
    for (const img of state.project.images) {
      if (img.overrideEnabled) {
        img.overrides = normalizeSettings({
          ...img.overrides,
          paletteSource: 'fixed',
          fixedPalettePreset: settings.fixedPalettePreset,
          fixedPaletteText: settings.fixedPaletteText,
        });
      }
      img.paletteSnapshot = null;
      state.results.delete(img.id);
    }
    state.scope = 'group';
    state.dirty = true;
    syncControls();
    scheduleRender();
    showToast(`已把 ${colors.length} 色固定调色板应用到整组（包含单张设置）`);
  });

  els.generateBatch.addEventListener('click', () => void generateBatchPalette());
  els.batchPaletteUse.addEventListener('click', () => {
    if (!state.project.batchPalette) return;
    commitSettings({ paletteSource: 'batch' });
    syncControls();
    showToast(`已切换到整组共享调色板（${state.project.batchPalette.length} 色）`);
  });
  els.batchPaletteExportGpl.addEventListener('click', () => {
    if (!state.project.batchPalette) return;
    downloadBytes(
      paletteToGpl(state.project.batchPalette, 'Batch Palette'),
      paletteFilename('batch', 'gpl'),
      'text/plain',
    );
    showToast('已导出 GPL 调色板');
  });

  els.applyPreset.addEventListener('click', () => applyPreset(els.presetSelect.value));
  els.presetSelect.addEventListener('change', () => {
    els.deletePreset.disabled = !loadStoredPresets().some((p) => p.id === els.presetSelect.value);
  });
  els.savePreset.addEventListener('click', () => saveCurrentPreset());
  els.deletePreset.addEventListener('click', () => deleteSelectedPreset());

  for (const btn of els.modeButtons) {
    btn.addEventListener('click', () => {
      els.modeButtons.forEach((b) => b.classList.toggle('active', b === btn));
      state.project.preview.mode = btn.dataset.mode;
      renderer.setView({ mode: btn.dataset.mode });
    });
  }
  for (const btn of els.bgButtons) {
    btn.addEventListener('click', () => {
      els.bgButtons.forEach((b) => b.classList.toggle('active', b === btn));
      state.project.preview.background = btn.dataset.bg;
      renderer.setView({ background: btn.dataset.bg });
    });
  }
  els.pixelGridToggle.addEventListener('change', () => {
    state.project.preview.pixelGrid = els.pixelGridToggle.checked;
    renderer.setView({ pixelGrid: els.pixelGridToggle.checked });
  });
  els.zoomIn.addEventListener('click', () => setZoom(renderer.view.zoom * 2));
  els.zoomOut.addEventListener('click', () => setZoom(renderer.view.zoom / 2));
  els.zoomActual.addEventListener('click', () => setZoom(1));
  els.zoomFit.addEventListener('click', () => setZoom(renderer.computeFitZoom(els.previewViewport)));

  bindSplitDrag();

  els.previewWrap.addEventListener('pointermove', (e) => {
    const rect = els.previewCanvas.getBoundingClientRect();
    const zoom = renderer.view.zoom;
    const x = Math.floor((e.clientX - rect.left) / zoom);
    const y = Math.floor((e.clientY - rect.top) / zoom);
    const pixel = renderer.pixelAt(x, y);
    if (!pixel) {
      els.hoverInfo.hidden = true;
      return;
    }
    els.hoverInfo.hidden = false;
    const describe = (c) => (c.a === 0 ? '透明' : `${c.r},${c.g},${c.b} · α${c.a}`);
    els.hoverCoords.textContent = `(${x}, ${y})`;
    els.hoverValues.textContent = `原 ${describe(pixel.original)}${
      pixel.result ? `  →  结果 ${describe(pixel.result)}` : ''
    }`;
    els.hoverSwatch.classList.toggle('transparent', pixel.original.a === 0);
    els.hoverSwatch.style.background =
      pixel.original.a === 0
        ? 'transparent'
        : rgbToHex(pixel.original.r, pixel.original.g, pixel.original.b);
  });
  els.previewWrap.addEventListener('pointerleave', () => {
    els.hoverInfo.hidden = true;
  });

  els.metricDetailToggle.addEventListener('click', () => {
    const nextHidden = !els.metricDetails.hidden;
    els.metricDetails.hidden = nextHidden;
    els.metricDetailToggle.textContent = nextHidden ? '展开明细' : '收起明细';
  });

  els.exportCurrent.addEventListener('click', () => void exportCurrent());
  els.exportPalette.addEventListener('click', () => exportCurrentPalette());
  els.exportAll.addEventListener('click', () => void exportAll());
  els.exportCsv.addEventListener('click', () => exportMetricsCsv());
  els.exportProject.addEventListener('click', () => saveProjectFile());
  els.openProject.addEventListener('click', () => els.projectInput.click());
  els.projectInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await openProjectFile(file);
  });
  els.projectName.addEventListener('input', () => {
    state.project.name = els.projectName.value.trim() || '未命名工程';
    state.dirty = true;
  });
  els.newProject.addEventListener('click', () => {
    if (state.project.images.length && !confirm('新建工程会清除当前所有图片，确定吗？')) return;
    createNewProject();
    showToast('已新建工程');
  });

  window.addEventListener('beforeunload', (e) => {
    // 仅在有未保存的图片时提醒；保存工程后不再拦截。
    if (state.project?.images.length && state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function bindSplitDrag() {
  let dragging = false;
  const update = (clientX) => {
    const rect = els.previewWrap.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = clamp((clientX - rect.left) / rect.width, 0.02, 0.98);
    state.project.preview.split = ratio;
    renderer.setView({ split: ratio });
  };
  els.splitHandle.addEventListener('pointerdown', (e) => {
    dragging = true;
    els.splitHandle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.splitHandle.addEventListener('pointermove', (e) => {
    if (dragging) update(e.clientX);
  });
  els.splitHandle.addEventListener('pointerup', (e) => {
    dragging = false;
    if (els.splitHandle.hasPointerCapture?.(e.pointerId)) els.splitHandle.releasePointerCapture(e.pointerId);
  });
  els.previewWrap.addEventListener('pointerdown', (e) => {
    if (renderer.view.mode !== 'split' || e.target === els.splitHandle) return;
    dragging = true;
    els.splitHandle.setPointerCapture?.(e.pointerId);
    update(e.clientX);
  });
  window.addEventListener('pointermove', (e) => {
    if (dragging) update(e.clientX);
  });
  window.addEventListener('pointerup', () => {
    dragging = false;
  });
}

function setZoom(value) {
  const zoom = clamp(value, 0.25, 32);
  state.project.preview.zoom = zoom;
  renderer.setView({ zoom });
  els.zoomValue.textContent = `${formatNumber(zoom)}×`;
}

function applyPreviewView() {
  const preview = normalizePreview(state.project.preview);
  renderer.setView(preview);
  els.modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === preview.mode));
  els.bgButtons.forEach((b) => b.classList.toggle('active', b.dataset.bg === preview.background));
  els.pixelGridToggle.checked = preview.pixelGrid;
  els.zoomValue.textContent = `${formatNumber(preview.zoom)}×`;
}

/* ------------------------------------------------------------------ */
/* 预设                                                                */
/* ------------------------------------------------------------------ */

function applyPreset(id) {
  if (!id) return;
  const preset =
    BUILTIN_PRESETS.find((p) => p.id === id) || loadStoredPresets().find((p) => p.id === id);
  if (!preset) return;
  const base = controlSettings();
  const merged = normalizeSettings({ ...base, ...preset.settings });
  if (isEditingImage()) {
    const image = activeImage();
    image.overrides = merged;
    image.paletteSnapshot = null;
    state.results.delete(image.id);
  } else {
    state.project.settings = merged;
    for (const img of state.project.images) {
      if (!img.overrideEnabled) {
        img.paletteSnapshot = null;
        state.results.delete(img.id);
      }
    }
    state.paletteCache.clear();
  }
  state.dirty = true;
  if (merged.fixedPaletteText) els.fixedPaletteText.value = merged.fixedPaletteText;
  syncControls();
  scheduleRender();
  showToast(`已应用预设「${preset.name}」`);
}

function saveCurrentPreset() {
  const name = (els.presetName.value || '').trim();
  if (!name) {
    showToast('请先给预设起个名字', 'error');
    els.presetName.focus();
    return;
  }
  // 保存的是“控件当前展示的参数”：整组作用域就保存整组参数，单张作用域就保存该图参数。
  const settings = normalizeSettings(readControlsIntoSettings());
  const stored = loadStoredPresets();
  const existing = stored.find((p) => p.name === name);
  if (existing) {
    existing.settings = settings;
    showToast(`已更新预设「${name}」`);
  } else {
    stored.push({
      id: uid('preset'),
      name: name.slice(0, 60),
      builtin: false,
      createdAt: new Date().toISOString(),
      settings,
    });
    showToast(`已保存预设「${name}」`);
  }
  saveStoredPresets(stored);
  els.presetName.value = '';
  buildPresetOptions();
}

function deleteSelectedPreset() {
  const id = els.presetSelect.value;
  if (!id) return;
  const stored = loadStoredPresets();
  if (!stored.some((p) => p.id === id)) {
    showToast('内置预设不能删除', 'error');
    return;
  }
  saveStoredPresets(stored.filter((p) => p.id !== id));
  buildPresetOptions();
  showToast('预设已删除');
}

/* ------------------------------------------------------------------ */
/* 调色板解析                                                          */
/* ------------------------------------------------------------------ */

function resolvePaletteForImage(image, settings) {
  if (settings.paletteSource === 'fixed') {
    const colors = fixedPaletteFromSettings(settings);
    return colors.length ? colors : null;
  }
  if (settings.paletteSource === 'batch') {
    const palette = state.project.batchPalette;
    return palette && palette.length ? palette : null;
  }
  // auto：优先使用调色板快照，保证工程重开后逐像素一致
  const hash = paletteHash(settings, image.id);
  if (image.paletteSnapshot && image.paletteSnapshot.hash === hash) {
    return image.paletteSnapshot.palette;
  }
  const cached = state.paletteCache.get(hash);
  if (cached) return cached;
  const model = createSourceModel();
  const stride = Math.max(1, Math.ceil((image.width * image.height) / 1_500_000));
  addImageToModel(model, image.rgba, settings.alphaCutoff, stride);
  const hasTransparency = imageTransparencyStats(image.rgba, settings.alphaCutoff).transparent > 0;
  const limit = hasTransparency ? Math.min(255, settings.colorCount) : settings.colorCount;
  const palette = generatePaletteFromModel(model, limit, settings.paletteMethod);
  state.paletteCache.set(hash, palette);
  return palette;
}

/* ------------------------------------------------------------------ */
/* 渲染管线                                                            */
/* ------------------------------------------------------------------ */

const scheduleRender = debounce(() => {
  void renderNow();
}, 150);

/** 参数变化时自动重新提取整组调色板；去抖后不弹重复提示。 */
const scheduleBatchRegen = debounce(() => {
  if (controlSettings().paletteSource !== 'batch') return;
  void generateBatchPalette({ quiet: true });
}, 380);

async function renderNow() {
  const image = activeImage();
  if (!image || !image.rgba) return;
  const token = ++state.renderToken;
  const settings = settingsFor(image);
  const palette = resolvePaletteForImage(image, settings);
  if (!palette) {
    els.previewMeta.textContent =
      settings.paletteSource === 'fixed' ? '固定调色板为空' : '尚未生成整组调色板';
    // 避免在输入调色板的过程中反复弹出同一条错误。
    if (settings.paletteSource === 'fixed' && !state.emptyPaletteWarned) {
      state.emptyPaletteWarned = true;
      showToast('固定调色板为空，请检查颜色输入', 'error');
    }
    // 上一次渲染可能已经把 busy 打开；这里提前返回时必须自己关掉。
    if (token === state.renderToken) setBusy(false);
    return;
  }
  state.emptyPaletteWarned = false;
  setBusy(true, '正在生成预览…');
  try {
    const result = await runQuantize(image, settings, palette, token);
    if (!result || token !== state.renderToken) return;
    state.results.set(image.id, result);
    storePaletteSnapshot(image, settings, palette);
    renderer.setImage({
      key: image.id,
      width: image.width,
      height: image.height,
      originalRGBA: image.rgba,
      resultRGBA: result.rgba,
      alphaCutoff: settings.alphaCutoff,
    });
    applyPreviewView();
    renderStats(result, image);
    renderPaletteList(result.palette, result);
    els.previewImageName.textContent = image.name;
    els.previewMeta.textContent = `${image.width}×${image.height} · ${result.usedColors} 色 · ${formatBytes(
      result.outputBytes.length,
    )}`;
    renderImageList();
  } catch (err) {
    console.error(err);
    showToast(`渲染失败：${err.message}`, 'error');
  } finally {
    if (token === state.renderToken) setBusy(false);
  }
}

function storePaletteSnapshot(image, settings, palette) {
  if (settings.paletteSource === 'auto') {
    image.paletteSnapshot = {
      hash: paletteHash(settings, image.id),
      palette: palette.map((c) => ({ r: c.r, g: c.g, b: c.b })),
    };
  } else {
    image.paletteSnapshot = null;
  }
}

/**
 * 运行一次量化。
 * @param {number|null} token 渲染令牌；传 null 表示“不参与取消”（导出用）。
 *   令牌不匹配说明已有更新的渲染在跑，本次结果应丢弃。
 */
async function runQuantize(image, settings, palette, token) {
  const stale = () => token !== null && token !== state.renderToken;
  if (workerBridge.ready && workerBridge.registered.has(image.id)) {
    try {
      const msg = await workerBridge.process(image, {
        palette,
        dither: settings.dither,
        strength: settings.strength,
        serpentine: settings.serpentine,
        alphaCutoff: settings.alphaCutoff,
        alphaMode: settings.alphaMode,
        distance: settings.distance,
        perceptual: settings.perceptual,
        outputFormat: settings.outputFormat,
      });
      if (stale()) return null;
      return { ...msg, settings };
    } catch (err) {
      console.warn('Worker 处理失败，回退主线程：', err);
      workerBridge.ready = false;
    }
  }
  // 主线程兜底：与 Worker 使用同一套函数，结果一致
  const started = performance.now();
  const quantized = quantizeImage(image.rgba, image.width, image.height, { ...settings, palette });
  const metrics = computeMetrics(image.rgba, quantized.rgba, image.width, image.height, {
    alphaCutoff: settings.alphaCutoff,
    alphaMode: settings.alphaMode,
    perceptual: settings.perceptual,
  });
  metrics.ssim = computeSSIM(
    image.rgba,
    quantized.rgba,
    image.width,
    image.height,
    settings.alphaCutoff,
  );
  const outputBytes = await encodeResult(quantized, settings.outputFormat);
  if (stale()) return null;
  return {
    ...quantized,
    metrics,
    outputBytes,
    elapsedMs: performance.now() - started,
    settings,
  };
}

/* ------------------------------------------------------------------ */
/* 整组调色板                                                          */
/* ------------------------------------------------------------------ */

async function generateBatchPalette({ quiet = false } = {}) {
  const ids = batchSourceIds();
  if (!ids.length) {
    if (!quiet) showToast('没有可用的图片', 'error');
    return;
  }
  const settings = controlSettings();
  if (!quiet) setBusy(true, '正在提取整组调色板…');
  try {
    const model = createSourceModel();
    let hasTransparency = false;
    let included = 0;
    for (const id of ids) {
      const image = state.project.images.find((i) => i.id === id);
      if (!image?.rgba) continue;
      included++;
      const stride = Math.max(1, Math.ceil((image.width * image.height) / 1_500_000));
      addImageToModel(model, image.rgba, settings.alphaCutoff, stride);
      if (!hasTransparency) {
        hasTransparency = imageTransparencyStats(image.rgba, settings.alphaCutoff).transparent > 0;
      }
    }
    if (!included) {
      if (!quiet) showToast('选中的图片尚未解码', 'error');
      return;
    }
    const limit = hasTransparency ? Math.min(255, settings.colorCount) : settings.colorCount;
    // 整组调色板本身不含透明项：每张图输出时按自己的透明度决定是否追加透明索引。
    state.project.batchPalette = generatePaletteFromModel(model, limit, settings.paletteMethod).map(
      (c) => ({ r: c.r, g: c.g, b: c.b }),
    );
    state.project.batchPaletteHash = paletteHash(
      { ...settings, paletteSource: 'batch' },
      ids.join(','),
    );
    renderBatchPalette();
    updateBatchPaletteUi(controlSettings());
    if (!quiet) showToast(`已生成 ${state.project.batchPalette.length} 色整组调色板（基于 ${included} 张图）`);
    if (controlSettings().paletteSource === 'batch') scheduleRender();
  } finally {
    if (!quiet) setBusy(false);
  }
}

function renderBatchPalette() {
  const palette = state.project.batchPalette;
  if (!palette || !palette.length) {
    els.batchPaletteStatus.textContent = '尚未生成。选择图片后点击按钮，从整组提取统一调色板。';
    els.batchPaletteSwatches.innerHTML = '';
    return;
  }
  els.batchPaletteStatus.textContent = `${palette.length} 色 · 整组共享`;
  renderSwatches(els.batchPaletteSwatches, palette);
}

function renderSwatches(container, colors) {
  container.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const c of colors.slice(0, 256)) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch';
    sw.style.background = rgbToHex(c.r, c.g, c.b);
    sw.title = `点击复制 ${rgbToHex(c.r, c.g, c.b)}`;
    sw.addEventListener('click', () => {
      navigator.clipboard?.writeText(rgbToHex(c.r, c.g, c.b)).then(
        () => showToast(`已复制 ${rgbToHex(c.r, c.g, c.b)}`),
        () => {},
      );
    });
    fragment.appendChild(sw);
  }
  container.appendChild(fragment);
}

/* ------------------------------------------------------------------ */
/* 指标/调色板面板                                                     */
/* ------------------------------------------------------------------ */

function renderStats(result, image) {
  if (!result) {
    for (const el of [
      els.statColors,
      els.statPaletteColors,
      els.statFileSize,
      els.statOriginalSize,
      els.statMae,
      els.statPsnr,
      els.statDeltaE,
      els.statSsim,
      els.statTransparent,
      els.statTime,
    ]) {
      el.textContent = '—';
    }
    els.metricsTable.innerHTML = '<tr><td colspan="2" class="hint">生成预览后显示指标。</td></tr>';
    els.metricDetails.innerHTML = '';
    els.metricDetailToggle.disabled = true;
    return;
  }
  const m = result.metrics;
  const paletteColors = result.palette.length - (result.hasTransparency ? 1 : 0);
  const originalSize = image?.sourceBytes || 0;
  els.statColors.textContent = `${result.usedColors}`;
  els.statPaletteColors.textContent = `${paletteColors}`;
  els.statFileSize.textContent = formatBytes(result.outputBytes.length);
  els.statOriginalSize.textContent = originalSize
    ? `${formatBytes(originalSize)}${ratioText(result.outputBytes.length, originalSize)}`
    : '—';
  els.statMae.textContent = `${(m.mae * 100).toFixed(2)}%`;
  els.statPsnr.textContent = m.psnr >= 99 ? '∞' : `${m.psnr.toFixed(2)} dB`;
  els.statDeltaE.textContent = m.deltaE76Mean.toFixed(2);
  els.statSsim.textContent = m.ssim == null ? '—' : m.ssim.toFixed(4);
  els.statTransparent.textContent = `${m.transparentPixels}`;
  els.statTime.textContent = `${Math.round(result.elapsedMs || 0)} ms`;

  const rows = [
    ['输出颜色', `${result.usedColors} 种（调色板 ${paletteColors} 色${result.hasTransparency ? ' + 透明索引' : ''}）`],
    ['输出文件', `${formatBytes(result.outputBytes.length)} · ${outputFormatInfo(result.settings.outputFormat).name}`],
    ['源文件体积', originalSize ? `${formatBytes(originalSize)}${ratioText(result.outputBytes.length, originalSize)}` : '—'],
    ['抖动', ditherDescription(result)],
    ['Alpha', result.alphaMode === 'preserve' ? '保留原始 alpha' : `二值化（阈值 ${result.alphaCutoff}）`],
    ['调色板来源', paletteSourceLabel(result.settings.paletteSource)],
    ['MAE', `${(m.mae * 100).toFixed(2)}%（0–255 尺度 ${m.mae255.toFixed(2)}）`],
    ['MSE / RMSE', `${m.mse.toFixed(2)} / ${m.rmse.toFixed(2)}`],
    ['PSNR', m.psnr >= 99 ? '∞（颜色完全一致）' : `${m.psnr.toFixed(2)} dB`],
    ['ΔE76 平均 / 最大', `${m.deltaE76Mean.toFixed(2)} / ${m.deltaE76Max.toFixed(2)}`],
    ['ΔE76 P95 / P99', `${m.p95DeltaE76} / ${m.p99DeltaE76}`],
    ...(m.deltaE2000Mean == null ? [] : [['ΔE2000 平均', m.deltaE2000Mean.toFixed(2)]]),
    ['SSIM', m.ssim == null ? '—（图像超过 4MP，未计算）' : m.ssim.toFixed(5)],
    ['透明像素', `${m.transparentPixels}（不参与颜色误差）`],
    ['透明判定不一致', `${m.alphaMismatchPixels} 像素`],
    ['边缘掩码不一致', `${m.edge.edgeMismatchPixels} / ${m.edge.edgePixels} 边缘像素`],
    ['采样', m.sampleStep > 1 ? `每 ${m.sampleStep} 像素取 1（共 ${m.sampledPixels}）` : `全部 ${m.sampledPixels} 像素`],
  ];
  els.metricsTable.innerHTML = rows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`)
    .join('');
  els.metricDetailToggle.disabled = false;
  renderMetricDetails(result);
  updateStatSignals(result);
}

function ditherDescription(result) {
  const info = ditherModeInfo(result.dither);
  const parts = [info.name];
  if (result.dither !== 'none') parts.push(`强度 ${formatNumber(result.settings.strength)}`);
  if (info.kind === 'diffusion' && result.settings.serpentine) parts.push('蛇形扫描');
  return parts.join(' · ');
}

function renderMetricDetails(result) {
  els.metricDetails.innerHTML = `
    <div class="detail-card">
      <h4>RGB 误差分布（绝对差 / 通道）</h4>
      <canvas data-hist="rgb" width="360" height="92"></canvas>
    </div>
    <div class="detail-card">
      <h4>ΔE76 分布</h4>
      <canvas data-hist="de" width="360" height="92"></canvas>
    </div>
  `;
  const hist = result.metrics.histograms;
  drawHistogram(
    els.metricDetails.querySelector('[data-hist="rgb"]'),
    [
      { data: hist.r, color: '#ff6b6b' },
      { data: hist.g, color: '#51cf66' },
      { data: hist.b, color: '#4dabf7' },
    ],
    32,
  );
  drawHistogram(
    els.metricDetails.querySelector('[data-hist="de"]'),
    [{ data: hist.deltaE, color: '#ffd43b' }],
    32,
  );
}

function drawHistogram(canvas, series, bins) {
  if (!canvas || !series.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, 0, w, h);
  const length = series[0].data.length;
  // 把 0..length-1 的原始分箱聚合到 bins 个可视柱子里。
  const aggregated = series.map((s) => {
    const out = new Array(bins).fill(0);
    for (let i = 0; i < length; i++) {
      const b = Math.min(bins - 1, Math.floor((i * bins) / length));
      out[b] += s.data[i] || 0;
    }
    return out;
  });
  let max = 0;
  for (const data of aggregated) {
    for (let i = 0; i < bins; i++) max = Math.max(max, data[i]);
  }
  if (max <= 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('无色差', 8, h / 2);
    return;
  }
  const bw = w / bins;
  for (let si = 0; si < series.length; si++) {
    ctx.fillStyle = series[si].color;
    ctx.globalAlpha = series.length > 1 ? 0.55 : 0.9;
    const data = aggregated[si];
    for (let i = 0; i < bins; i++) {
      const bh = (data[i] / max) * (h - 14);
      if (bh <= 0) continue;
      ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.6), bh);
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText('0', 2, h - 2);
  ctx.fillText(`${length - 1}+`, w - 24, h - 2);
}

function renderPaletteList(palette, result) {
  if (!palette) {
    els.paletteList.innerHTML = '<span class="hint">生成预览后显示调色板与像素用量。</span>';
    return;
  }
  els.paletteList.innerHTML = '';
  const usage = result?.colorUsage;
  palette.forEach((c, index) => {
    const isTransparent = !!c.transparent;
    const row = document.createElement('div');
    row.className = 'palette-row';
    const sw = document.createElement('span');
    sw.className = 'swatch large';
    if (isTransparent) {
      sw.classList.add('checker');
      sw.title = '透明索引（不会被当成黑色）';
    } else {
      sw.style.background = rgbToHex(c.r, c.g, c.b);
    }
    const code = document.createElement('code');
    code.textContent = isTransparent ? '透明索引' : rgbToHex(c.r, c.g, c.b);
    const count = document.createElement('span');
    count.className = 'palette-count';
    count.textContent = isTransparent ? '' : usage ? `${usage[index]} px` : '';    row.append(sw, code, count);
    row.addEventListener('click', () => {
      if (isTransparent) return;
      navigator.clipboard?.writeText(rgbToHex(c.r, c.g, c.b)).then(
        () => showToast(`已复制 ${rgbToHex(c.r, c.g, c.b)}`),
        () => {},
      );
    });
    els.paletteList.appendChild(row);
  });
}

function updateStatSignals(result) {
  const m = result.metrics;
  els.statPsnr.parentElement?.classList.toggle('warn', m.psnr < 20);
  els.statDeltaE.parentElement?.classList.toggle('warn', m.deltaE76Mean > 8);
  els.statMae.parentElement?.classList.toggle('warn', m.mae > 0.12);
}

function paletteSourceLabel(source) {
  return { auto: '自动生成', fixed: '固定调色板', batch: '整组共享' }[source] || source;
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

async function ensureResult(image) {
  const existing = state.results.get(image.id);
  if (existing) return existing;
  if (!image.rgba) return null;
  const settings = settingsFor(image);
  const palette = resolvePaletteForImage(image, settings);
  if (!palette) return null;
  // token = null：导出不取消正在进行的预览渲染，也不会被它取消。
  const result = await runQuantize(image, settings, palette, null);
  if (result) state.results.set(image.id, result);
  return result;
}

async function exportCurrent() {
  const image = activeImage();
  if (!image) {
    showToast('请先选择一张图片', 'error');
    return;
  }
  setBusy(true, '正在导出…');
  try {
    const result = await ensureResult(image);
    if (!result) {
      showToast('当前没有可导出的结果', 'error');
      return;
    }
    const format = settingsFor(image).outputFormat;
    const bytes = await encodeResult(result, format);
    const filename = exportFilename(image.name, result, format);
    downloadBytes(bytes, filename, outputFormatInfo(format).mime);
    showToast(`已导出 ${filename}（${formatBytes(bytes.length)}）`);
  } catch (err) {
    showToast(`导出失败：${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function exportAll() {
  const ids = batchSourceIds();
  if (!ids.length) return;
  setBusy(true, '正在批量导出…');
  try {
    const entries = [];
    const rows = [];
    for (let i = 0; i < ids.length; i++) {
      const image = state.project.images.find((img) => img.id === ids[i]);
      if (!image) continue;
      els.busyText.textContent = `正在处理 ${image.name}（${i + 1}/${ids.length}）`;
      const result = await ensureResult(image);
      if (!result) continue;
      const settings = settingsFor(image);
      const bytes = await encodeResult(result, settings.outputFormat);
      entries.push({ name: exportFilename(image.name, result, settings.outputFormat), data: bytes });
      rows.push(metricsRow(image, result, bytes.length));
    }
    if (!entries.length) {
      showToast('没有可导出的结果', 'error');
      return;
    }
    entries.push({ name: 'metrics.csv', data: metricsToCsv(rows) });
    const zip = createZip(entries);
    downloadBytes(
      zip,
      `${sanitizeFilename(state.project.name, 'palette-forge')}-export.zip`,
      'application/zip',
    );
    showToast(`已打包 ${entries.length - 1} 张图片与 metrics.csv`);
  } finally {
    setBusy(false);
  }
}

function metricsRow(image, result, bytes) {
  return {
    name: image.name,
    width: image.width,
    height: image.height,
    paletteColors: result.palette.length - (result.hasTransparency ? 1 : 0),
    usedColors: result.usedColors,
    dither: result.dither,
    alphaMode: result.alphaMode,
    fileBytes: bytes,
    originalBytes: image.sourceBytes || '',
    ...result.metrics,
    edgeMismatchPixels: result.metrics.edge?.edgeMismatchPixels ?? '',
  };
}

function exportMetricsCsv() {
  const rows = [];
  for (const image of state.project.images) {
    const result = state.results.get(image.id);
    if (result) rows.push(metricsRow(image, result, result.outputBytes.length));
  }
  if (!rows.length) {
    showToast('还没有可导出的指标，请先生成预览', 'error');
    return;
  }
  downloadBytes(
    metricsToCsv(rows),
    `${sanitizeFilename(state.project.name, 'metrics')}-metrics.csv`,
    'text/csv',
  );
  showToast(`已导出 ${rows.length} 行指标`);
}

function exportCurrentPalette() {
  const image = activeImage();
  const result = image ? state.results.get(image.id) : null;
  const settings = controlSettings();
  let palette = result?.palette?.filter((c) => !c.transparent) || null;
  if (!palette || !palette.length) {
    if (settings.paletteSource === 'fixed') palette = fixedPaletteFromSettings(settings);
    else if (settings.paletteSource === 'batch') palette = state.project.batchPalette;
  }
  if (!palette || !palette.length) {
    showToast('还没有可导出的调色板', 'error');
    return;
  }
  const format = els.paletteExportFormat.value;
  const baseName = paletteFilename(image ? image.name : state.project.name, format);
  const meta = {
    name: image ? image.name : state.project.name,
    source: image ? `${image.width}×${image.height}` : '',
    settings,
  };
  if (format === 'gpl') {
    downloadBytes(paletteToGpl(palette, meta.name), baseName, 'text/plain');
  } else if (format === 'act') {
    downloadBytes(paletteToAct(palette), baseName, 'application/octet-stream');
  } else if (format === 'hex') {
    downloadBytes(paletteToHexText(palette), baseName, 'text/plain');
  } else {
    downloadBytes(paletteToJson(palette, meta), baseName, 'application/json');
  }
  showToast(`已导出 ${palette.length} 色调色板（${format.toUpperCase()}）`);
}

function saveProjectFile() {
  const payload = serializeProject({ ...state.project, presets: loadStoredPresets() }, renderer.view);
  const text = JSON.stringify(payload, null, 2);
  const name = `${sanitizeFilename(state.project.name, 'palette-forge')}.palf.json`;
  downloadBytes(textBytes(text), name, 'application/json');
  state.dirty = false;
  showToast(`工程已保存（${formatBytes(text.length)}）`);
}

async function openProjectFile(file) {
  setBusy(true, '正在打开工程…');
  try {
    const raw = JSON.parse(await file.text());
    const project = deserializeProject(raw);
    await activateProject(project);
    showToast(`已打开工程「${project.name}」（${project.images.length} 张图）`);
  } catch (err) {
    console.error(err);
    showToast(`打开工程失败：${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function activateProject(project) {
  state.results.clear();
  state.paletteCache.clear();
  state.selection.clear();
  state.activeId = null;
  state.scope = 'group';
  workerBridge.clear();
  state.project = project;
  els.projectName.value = project.name;
  state.dirty = false;
  syncStoredPresets(project.presets);

  for (const image of project.images) {
    try {
      const bytes = dataUrlToBytes(image.dataUrl);
      const decoded = await decodeImageFile(new File([bytes], image.name, { type: 'image/png' }));
      image.rgba = decoded.rgba;
      image.width = decoded.width;
      image.height = decoded.height;
      // 工程文件里记录了原始文件体积；缺失时才退回嵌入 PNG 的字节数。
      image.sourceBytes = image.sourceBytes || bytes.length;
      image.sourceInfo = decoded.pngInfo;
      workerBridge.register(image);
    } catch (err) {
      console.warn(`工程图片无法解码：${image.name}`, err);
    }
  }
  state.selection = new Set(project.images.map((i) => i.id));
  renderImageList();
  renderBatchPalette();
  applyPreviewView();

  if (project.images.length) {
    state.activeId = project.images[0].id;
    syncControls();
    await selectImage(project.images[0].id, { silent: true });
    // 用快照调色板渲染当前图，确保预览与保存时逐像素一致；
    // 其余图片在被选中或导出时走同一套快照逻辑。
    await renderNow();
  } else {
    renderer.setImage(null);
    renderStats(null, null);
    renderPaletteList(null, null);
    els.previewImageName.textContent = '尚未选择图片';
  }
}

function syncStoredPresets(presets) {
  if (!Array.isArray(presets) || !presets.length) return;
  const stored = loadStoredPresets();
  const names = new Set(stored.map((p) => p.name));
  let added = 0;
  for (const preset of presets) {
    if (preset?.builtin || names.has(preset?.name)) continue;
    stored.push(preset);
    names.add(preset.name);
    added++;
  }
  if (added) {
    saveStoredPresets(stored);
    buildPresetOptions();
  }
}

/* ------------------------------------------------------------------ */
/* 界面辅助                                                            */
/* ------------------------------------------------------------------ */

function setBusy(busy, text) {
  els.busy.hidden = !busy;
  els.busy.classList.toggle('visible', !!busy);
  if (text) els.busyText.textContent = text;
}

let toastTimer = 0;
function showToast(message, kind = 'info') {
  els.toast.textContent = message;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  els.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('visible'), kind === 'error' ? 5200 : 3200);
}

function ratioText(outputBytes, originalBytes) {
  if (!outputBytes || !originalBytes) return '';
  const ratio = outputBytes / originalBytes;
  return ratio < 1 ? ` · 缩小到 ${formatPercent(ratio, 0)}` : ` · 变为 ${formatPercent(ratio, 0)}`;
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// 放在文件末尾启动，确保所有 const（renderer、workerBridge、sampleBytesCache、
// scheduleRender 等）都已完成初始化，避免模块顶层调用时踩到 TDZ。
init();
