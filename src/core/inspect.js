// UV 质量检查：岛间重叠、越界（超出 0..1 纹理方框）、过小区域。
// 重叠检测采用“光栅化占用表 + 岛对三角形精确相交”两层，
// 光栅化快速给出候选，精确相交确认并定位到具体面。

import { findIslands } from './topology.js';
import { islandBounds, triangleArea } from './islands.js';

const DEFAULT_OPTIONS = {
  resolution: 512,   // 光栅化分辨率
  minArea: 0.0008,   // 岛 UV 面积低于该值判为过小（约为单位纹理的 0.08%）
  bounds: 1,         // 合法范围 [0, bounds]
};

/** 把三角形画进占用网格，返回覆盖到的格子集合（每格记录岛 id）。 */
function rasterizeTriangle(grid, res, tri, islandId, owner) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of tri) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const x0 = Math.max(0, Math.floor(minX * res));
  const y0 = Math.max(0, Math.floor(minY * res));
  const x1 = Math.min(res - 1, Math.ceil(maxX * res));
  const y1 = Math.min(res - 1, Math.ceil(maxY * res));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const cx = (px + 0.5) / res;
      const cy = (py + 0.5) / res;
      if (pointInTriangle(cx, cy, tri)) {
        const idx = py * res + px;
        if (!grid[idx]) grid[idx] = [];
        if (!grid[idx].some((e) => e.island === islandId)) {
          grid[idx].push({ island: islandId, face: owner });
        }
      }
    }
  }
}

function pointInTriangle(px, py, tri) {
  const [[ax, ay], [bx, by], [cx, cy]] = tri;
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
const sign = (px, py, ax, ay, bx, by) =>
  (px - bx) * (ay - by) - (ax - bx) * (py - by);

/** 线段相交（含共线重叠），用于精确确认两个三角形是否相交。 */
function segmentsIntersect(p1, p2, q1, q2) {
  const d = (p2[0] - p1[0]) * (q2[1] - q1[1]) - (p2[1] - p1[1]) * (q2[0] - q1[0]);
  if (Math.abs(d) < 1e-12) {
    // 共线检查
    if (Math.abs(sign(q1[0], q1[1], p1[0], p1[1], p2[0], p2[1])) > 1e-12) return false;
    const onSeg = (a, b, c) =>
      Math.min(a[0], b[0]) - 1e-12 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-12 &&
      Math.min(a[1], b[1]) - 1e-12 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-12;
    return onSeg(p1, p2, q1) || onSeg(p1, p2, q2) || onSeg(q1, q2, p1);
  }
  const t = ((q1[0] - p1[0]) * (q2[1] - q1[1]) - (q1[1] - p1[1]) * (q2[0] - q1[0])) / d;
  const u = ((q1[0] - p1[0]) * (p2[1] - p1[1]) - (q1[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t >= -1e-10 && t <= 1 + 1e-10 && u >= -1e-10 && u <= 1 + 1e-10;
}

function trianglesIntersect(a, b) {
  // 任一点在另一三角形内，或任一组边相交
  if (pointInTriangle(a[0][0], a[0][1], b) || pointInTriangle(a[1][0], a[1][1], b) ||
      pointInTriangle(a[2][0], a[2][1], b)) return true;
  if (pointInTriangle(b[0][0], b[0][1], a) || pointInTriangle(b[1][0], b[1][1], a) ||
      pointInTriangle(b[2][0], b[2][1], a)) return true;
  const edgesA = [[a[0], a[1]], [a[1], a[2]], [a[2], a[0]]];
  const edgesB = [[b[0], b[1]], [b[1], b[2]], [b[2], b[0]]];
  for (const ea of edgesA) for (const eb of edgesB) {
    if (segmentsIntersect(ea[0], ea[1], eb[0], eb[1])) return true;
  }
  return false;
}

/**
 * 运行全部检查。
 * @returns {{overlaps:Array, outOfBounds:Array, tinyIslands:Array,
 *            islandCount:number, cellCount:number, maxIslandArea:number}}
 */
export function inspectUV(mesh, setIndex = 0, rawOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...rawOptions };
  const { islands } = findIslands(mesh, setIndex);
  const uvs = mesh.uvSets[setIndex];
  const res = opts.resolution;
  const grid = new Array(res * res).fill(null);

  // 1) 光栅化 + 候选岛对
  const candidatePairs = new Map(); // "i_j" -> 面候选
  islands.forEach((faces, id) => {
    for (const f of faces) rasterizeTriangle(grid, res, uvs[f], id, f);
  });
  for (const cell of grid) {
    if (!cell || cell.length < 2) continue;
    for (let i = 0; i < cell.length; i++) {
      for (let j = i + 1; j < cell.length; j++) {
        const [p, q] = cell[i].island < cell[j].island ? [cell[i], cell[j]] : [cell[j], cell[i]];
        const key = `${p.island}_${q.island}`;
        if (!candidatePairs.has(key)) candidatePairs.set(key, new Set());
        candidatePairs.get(key).add([p.face, q.face]);
      }
    }
  }

  // 2) 精确相交确认
  const overlaps = [];
  for (const [key, facePairs] of candidatePairs) {
    const [ia, ib] = key.split('_').map(Number);
    let confirmedFaces = [];
    for (const [fa, fb] of facePairs) {
      if (trianglesIntersect(uvs[fa], uvs[fb])) {
        confirmedFaces = [fa, fb];
        break;
      }
    }
    if (confirmedFaces.length) {
      overlaps.push({
        islands: [ia, ib],
        faces: confirmedFaces,
        message: `岛 #${ia} 与岛 #${ib} 重叠（面 ${confirmedFaces[0]} / ${confirmedFaces[1]}）`,
      });
    }
  }

  // 3) 越界检查
  const outOfBounds = [];
  islands.forEach((faces, id) => {
    const b = islandBounds(mesh, faces, setIndex);
    const eps = 1e-9;
    if (b.minX < -eps || b.minY < -eps || b.maxX > opts.bounds + eps || b.maxY > opts.bounds + eps) {
      outOfBounds.push({
        island: id,
        bounds: b,
        message: `岛 #${id} 越界：U[${b.minX.toFixed(3)}, ${b.maxX.toFixed(3)}] ` +
          `V[${b.minY.toFixed(3)}, ${b.maxY.toFixed(3)}]，应在 [0, ${opts.bounds}] 内`,
      });
    }
  });

  // 4) 过小岛
  const tinyIslands = [];
  let maxArea = 0;
  islands.forEach((faces, id) => {
    const b = islandBounds(mesh, faces, setIndex);
    maxArea = Math.max(maxArea, b.area);
    if (b.area < opts.minArea) {
      tinyIslands.push({
        island: id,
        area: b.area,
        faceCount: faces.length,
        message: `岛 #${id} 面积过小：${b.area.toExponential(2)}（${faces.length} 个面，阈值 ${opts.minArea}）`,
      });
    }
  });

  return {
    islandCount: islands.length,
    overlaps,
    outOfBounds,
    tinyIslands,
    maxIslandArea: maxArea,
    healthy: overlaps.length === 0 && outOfBounds.length === 0 && tinyIslands.length === 0,
  };
}

/** 供 UI 调用：计算单个面的 UV 面积。 */
export function faceUvArea(mesh, face, setIndex = 0) {
  return triangleArea(mesh.uvSets[setIndex][face]);
}
