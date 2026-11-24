/* 量化/还原、范围模式、误差与字节核算、接缝分析。 */
(function (global) {
  const MPC = global.MPC;
  const { f32 } = MPC.util;

  const PRECISION_LEVELS = [
    { bits: 8, label: '8 位（每轴 256 级，最省）' },
    { bits: 10, label: '10 位（每轴 1024 级，紧凑打包）' },
    { bits: 12, label: '12 位（每轴 4096 级，紧凑打包）' },
    { bits: 16, label: '16 位（每轴 65536 级，基准）' },
  ];
  const RANGE_MODES = [
    { id: 'global', label: '整组统一范围' },
    { id: 'perBlock', label: '各块单独范围' },
    { id: 'aligned', label: '保持接缝对齐' },
  ];

  function boundsOf(positions) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  function unionBounds(a, b) {
    return {
      minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
      minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY),
      minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ),
    };
  }

  const AXES = ['X', 'Y', 'Z'];
  function rangeStep(r, axis, bits) {
    const levels = (1 << bits) - 1;
    return (r['max' + axis] - r['min' + axis]) / levels;
  }

  // 对一组位置按给定范围逐轴量化，返回整数码与还原位置（全部 f32 舍入，保证跨运行复现）。
  // steps 可显式传入：对齐模式下同一份步长数组给同分量所有块共用，
  // 保证接缝两侧"相同坐标 → 相同运算 → 相同还原值"，错位恒为 0。
  function quantize(positions, range, bits, stepsIn) {
    const levels = (1 << bits) - 1;
    const steps = stepsIn || [
      (range.maxX - range.minX) / levels,
      (range.maxY - range.minY) / levels,
      (range.maxZ - range.minZ) / levels,
    ];
    const n = positions.length / 3;
    const codes = new Uint32Array(n * 3);
    const restored = new Float32Array(positions.length);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) {
        const v = positions[i * 3 + a];
        const min = range['min' + AXES[a]];
        const step = steps[a];
        let code = Math.round((v - min) / step);
        if (code < 0) code = 0; else if (code > levels) code = levels;
        codes[i * 3 + a] = code;
        restored[i * 3 + a] = f32(min + code * step);
      }
    }
    return { codes, restored };
  }

  // 并查集：通过真实接缝把块连成连通分量
  function buildComponents(scene) {
    const n = scene.blocks.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const s of scene.seams) {
      const ra = find(s.blockA), rb = find(s.blockB);
      if (ra !== rb) parent[rb] = ra;
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    }
    return [...groups.values()];
  }

  /* 计算每种模式下每个块使用的范围。返回
     { ranges:[去重范围], blockRangeId:[每块对应 id], components, notes:[{blockId, text}] } */
  function computeRanges(scene, mode) {
    const own = scene.blocks.map(b => boundsOf(b.positions));
    const components = buildComponents(scene);

    if (mode === 'global') {
      let g = own[0];
      for (let i = 1; i < own.length; i++) g = unionBounds(g, own[i]);
      return {
        ranges: [g],
        blockRangeId: own.map(() => 0),
        components,
        notes: scene.blocks.map((b, i) => ({
          blockId: i,
          text: '与整组共用范围；块内最细步长受全局跨度稀释（小块尤其明显）。',
        })),
      };
    }

    if (mode === 'perBlock') {
      return {
        ranges: own,
        blockRangeId: own.map((_, i) => i),
        components,
        notes: scene.blocks.map((b, i) => ({
          blockId: i,
          text: '独立范围，步长最小；但接边两侧各用各的量化网格，相同坐标可能落到不同码上 → 裂缝。',
        })),
      };
    }

    // aligned：同一接缝连通分量内的块共用范围（并集），无接边的分量保持独立
    const ranges = [];
    const blockRangeId = new Array(own.length);
    const notes = new Array(own.length);
    for (const comp of components) {
      let r = own[comp[0]];
      for (let k = 1; k < comp.length; k++) r = unionBounds(r, own[comp[k]]);
      const rid = ranges.length;
      ranges.push(r);
      const names = comp.map(i => scene.blocks[i].name).join('、');
      for (const bi of comp) {
        blockRangeId[bi] = rid;
        if (comp.length === 1) {
          notes[bi] = { blockId: bi, text: scene.blocks[bi].name + ' 没有任何真实接边，保持自身独立范围（与逐块模式相同），不被其他块拖精度。' };
        } else {
          // 与逐块模式相比各轴步长被放大的倍数
          const inflate = AXES.map(axis => {
            const sOwn = rangeStep(own[bi], axis, 16);
            const sShared = rangeStep(r, axis, 16);
            return axis + '×' + (sOwn === 0 ? '1.00' : (sShared / sOwn).toFixed(2));
          });
          notes[bi] = {
            blockId: bi,
            text: '与 ' + names + ' 共用并集范围以保证接边量化到同一码；相对逐块模式步长放大 ' +
                  inflate.join('，') + '。接边错位恒为 0（相同坐标 ⇒ 相同码 ⇒ 相同还原值）。',
          };
        }
      }
    }
    return { ranges, blockRangeId, components, notes };
  }

  // 完整打包一次：返回每块量化结果、范围、误差、接缝分析
  function packScene(scene, mode, bits, crackThreshold) {
    const { ranges, blockRangeId, components, notes } = computeRanges(scene, mode);
    // 每个范围只计算一次步长，同范围的块共享同一数组（对齐模式接缝零错位的关键）
    const levels = (1 << bits) - 1;
    const rangeSteps = ranges.map(r => [
      (r.maxX - r.minX) / levels,
      (r.maxY - r.minY) / levels,
      (r.maxZ - r.minZ) / levels,
    ]);
    const qBlocks = scene.blocks.map((block, bi) => {
      const rid = blockRangeId[bi];
      const range = ranges[rid];
      const { codes, restored } = quantize(block.positions, range, bits, rangeSteps[rid]);
      return { ...block, rangeId: rid, codes, restored, range };
    });

    const errors = qBlocks.map(qb => measureError(qb.positions, qb.restored));
    const allOrig = concatPositions(scene.blocks.map(b => b.positions));
    const allRestored = concatPositions(qBlocks.map(b => b.restored));
    const overall = measureError(allOrig, allRestored);
    const seamReport = analyzeSeams(scene, qBlocks, crackThreshold);

    return {
      mode, bits, ranges, blockRangeId, components, notes,
      qBlocks, errors, overall, seamReport,
    };
  }

  function concatPositions(list) {
    const total = list.reduce((s, a) => s + a.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const a of list) { out.set(a, off); off += a.length; }
    return out;
  }

  function measureError(orig, restored) {
    let max = 0, sumSq = 0, sum = 0, at = -1;
    const n = orig.length / 3;
    for (let i = 0; i < n; i++) {
      let d2 = 0;
      for (let a = 0; a < 3; a++) {
        const d = restored[i * 3 + a] - orig[i * 3 + a];
        d2 += d * d;
      }
      const d = Math.sqrt(d2);
      if (d > max) { max = d; at = i; }
      sum += d; sumSq += d2;
    }
    return {
      max, mean: n ? sum / n : 0, rms: n ? Math.sqrt(sumSq / n) : 0,
      maxVertex: at,
      maxPoint: at >= 0 ? [orig[at * 3], orig[at * 3 + 1], orig[at * 3 + 2]] : null,
      vertexCount: n,
    };
  }

  function dist3(ax, ay, az, bx, by, bz) {
    const dx = ax - bx, dy = ay - by, dz = az - bz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // 点到线段距离（用于 T 型接边上只存在于细网格一侧的顶点）
  function pointSegmentDistance(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
    const wx = p[0] - a[0], wy = p[1] - a[1], wz = p[2] - a[2];
    const len2 = vx * vx + vy * vy + vz * vz;
    let t = len2 > 0 ? (wx * vx + wy * vy + wz * vz) / len2 : 0;
    t = MPC.util.clamp(t, 0, 1);
    return dist3(p[0], p[1], p[2], a[0] + t * vx, a[1] + t * vy, a[2] + t * vz);
  }

  /* 接缝分析。真实接缝（scene.seams）与 UV 贴图边界（block.uvSeams）严格分开：
     只有真实接缝参与裂缝统计。 */
  function analyzeSeams(scene, qBlocks, threshold) {
    const seams = scene.seams.map(seam => {
      const A = qBlocks[seam.blockA], B = qBlocks[seam.blockB];
      const gaps = seam.pairs.map(p => {
        const a = p.va * 3, b = p.vb * 3;
        return {
          pair: p,
          distance: dist3(A.restored[a], A.restored[a + 1], A.restored[a + 2],
                          B.restored[b], B.restored[b + 1], B.restored[b + 2]),
          pointA: [A.restored[a], A.restored[a + 1], A.restored[a + 2]],
          pointB: [B.restored[b], B.restored[b + 1], B.restored[b + 2]],
        };
      });
      let maxGap = 0, worst = null, overCount = 0, sum = 0;
      for (const g of gaps) {
        if (g.distance > maxGap) { maxGap = g.distance; worst = g; }
        if (g.distance > threshold) overCount++;
        sum += g.distance;
      }

      // T 接顶点：细网格一侧多出的点，量它到粗网格一侧相邻匹配点连线的距离。
      // 注意：原始几何里该点也不在粗网格两点的直线弦上（浮雕是曲线），因此同时报告
      // 原始基线弦差 baseline 与量化引入的增量 delta，避免把地形曲率误判成裂缝。
      const tGaps = seam.extraVertices.map(ev => {
        const fine = qBlocks[ev.block];
        const coarse = ev.block === seam.blockA ? qBlocks[seam.blockB] : qBlocks[seam.blockA];
        const fineOrig = scene.blocks[ev.block];
        const coarseOrig = scene.blocks[ev.block === seam.blockA ? seam.blockB : seam.blockA];
        const vi = ev.vertex * 3;
        const p = [fine.restored[vi], fine.restored[vi + 1], fine.restored[vi + 2]];
        // 找 z 上相邻的两个匹配对
        const sorted = [...seam.pairs].sort((p1, p2) => p1.z - p2.z);
        let lo = sorted[0], hi = sorted[sorted.length - 1];
        for (let k = 0; k < sorted.length - 1; k++) {
          if (sorted[k].z <= ev.z && sorted[k + 1].z >= ev.z) { lo = sorted[k]; hi = sorted[k + 1]; break; }
        }
        const idLo = ev.block === seam.blockA ? lo.vb : lo.va;
        const idHi = ev.block === seam.blockA ? hi.vb : hi.va;
        const aPt = Array.from(coarse.restored.slice(idLo * 3, idLo * 3 + 3));
        const bPt = Array.from(coarse.restored.slice(idHi * 3, idHi * 3 + 3));
        const distance = pointSegmentDistance(p, aPt, bPt);
        const p0 = Array.from(fineOrig.positions.slice(vi, vi + 3));
        const a0 = Array.from(coarseOrig.positions.slice(idLo * 3, idLo * 3 + 3));
        const b0 = Array.from(coarseOrig.positions.slice(idHi * 3, idHi * 3 + 3));
        const baseline = pointSegmentDistance(p0, a0, b0);
        return { ev, distance, baseline, delta: Math.abs(distance - baseline), point: p };
      });
      let maxT = 0, worstT = null, maxTDelta = 0;
      for (const g of tGaps) {
        if (g.distance > maxT) { maxT = g.distance; worstT = g; }
        if (g.delta > maxTDelta) maxTDelta = g.delta;
      }

      return {
        id: seam.id, name: seam.name, axis: seam.axis,
        blockA: seam.blockA, blockB: seam.blockB,
        pairCount: gaps.length, extraCount: tGaps.length,
        maxGap, meanGap: gaps.length ? sum / gaps.length : 0,
        overThreshold: overCount, threshold, worst,
        maxTGap: maxT, maxTGapDelta: maxTDelta, worstT, gaps, tGaps,
      };
    });

    // UV 贴图边界：同位复制顶点。只做健康检查，永不计入裂缝
    const uvChecks = [];
    for (const qb of qBlocks) {
      let maxUv = 0;
      for (const s of qb.uvSeams) {
        const a = s.a * 3, b = s.b * 3;
        const d = dist3(qb.restored[a], qb.restored[a + 1], qb.restored[a + 2],
                        qb.restored[b], qb.restored[b + 1], qb.restored[b + 2]);
        if (d > maxUv) maxUv = d;
      }
      uvChecks.push({ blockId: qb.id, blockName: qb.name, count: qb.uvSeams.length, maxCopyDistance: maxUv });
    }

    const sharedMax = seams.reduce((m, s) => Math.max(m, s.maxGap), 0);
    const tMax = seams.reduce((m, s) => Math.max(m, s.maxTGap), 0);
    const tDeltaMax = seams.reduce((m, s) => Math.max(m, s.maxTGapDelta), 0);
    return {
      seams, uvChecks, threshold,
      globalMaxGap: Math.max(sharedMax, tMax),
      sharedMaxGap: sharedMax,
      tJunctionMaxGap: tMax,
      tJunctionMaxDelta: tDeltaMax,
    };
  }

  MPC.quantize = {
    PRECISION_LEVELS, RANGE_MODES, boundsOf, unionBounds, quantize,
    computeRanges, buildComponents, packScene, measureError, analyzeSeams,
    rangeStep,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = MPC;
})(typeof globalThis !== 'undefined' ? globalThis : this);
