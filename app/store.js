import {
  centeredAlignment,
  normalizeAlignment,
  solveSimilarity,
  transformIsUsable,
} from '../src/core/alignment.js';
import { normalizeDiffSettings } from '../src/core/diff.js';
import {
  createEmptyProject,
  createPairDraft,
  normalizeProject,
  normalizeStroke,
  pairImageIds,
  serializeProject,
  touchPair,
  touchProject,
  uid,
  ALIGNMENT_METHODS,
  PROJECT_FORMAT,
} from '../src/core/project.js';
import { loadImageElement, inspectImageBlob, blobToDataUrl, dataUrlToBlob } from '../src/core/images.js';
import { loadWorkspace, saveWorkspace, clearWorkspace } from '../src/storage.js';

const VIEW_DEFAULTS = () => ({ scale: 1, panX: 0, panY: 0 });

export class WorkbenchStore {
  constructor() {
    this.project = createEmptyProject();
    this.images = new Map();
    this.views = new Map();
    this.activePairId = null;
    this.view = VIEW_DEFAULTS();
    this.listeners = new Set();
    this.saveTimer = null;
    this.saveState = 'idle';
    this.diffCache = new Map();
    this.dirtyPairs = new Set();
    this.restored = false;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type = 'change', detail = {}) {
    for (const fn of this.listeners) {
      try {
        fn(type, detail);
      } catch (error) {
        console.error('listener failed', error);
      }
    }
  }

  /* ------------------------------ project ------------------------------ */

  get activePair() {
    return this.project.pairs.find((p) => p.id === this.activePairId) || null;
  }

  getPair(pairId) {
    return this.project.pairs.find((p) => p.id === pairId) || null;
  }

  setActivePair(pairId) {
    if (!pairId || !this.getPair(pairId)) return;
    this.activePairId = pairId;
    this.project.activePairId = pairId;
    if (!this.views.has(pairId)) this.views.set(pairId, VIEW_DEFAULTS());
    this.view = this.views.get(pairId);
    this.emit('active-pair', { pairId });
  }

  setProjectName(name) {
    this.project.name = String(name || '未命名对比项目');
    touchProject(this.project);
    this.scheduleSave();
    this.emit('project');
  }

  setView(view) {
    // Mutate in place so the viewport's live state reference stays current
    // during pointer drags (a replace would leave it holding a stale object).
    Object.assign(this.view, view);
    if (this.activePairId) this.views.set(this.activePairId, this.view);
    this.emit('view', this.view);
  }

  resetViewFor(pairId, view) {
    let target = this.views.get(pairId);
    if (!target) {
      target = { ...view };
      this.views.set(pairId, target);
    } else {
      Object.assign(target, view);
    }
    if (pairId === this.activePairId) {
      // Keep the live reference in sync with the map.
      this.view = target;
      this.emit('view', this.view);
    }
  }

  /* ------------------------------- images ------------------------------ */

  async addImage(blob, name, { reuse = true } = {}) {
    const inspected = await inspectImageBlob(blob, name);
    if (reuse) {
      for (const record of this.images.values()) {
        if (record.hash === inspected.hash && record.width === inspected.width) {
          // Discard the throwaway object URL created by the inspection.
          URL.revokeObjectURL(inspected.img.src);
          return record;
        }
      }
    }
    const record = {
      id: uid('img'),
      name: inspected.name,
      mime: inspected.mime,
      width: inspected.width,
      height: inspected.height,
      hash: inspected.hash,
      blob,
      img: inspected.img,
      url: inspected.img.src,
    };
    this.images.set(record.id, record);
    return record;
  }

  imageRecord(imageId) {
    return this.images.get(imageId) || null;
  }

  pruneImages() {
    const used = new Set();
    for (const pair of this.project.pairs) {
      for (const id of pairImageIds(pair)) used.add(id);
    }
    for (const [id, record] of this.images) {
      if (!used.has(id)) {
        URL.revokeObjectURL(record.url);
        this.images.delete(id);
      }
    }
  }

  /* -------------------------------- pairs ------------------------------- */

  createPair({ imageA, imageB, name, versionA, versionB, alignment, notes, alignmentMethod }) {
    const initial =
      alignment ||
      centeredAlignment(imageA.width, imageA.height, imageB.width, imageB.height);
    const pair = createPairDraft({
      name:
        name ||
        `${stripExtension(imageA.name)} → ${stripExtension(imageB.name)}`,
      a: {
        imageId: imageA.id,
        name: stripExtension(imageA.name),
        version: versionA || '',
        width: imageA.width,
        height: imageA.height,
      },
      b: {
        imageId: imageB.id,
        name: stripExtension(imageB.name),
        version: versionB || '',
        width: imageB.width,
        height: imageB.height,
      },
      alignment: initial,
      notes: notes || '',
    });
    if (alignmentMethod && ALIGNMENT_METHODS[alignmentMethod]) {
      pair.alignmentMethod = alignmentMethod;
    }
    this.project.pairs.push(pair);
    this.views.set(pair.id, VIEW_DEFAULTS());
    this.project.activePairId = pair.id;
    this.activePairId = pair.id;
    this.view = this.views.get(pair.id);
    touchProject(this.project);
    this.scheduleSave();
    this.emit('pairs', { created: pair.id });
    return pair;
  }

  updatePair(pairId, patch, { silent = false } = {}) {
    const pair = this.getPair(pairId);
    if (!pair) return null;
    const affectsDiff =
      'alignment' in patch ||
      'diffSettings' in patch ||
      'ignoreStrokes' in patch ||
      'cornerPoints' in patch;
    Object.assign(pair, patch);
    touchPair(pair);
    touchProject(this.project);
    if (affectsDiff) this.invalidateDiff(pairId);
    this.scheduleSave();
    if (!silent) this.emit('pair-updated', { pairId });
    return pair;
  }

  setPairImageMeta(pairId, side, patch) {
    const pair = this.getPair(pairId);
    if (!pair || (side !== 'a' && side !== 'b')) return;
    pair[side] = { ...pair[side], ...patch };
    touchPair(pair);
    this.scheduleSave();
    this.emit('pair-meta', { pairId, side });
  }

  deletePair(pairId) {
    const index = this.project.pairs.findIndex((p) => p.id === pairId);
    if (index < 0) return;
    const [removed] = this.project.pairs.splice(index, 1);
    this.views.delete(pairId);
    this.diffCache.delete(pairId);
    this.pruneImages();
    const next =
      this.project.pairs[index] ||
      this.project.pairs[index - 1] ||
      this.project.pairs[0] ||
      null;
    this.project.activePairId = next?.id || null;
    this.activePairId = next?.id || null;
    if (next) this.view = this.views.get(next.id) || VIEW_DEFAULTS();
    touchProject(this.project);
    this.scheduleSave();
    this.emit('pairs', { removed: removed.id });
  }

  duplicatePair(pairId) {
    const pair = this.getPair(pairId);
    if (!pair) return null;
    const copy = structuredClone(pair);
    copy.id = uid('pair');
    copy.name = `${pair.name}（副本）`;
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    copy.status = 'unreviewed';
    const index = this.project.pairs.findIndex((p) => p.id === pairId);
    this.project.pairs.splice(index + 1, 0, copy);
    this.views.set(copy.id, VIEW_DEFAULTS());
    this.setActivePair(copy.id);
    touchProject(this.project);
    this.scheduleSave();
    this.emit('pairs', { created: copy.id });
    return copy;
  }

  /* ------------------------------ alignment ---------------------------- */

  setAlignment(pairId, alignment, { method = 'manual', silent = false } = {}) {
    const pair = this.getPair(pairId);
    if (!pair) return;
    const next = normalizeAlignment(alignment);
    if (!transformIsUsable(next)) return;
    pair.alignment = next;
    // Keep the audit trail honest: once corner points were fitted, further
    // nudges are recorded as corner-fit plus manual tweaking.
    if (
      pair.alignmentMethod === 'corners' ||
      pair.alignmentMethod === 'corners+manual'
    ) {
      pair.alignmentMethod = 'corners+manual';
    } else {
      pair.alignmentMethod = method;
    }
    touchPair(pair);
    touchProject(this.project);
    this.invalidateDiff(pairId);
    this.scheduleSave();
    if (!silent) this.emit('alignment', { pairId });
  }

  addCornerPoint(pairId, point) {
    const pair = this.getPair(pairId);
    if (!pair) return;
    pair.cornerPoints.push({
      id: uid('cp'),
      ax: point.ax,
      ay: point.ay,
      bx: point.bx,
      by: point.by,
    });
    touchPair(pair);
    this.scheduleSave();
    this.emit('corners', { pairId });
  }

  removeCornerPoint(pairId, pointId) {
    const pair = this.getPair(pairId);
    if (!pair) return;
    pair.cornerPoints = pair.cornerPoints.filter((p) => p.id !== pointId);
    touchPair(pair);
    this.scheduleSave();
    this.emit('corners', { pairId });
  }

  clearCornerPoints(pairId) {
    const pair = this.getPair(pairId);
    if (!pair) return;
    pair.cornerPoints = [];
    pair.cornerFit = null;
    touchPair(pair);
    this.scheduleSave();
    this.emit('corners', { pairId });
  }

  fitCorners(pairId) {
    const pair = this.getPair(pairId);
    if (!pair) return { ok: false, error: '找不到对比组' };
    const fit = solveSimilarity(pair.cornerPoints);
    if (!fit.ok) return fit;
    pair.alignment = fit.alignment;
    pair.alignmentMethod = 'corners';
    pair.cornerFit = {
      count: fit.count,
      rms: round(fit.rms, 3),
      maxError: round(fit.maxError, 3),
      residuals: fit.residuals.map((r) => round(r, 3)),
      appliedAt: new Date().toISOString(),
    };
    touchPair(pair);
    touchProject(this.project);
    this.invalidateDiff(pairId);
    this.scheduleSave();
    this.emit('alignment', { pairId, fit });
    return fit;
  }

  /* ------------------------------- settings ----------------------------- */

  setDiffSettings(pairId, patch) {
    const pair = this.getPair(pairId);
    if (!pair) return;
    const next = { ...pair.diffSettings, ...patch };
    pair.diffSettings = normalizeDiffSettings(next);
    touchPair(pair);
    touchProject(this.project);
    this.invalidateDiff(pairId);
    this.scheduleSave();
    this.emit('settings', { pairId, settings: pair.diffSettings });
  }

  /* -------------------------------- strokes ----------------------------- */

  setIgnoreStrokes(pairId, strokes) {
    const pair = this.getPair(pairId);
    if (!pair) return;
    pair.ignoreStrokes = strokes;
    pair.ignoreRevision += 1;
    touchPair(pair);
    this.scheduleSave();
  }

  addIgnoreStroke(pairId, stroke) {
    const pair = this.getPair(pairId);
    if (!pair) return;
    const normalized = normalizeStroke(stroke);
    if (!normalized) return;
    pair.ignoreStrokes.push(normalized);
    pair.ignoreRevision += 1;
    touchPair(pair);
    this.scheduleSave();
    this.emit('strokes', { pairId });
  }

  undoIgnoreStroke(pairId) {
    const pair = this.getPair(pairId);
    if (!pair || !pair.ignoreStrokes.length) return false;
    pair.ignoreStrokes.pop();
    pair.ignoreRevision += 1;
    touchPair(pair);
    this.scheduleSave();
    this.emit('strokes', { pairId });
    return true;
  }

  clearIgnoreStrokes(pairId) {
    const pair = this.getPair(pairId);
    if (!pair || !pair.ignoreStrokes.length) return;
    pair.ignoreStrokes = [];
    pair.ignoreRevision += 1;
    touchPair(pair);
    this.scheduleSave();
    this.emit('strokes', { pairId });
  }

  /* --------------------------------- diff -------------------------------- */

  invalidateDiff(pairId) {
    this.diffCache.delete(pairId);
    this.emit('diff-invalidated', { pairId });
  }

  getDiff(pairId) {
    return this.diffCache.get(pairId) || null;
  }

  setDiff(pairId, result) {
    this.diffCache.set(pairId, result);
    this.emit('diff', { pairId, result });
  }

  /* ------------------------------ persistence ---------------------------- */

  scheduleSave() {
    this.saveState = 'dirty';
    this.emit('save-state', { state: this.saveState });
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 700);
  }

  async save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.project.pairs.length && !this.images.size) {
      this.saveState = 'saved';
      this.emit('save-state', { state: this.saveState });
      return;
    }
    this.saveState = 'saving';
    this.emit('save-state', { state: this.saveState });
    try {
      const payload = {
        schemaVersion: 2,
        savedAt: new Date().toISOString(),
        project: serializeProject(this.project).project,
        activePairId: this.activePairId,
        images: [...this.images.values()].map((img) => ({
          id: img.id,
          name: img.name,
          mime: img.mime,
          hash: img.hash,
          width: img.width,
          height: img.height,
          blob: img.blob,
        })),
      };
      await saveWorkspace(payload);
      this.saveState = 'saved';
      this.emit('save-state', { state: this.saveState, at: payload.savedAt });
    } catch (error) {
      this.saveState = 'error';
      this.emit('save-state', { state: this.saveState, error });
    }
  }

  async restore() {
    let saved = null;
    try {
      saved = await loadWorkspace();
    } catch (error) {
      console.warn('读取本地工作区失败', error);
    }
    if (!saved) {
      this.restored = true;
      this.emit('restored', { empty: true });
      return { empty: true };
    }
    const warnings = [];
    const imageMap = new Map();
    for (const rec of saved.images || []) {
      try {
        const blob = rec.blob instanceof Blob ? rec.blob : new Blob([rec.blob], { type: rec.mime });
        const img = await loadImageElement(blob);
        imageMap.set(rec.id, {
          id: rec.id,
          name: rec.name,
          mime: rec.mime || blob.type,
          hash: rec.hash,
          width: rec.width || img.naturalWidth,
          height: rec.height || img.naturalHeight,
          blob,
          img,
          url: img.src,
        });
      } catch (error) {
        warnings.push(`图片 ${rec.name || rec.id} 无法恢复：${error.message}`);
      }
    }

    const { project, warnings: projectWarnings } = normalizeProject(
      saved.project,
      saved.project?.name,
    );
    warnings.push(...projectWarnings);

    const keptPairs = [];
    for (const pair of project.pairs) {
      if (imageMap.has(pair.a.imageId) && imageMap.has(pair.b.imageId)) {
        keptPairs.push(pair);
      } else {
        warnings.push(`对比组「${pair.name}」的图片缺失，已跳过`);
      }
    }
    project.pairs = keptPairs;
    if (!project.pairs.some((p) => p.id === project.activePairId)) {
      project.activePairId = project.pairs[0]?.id || null;
    }

    this.images = imageMap;
    this.project = project;
    this.activePairId =
      saved.activePairId && this.getPair(saved.activePairId)
        ? saved.activePairId
        : project.activePairId;
    this.view = VIEW_DEFAULTS();
    this.restored = true;
    this.emit('restored', { empty: !project.pairs.length, warnings });
    return {
      empty: !project.pairs.length,
      warnings,
      savedAt: saved.savedAt,
    };
  }

  async resetWorkspace() {
    this.project = createEmptyProject();
    for (const record of this.images.values()) URL.revokeObjectURL(record.url);
    this.images.clear();
    this.views.clear();
    this.diffCache.clear();
    this.activePairId = null;
    this.view = VIEW_DEFAULTS();
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      await clearWorkspace();
    } catch (error) {
      console.warn('清空本地工作区失败', error);
    }
    this.emit('reset');
  }

  async exportProjectPayload() {
    const images = [];
    for (const img of this.images.values()) {
      images.push({
        id: img.id,
        name: img.name,
        mime: img.mime,
        hash: img.hash,
        width: img.width,
        height: img.height,
        dataUrl: await blobToDataUrl(img.blob),
      });
    }
    return {
      ...serializeProject(this.project),
      images,
    };
  }

  async importProjectPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('项目文件内容为空');
    }
    if (payload.format && payload.format !== PROJECT_FORMAT) {
      throw new Error(`不支持的项目格式：${payload.format}`);
    }
    const { project, warnings } = normalizeProject(payload, '导入的对比项目');
    const imageMap = new Map();
    for (const rec of payload.images || []) {
      try {
        const blob = dataUrlToBlob(rec.dataUrl);
        const img = await loadImageElement(blob);
        imageMap.set(rec.id, {
          id: rec.id,
          name: rec.name,
          mime: rec.mime || blob.type,
          hash: rec.hash,
          width: rec.width || img.naturalWidth,
          height: rec.height || img.naturalHeight,
          blob,
          img,
          url: img.src,
        });
      } catch (error) {
        warnings.push(`图片 ${rec.name || rec.id} 导入失败：${error.message}`);
      }
    }
    const keptPairs = project.pairs.filter(
      (pair) => imageMap.has(pair.a.imageId) && imageMap.has(pair.b.imageId),
    );
    if (!keptPairs.length) {
      throw new Error('项目文件中没有可用的对比组');
    }
    for (const pair of project.pairs) {
      if (!keptPairs.includes(pair)) warnings.push(`对比组「${pair.name}」缺少图片，已跳过`);
    }
    project.pairs = keptPairs;
    if (!project.pairs.some((p) => p.id === project.activePairId)) {
      project.activePairId = project.pairs[0].id;
    }

    for (const record of this.images.values()) URL.revokeObjectURL(record.url);
    this.images = imageMap;
    this.project = project;
    this.views.clear();
    this.diffCache.clear();
    this.activePairId = project.activePairId;
    this.view = VIEW_DEFAULTS();
    touchProject(this.project);
    this.emit('imported', { warnings });
    this.scheduleSave();
    return { warnings, pairCount: keptPairs.length };
  }

  stats() {
    let regionTotal = 0;
    let changedTotal = 0;
    let withDiff = 0;
    for (const pair of this.project.pairs) {
      const diff = this.diffCache.get(pair.id);
      if (!diff) continue;
      withDiff += 1;
      regionTotal += diff.regions.length;
      changedTotal += diff.stats.changedArea;
    }
    return {
      pairCount: this.project.pairs.length,
      regionTotal,
      changedTotal,
      withDiff,
    };
  }
}

export function stripExtension(name) {
  const stem = String(name || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .trim();
  return stem || '未命名图片';
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
