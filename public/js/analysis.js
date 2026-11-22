/* analysis.js — 接缝诊断引擎（纯像素计算，与显示缩放完全无关）
 *
 * 两类指标（沿每条相对边缘逐行/逐列计算）：
 *   1. 颜色差 color：接缝两侧像素的每通道平均绝对差（0–255），衡量“电平错位”
 *   2. 亮度走势 trend：把图像首尾相接后，拼接点三点 (W-1, 0, 1) 上的二阶亮度差分
 *        L[W-1] − 2·L[0] + L[1]
 *      与纹理内部任意三点的二阶差分同形态：线性斜坡跨缝（斜率突变）时显著增大；
 *      对称平滑的过渡（如修正 feather、砖缝）跨缝三点共弧，数值与内部噪声同级，不会误报。
 *
 * 阈值不用固定常数，而取纹理内部自身的噪声水平 × 灵敏度，
 * 这样平滑贴图和高噪点贴图都能得到合理判定。
 */
(function (global) {
  'use strict';
  const C = (typeof module !== 'undefined' && module.exports)
    ? require('./core.js')
    : global.SeamCore;

  /** 采样内部像素的统计基线，步长随尺寸放大，上限约 6 万样本 */
  function interiorBaselines(buf) {
    const { data, width: W, height: H } = buf;
    const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 60000)));
    const firstDiffs = [];
    const slopeDiffs = [];

    for (let y = 1; y < H - 2; y += step) {
      for (let x = 1; x < W - 2; x += step) {
        const im1 = C.idx(x - 1, y, W);
        const i0 = C.idx(x, y, W);
        const i1 = C.idx(x + 1, y, W);
        const i2 = C.idx(x + 2, y, W);
        const lm1 = C.luminance(data[im1], data[im1 + 1], data[im1 + 2]);
        const l0 = C.luminance(data[i0], data[i0 + 1], data[i0 + 2]);
        const l1 = C.luminance(data[i1], data[i1 + 1], data[i1 + 2]);
        const l2 = C.luminance(data[i2], data[i2 + 1], data[i2 + 2]);
        firstDiffs.push(Math.abs(l1 - l0));
        // 相邻两段一阶斜率之差，与接缝处的走势差同形态
        slopeDiffs.push(Math.abs((l1 - l0) - (l0 - lm1)));
        slopeDiffs.push(Math.abs((l2 - l1) - (l1 - l0)));

        const iu = C.idx(x, y - 1, W);
        const id = C.idx(x, y + 1, W);
        const id2 = C.idx(x, y + 2, W);
        const lu = C.luminance(data[iu], data[iu + 1], data[iu + 2]);
        const ld = C.luminance(data[id], data[id + 1], data[id + 2]);
        const ld2 = C.luminance(data[id2], data[id2 + 1], data[id2 + 2]);
        slopeDiffs.push(Math.abs((ld - l0) - (l0 - lu)));
        slopeDiffs.push(Math.abs((ld2 - ld) - (ld - l0)));
      }
    }
    return {
      // 内部一阶对比的 85 分位 → 颜色差的噪声地板（高分位不会被自然纹理波动频繁突破）
      color: C.quantile(firstDiffs, 0.85),
      // 内部二阶差分的 85 分位 → 走势差的噪声地板
      trend: C.quantile(slopeDiffs, 0.85),
    };
  }

  /** 把逐位置布尔异常序列合并为边段 */
  function extractSegments(flags, colorArr, trendArr, thrColor, thrTrend, axis, size) {
    const gap = Math.max(2, Math.round(size * 0.01));
    const minLen = 2;
    // 评分需显著超过 1：两个指标都只是贴线越界时视为自然纹理波动，不报异常
    const minScore = 1.25;
    const raw = [];
    let runStart = -1;
    for (let i = 0; i <= size; i++) {
      const on = i < size && flags[i];
      if (on && runStart < 0) runStart = i;
      if (!on && runStart >= 0) {
        raw.push([runStart, i - 1]);
        runStart = -1;
      }
    }
    // 合并小间隔
    const merged = [];
    for (const seg of raw) {
      const last = merged[merged.length - 1];
      if (last && seg[0] - last[1] - 1 <= gap) last[1] = seg[1];
      else merged.push(seg.slice());
    }
    return merged
      .filter(([s, e]) => e - s + 1 >= minLen)
      .map(([s, e]) => {
        let maxColor = 0, maxTrend = 0, sumColor = 0;
        let colorFlag = false, trendFlag = false;
        for (let i = s; i <= e; i++) {
          if (colorArr[i] > maxColor) maxColor = colorArr[i];
          if (trendArr[i] > maxTrend) maxTrend = trendArr[i];
          sumColor += colorArr[i];
          if (colorArr[i] > thrColor) colorFlag = true;
          if (trendArr[i] > thrTrend) trendFlag = true;
        }
        const len = e - s + 1;
        return {
          axis,
          start: s,
          end: e,
          length: len,
          maxColor: C.round3(maxColor),
          meanColor: C.round3(sumColor / len),
          maxTrend: C.round3(maxTrend),
          score: C.round3(0.5 * (maxColor / thrColor) + 0.5 * (maxTrend / thrTrend)),
          colorFlag,
          trendFlag,
        };
      })
      .filter((seg) => seg.score >= minScore)
      .sort((a, b) => b.score - a.score);
  }

  /** 分析竖向接缝：左边缘(x=0) 对 右边缘(x=W-1)，逐行 y */
  function analyzeVertical(buf, base, sensitivity) {
    const { data, width: W, height: H } = buf;
    const color = new Float32Array(H);
    const luma = new Float32Array(H);
    const trend = new Float32Array(H);
    const flags = new Uint8Array(H);

    const thrColor = Math.max(2, base.color * sensitivity);
    const thrTrend = Math.max(2, base.trend * sensitivity);

    for (let y = 0; y < H; y++) {
      const iL = C.idx(0, y, W);
      const iR = C.idx(W - 1, y, W);
      const rL = data[iL], gL = data[iL + 1], bL = data[iL + 2];
      const rR = data[iR], gR = data[iR + 1], bR = data[iR + 2];
      color[y] = (Math.abs(rR - rL) + Math.abs(gR - gL) + Math.abs(bR - bL)) / 3;
      luma[y] = Math.abs(C.luminance(rR, gR, bR) - C.luminance(rL, gL, bL));

      // 走势差：把图像按平铺方式首尾相接，取“拼接点”上的二阶亮度差分。
      // 平铺顺序 ...R[W-2], R[W-1] | L[0], L[1]...，拼接三点为 (W-1, 0, 1)：
      //   L[W-1] − 2·L[0] + L[1]
      // 与纹理内部任意三点的二阶差分同形态：
      //   · 线性斜坡的拼接点两侧斜率不同 → 二阶差分大（真实露线）
      //   · 对称平滑的 feather 跨缝三点共弧 → 二阶差分与内部噪声同级（不误报）
      const iL1 = C.idx(1, y, W);
      const iR0 = C.idx(W - 1, y, W);
      const lumL0 = C.luminance(rL, gL, bL);
      const lumL1 = C.luminance(data[iL1], data[iL1 + 1], data[iL1 + 2]);
      const lumR0 = C.luminance(rR, gR, bR);
      trend[y] = Math.abs(lumR0 - 2 * lumL0 + lumL1);

      flags[y] = color[y] > thrColor || trend[y] > thrTrend ? 1 : 0;
    }

    return {
      color, luma, trend, flags,
      thresholdColor: C.round3(thrColor),
      thresholdTrend: C.round3(thrTrend),
      baselineColor: C.round3(base.color),
      baselineTrend: C.round3(base.trend),
      meanColor: C.round3(C.mean(Array.from(color))),
      meanLuma: C.round3(C.mean(Array.from(luma))),
      meanTrend: C.round3(C.mean(Array.from(trend))),
      maxColor: C.round3(Math.max.apply(null, Array.from(color))),
      maxTrend: C.round3(Math.max.apply(null, Array.from(trend))),
      segments: extractSegments(flags, color, trend, thrColor, thrTrend, 'v', H),
    };
  }

  /** 分析横向接缝：上边缘(y=0) 对 下边缘(y=H-1)，逐列 x */
  function analyzeHorizontal(buf, base, sensitivity) {
    const { data, width: W, height: H } = buf;
    const color = new Float32Array(W);
    const luma = new Float32Array(W);
    const trend = new Float32Array(W);
    const flags = new Uint8Array(W);

    const thrColor = Math.max(2, base.color * sensitivity);
    const thrTrend = Math.max(2, base.trend * sensitivity);

    for (let x = 0; x < W; x++) {
      const iT = C.idx(x, 0, W);
      const iB = C.idx(x, H - 1, W);
      const rT = data[iT], gT = data[iT + 1], bT = data[iT + 2];
      const rB = data[iB], gB = data[iB + 1], bB = data[iB + 2];
      color[x] = (Math.abs(rB - rT) + Math.abs(gB - gT) + Math.abs(bB - bT)) / 3;
      luma[x] = Math.abs(C.luminance(rB, gB, bB) - C.luminance(rT, gT, bT));

      // 走势差：环绕拼接点三点 (H-1, 0, 1) 上的二阶亮度差分
      //   L[H-1] − 2·L[0] + L[1]
      const iT1 = C.idx(x, 1, W);
      const lumT0 = C.luminance(rT, gT, bT);
      const lumT1 = C.luminance(data[iT1], data[iT1 + 1], data[iT1 + 2]);
      const lumB0 = C.luminance(rB, gB, bB);
      trend[x] = Math.abs(lumB0 - 2 * lumT0 + lumT1);

      flags[x] = color[x] > thrColor || trend[x] > thrTrend ? 1 : 0;
    }

    return {
      color, luma, trend, flags,
      thresholdColor: C.round3(thrColor),
      thresholdTrend: C.round3(thrTrend),
      baselineColor: C.round3(base.color),
      baselineTrend: C.round3(base.trend),
      meanColor: C.round3(C.mean(Array.from(color))),
      meanLuma: C.round3(C.mean(Array.from(luma))),
      meanTrend: C.round3(C.mean(Array.from(trend))),
      maxColor: C.round3(Math.max.apply(null, Array.from(color))),
      maxTrend: C.round3(Math.max.apply(null, Array.from(trend))),
      segments: extractSegments(flags, color, trend, thrColor, thrTrend, 'h', W),
    };
  }

  /** 四角点：每个角同时落在一条竖向接缝与一条横向接缝上，单独评分 */
  function analyzeCorners(vRes, hRes) {
    const defs = [
      { name: '左上 (0,0)', x: 0, y: 0, vy: 0, hx: 0 },
      { name: '右上 (W−1,0)', x: -1, y: 0, vy: 0, hx: -1 },
      { name: '左下 (0,H−1)', x: 0, y: -1, vy: -1, hx: 0 },
      { name: '右下 (W−1,H−1)', x: -1, y: -1, vy: -1, hx: -1 },
    ];
    return defs.map((d) => {
      const yi = d.vy < 0 ? vRes.color.length - 1 : 0;
      const xi = d.hx < 0 ? hRes.color.length - 1 : 0;
      // 越界倍数：<=1 记 0，超出部分才累加，避免“完全为 0 的边”把角点拉成异常
      const excess = (val, thr) => Math.max(0, val / thr - 1);
      const parts = [
        excess(vRes.color[yi], vRes.thresholdColor),
        excess(vRes.trend[yi], vRes.thresholdTrend),
        excess(hRes.color[xi], hRes.thresholdColor),
        excess(hRes.trend[xi], hRes.thresholdTrend),
      ];
      const score = parts.reduce((a, b) => a + b, 0) / 4;
      return {
        name: d.name,
        cornerX: d.x,
        cornerY: d.y,
        vColor: C.round3(vRes.color[yi]),
        vTrend: C.round3(vRes.trend[yi]),
        hColor: C.round3(hRes.color[xi]),
        hTrend: C.round3(hRes.trend[xi]),
        score: C.round3(score),
        bad: parts.some((p) => p > 0),
      };
    });
  }

  function analyzeSeams(buf, sensitivity) {
    sensitivity = sensitivity || 2.5;
    const base = interiorBaselines(buf);
    const vertical = analyzeVertical(buf, base, sensitivity);
    const horizontal = analyzeHorizontal(buf, base, sensitivity);
    const corners = analyzeCorners(vertical, horizontal);
    return {
      width: buf.width,
      height: buf.height,
      sensitivity,
      baselines: { color: C.round3(base.color), trend: C.round3(base.trend) },
      vertical,
      horizontal,
      corners,
    };
  }

  const api = { analyzeSeams, interiorBaselines, extractSegments };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.SeamAnalysis = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
