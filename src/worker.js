/**
 * 量化 Worker。
 *
 * 主线程负责调色板生成与工程状态；Worker 只做“给定调色板 → 输出像素/索引/指标/PNG”，
 * 因此 Worker 与主线程的结果完全一致，且调色板快照可以跨会话复用。
 *
 * 消息：
 *   register {image:{id,width,height,rgba}}
 *   unregister {ids:[]}
 *   clear
 *   process {requestId, imageId, spec:{palette, dither, strength, serpentine,
 *            alphaCutoff, alphaMode, distance, perceptual, outputFormat}}
 */
import { quantizeImage } from './quantize.js';
import { computeMetrics, computeSSIM } from './metrics.js';
import { encodeResult } from './exporters.js';

const images = new Map();
const MAX_PIXELS = 24_000_000;

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'register') {
      const { image } = msg;
      if (!image || !image.width || !image.height) throw new Error('无效的图像数据');
      if (image.width * image.height > MAX_PIXELS) {
        throw new Error(`图像 ${image.width}×${image.height} 超过处理上限 ${MAX_PIXELS} 像素`);
      }
      images.set(image.id, {
        id: image.id,
        width: image.width,
        height: image.height,
        rgba: image.rgba,
      });
      self.postMessage({ type: 'registered', id: image.id });
    } else if (msg.type === 'unregister') {
      for (const id of msg.ids || []) images.delete(id);
    } else if (msg.type === 'clear') {
      images.clear();
    } else if (msg.type === 'process') {
      const image = images.get(msg.imageId);
      if (!image) throw new Error('图像未注册，请重新载入该图片');
      const spec = msg.spec || {};
      const palette = Array.isArray(spec.palette) ? spec.palette : [];
      if (!palette.length) throw new Error('调色板为空');

      const started = performance.now();
      const quantized = quantizeImage(image.rgba, image.width, image.height, {
        palette,
        alphaCutoff: spec.alphaCutoff ?? 128,
        alphaMode: spec.alphaMode || 'binary',
        dither: spec.dither || 'floyd-steinberg',
        strength: spec.strength ?? 1,
        serpentine: spec.serpentine !== false,
        metric: spec.distance || 'redmean',
      });
      const metrics = computeMetrics(image.rgba, quantized.rgba, image.width, image.height, {
        alphaCutoff: spec.alphaCutoff ?? 128,
        alphaMode: spec.alphaMode || 'binary',
        perceptual: spec.perceptual === true,
        maxSamples: spec.maxSamples,
      });
      metrics.ssim = computeSSIM(
        image.rgba,
        quantized.rgba,
        image.width,
        image.height,
        spec.alphaCutoff ?? 128,
      );
      const outputBytes = await encodeResult(quantized, spec.outputFormat || 'indexed');

      self.postMessage(
        {
          type: 'processed',
          requestId: msg.requestId,
          imageId: msg.imageId,
          width: image.width,
          height: image.height,
          palette: quantized.palette,
          transparentIndex: quantized.transparentIndex,
          hasTransparency: quantized.hasTransparency,
          usedColors: quantized.usedColors,
          colorUsage: quantized.colorUsage,
          dither: quantized.dither,
          alphaMode: quantized.alphaMode,
          alphaCutoff: quantized.alphaCutoff,
          rgba: quantized.rgba,
          indices: quantized.indices,
          metrics,
          outputBytes,
          elapsedMs: performance.now() - started,
        },
        [quantized.rgba.buffer, quantized.indices.buffer, outputBytes.buffer],
      );
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId: msg?.requestId,
      id: msg?.imageId,
      message: error?.message || String(error),
    });
  }
};
