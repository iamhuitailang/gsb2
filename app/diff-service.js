import { normalizeDiffSettings, rasterizeIgnoreMask } from '../src/core/diff.js';
import { renderWorldRasters, makeCanvas, maskKeyFor } from '../src/core/world.js';

/**
 * Owns the diff worker and the ignore-mask cache.
 * Heavy pixel work runs off the main thread where module workers are
 * available, with an inline fallback otherwise.
 */
export class DiffService {
  constructor() {
    this.worker = null;
    this.jobSeq = 0;
    this.pending = new Map();
    this.mask = null;
    this.maskKey = '';
    this.initWorker();
  }

  restartWorker() {
    if (this.worker) return;
    this.initWorker();
  }

  initWorker() {
    try {
      this.worker = new Worker(new URL('../src/diffWorker.js', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (event) => this.handleMessage(event.data);
      this.worker.onerror = (event) => {
        // A crashed worker leaves no way to recover transferred buffers;
        // reject pending jobs so the UI falls back on the next run.
        const error = new Error(event?.message || '差异计算线程异常退出');
        for (const [, entry] of this.pending) entry.reject(error);
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
  }

  handleMessage(message) {
    const entry = this.pending.get(message.jobId);
    if (!entry) return;
    this.pending.delete(message.jobId);
    if (message.type === 'error') {
      entry.reject(new Error(message.message));
      return;
    }
    entry.resolve({
      width: message.width,
      height: message.height,
      factor: message.factor,
      bounds: message.bounds,
      threshold: message.threshold,
      stats: message.stats,
      regions: message.regions,
      overlayPixels: new Uint8ClampedArray(message.overlayPixels),
      basePixels: new Uint8ClampedArray(message.basePixels),
      compositePixels: new Uint8ClampedArray(message.compositePixels),
    });
  }

  ensureMask(strokes, revision, rasters, pairId) {
    // The cache must be scoped to the pair: ignore revisions restart at 0 for
    // every pair, and two pairs can share identical raster dimensions.
    const key = `${pairId}|${maskKeyFor({
      strokesRevision: revision,
      factor: rasters.factor,
      width: rasters.width,
      height: rasters.height,
      bounds: rasters.bounds,
    })}|${strokes?.length || 0}`;
    if (this.maskKey === key) return this.mask;
    if (!strokes || !strokes.length) {
      this.mask = null;
      this.maskKey = key;
      return null;
    }
    this.mask = rasterizeIgnoreMask(strokes, {
      width: rasters.width,
      height: rasters.height,
      factor: rasters.factor,
      bounds: rasters.bounds,
      makeCanvas,
    });
    this.maskKey = key;
    return this.mask;
  }

  /**
   * Compute the diff for one pair. Raster work (both images drawn into a
   * shared world canvas) happens on this thread; the per-pixel comparison
   * and connected-component pass run in the worker when available.
   */
  async compute({ pairId, imgA, imgB, alignment, settings, strokes, strokesRevision }) {
    if (!imgA || !imgB) return null;
    const normalized = normalizeDiffSettings(settings);
    const rasters = renderWorldRasters({ imgA, imgB, alignment });
    const mask = this.ensureMask(strokes, strokesRevision, rasters, pairId);
    const jobId = ++this.jobSeq;

    const copyPixels = (pixels) => new Uint8ClampedArray(pixels);
    const payload = {
      jobId,
      aPixels: copyPixels(rasters.aPixels),
      bPixels: copyPixels(rasters.bPixels),
      ignoreMask: mask ? new Uint8Array(mask) : null,
      width: rasters.width,
      height: rasters.height,
      factor: rasters.factor,
      bounds: rasters.bounds,
      sensitivity: normalized.sensitivity,
      minRegionArea: normalized.minRegionArea,
      includeUncovered: normalized.includeUncovered,
    };

    let result;
    if (this.worker) {
      try {
        result = await this.runInWorker(payload);
      } catch {
        // The worker may have died after the buffers were transferred; rebuild
        // the payload from the still-live rasters before the inline fallback.
        payload.aPixels = copyPixels(rasters.aPixels);
        payload.bPixels = copyPixels(rasters.bPixels);
        payload.ignoreMask = mask ? new Uint8Array(mask) : null;
        result = await this.runInline(payload);
        this.restartWorker();
      }
    } else {
      result = await this.runInline(payload);
    }
    result.rasterKey = rasters.rasterKey;
    result.settings = normalized;
    result.strokesRevision = strokesRevision;
    result.alignment = { ...alignment };
    return result;
  }

  runInWorker(payload) {
    return new Promise((resolve, reject) => {
      this.pending.set(payload.jobId, { resolve, reject });
      const transfer = [
        payload.aPixels.buffer,
        payload.bPixels.buffer,
      ];
      if (payload.ignoreMask) transfer.push(payload.ignoreMask.buffer);
      try {
        this.worker.postMessage(payload, transfer);
      } catch (error) {
        this.pending.delete(payload.jobId);
        reject(error);
      }
    });
  }

  async runInline(payload) {
    const { computeDiff } = await import('../src/core/diff.js');
    return computeDiff({
      aPixels: payload.aPixels,
      bPixels: payload.bPixels,
      ignoreMask: payload.ignoreMask,
      width: payload.width,
      height: payload.height,
      factor: payload.factor,
      bounds: payload.bounds,
      sensitivity: payload.sensitivity,
      minRegionArea: payload.minRegionArea,
      includeUncovered: payload.includeUncovered,
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}
