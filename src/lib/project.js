/**
 * Project persistence.
 *
 * A project is plain JSON in localStorage. It stores original file references
 * (name, type, size, lastModified, EXIF orientation, thumbnail) plus every
 * image's working adjustments, named versions and relative fine-tune offset.
 *
 * Original full-resolution bytes are never stored, and never modified on disk:
 * the editor only reads them, and export writes a brand-new file.
 */

import { cloneAdjustments, normalizeAdjustments } from './adjustments.js';
import { CURVE_CHANNELS, normalizeCurve } from './curve.js';

export { CURVE_CHANNELS, normalizeCurve };

export const PROJECT_STORAGE_KEY = 'chromadeck.project.v1';
export const PROJECT_SCHEMA_VERSION = 1;
export const MAX_VERSIONS_PER_IMAGE = 24;

export function createProject({ name = '未命名项目' } = {}) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    images: [],
    batchAdjustments: null,
    compareImageIds: [],
    activeImageId: null,
    curveOverlayEnabled: true
  };
}

export function createImageRecord({
  fileRef,
  contentType,
  width,
  height,
  orientation,
  adjustments,
  thumbnail
}) {
  const now = new Date().toISOString();
  return {
    id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    fileRef,
    contentType,
    width,
    height,
    orientation: orientation || 1,
    thumbnail: thumbnail || null,
    savedAt: now,
    adjustments: cloneAdjustments(adjustments),
    versions: [],
    batchBase: null,
    preBatch: null,
    fineTune: [],
    recipeSource: null,
    status: 'ready'
  };
}

/**
 * @param {File} file
 */
export function fileRefFromFile(file, { orientation, width, height } = {}) {
  return {
    name: file.name,
    size: file.size,
    type: file.type || '',
    lastModified: file.lastModified,
    orientation: orientation || 1,
    width: width || null,
    height: height || null
  };
}

export function emptyProject() {
  return createProject();
}

/**
 * Group-level recipes for copying adjustments between images.
 *
 * `copyAdjustments(source, target, groups)` only replaces the selected groups,
 * which is how "single-image fine-tuning" is implemented: the batch copy sets
 * `batchBase` + a per-image `fineTune` overlay, and every later tweak of one
 * group is recorded as an overlay for that group only.
 */
export const COPY_GROUPS = ['exposure', 'whiteBalance', 'toneCurve', 'saturation'];

export function copyAdjustmentGroups(source, target, groups = COPY_GROUPS) {
  const next = cloneAdjustments(target);
  for (const group of groups) {
    if (!COPY_GROUPS.includes(group)) continue;
    next[group] = cloneAdjustments(source)[group];
  }
  return next;
}

/**
 * Record a fine-tune overlay. When `group` is null the whole adjustment set is
 * treated as a manual edit on top of the batch base.
 */
export function recordFineTune(image, group, adjustments) {
  const next = image.fineTune.filter((entry) => entry.group !== (group || '*'));
  next.push({ group: group || '*', adjustments: cloneAdjustments(adjustments), at: new Date().toISOString() });
  return next;
}

export function clearFineTune(image) {
  return { fineTune: [], adjustments: image.batchBase ? cloneAdjustments(image.batchBase) : cloneAdjustments(image.adjustments) };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeVersion(raw, messages, imageLabel) {
  if (!isPlainObject(raw)) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : '未命名版本';
  const { adjustments, warnings } = normalizeAdjustments(raw.adjustments);
  for (const warning of warnings) messages.push(`${imageLabel} · 版本「${name}」：${warning}`);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `ver_${Math.random().toString(36).slice(2, 10)}`,
    name,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    adjustments
  };
}

function sanitizeImage(raw, messages) {
  if (!isPlainObject(raw) || !isPlainObject(raw.fileRef)) return null;
  const label = typeof raw.fileRef.name === 'string' ? raw.fileRef.name : '图片';
  const { adjustments, warnings } = normalizeAdjustments(raw.adjustments);
  for (const warning of warnings) messages.push(`${label}：${warning}`);

  const versions = Array.isArray(raw.versions)
    ? raw.versions.map((version) => sanitizeVersion(version, messages, label)).filter(Boolean).slice(-MAX_VERSIONS_PER_IMAGE)
    : [];

  const fineTune = Array.isArray(raw.fineTune)
    ? raw.fineTune
        .filter((entry) => isPlainObject(entry) && typeof entry.group === 'string')
        .map((entry) => ({ group: entry.group, adjustments: normalizeAdjustments(entry.adjustments).adjustments }))
    : [];

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `img_${Math.random().toString(36).slice(2, 10)}`,
    fileRef: {
      name: String(raw.fileRef.name || '未知文件'),
      size: Number.isFinite(raw.fileRef.size) ? raw.fileRef.size : 0,
      type: typeof raw.fileRef.type === 'string' ? raw.fileRef.type : '',
      lastModified: Number.isFinite(raw.fileRef.lastModified) ? raw.fileRef.lastModified : 0,
      orientation: Number.isInteger(raw.fileRef.orientation) ? raw.fileRef.orientation : 1,
      width: Number.isFinite(raw.fileRef.width) ? raw.fileRef.width : null,
      height: Number.isFinite(raw.fileRef.height) ? raw.fileRef.height : null
    },
    contentType: typeof raw.contentType === 'string' ? raw.contentType : '',
    width: Number.isFinite(raw.width) ? raw.width : raw.fileRef.width,
    height: Number.isFinite(raw.height) ? raw.height : raw.fileRef.height,
    orientation: Number.isInteger(raw.orientation) ? raw.orientation : raw.fileRef.orientation,
    thumbnail: typeof raw.thumbnail === 'string' && raw.thumbnail.startsWith('data:image/') ? raw.thumbnail : null,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
    adjustments,
    versions,
    batchBase: raw.batchBase ? normalizeAdjustments(raw.batchBase).adjustments : null,
    preBatch: raw.preBatch ? normalizeAdjustments(raw.preBatch).adjustments : null,
    fineTune,
    recipeSource: typeof raw.recipeSource === 'string' ? raw.recipeSource : null,
    status: raw.status === 'recovered' ? 'recovered' : 'ready'
  };
}

/**
 * Tolerant project loader: everything that can be recovered is recovered,
 * everything unusable falls back to a default, and human-readable notes are
 * returned so the UI can show exactly what happened.
 */
export function loadProject(raw) {
  const messages = [];
  const project = createProject();
  if (!isPlainObject(raw)) {
    return { project, messages: ['项目数据无法识别，已创建空白项目。'], recovered: false };
  }

  if (raw.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    messages.push(`项目结构版本为 ${raw.schemaVersion ?? '未知'}，已按当前版本尽量恢复。`);
  }
  if (typeof raw.name === 'string' && raw.name.trim()) project.name = raw.name.trim().slice(0, 80);
  if (typeof raw.id === 'string' && raw.id) project.id = raw.id;
  if (typeof raw.createdAt === 'string') project.createdAt = raw.createdAt;
  if (typeof raw.updatedAt === 'string') project.updatedAt = raw.updatedAt;

  const images = Array.isArray(raw.images) ? raw.images : [];
  for (const rawImage of images) {
    const image = sanitizeImage(rawImage, messages);
    if (!image) {
      messages.push('发现一条无法识别的图片记录，已跳过。');
      continue;
    }
    project.images.push(image);
  }

  project.batchAdjustments = isPlainObject(raw.batchAdjustments)
    ? normalizeAdjustments(raw.batchAdjustments).adjustments
    : null;

  const ids = new Set(project.images.map((image) => image.id));
  project.compareImageIds = Array.isArray(raw.compareImageIds)
    ? raw.compareImageIds.filter((id) => ids.has(id)).slice(0, 4)
    : [];
  project.activeImageId = ids.has(raw.activeImageId)
    ? raw.activeImageId
    : project.images[0]?.id ?? null;
  project.curveOverlayEnabled = raw.curveOverlayEnabled !== false;

  const recovered = images.length !== project.images.length || messages.length > 0;
  return { project, messages, recovered };
}

export function serializeProject(project) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: new Date().toISOString(),
    images: project.images.map((image) => ({
      id: image.id,
      fileRef: image.fileRef,
      contentType: image.contentType,
      width: image.width,
      height: image.height,
      orientation: image.orientation,
      thumbnail: image.thumbnail,
      savedAt: image.savedAt,
      adjustments: image.adjustments,
      versions: image.versions,
      batchBase: image.batchBase,
      preBatch: image.preBatch,
      fineTune: image.fineTune,
      recipeSource: image.recipeSource,
      status: image.status
    })),
    batchAdjustments: project.batchAdjustments,
    compareImageIds: project.compareImageIds,
    activeImageId: project.activeImageId,
    curveOverlayEnabled: project.curveOverlayEnabled
  };
}

export function saveProjectToStorage(project, storage = globalThis.localStorage) {
  const payload = serializeProject(project);
  payload.updatedAt = new Date().toISOString();
  try {
    storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(payload));
    return { ok: true, updatedAt: payload.updatedAt };
  } catch (error) {
    const quota = error && (error.name === 'QuotaExceededError' || error.code === 22 || error.code === 1014);
    return {
      ok: false,
      error: quota
        ? '浏览器本地存储空间不足，项目未保存。原始图片与导出文件未受影响，可导出项目文件后再继续。'
        : `保存项目失败：${error?.message || error}`
    };
  }
}

export function readProjectFromStorage(storage = globalThis.localStorage) {
  let text;
  try {
    text = storage.getItem(PROJECT_STORAGE_KEY);
  } catch (error) {
    return { project: null, messages: [`读取本地存储失败：${error?.message || error}`] };
  }
  return parseProjectText(text);
}

/**
 * Parse project JSON text (used both for localStorage and for project files
 * opened from disk). Always returns a usable project object.
 */
export function parseProjectText(text) {
  if (!text) return { project: null, messages: [] };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { project: null, messages: ['项目数据不是有效的 JSON，已保留原始数据，可导入备份项目文件恢复。'] };
  }
  const { project, messages, recovered } = loadProject(raw);
  return { project, messages, recovered };
}

export function clearProjectStorage(storage = globalThis.localStorage) {
  try {
    storage.removeItem(PROJECT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Export/import a project as a file the user keeps next to the originals.
 */
export function projectToFilePayload(project) {
  return serializeProject(project);
}

export function downloadFileNameForProject(project, extension = 'json') {
  const safe = (project.name || 'chromadeck-project')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'chromadeck-project';
  return `${safe}.${extension}`;
}

/** Utility used by the UI to detect "this group differs from default". */
export function groupSignature(value) {
  return JSON.stringify(value);
}

