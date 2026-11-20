/* align.js — 刚体变换、配准误差（最近邻 RMS）与 ICP 自动配准。 */
"use strict";

const PCAlign = (() => {

  /** 由 {position:[x,y,z], rotationDeg:[x,y,z]} 生成 THREE.Matrix4（欧拉角 XYZ 序）。 */
  function transformToMatrix(t) {
    const m = new THREE.Matrix4();
    const e = new THREE.Euler(
      THREE.MathUtils.degToRad(t.rotationDeg[0]),
      THREE.MathUtils.degToRad(t.rotationDeg[1]),
      THREE.MathUtils.degToRad(t.rotationDeg[2]), "XYZ");
    m.makeRotationFromEuler(e);
    m.setPosition(t.position[0], t.position[1], t.position[2]);
    return m;
  }

  /** 把 Matrix4 拆解回 {position, rotationDeg}。 */
  function matrixToTransform(m) {
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(pos, q, s);
    const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
    return {
      position: [pos.x, pos.y, pos.z],
      rotationDeg: [
        THREE.MathUtils.radToDeg(e.x),
        THREE.MathUtils.radToDeg(e.y),
        THREE.MathUtils.radToDeg(e.z)]
    };
  }

  /** 把局部坐标点集经矩阵变换到世界坐标，返回新 Float32Array。 */
  function transformPoints(positions, m) {
    const n = positions.length / 3;
    const out = new Float32Array(n * 3);
    const e = m.elements;
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      out[i * 3]     = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    return out;
  }

  /** 均匀抽样索引（最多 maxN 个）。 */
  function sampleIndices(n, maxN) {
    const cnt = Math.min(n, maxN);
    const idx = new Uint32Array(cnt);
    if (n <= maxN) { for (let i = 0; i < n; i++) idx[i] = i; return idx; }
    const stride = n / maxN;
    for (let i = 0; i < cnt; i++) idx[i] = Math.floor(i * stride);
    return idx;
  }

  /* ---------- 最近邻索引：空间哈希网格 + 逐环扩展搜索 ---------- */

  function bboxOf(p) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < min[k]) min[k] = p[i + k];
        if (p[i + k] > max[k]) max[k] = p[i + k];
      }
    return [min, max];
  }

  /** 为点集建立最近邻索引。cell 取期望点距量级。 */
  function buildNNIndex(positions) {
    const n = positions.length / 3;
    const bb = bboxOf(positions);
    const vol = Math.max(1e-12,
      (bb[1][0] - bb[0][0]) * (bb[1][1] - bb[0][1]) * (bb[1][2] - bb[0][2]));
    const cell = Math.max(Math.cbrt(vol / n), 1e-9);
    const grid = new Map();
    const inv = 1 / cell;
    for (let i = 0; i < n; i++) {
      const key = Math.floor(positions[i * 3] * inv) + "," +
                  Math.floor(positions[i * 3 + 1] * inv) + "," +
                  Math.floor(positions[i * 3 + 2] * inv);
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(i);
    }
    return { positions, grid, cell };
  }

  /**
   * 索引中距 (x,y,z) 最近的点，距离超过 maxDist 视为无配对。
   * 逐环扩展：处理完 Chebyshev 半径 r 的壳层后，若当前最优距离 < r*cell，
   * 则外层不可能有更近的点，提前结束。
   */
  function nearestInIndex(idx, x, y, z, maxDist) {
    const { positions, grid, cell } = idx;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    const maxR = Math.max(1, Math.ceil(maxDist / cell));
    let best = Infinity, bj = -1;
    for (let r = 0; r <= maxR; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const arr = grid.get((cx + dx) + "," + (cy + dy) + "," + (cz + dz));
            if (!arr) continue;
            for (let t = 0; t < arr.length; t++) {
              const j = arr[t];
              const ddx = positions[j * 3] - x, ddy = positions[j * 3 + 1] - y, ddz = positions[j * 3 + 2] - z;
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2 < best) { best = d2; bj = j; }
            }
          }
      if (bj >= 0 && best < r * r * cell * cell) break;
    }
    if (bj < 0 || best > maxDist * maxDist) return null;
    return { dist: Math.sqrt(best), index: bj };
  }

  /**
   * 配准误差：从 src（世界坐标）抽样，找 dst（世界坐标）最近邻，
   * 返回 { rms, max, pairs, maxDist }；maxDist 之外的配对不计入。
   * trim（0–1，可选）只取距离最近的一部分配对计算 RMS，
   * 避免两份扫描不重叠区域拉偏指标。
   */
  function registrationError(srcWorld, dstWorld, maxDist, maxSamples, trim) {
    maxSamples = maxSamples || 3000;
    const nSrc = srcWorld.length / 3;
    if (nSrc === 0 || dstWorld.length === 0) return null;
    const idx = buildNNIndex(dstWorld);
    const sample = sampleIndices(nSrc, maxSamples);
    const dists = [];
    for (let s = 0; s < sample.length; s++) {
      const i = sample[s];
      const hit = nearestInIndex(idx, srcWorld[i * 3], srcWorld[i * 3 + 1], srcWorld[i * 3 + 2], maxDist);
      if (hit) dists.push(hit.dist);
    }
    if (dists.length === 0) return { rms: null, max: null, pairs: 0, maxDist };
    dists.sort((a, b) => a - b);
    const m = trim ? Math.max(1, Math.floor(dists.length * trim)) : dists.length;
    let sum = 0;
    for (let i = 0; i < m; i++) sum += dists[i] * dists[i];
    return { rms: Math.sqrt(sum / m), max: dists[dists.length - 1], pairs: m, maxDist };
  }

  /**
   * Horn 四元数法：给定配对点集 P→Q（均为世界坐标，等长），
   * 求使 sum |R*P+t - Q|^2 最小的刚体变换，返回 THREE.Matrix4。
   */
  function hornAlignment(P, Q) {
    const n = P.length / 3;
    const pc = [0, 0, 0], qc = [0, 0, 0];
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 3; k++) { pc[k] += P[i * 3 + k]; qc[k] += Q[i * 3 + k]; }
    for (let k = 0; k < 3; k++) { pc[k] /= n; qc[k] /= n; }

    // 交叉协方差 S = sum (P-pc)(Q-qc)^T
    let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0;
    for (let i = 0; i < n; i++) {
      const px = P[i * 3] - pc[0], py = P[i * 3 + 1] - pc[1], pz = P[i * 3 + 2] - pc[2];
      const qx = Q[i * 3] - qc[0], qy = Q[i * 3 + 1] - qc[1], qz = Q[i * 3 + 2] - qc[2];
      sxx += px * qx; sxy += px * qy; sxz += px * qz;
      syx += py * qx; syy += py * qy; syz += py * qz;
      szx += pz * qx; szy += pz * qy; szz += pz * qz;
    }

    // Horn 的 4x4 对称矩阵 N，最大特征值对应特征向量即旋转四元数
    const N = [
      [sxx + syy + szz, syz - szy,        szx - sxz,        sxy - syx       ],
      [syz - szy,       sxx - syy - szz,  sxy + syx,        szx + sxz       ],
      [szx - sxz,       sxy + syx,       -sxx + syy - szz,  syz + szy       ],
      [sxy - syx,       szx + sxz,        syz + szy,       -sxx - syy + szz ]
    ];
    const q = largestEigenvector(N);
    const quat = new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize();
    const R = new THREE.Matrix4().makeRotationFromQuaternion(quat);

    // t = qc - R*pc
    const c = new THREE.Vector3(pc[0], pc[1], pc[2]).applyMatrix4(R);
    R.setPosition(qc[0] - c.x, qc[1] - c.y, qc[2] - c.z);
    return R;
  }

  /** 幂迭代求 4x4 对称矩阵最大特征值对应特征向量。 */
  function largestEigenvector(N) {
    let v = [1, 0, 0, 0];
    for (let it = 0; it < 60; it++) {
      const w = [0, 0, 0, 0];
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 4; c++) w[r] += N[r][c] * v[c];
      const norm = Math.hypot(w[0], w[1], w[2], w[3]) || 1;
      v = [w[0] / norm, w[1] / norm, w[2] / norm, w[3] / norm];
    }
    return v;
  }

  /**
   * 完整 ICP（点到点，多尺度配对距离 + 裁剪配对）：
   * - 先把质心对齐作为初值，消除大平移偏差；
   * - 配对阈值从 maxDist 起步逐阶段减半，先对齐大体再收敛细节；
   * - 每轮只保留距离最近的一部分配对（trim），抑制不重叠区域的干扰。
   * @returns {{matrix: THREE.Matrix4, rms: number|null, iterations: number}|null}
   */
  function runICP(srcLocal, srcTransform, dstLocal, dstTransform, opts) {
    opts = opts || {};
    const stages = opts.stages || 4;
    const itersPerStage = Math.ceil((opts.maxIter || 40) / stages);
    const maxDist0 = opts.maxDist || 1.0;
    const minDist = maxDist0 / Math.pow(2, stages - 1);
    const maxSamples = opts.maxSamples || 2000;
    const trim = Math.min(1, Math.max(0.3, opts.trim || 0.8));

    const dstWorld = transformPoints(dstLocal, transformToMatrix(dstTransform));
    const nnIdx = buildNNIndex(dstWorld);
    const sample = sampleIndices(srcLocal.length / 3, maxSamples);

    // 初值：用户变换 + 质心对齐
    let matrix = transformToMatrix(srcTransform);
    const cs = centroidOfSample(srcLocal, sample, matrix);
    const cd = centroidOfSample(dstWorld, sampleIndices(dstWorld.length / 3, maxSamples), null);
    matrix.setPosition(
      matrix.elements[12] + cd[0] - cs[0],
      matrix.elements[13] + cd[1] - cs[1],
      matrix.elements[14] + cd[2] - cs[2]);

    let rms = null, totalIter = 0;

    for (let stage = 0; stage < stages; stage++) {
      const maxDist = Math.max(maxDist0 / Math.pow(2, stage), minDist);
      let prevRms = Infinity;
      for (let it = 0; it < itersPerStage; it++) {
        totalIter++;
        // 仅变换抽样点，避免每次迭代处理全量点
        const e = matrix.elements;
        const xs = [], ys = [], zs = [], qi = [], ds = [];
        for (let s = 0; s < sample.length; s++) {
          const i = sample[s];
          const lx = srcLocal[i * 3], ly = srcLocal[i * 3 + 1], lz = srcLocal[i * 3 + 2];
          const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
          const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
          const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
          const hit = nearestInIndex(nnIdx, x, y, z, maxDist);
          if (hit) { xs.push(x); ys.push(y); zs.push(z); qi.push(hit.index); ds.push(hit.dist); }
        }
        if (xs.length < 6) return null; // 对应点太少，放弃

        // 裁剪：只保留距离最近的一部分配对
        const order = ds.map((d, i) => i).sort((a, b) => ds[a] - ds[b]);
        const m = Math.max(6, Math.floor(order.length * trim));
        const P = [], Q = [];
        for (let t = 0; t < m; t++) {
          const j = order[t];
          P.push(xs[j], ys[j], zs[j]);
          Q.push(dstWorld[qi[j] * 3], dstWorld[qi[j] * 3 + 1], dstWorld[qi[j] * 3 + 2]);
        }

        const delta = hornAlignment(P, Q);
        matrix = delta.multiply(matrix.clone());

        // 以保留配对在新变换下的残差作为收敛判据
        let sum = 0;
        const cnt = P.length / 3;
        const de = delta.elements;
        for (let s = 0; s < cnt; s++) {
          const lx = P[s * 3], ly = P[s * 3 + 1], lz = P[s * 3 + 2];
          const nx = de[0] * lx + de[4] * ly + de[8] * lz + de[12];
          const ny = de[1] * lx + de[5] * ly + de[9] * lz + de[13];
          const nz = de[2] * lx + de[6] * ly + de[10] * lz + de[14];
          const dx = nx - Q[s * 3], dy = ny - Q[s * 3 + 1], dz = nz - Q[s * 3 + 2];
          sum += dx * dx + dy * dy + dz * dz;
        }
        rms = Math.sqrt(sum / cnt);
        if (prevRms - rms < 1e-7) break;
        prevRms = rms;
      }
    }
    return { matrix, rms, iterations: totalIter };
  }

  /* ---------- PCA 粗对齐 ---------- */

  /** 对称 3x3 矩阵的 Jacobi 特征分解，返回 {values:[3], vectors: 列为主特征向量的 3x3} */
  function jacobiEigen3(A) {
    let a = [A[0].slice(), A[1].slice(), A[2].slice()];
    let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
      // 找最大非对角元
      let p = 0, q = 1, max = Math.abs(a[0][1]);
      if (Math.abs(a[0][2]) > max) { p = 0; q = 2; max = Math.abs(a[0][2]); }
      if (Math.abs(a[1][2]) > max) { p = 1; q = 2; max = Math.abs(a[1][2]); }
      if (max < 1e-12) break;
      const app = a[p][p], aqq = a[q][q], apq = a[p][q];
      const theta = 0.5 * Math.atan2(2 * apq, aqq - app);
      const c = Math.cos(theta), s = Math.sin(theta);
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
    return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
  }

  /** 抽样点集的质心与主轴（特征值降序，列为主轴）。 */
  function pcaOf(positions, maxSamples) {
    const sample = sampleIndices(positions.length / 3, maxSamples || 5000);
    const c = [0, 0, 0];
    for (const i of sample) {
      c[0] += positions[i * 3]; c[1] += positions[i * 3 + 1]; c[2] += positions[i * 3 + 2];
    }
    const n = sample.length;
    c[0] /= n; c[1] /= n; c[2] /= n;
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (const i of sample) {
      const x = positions[i * 3] - c[0], y = positions[i * 3 + 1] - c[1], z = positions[i * 3 + 2] - c[2];
      xx += x * x; xy += x * y; xz += x * z;
      yy += y * y; yz += y * z; zz += z * z;
    }
    const eig = jacobiEigen3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
    // 按特征值降序排列主轴
    const order = [0, 1, 2].sort((a, b) => eig.values[b] - eig.values[a]);
    const axes = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let col = 0; col < 3; col++)
      for (let row = 0; row < 3; row++)
        axes[row][col] = eig.vectors[row][order[col]];
    // 保证右手系（det=+1）
    const det = axes[0][0] * (axes[1][1] * axes[2][2] - axes[1][2] * axes[2][1])
              - axes[0][1] * (axes[1][0] * axes[2][2] - axes[1][2] * axes[2][0])
              + axes[0][2] * (axes[1][0] * axes[2][1] - axes[1][1] * axes[2][0]);
    if (det < 0) for (let row = 0; row < 3; row++) axes[row][2] = -axes[row][2];
    return { centroid: c, axes };
  }

  /**
   * PCA 粗对齐：主轴对齐 + 4 种符号翻转，返回全部候选（含评分），
   * 供后续逐一 ICP 精化后择优——子集扫描的 PCA 主轴可能反号，
   * 单靠粗评分无法可靠区分。
   */
  function coarseAlign(srcLocal, dstLocal, maxDist) {
    const S = pcaOf(srcLocal), D = pcaOf(dstLocal);
    const dstNN = buildNNIndex(dstLocal);
    const sample = sampleIndices(srcLocal.length / 3, 1500);
    const flips = [
      [1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]
    ];
    const candidates = [];
    for (const f of flips) {
      // R = D * diag(f) * S^T
      const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let k = 0; k < 3; k++) s += D.axes[r][k] * f[k] * S.axes[c][k];
          R[r][c] = s;
        }
      // t = cD - R * cS
      const t = [0, 0, 0];
      for (let r = 0; r < 3; r++) {
        t[r] = D.centroid[r]
          - (R[r][0] * S.centroid[0] + R[r][1] * S.centroid[1] + R[r][2] * S.centroid[2]);
      }
      const mat = new THREE.Matrix4().set(
        R[0][0], R[0][1], R[0][2], t[0],
        R[1][0], R[1][1], R[1][2], t[1],
        R[2][0], R[2][1], R[2][2], t[2],
        0, 0, 0, 1);
      candidates.push({ matrix: mat, score: trimmedRms(srcLocal, mat, dstNN, maxDist, sample) });
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates;
  }

  /** 抽样点在矩阵变换下对索引的裁剪最近邻 RMS（保留最近 70%）。 */
  function trimmedRms(srcLocal, matrix, dstNN, maxDist, sample) {
    const e = matrix.elements;
    const dists = [];
    for (const i of sample) {
      const lx = srcLocal[i * 3], ly = srcLocal[i * 3 + 1], lz = srcLocal[i * 3 + 2];
      const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
      const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
      const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
      const hit = nearestInIndex(dstNN, x, y, z, maxDist);
      if (hit) dists.push(hit.dist);
    }
    if (dists.length < 20) return Infinity;
    dists.sort((a, b) => a - b);
    const m = Math.max(1, Math.floor(dists.length * 0.7));
    let sum = 0;
    for (let i = 0; i < m; i++) sum += dists[i] * dists[i];
    return Math.sqrt(sum / m);
  }

  /**
   * 自动配准：PCA 粗对齐产生 4 个候选，各自 ICP 精化后按最终误差择优，
   * 最优候选再补一轮精化。
   * @returns {{matrix, rms, iterations, coarseScore}|null}
   */
  function autoAlign(srcLocal, dstLocal, opts) {
    opts = opts || {};
    const maxDist = opts.maxDist || 1.0;
    const candidates = coarseAlign(srcLocal, dstLocal, maxDist);
    if (!candidates.length) return null;
    const dstNN = buildNNIndex(dstLocal);
    const scoreSample = sampleIndices(srcLocal.length / 3, 2000);

    let best = null, totalIter = 0;
    for (const cand of candidates) {
      const refined = runICP(srcLocal, matrixToTransform(cand.matrix), dstLocal,
        { position: [0, 0, 0], rotationDeg: [0, 0, 0] },
        { maxIter: opts.candidateIter || 25, maxDist, maxSamples: 1500, trim: opts.trim });
      if (!refined) continue;
      totalIter += refined.iterations;
      const score = trimmedRms(srcLocal, refined.matrix, dstNN, maxDist / 2, scoreSample);
      if (!best || score < best.score) best = { matrix: refined.matrix, score };
    }
    if (!best) return null;

    // 最优候选最终精化（点到面，对近平面扫描更稳）
    const final = runICPPointToPlane(srcLocal, matrixToTransform(best.matrix), dstLocal,
      { position: [0, 0, 0], rotationDeg: [0, 0, 0] },
      { maxIter: opts.maxIter || 30, maxDist: maxDist / 2, maxSamples: 3000, trim: opts.trim });
    if (final) {
      totalIter += final.iterations;
      const finalScore = trimmedRms(srcLocal, final.matrix, dstNN, maxDist / 2, scoreSample);
      if (finalScore <= best.score) {
        best = { matrix: final.matrix, score: finalScore };
      }
    }
    return { matrix: best.matrix, rms: best.score,
             iterations: totalIter, coarseScore: candidates[0].score };
  }

  /* ---------- 点到面 ICP（精化阶段，对近平面扫描收敛更准） ---------- */

  /** 索引中的 k 近邻（逐环扩展），返回索引数组。 */
  function knnInIndex(idx, x, y, z, k) {
    const { positions, grid, cell } = idx;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let cand = [];
    for (let r = 0; r <= 8; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const arr = grid.get((cx + dx) + "," + (cy + dy) + "," + (cz + dz));
            if (arr) for (let t = 0; t < arr.length; t++) cand.push(arr[t]);
          }
      if (cand.length >= k * 2 || (cand.length >= k && r >= 2)) break;
    }
    const dists = cand.map(j => {
      const dx = positions[j * 3] - x, dy = positions[j * 3 + 1] - y, dz = positions[j * 3 + 2] - z;
      return { j, d2: dx * dx + dy * dy + dz * dz };
    });
    dists.sort((a, b) => a.d2 - b.d2);
    return dists.slice(0, k).map(e => e.j);
  }

  /**
   * 估计点集法向：每点取 k 近邻做局部 PCA，最小特征向量即法向。
   * 返回 Float32Array(n*3)。点数过多时只对抽样点估计（供 ICP 使用足够）。
   */
  function estimateNormals(positions, k, maxPoints) {
    const n = positions.length / 3;
    const idx = buildNNIndex(positions);
    const normals = new Float32Array(n * 3);
    const step = Math.max(1, Math.ceil(n / (maxPoints || 20000)));
    for (let i = 0; i < n; i += step) {
      const nbr = knnInIndex(idx, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], k);
      if (nbr.length < 3) continue;
      const c = [0, 0, 0];
      for (const j of nbr) {
        c[0] += positions[j * 3]; c[1] += positions[j * 3 + 1]; c[2] += positions[j * 3 + 2];
      }
      c[0] /= nbr.length; c[1] /= nbr.length; c[2] /= nbr.length;
      let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
      for (const j of nbr) {
        const x = positions[j * 3] - c[0], y = positions[j * 3 + 1] - c[1], z = positions[j * 3 + 2] - c[2];
        xx += x * x; xy += x * y; xz += x * z;
        yy += y * y; yz += y * z; zz += z * z;
      }
      const eig = jacobiEigen3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
      // 最小特征值对应特征向量
      let mi = 0;
      if (eig.values[1] < eig.values[mi]) mi = 1;
      if (eig.values[2] < eig.values[mi]) mi = 2;
      normals[i * 3] = eig.vectors[0][mi];
      normals[i * 3 + 1] = eig.vectors[1][mi];
      normals[i * 3 + 2] = eig.vectors[2][mi];
    }
    return normals;
  }

  /** 6x6 线性方程组求解（部分主元高斯消元）。 */
  function solve6(A, b) {
    const M = A.map((row, i) => row.concat(b[i]));
    for (let col = 0; col < 6; col++) {
      let piv = col;
      for (let r = col + 1; r < 6; r++)
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-14) return null;
      [M[col], M[piv]] = [M[piv], M[col]];
      for (let r = 0; r < 6; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        for (let c = col; c <= 6; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((row, i) => row[6] / M[i][i]);
  }

  /**
   * 点到面 ICP：线性化旋转，每轮解 6 自由度最小二乘。
   * 对近平面/地形类扫描比点到点收敛快且不易滑动。
   * @returns {{matrix, rms, iterations}|null}
   */
  function runICPPointToPlane(srcLocal, srcTransform, dstLocal, dstTransform, opts) {
    opts = opts || {};
    const maxIter = opts.maxIter || 20;
    const maxDist = opts.maxDist || 0.5;
    const maxSamples = opts.maxSamples || 3000;
    const trim = Math.min(1, Math.max(0.3, opts.trim || 0.8));

    const dstWorld = transformPoints(dstLocal, transformToMatrix(dstTransform));
    const nnIdx = buildNNIndex(dstWorld);
    const normals = estimateNormals(dstWorld, 10, 20000);
    const sample = sampleIndices(srcLocal.length / 3, maxSamples);

    let matrix = transformToMatrix(srcTransform);
    let rms = null, prevRms = Infinity, iter = 0;

    for (; iter < maxIter; iter++) {
      const e = matrix.elements;
      // 收集配对（点到面）
      const rows = [];
      const bs = [];
      const ds = [];
      for (let s = 0; s < sample.length; s++) {
        const i = sample[s];
        const lx = srcLocal[i * 3], ly = srcLocal[i * 3 + 1], lz = srcLocal[i * 3 + 2];
        const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
        const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
        const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
        const hit = nearestInIndex(nnIdx, x, y, z, maxDist);
        if (!hit) continue;
        const j = hit.index;
        const nx = normals[j * 3], ny = normals[j * 3 + 1], nz = normals[j * 3 + 2];
        if (nx === 0 && ny === 0 && nz === 0) continue;
        const qx = dstWorld[j * 3], qy = dstWorld[j * 3 + 1], qz = dstWorld[j * 3 + 2];
        // 行向量 a = [p × n, n]，b = n·(q - p)
        rows.push([
          y * nz - z * ny, z * nx - x * nz, x * ny - y * nx, nx, ny, nz
        ]);
        bs.push(nx * (qx - x) + ny * (qy - y) + nz * (qz - z));
        ds.push(hit.dist);
      }
      if (rows.length < 10) return null;

      // 裁剪最远配对
      const order = ds.map((d, i) => i).sort((a, b) => ds[a] - ds[b]);
      const m = Math.max(10, Math.floor(order.length * trim));

      // 构建法方程 A^T A x = A^T b
      const AtA = Array.from({ length: 6 }, () => new Array(6).fill(0));
      const Atb = new Array(6).fill(0);
      let sum = 0;
      for (let t = 0; t < m; t++) {
        const a = rows[order[t]], b = bs[order[t]];
        for (let r = 0; r < 6; r++) {
          Atb[r] += a[r] * b;
          for (let c = 0; c < 6; c++) AtA[r][c] += a[r] * a[c];
        }
        sum += b * b;
      }
      const x = solve6(AtA, Atb);
      if (!x) return null;

      // 由旋转向量构造增量矩阵（Rodrigues）
      const w = [x[0], x[1], x[2]];
      const angle = Math.hypot(w[0], w[1], w[2]);
      const delta = new THREE.Matrix4();
      if (angle > 1e-12) {
        const axis = new THREE.Vector3(w[0] / angle, w[1] / angle, w[2] / angle);
        delta.makeRotationAxis(axis, angle);
      }
      delta.setPosition(x[3], x[4], x[5]);
      matrix = delta.multiply(matrix.clone());

      rms = Math.sqrt(sum / m);
      if (prevRms - rms < 1e-8) { iter++; break; }
      prevRms = rms;
    }
    return { matrix, rms, iterations: iter + 1 };
  }

  function centroidOfSample(positions, sample, matrix) {
    const c = [0, 0, 0];
    const e = matrix ? matrix.elements : null;
    for (let s = 0; s < sample.length; s++) {
      const i = sample[s];
      let x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (e) {
        const nx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const ny = e[1] * x + e[5] * y + e[9] * z + e[13];
        const nz = e[2] * x + e[6] * y + e[10] * z + e[14];
        x = nx; y = ny; z = nz;
      }
      c[0] += x; c[1] += y; c[2] += z;
    }
    c[0] /= sample.length; c[1] /= sample.length; c[2] /= sample.length;
    return c;
  }

  return { transformToMatrix, matrixToTransform, transformPoints,
           buildNNIndex, nearestInIndex, registrationError, runICP, hornAlignment,
           coarseAlign, autoAlign, estimateNormals, runICPPointToPlane };
})();
