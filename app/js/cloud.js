/* cloud.js — 点云数据模型：撤销栈、裁剪、离群点筛除、稀疏采样。 */
"use strict";

class PointCloud {
  /**
   * @param {string} name       显示名（通常为文件名）
   * @param {Float32Array} positions
   * @param {Uint8Array|null} colors
   */
  constructor(name, positions, colors) {
    this.name = name;
    this.positions = positions;
    this.colors = colors;
    /** 撤销栈：每项 {positions, colors, label}，栈底即原始点集 */
    this.undoStack = [];
    /** 操作日志（写入项目文件与项目说明） */
    this.ops = [];
    /** 用户变换：position 为平移，rotationDeg 为 XYZ 欧拉角（度） */
    this.transform = { position: [0, 0, 0], rotationDeg: [0, 0, 0] };
  }

  get count() { return this.positions.length / 3; }

  pushUndo(label) {
    this.undoStack.push({ positions: this.positions, colors: this.colors, label });
    if (this.undoStack.length > 30) this.undoStack.shift();
  }

  /** 撤销一步；返回被撤销的操作名，栈空返回 null。 */
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.positions = prev.positions;
    this.colors = prev.colors;
    this.ops.push("撤销: " + prev.label);
    return prev.label;
  }

  /** 按布尔掩码保留点（keep[i] 为 true 保留）。记录撤销与日志。 */
  applyMask(keep, label) {
    const n = this.count;
    let m = 0;
    for (let i = 0; i < n; i++) if (keep[i]) m++;
    this.pushUndo(label);
    const pos = new Float32Array(m * 3);
    const col = this.colors ? new Uint8Array(m * 3) : null;
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (!keep[i]) continue;
      pos[j * 3] = this.positions[i * 3];
      pos[j * 3 + 1] = this.positions[i * 3 + 1];
      pos[j * 3 + 2] = this.positions[i * 3 + 2];
      if (col) {
        col[j * 3] = this.colors[i * 3];
        col[j * 3 + 1] = this.colors[i * 3 + 1];
        col[j * 3 + 2] = this.colors[i * 3 + 2];
      }
      j++;
    }
    this.positions = pos;
    this.colors = col;
    this.ops.push(`${label}: ${n} → ${m} 点`);
    return m;
  }

  /** 轴对齐包围盒 {min:[...], max:[...]}，空云返回 null。 */
  bbox() {
    if (this.count === 0) return null;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < min[k]) min[k] = p[i + k];
        if (p[i + k] > max[k]) max[k] = p[i + k];
      }
    }
    return { min, max };
  }

  /** 局部坐标裁剪掩码：保留落在 [min,max] 盒内的点。 */
  cropMask(min, max) {
    const n = this.count, p = this.positions;
    const keep = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      keep[i] = (x >= min[0] && x <= max[0] &&
                 y >= min[1] && y <= max[1] &&
                 z >= min[2] && z <= max[2]) ? 1 : 0;
    }
    return keep;
  }

  /** 体素降采样掩码：每个边长 voxelSize 的体素只保留第一个点。 */
  voxelMask(voxelSize) {
    const n = this.count, p = this.positions;
    const seen = new Set();
    const keep = new Uint8Array(n);
    const inv = 1 / voxelSize;
    for (let i = 0; i < n; i++) {
      const key = Math.floor(p[i * 3] * inv) + "," +
                  Math.floor(p[i * 3 + 1] * inv) + "," +
                  Math.floor(p[i * 3 + 2] * inv);
      if (!seen.has(key)) { seen.add(key); keep[i] = 1; }
    }
    return keep;
  }

  /** 随机保留比掩码。 */
  randomMask(ratio) {
    const n = this.count;
    const keep = new Uint8Array(n);
    for (let i = 0; i < n; i++) keep[i] = Math.random() < ratio ? 1 : 0;
    return keep;
  }

  /**
   * 统计离群点掩码：对每个点取 k 近邻平均距离，
   * 均值距离 > 全局均值 + stdRatio * 标准差 的点判为离群（不保留）。
   * 点数超过 maxCheck 时抽样估计阈值，再逐点判定。
   */
  outlierMask(k, stdRatio) {
    const n = this.count, p = this.positions;
    if (n <= k) { const keep = new Uint8Array(n); keep.fill(1); return keep; }

    // 依据密度估计网格单元边长
    const bb = this.bbox();
    const vol = Math.max(1e-12,
      (bb.max[0] - bb.min[0]) * (bb.max[1] - bb.min[1]) * (bb.max[2] - bb.min[2]));
    const cell = Math.cbrt(vol / n) * 2;

    const grid = buildGrid(p, cell);

    const meanDist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      meanDist[i] = knnMeanDist(p, i, k, grid, cell);
    }

    let mean = 0;
    for (let i = 0; i < n; i++) mean += meanDist[i];
    mean /= n;
    let sq = 0;
    for (let i = 0; i < n; i++) sq += (meanDist[i] - mean) * (meanDist[i] - mean);
    const std = Math.sqrt(sq / n);
    const thresh = mean + stdRatio * std;

    const keep = new Uint8Array(n);
    for (let i = 0; i < n; i++) keep[i] = meanDist[i] <= thresh ? 1 : 0;
    return keep;
  }
}

/* ---------- 空间哈希网格工具（供离群点与配准共用） ---------- */

function buildGrid(positions, cell) {
  const grid = new Map();
  const n = positions.length / 3;
  const inv = 1 / cell;
  for (let i = 0; i < n; i++) {
    const key = Math.floor(positions[i * 3] * inv) + "," +
                Math.floor(positions[i * 3 + 1] * inv) + "," +
                Math.floor(positions[i * 3 + 2] * inv);
    let arr = grid.get(key);
    if (!arr) { arr = []; grid.set(key, arr); }
    arr.push(i);
  }
  return grid;
}

function gridNeighbors(grid, x, y, z, cell, radiusCells) {
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
  const out = [];
  for (let dx = -radiusCells; dx <= radiusCells; dx++)
    for (let dy = -radiusCells; dy <= radiusCells; dy++)
      for (let dz = -radiusCells; dz <= radiusCells; dz++) {
        const arr = grid.get((cx + dx) + "," + (cy + dy) + "," + (cz + dz));
        if (arr) for (let t = 0; t < arr.length; t++) out.push(arr[t]);
      }
  return out;
}

/** 点 i 的 k 近邻平均距离（网格逐步扩大搜索半径）。 */
function knnMeanDist(p, i, k, grid, cell) {
  const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
  let radius = 1, cand = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    cand = gridNeighbors(grid, x, y, z, cell, radius);
    if (cand.length > k) break;
    radius *= 2;
  }
  const dists = [];
  for (const j of cand) {
    if (j === i) continue;
    const dx = p[j * 3] - x, dy = p[j * 3 + 1] - y, dz = p[j * 3 + 2] - z;
    dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  if (dists.length === 0) return 0;
  dists.sort((a, b) => a - b);
  const m = Math.min(k, dists.length);
  let s = 0;
  for (let t = 0; t < m; t++) s += dists[t];
  return s / m;
}
