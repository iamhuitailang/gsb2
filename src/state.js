/**
 * 工程状态、参数校验、序列化与预设。
 *
 * 工程文件（.palf.json）包含：整组参数、每张图的原始 PNG（base64）、
 * 每张图的参数覆盖、自动生成调色板的快照，以及用户预设。
 * 调色板快照的 hash 与当前参数一致时会被直接复用，保证重新打开工程后
 * 预览与保存时逐像素一致，即使未来调色板算法有调整也不会悄悄改变旧工程。
 */
import { DITHER_IDS } from './quantize.js';
import { presetColors, getPreset, PALETTE_PRESETS } from './palette.js';
import { rgbToHex, dedupePalette, parsePaletteText } from './color.js';
import { clamp, deepClone, uid, isPlainObject } from './utils.js';

export const PROJECT_FORMAT = 'palette-forge-project';
export const PROJECT_VERSION = 1;
export const PRESET_STORAGE_KEY = 'palette-forge.presets.v1';

export const PALETTE_SOURCES = [
  { id: 'auto', name: '自动生成（每张图各自一版）' },
  { id: 'fixed', name: '固定调色板（全组一致）' },
  { id: 'batch', name: '整组共享调色板（从整组图片生成）' },
];

export const ALPHA_MODES = [
  { id: 'binary', name: '二值化', help: '保留透明/不透明两种状态，半透明像素按阈值变为不透明。' },
  { id: 'preserve', name: '保留原始 alpha', help: '半透明像素保留 alpha；透明像素依然完全独立。' },
];

export const DISTANCE_METRICS = [
  { id: 'redmean', name: '红均值加权 RGB（推荐）' },
  { id: 'rgb', name: '欧氏 RGB' },
  { id: 'lab', name: 'Lab ΔE76（最慢）' },
];

export const DEFAULT_SETTINGS = Object.freeze({
  paletteSource: 'auto',
  colorCount: 16,
  paletteMethod: 'kmeans',
  fixedPalettePreset: 'gameboy',
  fixedPaletteText: '#0f380f\n#306230\n#8bac0f\n#9bbc0f',
  dither: 'floyd-steinberg',
  strength: 1,
  serpentine: true,
  alphaCutoff: 128,
  alphaMode: 'binary',
  distance: 'redmean',
  outputFormat: 'indexed',
  perceptual: false,
});

export const DEFAULT_PREVIEW = Object.freeze({
  mode: 'split',
  zoom: 4,
  background: 'checker',
  pixelGrid: false,
  split: 0.5,
});

export function paletteTextFromId(id) {
  const colors = presetColors(id);
  if (!colors.length) return '';
  return colors.map((c) => rgbToHex(c.r, c.g, c.b)).join('\n');
}

export function fixedPaletteFromSettings(settings) {
  return dedupePalette(parsePaletteText(settings.fixedPaletteText)).slice(0, 256);
}

function coerceBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeSettings(input) {
  const source = isPlainObject(input) ? input : {};
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  out.paletteSource = ['auto', 'fixed', 'batch'].includes(out.paletteSource)
    ? out.paletteSource
    : DEFAULT_SETTINGS.paletteSource;
  out.colorCount = Math.round(
    clamp(Number.isFinite(Number(out.colorCount)) ? Number(out.colorCount) : 16, 2, 256),
  );
  out.paletteMethod = out.paletteMethod === 'median' ? 'median' : 'kmeans';
  out.dither = DITHER_IDS.includes(out.dither) ? out.dither : DEFAULT_SETTINGS.dither;
  out.strength = clamp(Number.isFinite(Number(out.strength)) ? Number(out.strength) : 1, 0, 2);
  out.serpentine = coerceBool(out.serpentine, true);
  out.alphaCutoff = Math.round(
    clamp(Number.isFinite(Number(out.alphaCutoff)) ? Number(out.alphaCutoff) : 128, 1, 255),
  );
  out.alphaMode = out.alphaMode === 'preserve' ? 'preserve' : 'binary';
  out.distance = ['redmean', 'rgb', 'lab'].includes(out.distance) ? out.distance : 'redmean';
  out.outputFormat = ['indexed', 'rgba', 'gray'].includes(out.outputFormat)
    ? out.outputFormat
    : 'indexed';
  out.perceptual = coerceBool(out.perceptual, false);

  if (typeof out.fixedPalettePreset !== 'string') out.fixedPalettePreset = 'custom';
  if (typeof out.fixedPaletteText !== 'string') out.fixedPaletteText = '';
  // 预设文本缺失时按当前预设补全（而不是让固定调色板悄悄变成空）。
  if (!out.fixedPaletteText.trim() && out.fixedPalettePreset !== 'custom') {
    out.fixedPaletteText = paletteTextFromId(out.fixedPalettePreset);
  }
  return out;
}

export function normalizePreview(input) {
  const source = isPlainObject(input) ? input : {};
  const out = { ...DEFAULT_PREVIEW, ...source };
  out.mode = ['original', 'result', 'split', 'diff'].includes(out.mode) ? out.mode : 'split';
  out.zoom = clamp(Number(out.zoom) || 4, 0.25, 32);
  out.background = ['checker', 'white', 'black', 'gray'].includes(out.background)
    ? out.background
    : 'checker';
  out.pixelGrid = coerceBool(out.pixelGrid, false);
  out.split = clamp(Number.isFinite(out.split) ? out.split : 0.5, 0.02, 0.98);
  return out;
}

/** 与调色板生成有关的参数指纹。 */
export function paletteHash(settings, imageId = '') {
  return [
    imageId,
    settings.paletteSource,
    settings.colorCount,
    settings.paletteMethod,
    settings.alphaCutoff,
    settings.fixedPalettePreset,
    settings.fixedPaletteText.replace(/\s+/g, ' ').trim(),
  ].join('|');
}

/** 与整图输出（不含输出格式/预览）有关的参数指纹。 */
export function renderHash(settings) {
  const s = normalizeSettings(settings);
  return [
    s.paletteSource,
    s.colorCount,
    s.paletteMethod,
    s.fixedPalettePreset,
    s.fixedPaletteText.replace(/\s+/g, ' ').trim(),
    s.dither,
    s.strength.toFixed(3),
    s.serpentine ? 1 : 0,
    s.alphaCutoff,
    s.alphaMode,
    s.distance,
    s.perceptual ? 1 : 0,
  ].join('|');
}

export function mergeSettings(groupSettings, overrides) {
  if (!overrides || !isPlainObject(overrides)) return normalizeSettings(groupSettings);
  return normalizeSettings({ ...groupSettings, ...overrides });
}

export function createImageRecord({ id, name, width, height, rgba, bytes, dataUrl, sourceInfo }) {
  return {
    id: id || uid('img'),
    name,
    width,
    height,
    rgba,
    bytes: bytes || null,
    dataUrl,
    sourceInfo: sourceInfo || null,
    overrides: null,
    overrideEnabled: false,
    paletteSnapshot: null,
    metricsSnapshot: null,
  };
}

export function createProject(name = '未命名工程') {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: uid('proj'),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: normalizeSettings(DEFAULT_SETTINGS),
    preview: normalizePreview(DEFAULT_PREVIEW),
    images: [],
    batchPalette: null,
    batchPaletteHash: null,
    presets: loadStoredPresets(),
  };
}

export function touchProject(project) {
  project.updatedAt = new Date().toISOString();
  return project;
}

/* ------------------------------------------------------------------ */
/* 序列化                                                              */
/* ------------------------------------------------------------------ */

export function serializeProject(project, preview) {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: new Date().toISOString(),
    settings: normalizeSettings(project.settings),
    preview: normalizePreview(preview || project.preview),
    batchPalette: project.batchPalette ? project.batchPalette.map((c) => ({ ...c })) : null,
    batchPaletteHash: project.batchPaletteHash || null,
    presets: Array.isArray(project.presets) ? project.presets : loadStoredPresets(),
    images: project.images.map((img) => ({
      id: img.id,
      name: img.name,
      width: img.width,
      height: img.height,
      // 保留原始文件体积，重开工程后“源文件体积”比值仍然可比。
      sourceBytes: Number.isFinite(img.sourceBytes) ? img.sourceBytes : null,
      sourceInfo: img.sourceInfo || null,
      overrideEnabled: !!img.overrideEnabled,
      overrides: img.overrideEnabled && img.overrides ? deepClone(img.overrides) : null,
      paletteSnapshot: img.paletteSnapshot
        ? { hash: img.paletteSnapshot.hash, palette: img.paletteSnapshot.palette.map((c) => ({ ...c })) }
        : null,
      dataUrl: img.dataUrl,
    })),
  };
}

export function deserializeProject(raw) {
  if (!isPlainObject(raw)) throw new Error('工程文件不是有效的 JSON 对象');
  if (raw.format !== PROJECT_FORMAT) {
    throw new Error('不是 Palette Forge 工程文件（缺少 format 标记）');
  }
  if (Number(raw.version) > PROJECT_VERSION) {
    throw new Error(`工程版本 ${raw.version} 高于当前支持的 ${PROJECT_VERSION}`);
  }
  const project = createProject(raw.name || '未命名工程');
  project.id = typeof raw.id === 'string' ? raw.id : project.id;
  project.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : project.createdAt;
  project.settings = normalizeSettings(raw.settings);
  project.preview = normalizePreview(raw.preview);
  project.presets = normalizePresets(raw.presets);
  project.batchPalette = normalizePaletteArray(raw.batchPalette);
  project.batchPaletteHash = typeof raw.batchPaletteHash === 'string' ? raw.batchPaletteHash : null;
  project.images = (Array.isArray(raw.images) ? raw.images : []).map((entry) => {
    if (!isPlainObject(entry)) return null;
    if (typeof entry.dataUrl !== 'string' || !entry.dataUrl.startsWith('data:image/')) return null;
    const width = Math.round(Number(entry.width));
    const height = Math.round(Number(entry.height));
    if (!(width > 0 && height > 0)) return null;
    return {
      id: typeof entry.id === 'string' ? entry.id : uid('img'),
      name: typeof entry.name === 'string' ? entry.name : 'image.png',
      width,
      height,
      dataUrl: entry.dataUrl,
      rgba: null,
      bytes: null,
      sourceBytes: Number.isFinite(entry.sourceBytes) ? entry.sourceBytes : null,
      sourceInfo: isPlainObject(entry.sourceInfo) ? entry.sourceInfo : null,
      overrides: isPlainObject(entry.overrides) ? entry.overrides : null,
      overrideEnabled: !!entry.overrideEnabled && isPlainObject(entry.overrides),
      paletteSnapshot: normalizeSnapshot(entry.paletteSnapshot),
      metricsSnapshot: null,
    };
  }).filter(Boolean);
  return project;
}

function normalizePaletteArray(value) {
  if (!Array.isArray(value)) return null;
  const palette = value
    .filter((c) => c && Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b))
    .map((c) => ({ r: Math.round(clamp(c.r, 0, 255)), g: Math.round(clamp(c.g, 0, 255)), b: Math.round(clamp(c.b, 0, 255)) }));
  const deduped = dedupePalette(palette);
  return deduped.length ? deduped : null;
}

function normalizeSnapshot(value) {
  if (!isPlainObject(value) || typeof value.hash !== 'string') return null;
  const palette = normalizePaletteArray(value.palette);
  if (!palette) return null;
  return { hash: value.hash, palette };
}

/* ------------------------------------------------------------------ */
/* 预设                                                                */
/* ------------------------------------------------------------------ */

export const BUILTIN_PRESETS = [
  {
    id: 'builtin-pixel16',
    name: '像素画 16 色',
    builtin: true,
    settings: { paletteSource: 'auto', colorCount: 16, paletteMethod: 'kmeans', dither: 'none', alphaMode: 'binary' },
  },
  {
    id: 'builtin-gameboy',
    name: 'Game Boy 手感',
    builtin: true,
    settings: {
      paletteSource: 'fixed',
      fixedPalettePreset: 'gameboy',
      fixedPaletteText: paletteTextFromId('gameboy'),
      colorCount: 4,
      dither: 'bayer4',
      alphaMode: 'binary',
    },
  },
  {
    id: 'builtin-photo64',
    name: '照片压缩 64 色',
    builtin: true,
    settings: { paletteSource: 'auto', colorCount: 64, paletteMethod: 'kmeans', dither: 'stucki', strength: 0.8 },
  },
  {
    id: 'builtin-webicon',
    name: '网页图标 32 色',
    builtin: true,
    settings: { paletteSource: 'auto', colorCount: 32, paletteMethod: 'kmeans', dither: 'atkinson', strength: 1 },
  },
  {
    id: 'builtin-eink',
    name: '电子墨水 4 灰阶',
    builtin: true,
    settings: {
      paletteSource: 'fixed',
      fixedPalettePreset: 'gray4',
      fixedPaletteText: paletteTextFromId('gray4'),
      colorCount: 4,
      dither: 'bayer8',
    },
  },
  {
    id: 'builtin-cga',
    name: 'CGA 复古',
    builtin: true,
    settings: {
      paletteSource: 'fixed',
      fixedPalettePreset: 'cga16',
      fixedPaletteText: paletteTextFromId('cga16'),
      colorCount: 16,
      dither: 'floyd-steinberg',
    },
  },
];

export function normalizePresets(list) {
  if (!Array.isArray(list)) return [];
  return list.map((p) => {
    if (!isPlainObject(p) || typeof p.name !== 'string' || !isPlainObject(p.settings)) return null;
    return {
      id: typeof p.id === 'string' ? p.id : uid('preset'),
      name: p.name.slice(0, 60) || '未命名预设',
      builtin: false,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
      settings: normalizeSettings(p.settings),
    };
  }).filter(Boolean);
}

export function loadStoredPresets() {
  try {
    const raw = globalThis.localStorage?.getItem(PRESET_STORAGE_KEY);
    if (!raw) return [];
    return normalizePresets(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveStoredPresets(presets) {
  try {
    globalThis.localStorage?.setItem(PRESET_STORAGE_KEY, JSON.stringify(normalizePresets(presets)));
    return true;
  } catch {
    return false;
  }
}

export function palettesForDisplay() {
  return PALETTE_PRESETS;
}

export function isBuiltinPreset(id) {
  return BUILTIN_PRESETS.some((p) => p.id === id);
}

export function findFixedPreset(id) {
  return getPreset(id);
}
