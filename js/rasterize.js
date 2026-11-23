/*
 * 光栅化：把 buildWarp 的源坐标数组采样成展开图 ImageData。
 * status!=0 的像素一律不取样、保持透明，并由 hatching 单独画标记，
 * 保证“没拍到 / 被限制 / 源图外”不会出现看似有效的颜色。
 */
(function (global) {
  'use strict';

  function bilinear(src, x, y, w, h) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
    const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    const out = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const top = src[i00 + k] * (1 - fx) + src[i10 + k] * fx;
      const bot = src[i01 + k] * (1 - fx) + src[i11 + k] * fx;
      out[k] = top * (1 - fy) + bot * fy;
    }
    return out;
  }

  /** 单个视角的展开结果：RGBA ImageData + 每像素状态/源坐标/角度/拉伸 */
  function renderWarp(warp, srcImageData) {
    const { W, H, sx, sy, status } = warp;
    const src = srcImageData.data;
    const sw = srcImageData.width, sh = srcImageData.height;
    const out = new ImageData(W, H);
    const d = out.data;
    for (let i = 0; i < W * H; i++) {
      if (status[i] !== 0) continue; // 透明 NO-DATA
      const px = bilinear(src, sx[i], sy[i], sw, sh);
      const o = i * 4;
      d[o] = px[0]; d[o + 1] = px[1]; d[o + 2] = px[2]; d[o + 3] = 255;
    }
    return out;
  }

  /** 在预览上叠加 NO-DATA 标记：品红斜线=超取用角，黄色点=源图外。
   *  status 为行优先 (y*W+x)，同列状态一致，取首行即可。 */
  function drawHatching(ctx, warp, opts = {}) {
    const { W, H, status } = warp;
    ctx.save();
    const spacing = 8;
    for (let x = 0; x < W; x++) {
      const colStatus = status[x]; // 首行索引即列号
      if (colStatus === 1) {
        ctx.fillStyle = 'rgba(255,0,255,0.22)';
        ctx.fillRect(x, 0, 1, H);
      } else if (colStatus === 2) {
        ctx.fillStyle = 'rgba(255,210,0,0.18)';
        ctx.fillRect(x, 0, 1, H);
      }
    }
    ctx.strokeStyle = 'rgba(255,0,255,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      if (status[x] !== 1) continue;
      for (let y = -spacing; y < H; y += spacing) {
        ctx.moveTo(x - 3, y);
        ctx.lineTo(x + 3, y + 6);
      }
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(200,150,0,0.8)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      if (status[x] !== 2) continue;
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 覆盖范围图：绿=有效，品红=超角限制，黄=源图外，灰=无任何数据 */
  function coverageImage(warp) {
    const { W, H, status } = warp;
    const img = new ImageData(W, H);
    const d = img.data;
    const colors = {
      0: [60, 200, 90],
      1: [255, 0, 255],
      2: [255, 210, 0],
    };
    for (let i = 0; i < W * H; i++) {
      const c = colors[status[i]] || [128, 128, 128];
      const o = i * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    return img;
  }

  /**
   * 源图采样安全距离：控制点到图像四边的最小距离。
   * 距离过小意味着展开采样会频繁落到源图外，给提示。
   */
  function edgeMargins(c, imgW, imgH) {
    let min = Infinity;
    for (const k of ['LT', 'RT', 'LB', 'RB', 'TM', 'BM']) {
      const p = c[k];
      min = Math.min(min, p[0], imgW - 1 - p[0], p[1], imgH - 1 - p[1]);
    }
    return min;
  }

  global.CylRaster = { renderWarp, drawHatching, coverageImage, bilinear, edgeMargins };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.CylRaster;
})(typeof window !== 'undefined' ? window : globalThis);
