// 简化前后偏差度量。
// 采用顶点采样 + 均匀空间网格最近点查询，双向计算：
//   正向 d(o→s)：原模型每个顶点到简化模型的最近距离
//   反向 d(s→o)：简化模型每个顶点到原模型的最近距离
// 对称 Hausdorff = max(maxForward, maxBackward)。
// 注意：这是基于顶点采样的近似 Hausdorff 距离，不是严格的面-面距离，
// 网格越密越准确；UI 与 README 中均明确标注这一点。

import { boundingBox } from './mesh.js';

class PointGrid {
  constructor(points, diagonal, targetCells = 96) {
    this.points = points;
    this.cell = Math.max(diagonal / targetCells, 1e-9);
    this.cells = new Map();
    for (let i = 0; i < points.length; i += 3) {
      const key = this._key(points[i], points[i + 1], points[i + 2]);
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(i);
    }
  }
  _key(x, y, z) {
    return `${Math.floor(x / this.cell)}|${Math.floor(y / this.cell)}|${Math.floor(z / this.cell)}`;
  }
  nearestDistance(x, y, z) {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const cz = Math.floor(z / this.cell);
    const pts = this.points;
    let best = Infinity;
    // 逐层扩大搜索半径，直到命中单元格
    for (let r = 0; r < 100000; r++) {
      let found = false;
      for (let ix = cx - r; ix <= cx + r; ix++) {
        for (let iy = cy - r; iy <= cy + r; iy++) {
          for (let iz = cz - r; iz <= cz + r; iz++) {
            if (Math.max(Math.abs(ix - cx), Math.abs(iy - cy), Math.abs(iz - cz)) !== r) continue;
            const cell = this.cells.get(`${ix}|${iy}|${iz}`);
            if (!cell) continue;
            found = true;
            for (const i of cell) {
              const dx = x - pts[i], dy = y - pts[i + 1], dz = z - pts[i + 2];
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < best) best = d2;
            }
          }
        }
      }
      if (found) return Math.sqrt(best);
    }
    return best === Infinity ? Infinity : Math.sqrt(best);
  }
  /** 最近点的顶点序号（区域法线对比用）。 */
  nearestVertex(x, y, z) {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const cz = Math.floor(z / this.cell);
    const pts = this.points;
    let best = Infinity, nearest = -1;
    for (let r = 0; r < 100000; r++) {
      let found = false;
      for (let ix = cx - r; ix <= cx + r; ix++) {
        for (let iy = cy - r; iy <= cy + r; iy++) {
          for (let iz = cz - r; iz <= cz + r; iz++) {
            if (Math.max(Math.abs(ix - cx), Math.abs(iy - cy), Math.abs(iz - cz)) !== r) continue;
            const cell = this.cells.get(`${ix}|${iy}|${iz}`);
            if (!cell) continue;
            found = true;
            for (const i of cell) {
              const dx = x - pts[i], dy = y - pts[i + 1], dz = z - pts[i + 2];
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < best) { best = d2; nearest = i / 3; }
            }
          }
        }
      }
      if (found) return nearest;
    }
    return nearest;
  }
}

function distancesFromVertices(sourceMesh, grid) {
  const out = new Float32Array(sourceMesh.vertexCount);
  const p = sourceMesh.positions;
  for (let v = 0; v < sourceMesh.vertexCount; v++) {
    out[v] = grid.nearestDistance(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
  }
  return out;
}

function summarize(distances) {
  let max = 0, sum = 0;
  for (const d of distances) {
    if (d > max) max = d;
    sum += d * d;
  }
  return { max, rms: Math.sqrt(sum / distances.length) };
}

/**
 * 两个网格间的偏差报告。
 * @returns {{hausdorff:number, rms:number, forwardMax:number, forwardRms:number,
 *            backwardMax:number, backwardRms:number, normalizedHausdorff:number,
 *            perVertexBackward:Float32Array}}
 * perVertexBackward：简化网格每个顶点到原模型的距离，可直接驱动偏差热力图。
 */
export function deviationReport(originalMesh, simplifiedMesh) {
  const bb = boundingBox(originalMesh);
  const targetGrid = new PointGrid(simplifiedMesh.positions, bb.diagonal);
  const sourceGrid = new PointGrid(originalMesh.positions, bb.diagonal);
  const forward = distancesFromVertices(originalMesh, targetGrid);
  const backward = distancesFromVertices(simplifiedMesh, sourceGrid);
  const f = summarize(forward);
  const b = summarize(backward);
  return {
    hausdorff: Math.max(f.max, b.max),
    rms: Math.sqrt((f.rms * f.rms + b.rms * b.rms) / 2),
    forwardMax: f.max,
    forwardRms: f.rms,
    backwardMax: b.max,
    backwardRms: b.rms,
    normalizedHausdorff: bb.diagonal > 0 ? Math.max(f.max, b.max) / bb.diagonal : 0,
    perVertexBackward: backward,
  };
}

/**
 * 选中区域的前后对比。
 * @param {Mesh} originalMesh
 * @param {Mesh} simplifiedMesh
 * @param {Uint8Array} region 长度为简化网格顶点数的 0/1 标记
 * @returns {{vertexCount:number, averageDistance:number, maxDistance:number,
 *            normalDeltaAvg:number, normalDeltaMax:number,
 *            rows:Array<{distance:number, normalAngleDeg:number}>}}
 */
export function regionComparison(originalMesh, simplifiedMesh, region) {
  const bb = boundingBox(originalMesh);
  const grid = new PointGrid(originalMesh.positions, bb.diagonal);
  const sNormals = simplifiedMesh.normals;
  const oNormals = originalMesh.normals;
  const rows = [];
  let sumD = 0, maxD = 0, sumAngle = 0, maxAngle = 0, count = 0;
  const sp = simplifiedMesh.positions;

  for (let v = 0; v < simplifiedMesh.vertexCount; v++) {
    if (!region[v]) continue;
    count++;
    const x = sp[v * 3], y = sp[v * 3 + 1], z = sp[v * 3 + 2];
    const d = grid.nearestDistance(x, y, z);
    sumD += d;
    if (d > maxD) maxD = d;

    let angle = null;
    if (sNormals && oNormals) {
      const nearest = grid.nearestVertex(x, y, z);
      if (nearest >= 0) {
        const dot = Math.max(-1, Math.min(1,
          sNormals[v * 3] * oNormals[nearest * 3] +
          sNormals[v * 3 + 1] * oNormals[nearest * 3 + 1] +
          sNormals[v * 3 + 2] * oNormals[nearest * 3 + 2]));
        angle = Math.acos(dot) * 180 / Math.PI;
        sumAngle += angle;
        if (angle > maxAngle) maxAngle = angle;
      }
    }
    if (rows.length < 500) rows.push({ distance: d, normalAngleDeg: angle });
  }

  return {
    vertexCount: count,
    averageDistance: count ? sumD / count : 0,
    maxDistance: maxD,
    normalDeltaAvg: count ? sumAngle / count : 0,
    normalDeltaMax: maxAngle,
    rows,
  };
}
