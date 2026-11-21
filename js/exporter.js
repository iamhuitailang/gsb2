/*
 * exporter.js — 实际分辨率导出
 *  - crop 模式：按目标分辨率重采样裁切区域（不是导出屏幕截图）
 *  - pad 模式：整张原图等比缩放居中，补边色填充，输出含有效图像占比
 *  - 框位置清单：像素坐标 + 归一化坐标 + 每个关注区的保留情况，JSON 导出
 */
(function (root, factory) {
  const mod = factory(typeof require === 'function' ? require('./geometry') : root.SCGeometry,
                      typeof require === 'function' ? require('./cropper') : root.SCCropper);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.SCExporter = mod;
})(typeof self !== 'undefined' ? self : this, function (G, C) {
  'use strict';

  /**
   * 渲染单个目标的输出画布（目标真实分辨率）
   * @param sourceCanvas 原图 canvas
   * @param target       {id,name,width,height}
   * @param analysis     app.computeAnalysis 的结果（含 mode/crop/padLayout）
   * @param padColor     带留白补边色
   */
  function renderOutput(sourceCanvas, target, analysis, padColor) {
    const out = document.createElement('canvas');
    out.width = target.width;
    out.height = target.height;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (analysis.mode === 'pad') {
      // 先铺满补边色，再把整张原图按 imageRect 等比绘制（全图完整保留）
      ctx.fillStyle = padColor || '#0b1020';
      ctx.fillRect(0, 0, target.width, target.height);
      const ir = analysis.padLayout.imageRect;
      ctx.drawImage(sourceCanvas, ir.x, ir.y, ir.w, ir.h);
    } else {
      const crop = analysis.crop;
      ctx.drawImage(
        sourceCanvas,
        crop.x, crop.y, crop.w, crop.h,
        0, 0, target.width, target.height
      );
    }
    return out;
  }

  function downloadCanvas(canvas, filename, type, quality) {
    const mime = type || 'image/png';
    const url = canvas.toDataURL(mime, quality || 0.92);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 200);
  }

  function safeName(s) {
    return String(s || 'target').replace(/[\\/:*?"<>|\s]+/g, '_');
  }

  /**
   * 框位置清单（单个目标）
   * 所有坐标同时给出原图像素与归一化两套，关注区给出在该方案下的保留比例。
   */
  function buildFrameEntry(target, analysis, regions, imgW, imgH, padColor) {
    const entry = {
      targetId: target.id,
      targetName: target.name,
      outputSize: { width: target.width, height: target.height },
      mode: analysis.mode,
      effectiveImageRatio: Number(analysis.effectiveRatio.toFixed(4)),
      padColor: analysis.mode === 'pad' ? (padColor || '#0b1020') : null,
    };

    if (analysis.mode === 'crop') {
      const c = analysis.crop;
      entry.cropRectPx = { x: round(c.x), y: round(c.y), w: round(c.w), h: round(c.h) };
      entry.cropRectNormalized = G.roundRect(G.normalizeRect(c, imgW, imgH), 6);
      entry.conflicts = analysis.conflicts || [];
    } else {
      const ir = analysis.padLayout.imageRect;
      entry.paddedImageRectPx = { x: ir.x, y: ir.y, w: ir.w, h: ir.h };
      entry.scale = Number(analysis.padLayout.scale.toFixed(6));
      entry.note = '整张原图完整保留，补边区域不计入有效图像占比';
    }

    entry.regions = regions.map((r) => {
      const px = G.denormalizeRect(r, imgW, imgH);
      let status;
      let ratio;
      if (analysis.mode === 'pad') {
        status = 'full';
        ratio = 1;
      } else {
        const overlap = G.intersectionArea(analysis.crop, px);
        ratio = G.area(px) > 0 ? G.clamp(overlap / G.area(px), 0, 1) : 1;
        status = ratio >= 1 - 1e-4 ? 'full' : ratio <= 0.01 ? 'cropped-out' : 'partial';
      }
      return {
        id: r.id,
        label: r.label,
        priority: r.priority,
        rectNormalized: G.roundRect(r, 6),
        rectPx: { x: round(px.x), y: round(px.y), w: round(px.w), h: round(px.h) },
        retainedRatio: Number(ratio.toFixed(4)),
        status,
      };
    });
    return entry;
  }

  function round(v) {
    return Math.round(v * 100) / 100;
  }

  /** 全部目标的框位置清单 -> JSON 文件 */
  function exportFramesJSON(entries, imgW, imgH, sourceName) {
    const payload = {
      exportedAt: new Date().toISOString(),
      source: { name: sourceName || 'source', width: imgW, height: imgH },
      frames: entries,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'crop-frames-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  /** 顺序导出多张图片（浏览器单次手势后允许多次下载，间隔触发避免拦截） */
  async function exportAllImages(items) {
    for (let i = 0; i < items.length; i++) {
      const { canvas, filename, type } = items[i];
      downloadCanvas(canvas, filename, type);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return {
    renderOutput,
    downloadCanvas,
    buildFrameEntry,
    exportFramesJSON,
    exportAllImages,
    safeName,
  };
});
