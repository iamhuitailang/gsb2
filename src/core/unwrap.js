// UV 展开：等距三角形展开（保持每个三角形边长，逐三角形铺开）与平面投影。
// 输出写入 mesh.uvSets[setIndex]，只修改指定面集合，其余面的 UV 不动。

import { adjacentFace, isSeam } from './topology.js';

const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a) => {
  const l = vlen(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * 沿非切缝邻接，在 faceSet 内做洪水填充，得到连通区域列表。
 */
export function regionConnected(mesh, faceSet) {
  const { faces, topology, seams } = mesh;
  const seen = new Set();
  const regions = [];
  for (const seed of faceSet) {
    if (seen.has(seed)) continue;
    const region = [];
    const stack = [seed];
    seen.add(seed);
    while (stack.length) {
      const f = stack.pop();
      region.push(f);
      for (let k = 0; k < 3; k++) {
        const c = f * 3 + k;
        const nf = adjacentFace(topology, c);
        if (nf < 0 || seen.has(nf) || !faceSet.has(nf)) continue;
        const a = faces[f][k];
        const b = faces[f][(k + 1) % 3];
        if (isSeam(seams, topology, a, b)) continue;
        seen.add(nf);
        stack.push(nf);
      }
    }
    regions.push(region);
  }
  return regions;
}

/**
 * 把一个连通区域等距铺到 2D：起始三角形按真实边长放置，
 * 之后每个跨过共享边的新三角形用三边长度求第三顶点；
 * 朝向由“新旧第三顶点在 3D 共享边两侧、UV 中也应在两侧”确定。
 *
 * @returns {Map<number,[number,number]>} 顶点 -> 2D 坐标
 */
function flattenRegion(mesh, region) {
  const { faces, positions } = mesh;
  const pos2 = new Map();
  if (region.length === 0) return pos2;

  // 选面积最大的三角形作起始面，数值更稳
  let start = region[0];
  let bestArea = -1;
  for (const f of region) {
    const [a, b, c] = faces[f];
    const area =
      0.5 * vlen(vcross(vsub(positions[b], positions[a]), vsub(positions[c], positions[a])));
    if (area > bestArea) {
      bestArea = area;
      start = f;
    }
  }

  // 起始三角形：ia 放原点，ib 放 +x 轴，ic 在 +y 侧
  {
    const [ia, ib, ic] = faces[start];
    const lab = vlen(vsub(positions[ib], positions[ia]));
    const lac = vlen(vsub(positions[ic], positions[ia]));
    const lbc = vlen(vsub(positions[ic], positions[ib]));
    const along = (lab * lab + lac * lac - lbc * lbc) / (2 * (lab || 1e-9));
    const h = Math.sqrt(Math.max(0, lac * lac - along * along));
    pos2.set(ia, [0, 0]);
    pos2.set(ib, [lab, 0]);
    pos2.set(ic, [along, h]);
  }

  const inRegion = new Set(region);
  const done = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const f = queue.shift();
    const [fa, fb, fc] = faces[f];
    const n3 = vnorm(vcross(vsub(positions[fb], positions[fa]), vsub(positions[fc], positions[fa])));

    for (let k = 0; k < 3; k++) {
      const c = f * 3 + k;
      const nf = adjacentFace(mesh.topology, c);
      if (nf < 0 || done.has(nf) || !inRegion.has(nf)) continue;
      const u0 = faces[f][k];
      const u1 = faces[f][(k + 1) % 3];
      if (isSeam(mesh.seams, mesh.topology, u0, u1)) continue;
      const w = faces[nf].find((v) => v !== u0 && v !== u1);
      if (w === undefined) continue;

      if (pos2.has(w)) {
        done.add(nf);
        queue.push(nf);
        continue;
      }

      const A = pos2.get(u0);
      const B = pos2.get(u1);
      const dx = B[0] - A[0];
      const dy = B[1] - A[1];
      const d = Math.hypot(dx, dy) || 1e-9;
      const luw = vlen(vsub(positions[w], positions[u0]));
      const lvw = vlen(vsub(positions[w], positions[u1]));
      const along = (d * d + luw * luw - lvw * lvw) / (2 * d);
      const h = Math.sqrt(Math.max(0, luw * luw - along * along));
      const nx = dx / d, ny = dy / d; // 共享边单位向量
      const leftX = -ny, leftY = nx;  // 左转 90°（边的左侧）

      // 旧第三顶点（当前面内）与新顶点在 3D 边的哪一侧
      const oldV = faces[f].find((v) => v !== u0 && v !== u1);
      const e3 = vnorm(vsub(positions[u1], positions[u0]));
      const sideOld = vdot(n3, vcross(e3, vsub(positions[oldV], positions[u0])));
      const sideNew = vdot(n3, vcross(e3, vsub(positions[w], positions[u0])));
      const oppositeSides = sideOld * sideNew < 0;

      // 旧顶点在 UV 边的哪一侧
      const oldUV = pos2.get(oldV);
      const sideOldUV = leftX * (oldUV[0] - A[0]) + leftY * (oldUV[1] - A[1]);
      const oldOnLeft = sideOldUV >= 0;
      // 新顶点：3D 中对侧 => UV 中也对侧
      const newOnLeft = oppositeSides ? !oldOnLeft : oldOnLeft;
      const s = newOnLeft ? 1 : -1;

      pos2.set(w, [
        A[0] + nx * along + leftX * h * s,
        A[1] + ny * along + leftY * h * s,
      ]);
      done.add(nf);
      queue.push(nf);
    }
  }
  return pos2;
}

/** 把展开结果归一化到 [0,1] 方框（保持比例，留 5% 边距，居中）。 */
function normalizeToUnitSquare(pos2) {
  const pts = [...pos2.values()];
  if (!pts.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const s = 0.9 / Math.max(w, h);
  for (const [v, [x, y]] of pos2) {
    pos2.set(v, [0.05 + (x - minX) * s, 0.05 + (y - minY) * s]);
  }
}

/**
 * 展开选中的面。切缝处断开，区域内共享顶点共用 UV 坐标；
 * 切缝另一侧的面不受影响（只写 faceSet 内的面）。
 *
 * 整体展开（faceSet 为空）时保留各区域真实尺寸比例，不做逐区域归一化，
 * 这样小岛不会被放大到与主岛同高，后续 packIslands 才能按真实面积装箱；
 * 局部展开（选中部分面）时才把该区域归一化进单位方框，便于直接查看。
 *
 * @param {object} mesh
 * @param {Set<number>} faceSet 要展开的面；为空时展开整个网格
 * @param {number} setIndex UV 套编号
 * @param {{mode?:'isometric'|'planar'}} [opts]
 * @returns {number} 展开的连通区域数
 */
export function unwrapFaces(mesh, faceSet, setIndex, opts = {}) {
  const mode = opts.mode ?? 'isometric';
  const isFull = !faceSet || !faceSet.size;
  const target = isFull ? new Set(mesh.faces.map((_, i) => i)) : faceSet;
  const regions = regionConnected(mesh, target);
  const uvs = mesh.uvSets[setIndex];

  for (const region of regions) {
    if (mode === 'planar') {
      applyPlanarProjection(mesh, region, uvs, !isFull);
      continue;
    }
    const pos2 = flattenRegion(mesh, region);
    if (!isFull) normalizeToUnitSquare(pos2);
    for (const f of region) {
      uvs[f] = mesh.faces[f].map((v) => {
        const p = pos2.get(v);
        return p ? [p[0], p[1]] : [0, 0];
      });
    }
  }
  return regions.length;
}

/**
 * 平面投影：用区域平均法向建立 2D 基，直接把 3D 顶点投上去。
 * 适合近平面区域，速度快且无拼接误差。normalize=true 时缩放进单位方框。
 */
function applyPlanarProjection(mesh, region, uvs, normalize = true) {
  const { faces, positions } = mesh;
  let n = [0, 0, 0];
  let center = [0, 0, 0];
  const verts = new Set();
  for (const f of region) {
    const [a, b, c] = faces[f];
    const fn = vcross(vsub(positions[b], positions[a]), vsub(positions[c], positions[a]));
    n = [n[0] + fn[0], n[1] + fn[1], n[2] + fn[2]];
    for (const v of faces[f]) {
      if (!verts.has(v)) {
        verts.add(v);
        center = [center[0] + positions[v][0], center[1] + positions[v][1], center[2] + positions[v][2]];
      }
    }
  }
  n = vnorm(n);
  center = center.map((x) => x / verts.size);
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const ex = vnorm(vcross(ref, n));
  const ey = vcross(n, ex);

  const pos2 = new Map();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of verts) {
    const d = vsub(positions[v], center);
    const x = vdot(d, ex);
    const y = vdot(d, ey);
    pos2.set(v, [x, y]);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  if (!normalize) {
    // 保留真实投影尺寸（单位与 3D 一致），仅平移使最小值接近 0
    for (const [v, [x, y]] of pos2) pos2.set(v, [x - minX, y - minY]);
    for (const f of region) uvs[f] = faces[f].map((v) => [...pos2.get(v)]);
    return;
  }
  const s = 0.9 / Math.max(w, h);
  for (const [v, [x, y]] of pos2) pos2.set(v, [0.05 + (x - minX) * s, 0.05 + (y - minY) * s]);
  for (const f of region) uvs[f] = faces[f].map((v) => [...pos2.get(v)]);
}
