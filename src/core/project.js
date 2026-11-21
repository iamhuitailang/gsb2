import { normalizeAlignment, DEFAULT_ALIGNMENT } from './alignment.js';
import { normalizeDiffSettings, DEFAULT_DIFF_SETTINGS } from './diff.js';

export const PROJECT_FORMAT = 'verso.diff-project';
export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_FILE_EXTENSION = '.verso.json';

export const PAIR_STATUSES = Object.freeze([
  { id: 'unreviewed', label: '待检查', tone: 'neutral' },
  { id: 'confirmed', label: '已确认', tone: 'ok' },
  { id: 'attention', label: '需修改', tone: 'warn' },
]);

export const ALIGNMENT_METHODS = Object.freeze({
  initial: '初始居中对齐',
  manual: '手动微调',
  corners: '角点辅助对齐',
  'corners+manual': '角点对齐 + 手动微调',
});

export function alignmentMethodLabel(method) {
  return ALIGNMENT_METHODS[method] || ALIGNMENT_METHODS.initial;
}

export function pairStatusLabel(status) {
  return PAIR_STATUSES.find((s) => s.id === status)?.label || PAIR_STATUSES[0].label;
}

export function uid(prefix = 'id') {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return `${prefix}_${cryptoObj.randomUUID().slice(0, 8)}`;
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function createEmptyProject(name = '未命名对比项目') {
  const time = nowIso();
  return {
    id: uid('proj'),
    name,
    createdAt: time,
    updatedAt: time,
    activePairId: null,
    pairs: [],
  };
}

export function createPairDraft({ name, a, b, alignment, notes = '' }) {
  return {
    id: uid('pair'),
    name: name || '未命名对比',
    a: normalizeImageRef(a),
    b: normalizeImageRef(b),
    alignment: normalizeAlignment(alignment || DEFAULT_ALIGNMENT),
    alignmentMethod: 'initial',
    cornerPoints: [],
    cornerFit: null,
    notes,
    diffSettings: normalizeDiffSettings(DEFAULT_DIFF_SETTINGS),
    ignoreStrokes: [],
    ignoreRevision: 0,
    status: 'unreviewed',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeImageRef(ref = {}) {
  return {
    imageId: String(ref.imageId || ''),
    name: String(ref.name || '未命名图片'),
    version: String(ref.version || ''),
    width: Number(ref.width) || 0,
    height: Number(ref.height) || 0,
  };
}

export function normalizePair(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const a = normalizeImageRef(raw.a);
  const b = normalizeImageRef(raw.b);
  if (!a.imageId || !b.imageId) return null;
  const cornerPoints = Array.isArray(raw.cornerPoints)
    ? raw.cornerPoints
        .map((p) => ({
          id: String(p.id || uid('cp')),
          ax: Number(p.ax),
          ay: Number(p.ay),
          bx: Number(p.bx),
          by: Number(p.by),
        }))
        .filter((p) => [p.ax, p.ay, p.bx, p.by].every(Number.isFinite))
    : [];
  const ignoreStrokes = Array.isArray(raw.ignoreStrokes)
    ? raw.ignoreStrokes
        .map((stroke) => normalizeStroke(stroke))
        .filter(Boolean)
    : [];
  return {
    id: String(raw.id || uid('pair')),
    name: String(raw.name || `对比组 ${index + 1}`),
    a,
    b,
    alignment: normalizeAlignment(raw.alignment),
    alignmentMethod: ALIGNMENT_METHODS[raw.alignmentMethod]
      ? raw.alignmentMethod
      : 'initial',
    cornerPoints,
    cornerFit: normalizeCornerFit(raw.cornerFit),
    notes: String(raw.notes || ''),
    diffSettings: normalizeDiffSettings(raw.diffSettings),
    ignoreStrokes,
    ignoreRevision: 0,
    status: PAIR_STATUSES.some((s) => s.id === raw.status)
      ? raw.status
      : 'unreviewed',
    createdAt: String(raw.createdAt || nowIso()),
    updatedAt: String(raw.updatedAt || nowIso()),
  };
}

function normalizeCornerFit(fit) {
  if (!fit || typeof fit !== 'object') return null;
  const count = Number(fit.count);
  if (!Number.isFinite(count) || count < 2) return null;
  return {
    count,
    rms: Number.isFinite(Number(fit.rms)) ? Number(fit.rms) : null,
    maxError: Number.isFinite(Number(fit.maxError)) ? Number(fit.maxError) : null,
    appliedAt: String(fit.appliedAt || ''),
  };
}

export function normalizeStroke(stroke) {
  if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) return null;
  const points = stroke.points
    .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!points.length) return null;
  return {
    id: String(stroke.id || uid('stroke')),
    mode: stroke.mode === 'erase' ? 'erase' : 'paint',
    size: Math.max(1, Number(stroke.size) || 24),
    points,
  };
}

export function normalizeProject(raw, fallbackName = '未命名对比项目') {
  if (!raw || typeof raw !== 'object') {
    return { project: createEmptyProject(fallbackName), warnings: ['项目文件内容无法识别'] };
  }
  const warnings = [];
  let source = raw;
  if (raw.format && raw.format !== PROJECT_FORMAT) {
    warnings.push(`项目格式标记为 ${raw.format}，已按兼容模式尝试载入`);
  }
  if (raw.project && typeof raw.project === 'object') source = raw.project;
  const project = {
    id: String(source.id || uid('proj')),
    name: String(source.name || fallbackName),
    createdAt: String(source.createdAt || nowIso()),
    updatedAt: String(source.updatedAt || nowIso()),
    activePairId: source.activePairId ? String(source.activePairId) : null,
    pairs: [],
  };
  const list = Array.isArray(source.pairs) ? source.pairs : [];
  list.forEach((rawPair, index) => {
    const pair = normalizePair(rawPair, index);
    if (!pair) {
      warnings.push(`第 ${index + 1} 组对比缺少图片引用，已跳过`);
      return;
    }
    project.pairs.push(pair);
  });
  if (!project.pairs.some((p) => p.id === project.activePairId)) {
    project.activePairId = project.pairs[0]?.id || null;
  }
  return { project, warnings };
}

export function serializeProject(project) {
  return {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    exportedAt: nowIso(),
    project: {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      activePairId: project.activePairId,
      pairs: project.pairs.map((pair) => ({
        id: pair.id,
        name: pair.name,
        a: pair.a,
        b: pair.b,
        alignment: pair.alignment,
        alignmentMethod: pair.alignmentMethod,
        cornerPoints: pair.cornerPoints,
        cornerFit: pair.cornerFit,
        notes: pair.notes,
        diffSettings: pair.diffSettings,
        ignoreStrokes: pair.ignoreStrokes,
        status: pair.status,
        createdAt: pair.createdAt,
        updatedAt: pair.updatedAt,
      })),
    },
  };
}

export function collectImageIds(project) {
  const ids = new Set();
  for (const pair of project.pairs) {
    if (pair.a.imageId) ids.add(pair.a.imageId);
    if (pair.b.imageId) ids.add(pair.b.imageId);
  }
  return [...ids];
}

export function pairImageIds(pair) {
  return [pair.a.imageId, pair.b.imageId].filter(Boolean);
}

export function touchPair(pair) {
  pair.updatedAt = nowIso();
}

export function touchProject(project) {
  project.updatedAt = nowIso();
}
