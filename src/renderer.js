/** 预览画布：原图 / 结果 / 左右对比 / 差异图，支持像素网格与背景。 */

const DIFF_VIEW_SCALE = 6;

function makeLayer(width, height, rgba) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function heat(value) {
  // 黑 → 深红 → 橙 → 黄 → 白
  const t = Math.max(0, Math.min(1, value));
  if (t < 0.25) {
    const k = t / 0.25;
    return [Math.round(80 * k), 0, 0];
  }
  if (t < 0.5) {
    const k = (t - 0.25) / 0.25;
    return [80 + Math.round(175 * k), Math.round(40 * k), 0];
  }
  if (t < 0.75) {
    const k = (t - 0.5) / 0.25;
    return [255, 40 + Math.round(170 * k), 0];
  }
  const k = (t - 0.75) / 0.25;
  return [255, 210 + Math.round(45 * k), Math.round(180 * k)];
}

/**
 * 差异图：
 *   - 两边都透明的像素保持透明；
 *   - 只有一边不透明 → 品红（结构/透明判定差异）；
 *   - 两边都不透明 → 放大 6 倍的颜色误差热力图。
 */
function buildDiffImage(original, result, width, height, alphaCutoff = 128) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const ra = original[i + 3];
    const qa = result[i + 3];
    const refOpaque = ra >= alphaCutoff;
    const qOpaque = qa >= alphaCutoff;
    if (!refOpaque && !qOpaque) continue;
    if (refOpaque !== qOpaque) {
      out[i] = 255;
      out[i + 1] = 0;
      out[i + 2] = 210;
      out[i + 3] = 255;
      continue;
    }
    const dr = Math.abs(original[i] - result[i]);
    const dg = Math.abs(original[i + 1] - result[i + 1]);
    const db = Math.abs(original[i + 2] - result[i + 2]);
    const magnitude = ((dr + dg + db) / 3 / 255) * DIFF_VIEW_SCALE;
    const [r, g, b] = heat(Math.min(1, magnitude));
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = 255;
  }
  return out;
}

export class PreviewRenderer {
  constructor({ canvas, wrap, gridOverlay, splitHandle, emptyState }) {
    this.canvas = canvas;
    this.wrap = wrap;
    this.gridOverlay = gridOverlay;
    this.splitHandle = splitHandle;
    this.emptyState = emptyState;
    this.image = null;
    this.view = { mode: 'split', zoom: 4, background: 'checker', pixelGrid: false, split: 0.5 };
    this.layers = null;
    this.diffLayer = null;
    this.diffKey = '';
    this.alphaCutoff = 128;
    this.ctx = canvas.getContext('2d');
  }

  setImage(data) {
    if (!data) {
      this.image = null;
      this.layers = null;
      this.sourceKey = null;
      this.emptyState.hidden = false;
      this.canvas.hidden = true;
      this.splitHandle.hidden = true;
      this.gridOverlay.hidden = true;
      return;
    }
    // 同一张图重复渲染时复用已解码的原图层，避免每次拷贝整幅 RGBA。
    const key = data.key || `${data.width}x${data.height}`;
    const reuseOriginal = this.layers && this.sourceKey === key;
    const original = reuseOriginal ? this.layers.original : makeLayer(data.width, data.height, data.originalRGBA);
    this.sourceKey = key;
    this.image = data;
    this.emptyState.hidden = true;
    this.canvas.hidden = false;
    this.layers = {
      original,
      result: data.resultRGBA ? makeLayer(data.width, data.height, data.resultRGBA) : null,
    };
    this.diffLayer = null;
    this.diffKey = '';
    this.alphaCutoff = data.alphaCutoff || 128;
    this.draw();
  }

  setResult(resultRGBA, key = '') {
    if (!this.image) return;
    this.image.resultRGBA = resultRGBA;
    this.layers.result = resultRGBA ? makeLayer(this.image.width, this.image.height, resultRGBA) : null;
    this.diffLayer = null;
    this.diffKey = key;
    this.draw();
  }
  setView(partial) {
    this.view = { ...this.view, ...partial };
    this.draw();
  }

  draw() {
    if (!this.image) return;
    const { width, height } = this.image;
    const { mode, zoom, split } = this.view;
    const canvas = this.canvas;
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width * zoom}px`;
    canvas.style.height = `${height * zoom}px`;
    canvas.style.imageRendering = zoom >= 2 ? 'pixelated' : 'auto';

    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);

    const original = this.layers.original;
    const result = this.layers.result || original;

    if (mode === 'original') {
      ctx.drawImage(original, 0, 0);
    } else if (mode === 'result') {
      ctx.drawImage(result, 0, 0);
    } else if (mode === 'split') {
      ctx.drawImage(result, 0, 0);
      const splitX = Math.max(0, Math.min(width, Math.round(width * split)));
      if (splitX > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, splitX, height);
        ctx.clip();
        ctx.drawImage(original, 0, 0);
        ctx.restore();
      }
    } else if (mode === 'diff') {
      if (!this.diffLayer) {
        const diff = buildDiffImage(
          this.image.originalRGBA,
          this.image.resultRGBA || this.image.originalRGBA,
          width,
          height,
          this.alphaCutoff,
        );
        this.diffLayer = makeLayer(width, height, diff);
      }
      ctx.drawImage(this.diffLayer, 0, 0);
    }

    this.wrap.style.width = `${width * zoom}px`;
    this.wrap.style.height = `${height * zoom}px`;
    this.wrap.dataset.background = this.view.background;
    this.wrap.dataset.mode = mode;

    const showHandle = mode === 'split';
    this.splitHandle.hidden = !showHandle;
    if (showHandle) {
      this.splitHandle.style.left = `${split * 100}%`;
    }

    const showGrid = this.view.pixelGrid && zoom >= 4;
    this.gridOverlay.hidden = !showGrid;
    if (showGrid) {
      const size = Math.max(4, zoom);
      this.gridOverlay.style.backgroundSize = `${size}px ${size}px`;
      this.gridOverlay.style.opacity = zoom >= 8 ? '0.9' : '0.55';
    }
  }

  /** 根据容器可视区域计算“适应窗口”的缩放比例。 */
  computeFitZoom(viewport) {
    if (!this.image) return 1;
    const padding = 32;
    const maxW = Math.max(64, viewport.clientWidth - padding);
    const maxH = Math.max(64, viewport.clientHeight - padding);
    const scale = Math.min(maxW / this.image.width, maxH / this.image.height);
    if (scale >= 1) return Math.max(1, Math.floor(scale * 2) / 2);
    return Math.max(0.1, Math.floor(scale * 100) / 100);
  }

  pixelAt(x, y) {
    if (!this.image) return null;
    const { width, height, originalRGBA, resultRGBA } = this.image;
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const i = (y * width + x) * 4;
    return {
      x,
      y,
      original: {
        r: originalRGBA[i],
        g: originalRGBA[i + 1],
        b: originalRGBA[i + 2],
        a: originalRGBA[i + 3],
      },
      result: resultRGBA
        ? { r: resultRGBA[i], g: resultRGBA[i + 1], b: resultRGBA[i + 2], a: resultRGBA[i + 3] }
        : null,
    };
  }
}
