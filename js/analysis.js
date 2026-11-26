/**
 * analysis.js — 可辨认性分析（只依赖 RGBA 缓冲区，可在 Node 下单测）
 *
 * 设计要点：
 *  - 所有色差都在“当前视图模式转换后的真实合成像素”上计算，
 *    即正常/红色盲/绿色盲/灰度看到什么就量什么；
 *  - 局部背景 = 每个图标像素最近的、未被任何提示覆盖的背景像素（距离变换），
 *    不使用平均色；
 *  - 全不透明 / 半透明边缘 / 全透明 三类分开统计；
 *  - 两提示之间按重叠区域逐像素比较；不重叠时改量两者最近边缘距离。
 */
(function (root, factory) {
  const C = (typeof require === 'function') ? require('./color') : root.C;
  const Geo = (typeof require === 'function') ? require('./geometry') : root.Geo;
  const api = factory(C, Geo);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Analysis = api;
})(typeof self !== 'undefined' ? self : this, function (C, Geo) {
  'use strict';

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const idx = (x, y, W) => (y * W + x) * 4;

  function makeLabLut(frame) {
    const n = frame.length / 4;
    const L = new Float32Array(n);
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      if (frame[i + 3] === 0) { L[p] = NaN; continue; }
      const lab = C.rgbToLab(frame[i], frame[i + 1], frame[i + 2]);
      L[p] = lab.L; a[p] = lab.a; b[p] = lab.b;
    }
    return { L, a, b };
  }
  function lutLab(lut, p) { return { L: lut.L[p], a: lut.a[p], b: lut.b[p] }; }

  /** 任意图标覆盖掩膜（alpha > 全透明阈值即算覆盖），用于提取“干净背景” */
  function buildCoveredMask(W, H, icons) {
    const covered = new Uint8Array(W * H);
    for (const ic of icons) {
      const { x0, y0, W: iw, H: ih, alpha } = ic;
      for (let y = 0; y < ih; y++) {
        const fy = y0 + y;
        if (fy < 0 || fy >= H) continue;
        for (let x = 0; x < iw; x++) {
          const fx = x0 + x;
          if (fx < 0 || fx >= W) continue;
          if (alpha[y * iw + x] > Geo.ALPHA_EDGE_LO) covered[fy * W + fx] = 1;
        }
      }
    }
    return covered;
  }

  /**
   * 单个提示 vs 局部背景
   * @param frame  视图模式转换后的整帧 RGBA
   * @param lut    整帧 Lab 查找表
   * @param icon   {id,name,x0,y0,W,H,alpha[]}（alpha 为该图标在画面中的逐像素 alpha）
   * @param covered 任意提示覆盖掩膜
   * @param metric '2000' | '76'
   */
  function analyzeIcon(frame, lut, W, H, icon, covered, metric) {
    const delta = metric === '76' ? C.deltaE76 : C.deltaE2000;
    const backgroundTarget = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) {
      if (!covered[p] && frame[p * 4 + 3] > 0) backgroundTarget[p] = 1;
    }
    const { nearest, dist } = Geo.nearestTarget(W, H, backgroundTarget);

    const buckets = { full: [], edge: [], transparent: [] };
    const heat = new Float32Array(W * H);   // 图标像素色差，其余为 0
    const valid = new Uint8Array(W * H);    // heat 有效位
    const contrastFull = [];
    let worst = []; // {x,y,dE,cls,bgX,bgY,bgRgb,fgRgb,bgDist}

    const { x0, y0, W: iw, H: ih, alpha } = icon;
    for (let y = 0; y < ih; y++) {
      const fy = y0 + y;
      if (fy < 0 || fy >= H) continue;
      for (let x = 0; x < iw; x++) {
        const fx = x0 + x;
        if (fx < 0 || fx >= W) continue;
        const p = fy * W + fx;
        const av = alpha[y * iw + x];
        const cls = Geo.alphaClass(av);
        if (cls === 'transparent') { buckets.transparent.push(1); continue; }
        const bp = nearest[p];
        if (bp < 0) continue; // 整帧没有可用背景（极端情况）
        const fg = lutLab(lut, p);
        const bg = lutLab(lut, bp);
        const dE = delta(fg, bg);
        buckets[cls].push(dE);
        heat[p] = dE; valid[p] = 1;
        const fi = p * 4, bi = bp * 4;
        worst.push({
          x: fx, y: fy, dE, cls,
          bgX: bp % W, bgY: Math.floor(bp / W),
          bgDist: dist[p],
          fgRgb: [frame[fi], frame[fi + 1], frame[fi + 2]],
          bgRgb: [frame[bi], frame[bi + 1], frame[bi + 2]],
        });
        if (cls === 'full') {
          contrastFull.push(C.contrastRatio(
            { r: frame[fi], g: frame[fi + 1], b: frame[fi + 2] },
            { r: frame[bi], g: frame[bi + 1], b: frame[bi + 2] },
          ));
        }
      }
    }
    worst.sort((a, b) => a.dE - b.dE);
    worst = worst.slice(0, 15);

    const summary = {
      full: Geo.summarize(buckets.full),
      edge: Geo.summarize(buckets.edge),
      transparentCount: buckets.transparent.length,
      contrastFull: Geo.summarize(contrastFull),
    };
    return {
      iconId: icon.id, metric, W, H,
      heat, valid, summary, worst,
      thresholds: Geo.passRates(buckets.full.concat(buckets.edge), [3, 5, 8, 12]),
    };
  }

  /**
   * 两个提示之间的可区分度：取各自单独合成画面，在掩膜重叠区逐像素量色差。
   * soloA/soloB 为只渲染对应提示后的整帧 RGBA（同一种视图模式）。
   */
  function analyzePair(frame, soloA, soloB, lutA, lutB, W, H, iconA, iconB, coveredA, coveredB, metric) {
    const delta = metric === '76' ? C.deltaE76 : C.deltaE2000;
    const overlapMask = new Uint8Array(W * H);
    let overlapCount = 0;
    for (let p = 0; p < W * H; p++) {
      if (coveredA[p] && coveredB[p]) { overlapMask[p] = 1; overlapCount++; }
    }
    const edge = [], full = [];
    const heat = new Float32Array(W * H);
    const valid = new Uint8Array(W * H);
    let worst = [];
    if (overlapCount) {
      for (let p = 0; p < W * H; p++) {
        if (!overlapMask[p]) continue;
        const dE = delta(lutLab(lutA, p), lutLab(lutB, p));
        const cls = Geo.alphaClass(Math.min(frame[p * 4 + 3], 255)); // 重叠合成后的类别
        (cls === 'full' ? full : edge).push(dE);
        heat[p] = dE; valid[p] = 1;
        const i = p * 4;
        worst.push({
          x: p % W, y: Math.floor(p / W), dE, cls,
          rgbA: [soloA[i], soloA[i + 1], soloA[i + 2]],
          rgbB: [soloB[i], soloB[i + 1], soloB[i + 2]],
        });
      }
    }
    // 不重叠：求两个掩膜之间的最近像素距离
    let minGap = Infinity;
    if (!overlapCount) {
      const dtA = Geo.nearestTarget(W, H, coveredA);
      for (let p = 0; p < W * H; p++) {
        if (coveredB[p] && dtA.dist[p] < minGap) minGap = dtA.dist[p];
      }
    }
    worst.sort((a, b) => a.dE - b.dE);
    worst = worst.slice(0, 15);
    return {
      iconA: iconA.id, iconB: iconB.id, metric,
      overlapCount, minGap: isFinite(minGap) ? minGap : null,
      full: Geo.summarize(full),
      edge: Geo.summarize(edge),
      heat, valid, worst,
      thresholds: Geo.passRates(full.concat(edge), [3, 5, 8, 12]),
    };
  }

  /**
   * 最难位置扫描：在背景上平移指定图标，逐位置打分。
   * @param renderAt 异步回调 (x,y) => {frame, iconBuffer}，由渲染层提供
   * @param opts {W,H,iconW,iconH,step,metric,onProgress,signal:{cancelled:boolean}}
   * @returns {grid: Float32Array, cols, rows, originX, originY, step, best, worst}
   */
  async function scanWorstPositions(renderAt, opts) {
    const { W, H, iconW, iconH, step = 8, metric = '76', onProgress, signal } = opts;
    const cols = Math.max(1, Math.floor((W - iconW) / step) + 1);
    const rows = Math.max(1, Math.floor((H - iconH) / step) + 1);
    const grid = new Float32Array(cols * rows);
    const p5grid = new Float32Array(cols * rows);
    const mingrid = new Float32Array(cols * rows);
    let worst = { score: -Infinity, gx: 0, gy: 0, x: 0, y: 0 };
    let best = { score: Infinity, gx: 0, gy: 0, x: 0, y: 0 };
    const delta = metric === '76' ? C.deltaE76 : C.deltaE2000;
    const total = cols * rows;
    let done = 0;

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        if (signal && signal.cancelled) {
          return { cancelled: true, grid, cols, rows, step, progress: done / total };
        }
        const x = gx * step, y = gy * step;
        const { frame, iconAlpha } = await renderAt(x, y);
        const lut = makeLabLut(frame);
        // 对图标可见像素，找最近背景像素（图标外扩环带内局部搜索）
        const dEs = await localDeltas(frame, lut, W, H, x, y, iconW, iconH, iconAlpha, delta);
        const s = Geo.summarize(dEs);
        const k = gy * cols + gx;
        grid[k] = s.mean;
        p5grid[k] = isNaN(s.p5) ? NaN : s.p5;
        mingrid[k] = isNaN(s.min) ? NaN : s.min;
        const score = s.mean;
        if (isFinite(score)) {
          if (score < best.score) best = { score, gx, gy, x, y };
          if (score > worst.score) worst = { score, gx, gy, x, y };
        }
        done++;
        if (onProgress && (done % 5 === 0 || done === total)) onProgress(done / total);
        if (done % 20 === 0) await sleep(0);
      }
    }
    // “最难分辨”= 平均分最低的位置
    let hardest = { score: Infinity, gx: 0, gy: 0, x: 0, y: 0 };
    let easiest = { score: -Infinity, gx: 0, gy: 0, x: 0, y: 0 };
    for (let k = 0; k < grid.length; k++) {
      const v = grid[k];
      if (!isFinite(v)) continue;
      if (v < hardest.score) hardest = { score: v, gx: k % cols, gy: Math.floor(k / cols), x: (k % cols) * step, y: Math.floor(k / cols) * step };
      if (v > easiest.score) easiest = { score: v, gx: k % cols, gy: Math.floor(k / cols), x: (k % cols) * step, y: Math.floor(k / cols) * step };
    }
    return {
      grid, p5grid, mingrid, cols, rows, step, metric,
      hardest, easiest,
    };
  }

  /**
   * 扫描内部：在图标包围盒外扩 ring 像素内找最近背景像素。
   * 背景像素 = 不在当前图标掩膜内的像素（单图标场景等价于干净背景）。
   */
  async function localDeltas(frame, lut, W, H, x0, y0, iw, ih, alpha, delta) {
    const RING = 6;
    const ring = [];
    const xLo = Math.max(0, x0 - RING), xHi = Math.min(W - 1, x0 + iw - 1 + RING);
    const yLo = Math.max(0, y0 - RING), yHi = Math.min(H - 1, y0 + ih - 1 + RING);
    for (let y = yLo; y <= yHi; y++) {
      for (let x = xLo; x <= xHi; x++) {
        const inside = x >= x0 && x < x0 + iw && y >= y0 && y < y0 + ih;
        if (inside && alpha[(y - y0) * iw + (x - x0)] > Geo.ALPHA_EDGE_LO) continue;
        const p = y * W + x;
        if (frame[p * 4 + 3] > 0) ring.push(p);
      }
    }
    const out = [];
    for (let y = 0; y < ih; y++) {
      const fy = y0 + y;
      if (fy < 0 || fy >= H) continue;
      for (let x = 0; x < iw; x++) {
        const fx = x0 + x;
        if (fx < 0 || fx >= W) continue;
        if (alpha[y * iw + x] <= Geo.ALPHA_EDGE_LO) continue;
        const p = fy * W + fx;
        let bp = -1, bd = Infinity;
        for (const q of ring) {
          const dx = (q % W) - fx, dy = Math.floor(q / W) - fy;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; bp = q; }
        }
        if (bp < 0) continue;
        out.push(delta(lutLab(lut, p), lutLab(lut, bp)));
      }
    }
    return out;
  }

  return {
    makeLabLut, buildCoveredMask, analyzeIcon, analyzePair,
    scanWorstPositions, localDeltas, idx,
  };
});
