/*
 * cropper.js — 智能裁切核心算法（纯逻辑，无 DOM 依赖）
 *
 * 输入均为原图像素坐标，关注区通过 geometry.denormalizeRect 从归一化坐标换算。
 * 核心思路：
 *   1. 按目标宽高比求原图内最大裁切框 cw×ch；
 *   2. 每个"必须保留"区给出裁切框左上角的可行区间 (x∈[lo,hi], y∈[lo,hi])；
 *   3. 区间交集即同时完整保留多个区域的可行域；交集为空则枚举最优可保留子集，
 *      并输出具体冲突（哪两个区域不能共存 / 哪个区域比裁切框还大）；
 *   4. 在可行域内按"尽量保留区完整度 + 中心贴合度"打分选位。
 */
(function (root, factory) {
  const mod = factory(typeof require === 'function' ? require('./geometry') : root.SCGeometry);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.SCCropper = mod;
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  const EPS = 1e-4;

  /** 目标宽高比下，原图内能放下的最大裁切框尺寸 */
  function maxFittingCrop(imgW, imgH, targetW, targetH) {
    const targetAspect = targetW / targetH;
    const imgAspect = imgW / imgH;
    let cw;
    let ch;
    // 用相对容差比较比例，吸收 2000.0000000000002 这类浮点误差，
    // 保证裁切框严格保持目标宽高比且不超出原图
    if (imgAspect > targetAspect * (1 + EPS)) {
      // 原图更宽：高度拉满，宽度按比例反推
      ch = imgH;
      cw = ch * targetAspect;
    } else if (imgAspect < targetAspect * (1 - EPS)) {
      // 原图更窄：宽度拉满，高度按比例反推
      cw = imgW;
      ch = cw / targetAspect;
    } else {
      // 比例一致（容差内）：直接取原图尺寸
      cw = imgW;
      ch = imgH;
    }
    return { cw, ch };
  }

  /**
   * 单个区域对裁切框左上角的可行区间。
   * 区域本身比裁切框大时返回 null（任何位置都无法完整保留）。
   */
  function feasibleRange(region, cw, ch, imgW, imgH) {
    if (region.w > cw + EPS || region.h > ch + EPS) return null;
    const loX = Math.max(0, region.x + region.w - cw);
    const hiX = Math.min(imgW - cw, region.x);
    const loY = Math.max(0, region.y + region.h - ch);
    const hiY = Math.min(imgH - ch, region.y);
    if (loX > hiX + EPS || loY > hiY + EPS) return null;
    return {
      x: [loX, hiX],
      y: [loY, hiY],
    };
  }

  function intersectRanges(ranges) {
    if (!ranges.length) return null;
    const out = {
      x: [
        Math.max.apply(null, ranges.map((r) => r.x[0])),
        Math.min.apply(null, ranges.map((r) => r.x[1])),
      ],
      y: [
        Math.max.apply(null, ranges.map((r) => r.y[0])),
        Math.min.apply(null, ranges.map((r) => r.y[1])),
      ],
    };
    if (out.x[0] > out.x[1] + EPS || out.y[0] > out.y[1] + EPS) return null;
    return out;
  }

  /** 枚举所有子集，返回能同时完整保留的最大子集（数量优先，面积次之） */
  function findBestSubset(required, ranges, cw, ch, imgW, imgH) {
    const n = required.length;
    let best = [];
    let bestArea = -1;
    for (let mask = 1; mask < (1 << n); mask++) {
      const picked = [];
      const pickedRanges = [];
      let area = 0;
      for (let i = 0; i < n; i++) {
        if (!(mask & (1 << i))) continue;
        const rg = ranges[i];
        if (!rg) {
          picked.length = 0;
          break;
        }
        picked.push(required[i]);
        pickedRanges.push(rg);
        area += G.area(required[i]);
      }
      if (!picked.length) continue;
      if (!intersectRanges(pickedRanges)) continue;
      if (
        picked.length > best.length ||
        (picked.length === best.length && area > bestArea)
      ) {
        best = picked;
        bestArea = area;
      }
    }
    return best;
  }

  /**
   * 冲突清单：
   *  - {type:'oversize', regionId}  区域比裁切框还大，任何方案都保不住
   *  - {type:'pair', a, b}          两区域各自能放下，但无法同时完整保留
   */
  function detectConflicts(required, ranges) {
    const conflicts = [];
    const fitIds = [];
    required.forEach((r, i) => {
      if (!ranges[i]) conflicts.push({ type: 'oversize', regionId: r.id });
      else fitIds.push(i);
    });
    for (let a = 0; a < fitIds.length; a++) {
      for (let b = a + 1; b < fitIds.length; b++) {
        const ia = fitIds[a];
        const ib = fitIds[b];
        if (!intersectRanges([ranges[ia], ranges[ib]])) {
          conflicts.push({
            type: 'pair',
            a: required[ia].id,
            b: required[ib].id,
          });
        }
      }
    }
    return conflicts;
  }

  function clampToRange(v, range) {
    return G.clamp(v, range[0], range[1]);
  }

  /** 评估某个裁切框对关注区的保留情况 */
  function evaluate(crop, regions) {
    const required = [];
    const preferred = [];
    regions.forEach((r) => {
      const full = G.containsRect(crop, r, EPS);
      const overlap = G.intersectionArea(crop, r);
      const ratio = G.area(r) > 0 ? G.clamp(overlap / G.area(r), 0, 1) : 1;
      const info = { id: r.id, ratio, contained: full };
      if (r.priority === 'required') required.push(info);
      else preferred.push(info);
    });
    return {
      containedRequired: required.filter((r) => r.contained).map((r) => r.id),
      missingRequired: required.filter((r) => !r.contained).map((r) => r.id),
      preferred,
    };
  }

  /**
   * 自动裁切。
   * @param {number} imgW 原图宽（像素）
   * @param {number} imgH 原图高（像素）
   * @param {Array}  regions 像素坐标关注区 [{id,x,y,w,h,priority:'required'|'preferred'}]
   * @param {number} targetW 目标宽（决定宽高比，输出裁切比例由原图反推）
   * @param {number} targetH 目标高
   * @returns 完整方案与保留情况
   */
  function autoCrop(imgW, imgH, regions, targetW, targetH) {
    const { cw, ch } = maxFittingCrop(imgW, imgH, targetW, targetH);
    const required = regions.filter((r) => r.priority === 'required');
    const preferred = regions.filter((r) => r.priority === 'preferred');

    const ranges = required.map((r) => feasibleRange(r, cw, ch, imgW, imgH));
    const allFitRanges = ranges.filter(Boolean);
    let feasible = allFitRanges.length === required.length ? intersectRanges(allFitRanges) : null;

    let kept = required;
    if (!feasible) {
      kept = findBestSubset(required, ranges, cw, ch, imgW, imgH);
      const keptRanges = kept
        .map((r) => ranges[required.indexOf(r)])
        .filter(Boolean);
      feasible = keptRanges.length ? intersectRanges(keptRanges) : null;
    }

    // 没有任何可保留的必须区（或根本没有必须区）：可行域退化为整张原图
    if (!feasible) {
      feasible = { x: [0, Math.max(0, imgW - cw)], y: [0, Math.max(0, imgH - ch)] };
    }

    // 候选位置：可行域四角 + 各关注区中心夹紧 + 原图中心夹紧
    const candidates = [];
    const push = (x, y, tag) => {
      const cx = clampToRange(x, feasible.x);
      const cy = clampToRange(y, feasible.y);
      if (!candidates.some((c) => Math.abs(c.x - cx) < 0.5 && Math.abs(c.y - cy) < 0.5)) {
        candidates.push({ x: cx, y: cy, tag });
      }
    };
    push(feasible.x[0], feasible.y[0], 'corner');
    push(feasible.x[1], feasible.y[0], 'corner');
    push(feasible.x[0], feasible.y[1], 'corner');
    push(feasible.x[1], feasible.y[1], 'corner');
    push((feasible.x[0] + feasible.x[1]) / 2, (feasible.y[0] + feasible.y[1]) / 2, 'feasible-center');
    regions.forEach((r) => {
      const c = G.center(r);
      push(c.x - cw / 2, c.y - ch / 2, 'region-center:' + r.id);
    });
    push((imgW - cw) / 2, (imgH - ch) / 2, 'image-center');

    const scoreAt = (x, y) => {
      const crop = { x, y, w: cw, h: ch };
      const ev = evaluate(crop, regions);
      let score = 0;
      // 1. 尽量保留区：完整保留重奖，按覆盖面积比例给部分分
      ev.preferred.forEach((p) => {
        score += p.ratio * 10;
        if (p.contained) score += 6;
      });
      // 2. 裁切框中心贴近尽量保留区中心
      const cc = G.center(crop);
      preferred.forEach((r) => {
        const rc = G.center(r);
        const d = Math.hypot((cc.x - rc.x) / imgW, (cc.y - rc.y) / imgH);
        score += (1 - G.clamp(d, 0, 1)) * 2;
      });
      // 3. 轻微偏向原图中心，避免无意义贴边
      const dc = Math.hypot(
        (cc.x - imgW / 2) / imgW,
        (cc.y - imgH / 2) / imgH
      );
      score += (1 - G.clamp(dc, 0, 1)) * 0.5;
      return score;
    };

    let best = candidates[0];
    let bestScore = -Infinity;
    candidates.forEach((c) => {
      const s = scoreAt(c.x, c.y);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    });

    const crop = { x: best.x, y: best.y, w: cw, h: ch };
    const ev = evaluate(crop, regions);
    const conflicts = detectConflicts(required, ranges);

    return {
      mode: 'crop',
      crop,
      cw,
      ch,
      containedRequired: ev.containedRequired,
      missingRequired: ev.missingRequired,
      preferred: ev.preferred,
      conflicts,
      feasibleRanges: feasible,
      effectiveRatio: 1,
    };
  }

  /** 手动裁切框的保留情况（crop 为像素坐标，尺寸已由 UI 约束为目标宽高比） */
  function analyzeManual(crop, imgW, imgH, regions, targetW, targetH) {
    const { cw, ch } = maxFittingCrop(imgW, imgH, targetW, targetH);
    const required = regions.filter((r) => r.priority === 'required');
    const ranges = required.map((r) => feasibleRange(r, cw, ch, imgW, imgH));
    const conflicts = detectConflicts(required, ranges);
    const ev = evaluate(crop, regions);
    return {
      mode: 'crop',
      crop: { ...crop },
      cw,
      ch,
      containedRequired: ev.containedRequired,
      missingRequired: ev.missingRequired,
      preferred: ev.preferred,
      conflicts,
      effectiveRatio: 1,
    };
  }

  /**
   * 带留白方案：整张原图等比缩放进目标画布，不足部分补边。
   * 关注区天然全部完整保留；有效图像占比 = 实际图像面积 / 目标画布面积，
   * 补边部分不计入原图内容。
   */
  function padLayout(imgW, imgH, targetW, targetH) {
    const scale = Math.min(targetW / imgW, targetH / imgH);
    const dw = Math.round(imgW * scale);
    const dh = Math.round(imgH * scale);
    const dx = Math.round((targetW - dw) / 2);
    const dy = Math.round((targetH - dh) / 2);
    const effectiveRatio = (dw * dh) / (targetW * targetH);
    return {
      mode: 'pad',
      scale,
      imageRect: { x: dx, y: dy, w: dw, h: dh },
      canvas: { w: targetW, h: targetH },
      effectiveRatio,
      containedRequired: null, // pad 模式整张图都在，全部保留
      missingRequired: [],
      conflicts: [],
    };
  }

  /** 归一化关注区转像素并补默认值 */
  function toPixelRegions(regions, imgW, imgH) {
    return regions.map((r) => {
      const p = G.denormalizeRect(r, imgW, imgH);
      return { id: r.id, ...p, priority: r.priority, label: r.label };
    });
  }

  return {
    EPS,
    maxFittingCrop,
    feasibleRange,
    intersectRanges,
    findBestSubset,
    detectConflicts,
    evaluate,
    autoCrop,
    analyzeManual,
    padLayout,
    toPixelRegions,
  };
});
