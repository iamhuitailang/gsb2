/*
 * packer.js — MaxRects 装箱排版核心（无依赖，浏览器 / Node 均可加载）
 *
 * 坐标系约定：原点在左上角，x 向右、y 向下。
 * 排版单元 = 裁剪后的精灵内容 + 四周留白(padding) + 边缘扩展(extrude)，
 * 即单元格尺寸 cellW = trimW + 2*(padding+extrude)，cellH 同理。
 * 旋转只交换单元格宽高，精灵内容在渲染层处理。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpritePacker = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function nextPow2(v) {
    if (v <= 1) return 1;
    return Math.pow(2, Math.ceil(Math.log2(v)));
  }

  function rectsOverlap(a, b) {
    return (
      a.x < b.x + b.w &&
      a.x + a.w > b.x &&
      a.y < b.y + b.h &&
      a.y + a.h > b.y
    );
  }

  function containsRect(outer, inner) {
    return (
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.w <= outer.x + outer.w &&
      inner.y + inner.h <= outer.y + outer.h
    );
  }

  /**
   * MaxRects：从可用矩形 f 里扣除占用矩形 used，返回新的自由矩形列表。
   */
  function splitFree(f, used) {
    if (!rectsOverlap(f, used)) return [f];
    var out = [];
    // 左侧竖条
    if (used.x > f.x) {
      out.push({ x: f.x, y: f.y, w: used.x - f.x, h: f.h });
    }
    // 右侧竖条
    if (used.x + used.w < f.x + f.w) {
      out.push({
        x: used.x + used.w,
        y: f.y,
        w: f.x + f.w - (used.x + used.w),
        h: f.h,
      });
    }
    // 顶部横条
    if (used.y > f.y) {
      out.push({ x: f.x, y: f.y, w: f.w, h: used.y - f.y });
    }
    // 底部横条
    if (used.y + used.h < f.y + f.h) {
      out.push({
        x: f.x,
        y: used.y + used.h,
        w: f.w,
        h: f.y + f.h - (used.y + used.h),
      });
    }
    return out;
  }

  /** 剔除被其它自由矩形完全包含的冗余矩形。 */
  function pruneFree(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var dominated = false;
      for (var j = 0; j < list.length; j++) {
        if (i === j) continue;
        if (containsRect(list[j], list[i])) {
          dominated = true;
          break;
        }
      }
      if (!dominated) out.push(list[i]);
    }
    return out;
  }

  /** 最佳短边适配（BSSF）：先比剩余短边、再比剩余长边。 */
  function bestShortSideFit(free, w, h) {
    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < free.length; i++) {
      var f = free[i];
      if (f.w < w || f.h < h) continue;
      var leftW = f.w - w;
      var leftH = f.h - h;
      var shortSide = Math.min(leftW, leftH);
      var longSide = Math.max(leftW, leftH);
      var score = shortSide * 1e7 + longSide;
      if (score < bestScore) {
        bestScore = score;
        best = { x: f.x, y: f.y, w: w, h: h, freeIndex: i };
      }
    }
    return best;
  }

  function largestFreeRect(free) {
    var best = { w: 0, h: 0 };
    for (var i = 0; i < free.length; i++) {
      if (free[i].w * free[i].h > best.w * best.h) best = free[i];
    }
    return best;
  }

  /**
   * 主入口。
   * @param {Array} items  [{ id, w, h, allowRotate }]（w/h 为单元格尺寸，正整数）
   * @param {Object} options
   *   - width / height：fixed 模式下为目标尺寸；limit 模式下为上限
   *   - mode: 'fixed' | 'limit'
   *   - powerOfTwo: limit 模式下是否把最终尺寸向上取 2 的幂
   *   - allowRotate: 全局旋转开关（单项 allowRotate=false 可禁用）
   *   - previous: Map<id, {x,y,w,h,rotated}>，上一轮排版结果，用于稳定重排
   * @returns {Object} { ok, width, height, placements:Map, rejected:[],
   *                     changed:{added,removed,moved,resized}, stats }
   */
  function pack(items, options) {
    options = options || {};
    var maxW = Math.max(1, Math.floor(options.width || 1024));
    var maxH = Math.max(1, Math.floor(options.height || 1024));
    var mode = options.mode === 'fixed' ? 'fixed' : 'limit';
    var globalRotate = options.allowRotate !== false;
    var powerOfTwo = !!options.powerOfTwo;
    var previous = options.previous instanceof Map ? options.previous : new Map();

    // 确定性排序：面积降序，其次长边、id，保证同样输入得到同样结果
    var sorted = items
      .filter(function (it) { return it.w > 0 && it.h > 0; })
      .slice()
      .sort(function (a, b) {
        var sa = a.w * a.h;
        var sb = b.w * b.h;
        if (sb !== sa) return sb - sa;
        var la = Math.max(a.w, a.h);
        var lb = Math.max(b.w, b.h);
        if (lb !== la) return lb - la;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

    var rejected = [];
    var placements = new Map();
    var free = [{ x: 0, y: 0, w: maxW, h: maxH }];

    // ---- 第一步：恢复上一轮未变化精灵的位置（稳定重排）----
    var lockCandidates = [];
    sorted.forEach(function (it) {
      var prev = previous.get(it.id);
      if (!prev) return;
      var canRotate = globalRotate && it.allowRotate !== false;
      var normal = { x: prev.x, y: prev.y, w: it.w, h: it.h, rotated: false };
      var rotated = {
        x: prev.x,
        y: prev.y,
        w: it.h,
        h: it.w,
        rotated: true,
      };
      var pick = null;
      if (!prev.rotated && prev.w === it.w && prev.h === it.h) {
        pick = normal;
      } else if (
        canRotate &&
        prev.rotated &&
        prev.w === it.h &&
        prev.h === it.w
      ) {
        pick = rotated;
      }
      if (pick && pick.x >= 0 && pick.y >= 0 &&
          pick.x + pick.w <= maxW && pick.y + pick.h <= maxH) {
        lockCandidates.push({ item: it, rect: pick });
      }
    });

    // 两两不冲突才整体锁定，避免历史数据异常时互相覆盖
    var locked = [];
    lockCandidates.forEach(function (cand) {
      for (var i = 0; i < locked.length; i++) {
        if (rectsOverlap(cand.rect, locked[i].rect)) return;
      }
      locked.push(cand);
    });
    locked.forEach(function (c) {
      var r = c.rect;
      placements.set(c.item.id, {
        id: c.item.id,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        rotated: r.rotated,
        locked: true,
      });
      free = pruneFree(
        free.flatMap(function (f) { return splitFree(f, r); })
      );
    });

    // ---- 第二步：剩余精灵走 MaxRects BSSF ----
    function reject(it, reason, detail) {
      rejected.push({
        id: it.id,
        name: it.name || it.id,
        w: it.w,
        h: it.h,
        reason: reason,
        detail: detail || '',
      });
    }

    sorted.forEach(function (it) {
      if (placements.has(it.id)) return;
      var canRotate = globalRotate && it.allowRotate !== false;

      // 无论怎么旋转都超出图集边界
      var fitsNormal = it.w <= maxW && it.h <= maxH;
      var fitsRotated = canRotate && it.h <= maxW && it.w <= maxH;
      if (!fitsNormal && !fitsRotated) {
        var hint =
          !canRotate && (it.h <= maxW && it.w <= maxH)
            ? '该精灵已禁用旋转；开启旋转后或可放入'
            : '单元格 ' + it.w + '×' + it.h +
              ' 超过图集上限 ' + maxW + '×' + maxH;
        reject(it, 'too_large', hint);
        return;
      }

      var bestNormal = bestShortSideFit(free, it.w, it.h);
      var bestRot = canRotate
        ? bestShortSideFit(free, it.h, it.w)
        : null;
      var best = bestNormal;
      var rotated = false;
      if (bestRot) {
        var nScore = bestNormal
          ? Math.min(bestNormal.w - it.w, bestNormal.h - it.h) * 1e7 +
            Math.max(bestNormal.w - it.w, bestNormal.h - it.h)
          : Infinity;
        var rScore =
          Math.min(bestRot.w - it.h, bestRot.h - it.w) * 1e7 +
          Math.max(bestRot.w - it.h, bestRot.h - it.w);
        if (rScore < nScore) {
          best = bestRot;
          rotated = true;
        }
      }

      if (!best) {
        var lf = largestFreeRect(free);
        var totalCell = it.w * it.h;
        reject(
          it,
          'no_space',
          '需要 ' + it.w + '×' + it.h +
            (canRotate ? '（可旋转）' : '（禁旋转）') +
            '；当前最大空闲矩形仅 ' + lf.w + '×' + lf.h +
            '，该单元格占 ' + totalCell + 'px²'
        );
        return;
      }

      var place = {
        id: it.id,
        x: best.x,
        y: best.y,
        w: rotated ? it.h : it.w,
        h: rotated ? it.w : it.h,
        rotated: rotated,
        locked: false,
      };
      placements.set(it.id, place);
      free = pruneFree(
        free.flatMap(function (f) { return splitFree(f, place); })
      );
    });

    // ---- 第三步：确定实际图集尺寸 ----
    var contentW = 0;
    var contentH = 0;
    placements.forEach(function (p) {
      contentW = Math.max(contentW, p.x + p.w);
      contentH = Math.max(contentH, p.y + p.h);
    });

    var width = maxW;
    var height = maxH;
    if (mode === 'limit') {
      width = powerOfTwo ? nextPow2(contentW) : Math.max(1, contentW);
      height = powerOfTwo ? nextPow2(contentH) : Math.max(1, contentH);
      // 内容本身已在 maxW/maxH 内排版成功，这里仅做防御性钳制
      width = Math.min(width, maxW);
      height = Math.min(height, maxH);
    }

    // ---- 第四步：与上一轮对比，计算本次变化范围 ----
    var changed = diffLayout(previous, placements);
    var usedArea = 0;
    placements.forEach(function (p) {
      usedArea += p.w * p.h;
    });
    var bounds = layoutBounds(placements);

    return {
      ok: rejected.length === 0,
      width: width,
      height: height,
      maxWidth: maxW,
      maxHeight: maxH,
      mode: mode,
      powerOfTwo: powerOfTwo,
      placements: placements,
      rejected: rejected,
      changed: changed,
      stats: {
        spriteCount: placements.size,
        rejectedCount: rejected.length,
        usedArea: usedArea,
        atlasArea: width * height,
        utilization: width * height ? usedArea / (width * height) : 0,
        contentWidth: contentW,
        contentHeight: contentH,
        bounds: bounds,
      },
    };
  }

  function layoutBounds(placements) {
    var b = { x: Infinity, y: Infinity, right: 0, bottom: 0 };
    placements.forEach(function (p) {
      b.x = Math.min(b.x, p.x);
      b.y = Math.min(b.y, p.y);
      b.right = Math.max(b.right, p.x + p.w);
      b.bottom = Math.max(b.bottom, p.y + p.h);
    });
    if (!isFinite(b.x)) return null;
    return { x: b.x, y: b.y, w: b.right - b.x, h: b.bottom - b.y };
  }

  function diffLayout(previous, current) {
    var added = [];
    var removed = [];
    var moved = [];
    var resized = [];
    current.forEach(function (p, id) {
      var prev = previous.get(id);
      if (!prev) {
        added.push(id);
      } else if (prev.w !== p.w || prev.h !== p.h || prev.rotated !== p.rotated) {
        resized.push(id);
      } else if (prev.x !== p.x || prev.y !== p.y) {
        moved.push(id);
      }
    });
    previous.forEach(function (_p, id) {
      if (!current.has(id)) removed.push(id);
    });
    return {
      added: added,
      removed: removed,
      moved: moved,
      resized: resized,
      any: added.length + removed.length + moved.length + resized.length > 0,
    };
  }

  return {
    pack: pack,
    nextPow2: nextPow2,
    rectsOverlap: rectsOverlap,
    splitFree: splitFree,
    pruneFree: pruneFree,
    bestShortSideFit: bestShortSideFit,
  };
});
