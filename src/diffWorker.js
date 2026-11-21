import { computeDiff } from './core/diff.js';

self.onmessage = (event) => {
  const message = event.data;
  if (!message || message.type !== 'compute') return;
  try {
    const result = computeDiff({
      aPixels: new Uint8ClampedArray(message.aPixels),
      bPixels: new Uint8ClampedArray(message.bPixels),
      ignoreMask: message.ignoreMask
        ? new Uint8Array(message.ignoreMask)
        : null,
      width: message.width,
      height: message.height,
      factor: message.factor,
      bounds: message.bounds,
      sensitivity: message.sensitivity,
      minRegionArea: message.minRegionArea,
      includeUncovered: message.includeUncovered,
    });
    self.postMessage(
      {
        type: 'result',
        jobId: message.jobId,
        width: result.width,
        height: result.height,
        factor: result.factor,
        bounds: result.bounds,
        threshold: result.threshold,
        stats: result.stats,
        regions: result.regions,
        overlayPixels: result.overlayPixels.buffer,
        basePixels: result.basePixels.buffer,
        compositePixels: result.compositePixels.buffer,
      },
      [
        result.overlayPixels.buffer,
        result.basePixels.buffer,
        result.compositePixels.buffer,
      ],
    );
  } catch (error) {
    self.postMessage({
      type: 'error',
      jobId: message.jobId,
      message: error?.message || String(error),
    });
  }
};
