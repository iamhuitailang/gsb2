/*
 * 双视角合并：在共享画布（A 的局部展开坐标系）上合成。
 * 每个像素记录来源（A/B/both/none），任何来源都不覆盖 NO-DATA，
 * 空白永远保持空白，绝不用已有一圈的数据把背面补成有效数据。
 */
(function (global) {
  'use strict';

  const SRC_NONE = 0, SRC_A = 1, SRC_B = 2, SRC_BOTH = 3;

  /** 采样展开 ImageData 的最近邻（展开图本身已是规则栅格，无需再插值） */
  function sampleNN(img, x, y) {
    const W = img.width, H = img.height;
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return null;
    const i = (iy * W + ix) * 4;
    if (img.data[i + 3] === 0) return null; // 该视角此处是 NO-DATA
    return [img.data[i], img.data[i + 1], img.data[i + 2], i];
  }

  /**
   * @param viewA {img, warp} 视角 A 的展开图与映射
   * @param viewB {img, warp, M} B→A 的相似变换（fitSimilarity 的 M）
   * @param mode 'A' | 'B' | 'average' | 'brighter'
   * @returns {merged:ImageData, source:Uint8Array, lumaDiff:Float32Array}
   */
  function mergeViews(viewA, viewB, mode) {
    const W = viewA.img.width, H = viewA.img.height;
    const merged = new ImageData(W, H);
    const source = new Uint8Array(W * H);
    const lumaDiff = new Float32Array(W * H);
    const d = merged.data;
    const inv = viewB && viewB.M ? global.CylGeo.invertSim(viewB.M) : null;
    const luma = (px) => 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const pa = sampleNN(viewA.img, x, y);
        let pb = null;
        if (viewB && inv) {
          const q = global.CylGeo.applySim(inv, x, y);
          pb = sampleNN(viewB.img, q[0], q[1]);
        }
        const o = i * 4;
        if (pa && pb) {
          source[i] = SRC_BOTH;
          const la = luma(pa), lb = luma(pb);
          lumaDiff[i] = la - lb;
          for (let k = 0; k < 3; k++) {
            let v;
            if (mode === 'A') v = pa[k];
            else if (mode === 'B') v = pb[k];
            else if (mode === 'brighter') v = la >= lb ? pa[k] : pb[k];
            else v = (pa[k] + pb[k]) / 2;
            d[o + k] = v;
          }
          d[o + 3] = 255;
        } else if (pa) {
          source[i] = SRC_A;
          d[o] = pa[0]; d[o + 1] = pa[1]; d[o + 2] = pa[2]; d[o + 3] = 255;
        } else if (pb) {
          source[i] = SRC_B;
          d[o] = pb[0]; d[o + 1] = pb[1]; d[o + 2] = pb[2]; d[o + 3] = 255;
        }
      }
    }
    return { merged, source, lumaDiff };
  }

  /** 覆盖层颜色：蓝=仅A，橙=仅B，紫=重合；无数据区保持透明，交给灰斜纹单独标记。
   *  必须用临时 canvas + drawImage 叠加；putImageData 是整体替换会冲掉底图。 */
  function drawCoverage(ctx, merge, W, H) {
    const layer = document.createElement('canvas');
    layer.width = W; layer.height = H;
    const lctx = layer.getContext('2d');
    const img = lctx.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      const s = merge.source[i];
      if (s === SRC_A) [d[o], d[o + 1], d[o + 2]] = [70, 130, 255];
      else if (s === SRC_B) [d[o], d[o + 1], d[o + 2]] = [255, 150, 60];
      else if (s === SRC_BOTH) [d[o], d[o + 1], d[o + 2]] = [180, 90, 220];
      d[o + 3] = s === SRC_NONE ? 0 : 150;
    }
    lctx.putImageData(img, 0, 0);
    ctx.drawImage(layer, 0, 0);
  }

  /** 亮度分歧热力叠加：重合区 |ΔY| 超阈值处描红（同样走临时 canvas 叠加） */
  function drawLumaConflict(ctx, merge, W, H, threshold) {
    const layer = document.createElement('canvas');
    layer.width = W; layer.height = H;
    const lctx = layer.getContext('2d');
    const img = lctx.createImageData(W, H);
    const d = img.data;
    for (let i = 0; i < W * H; i++) {
      if (merge.source[i] !== SRC_BOTH) continue;
      const diff = Math.abs(merge.lumaDiff[i]);
      if (diff < threshold) continue;
      const o = i * 4;
      d[o] = 255; d[o + 1] = 40; d[o + 2] = 40;
      d[o + 3] = Math.min(220, 80 + diff * 2);
    }
    lctx.putImageData(img, 0, 0);
    ctx.drawImage(layer, 0, 0);
  }

  /** 合并图坐标 → 各视角来源信息（查询/跳转） */
  function traceOrigin(merge, viewA, viewB, x, y) {
    const W = viewA.img.width, H = viewA.img.height;
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return null;
    const i = iy * W + ix;
    const out = { x: ix, y: iy, source: merge.source[i], lumaDiff: merge.lumaDiff[i], a: null, b: null };
    if (merge.source[i] === SRC_A || merge.source[i] === SRC_BOTH) {
      out.a = { localX: ix, localY: iy };
    }
    if ((merge.source[i] === SRC_B || merge.source[i] === SRC_BOTH) && viewB && viewB.M) {
      const inv = global.CylGeo.invertSim(viewB.M);
      out.b = { local: global.CylGeo.applySim(inv, ix, iy) };
    }
    return out;
  }

  global.CylMerge = {
    SRC_NONE, SRC_A, SRC_B, SRC_BOTH,
    mergeViews, drawCoverage, drawLumaConflict, traceOrigin,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.CylMerge;
})(typeof window !== 'undefined' ? window : globalThis);
