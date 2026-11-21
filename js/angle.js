/*
 * 纯角度/方向选择算法，不依赖 DOM，浏览器与 node 均可使用。
 * 角度约定：0° = 正北(N)，顺时针递增，90° = 东(E)，180° = 南(S)，270° = 西(W)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Angle = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 归一化到 [0, 360) */
  function norm(a) {
    return ((a % 360) + 360) % 360;
  }

  /** 从 from 顺时针到 to 的角度差，范围 [0, 360) */
  function cwDelta(from, to) {
    return norm(to - from);
  }

  /** 圆环上两个角度的最短距离，范围 [0, 180] */
  function circularDistance(a, b) {
    const d = norm(a - b);
    return Math.min(d, 360 - d);
  }

  /**
   * 按镜头角度选择最接近的方向。
   * 关键：距离在圆环上计算，0°/360° 跨界不会选错；
   * 镜头正好停在两个方向的分界上时，取顺时针方向的下一个方向
   * （与“顺时针拖动镜头”的预期一致），保证结果确定、可复现。
   */
  function selectDirection(directions, camera) {
    if (!directions || !directions.length) return null;
    const c = norm(camera);
    let best = null;
    let bestDist = Infinity;
    let bestCw = -Infinity;
    for (const d of directions) {
      const cw = cwDelta(d.angle, c);
      const dist = Math.min(cw, 360 - cw);
      if (dist < bestDist || (dist === bestDist && cw > bestCw)) {
        best = d;
        bestDist = dist;
        bestCw = cw;
      }
    }
    return best;
  }

  /** 沿南北轴镜像后的角度（东西翻转），用于缺方向镜像补齐 */
  function mirrorAngle(a) {
    return norm(-a);
  }

  /** 相邻方向之间的分界角度（转盘上的切换边界） */
  function boundaries(directions) {
    const sorted = directions.slice().sort((a, b) => a.angle - b.angle);
    return sorted.map((d, i) => {
      const next = sorted[(i + 1) % sorted.length];
      return norm((d.angle + next.angle) / 2 + (next.angle <= d.angle ? 180 : 0));
    });
  }

  function sequenceKey(actionId, directionId) {
    return actionId + ':' + directionId;
  }

  const seqUsable = (seq) => !!seq && seq.frames.some((f) => !f.missing);

  /**
   * 按动作周期进度取帧。progress 为 [0,1) 的周期内比例，
   * 这样切换方向时沿用同一个 progress，动作进度天然连续。
   * 遇到缺帧：优先沿用前一帧，前面也没有时取后一帧。
   */
  function frameAtProgress(frames, progress) {
    const cycleDuration = frames.reduce((s, f) => s + f.duration, 0);
    let t = norm(progress) * cycleDuration;
    let index = 0;
    let lastValid = -1;
    let nextValid = -1;
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i].missing && nextValid === -1) nextValid = i;
      if (t < frames[i].duration) {
        index = i;
        break;
      }
      t -= frames[i].duration;
      if (i === frames.length - 1) index = frames.length;
      if (!frames[i].missing) lastValid = i;
    }
    if (index >= frames.length) index = frames.length - 1;
    let frame = frames[index];
    let held = false;
    if (frame.missing) {
      held = true;
      frame = lastValid >= 0 ? frames[lastValid] : frames[nextValid];
    }
    return { frame, index, cycleDuration, held };
  }

  /**
   * 解析某个镜头角度下应显示的序列与帧。
   * 返回 substitute 表示该朝向来自替代素材（镜像补齐）。
   */
  function resolve(dataset, camera, actionId, mirrorEnabled, progress) {
    const selected = selectDirection(dataset.directions, camera);
    if (!selected) return { unresolved: true };
    let seq = dataset.sequences[sequenceKey(actionId, selected.id)];
    let substitute = null;

    if (!seqUsable(seq) && mirrorEnabled) {
      const srcDir = dataset.directions.find((d) => d.angle === mirrorAngle(selected.angle));
      const srcSeq = srcDir && dataset.sequences[sequenceKey(actionId, srcDir.id)];
      // N/S 镜像后是自己，不能算替代来源
      if (srcDir && srcDir.id !== selected.id && seqUsable(srcSeq)) {
        seq = srcSeq;
        substitute = {
          directionId: selected.id,
          sourceDirectionId: srcDir.id,
          mirrored: true,
        };
      }
    }

    if (!seqUsable(seq)) {
      return { direction: selected, sequence: null, frame: null, frameIndex: -1,
        substitute: null, unresolved: true, cycleDuration: 0 };
    }
    const r = frameAtProgress(seq.frames, progress);
    return {
      direction: selected,
      sequence: seq,
      frame: r.frame,
      frameIndex: r.index,
      held: r.held,
      substitute,
      unresolved: false,
      cycleDuration: r.cycleDuration,
    };
  }

  /**
   * 素材审计：按方向列出缺方向、缺帧，以及镜像补齐关系。
   */
  function audit(dataset, mirrorEnabled) {
    const report = [];
    for (const action of dataset.actions) {
      for (const dir of dataset.directions) {
        const seq = dataset.sequences[sequenceKey(action.id, dir.id)];
        if (!seqUsable(seq)) {
          let mirrorSource = null;
          if (mirrorEnabled) {
            const srcDir = dataset.directions.find((d) => d.angle === mirrorAngle(dir.angle));
            const srcSeq = srcDir && dataset.sequences[sequenceKey(action.id, srcDir.id)];
            if (srcDir && srcDir.id !== dir.id && seqUsable(srcSeq)) {
              mirrorSource = srcDir.id;
            }
          }
          report.push({ type: 'direction', actionId: action.id, directionId: dir.id, mirrorSource });
        } else {
          const indexes = seq.frames.map((f, i) => (f.missing ? i : -1)).filter((i) => i >= 0);
          if (indexes.length) {
            report.push({ type: 'frame', actionId: action.id, directionId: dir.id, indexes });
          }
        }
      }
    }
    return report;
  }

  return {
    norm, cwDelta, circularDistance, selectDirection, mirrorAngle,
    boundaries, sequenceKey, frameAtProgress, resolve, audit,
  };
});
