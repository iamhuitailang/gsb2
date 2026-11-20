// QEM（Garland–Heckbert 二次误差度量）边折叠简化。
// 关键约束：
//  1. 只折叠真实边 —— 边只存在于同一连通分量内部，因此不同对象永远不会被焊接；
//  2. 每个连通分量按原始面数比例分配面数预算，并至少保留 1 个面，避免小对象整体消失；
//  3. 边界边附加约束平面（可配权重），抑制轮廓收缩。

import { Mesh, computeVertexNormals, connectedComponents } from './mesh.js';

// 4x4 对称矩阵只用 10 个分量存储：
// [aa, ab, ac, ad, bb, bc, bd, cc, cd, dd]
function faceQuadric(px, py, pz, nx, ny, nz, d) {
  const a = nx, b = ny, c = nz;
  return [
    a * a, a * b, a * c, a * d,
    b * b, b * c, b * d,
    c * c, c * d,
    d * d,
  ];
}

function addQuadric(q1, q2) {
  const out = new Float64Array(10);
  for (let i = 0; i < 10; i++) out[i] = q1[i] + q2[i];
  return out;
}

function quadricCost(q, x, y, z) {
  const [aa, ab, ac, ad, bb, bc, bd, cc, cd, dd] = q;
  return (
    aa * x * x + 2 * ab * x * y + 2 * ac * x * z + 2 * ad * x +
    bb * y * y + 2 * bc * y * z + 2 * bd * y +
    cc * z * z + 2 * cd * z +
    dd
  );
}

/**
 * 求使 v^T Q v 最小的最优折叠点；奇异时退回到中点/端点中代价最小者。
 */
function optimalPosition(q, pa, pb) {
  const [aa, ab, ac, ad, bb, bc, bd, cc, cd] = q;
  const det =
    aa * (bb * cc - bc * bc) -
    ab * (ab * cc - bc * ac) +
    ac * (ab * bc - bb * ac);
  if (Math.abs(det) > 1e-10) {
    const rhs = [-ad, -bd, -cd];
    const invDet = 1 / det;
    const m00 = (bb * cc - bc * bc) * invDet;
    const m01 = (ac * bc - ab * cc) * invDet;
    const m02 = (ab * bc - ac * bb) * invDet;
    const m11 = (aa * cc - ac * ac) * invDet;
    const m12 = (ab * ac - aa * bc) * invDet;
    const m22 = (aa * bb - ab * ab) * invDet;
    const x = m00 * rhs[0] + m01 * rhs[1] + m02 * rhs[2];
    const y = m01 * rhs[0] + m11 * rhs[1] + m12 * rhs[2];
    const z = m02 * rhs[0] + m12 * rhs[1] + m22 * rhs[2];
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return [x, y, z];
    }
  }
  const candidates = [
    pa,
    pb,
    [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2],
  ];
  let best = candidates[0];
  let bestCost = Infinity;
  for (const c of candidates) {
    const cost = quadricCost(q, c[0], c[1], c[2]);
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  return [...best];
}

// 最小二叉堆（按 cost 升序），懒删除靠顶点 version 校验。
class MinHeap {
  constructor() { this.h = []; }
  get size() { return this.h.length; }
  push(entry) {
    const h = this.h;
    h.push(entry);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (h[parent].cost <= h[i].cost) break;
      [h[parent], h[i]] = [h[i], h[parent]];
      i = parent;
    }
  }
  pop() {
    const h = this.h;
    if (h.length === 0) return null;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let smallest = i;
        if (l < h.length && h[l].cost < h[smallest].cost) smallest = l;
        if (r < h.length && h[r].cost < h[smallest].cost) smallest = r;
        if (smallest === i) break;
        [h[smallest], h[i]] = [h[i], h[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * @param {Mesh} mesh 输入网格（不会被修改）
 * @param {number} targetFaces 目标三角面数
 * @param {object} [opts]
 * @param {number} [opts.boundaryWeight=10] 边界约束平面权重；0 表示不做边界保护
 * @returns {{mesh:Mesh, targetFaceCount:number, collapses:number, componentBudgets:number[], componentFacesAfter:number[], error:string|null}}
 */
export function simplifyMesh(mesh, targetFaces, opts = {}) {
  const boundaryWeight = opts.boundaryWeight ?? 10;
  const originalFaces = mesh.faceCount;
  targetFaces = Math.max(1, Math.floor(targetFaces));
  if (targetFaces >= originalFaces) {
    const clone = mesh.clone();
    if (!clone.normals) computeVertexNormals(clone);
    const cc = connectedComponents(clone);
    return {
      mesh: clone,
      targetFaceCount: targetFaces,
      collapses: 0,
      componentBudgets: componentFaceCounts(cc),
      componentFacesAfter: componentFaceCounts(cc),
      error: null,
    };
  }

  const n = mesh.vertexCount;
  const positions = new Float64Array(mesh.positions); // 折叠中用 float64 累积
  const { vertexComponents, faceComponents, count: compCount } = connectedComponents(mesh);

  // 每个连通分量的面数预算（比例分配 + 至少 1 面）
  const origCompFaces = new Array(compCount).fill(0);
  for (let f = 0; f < originalFaces; f++) origCompFaces[faceComponents[f]]++;
  const budget = origCompFaces.map((fi) =>
    Math.max(1, Math.round((targetFaces * fi) / originalFaces))
  );
  // 修正取整导致的总量越界
  while (budget.reduce((s, b) => s + b, 0) > targetFaces) {
    let idx = -1, slack = 0;
    budget.forEach((b, i) => { if (b - 1 > slack) { slack = b - 1; idx = i; } });
    if (idx < 0) break;
    budget[idx]--;
  }
  const compFaceCount = [...origCompFaces];

  // 面表：[v0,v1,v2] 或 null（已消亡）
  const faceVerts = [];
  for (let f = 0; f < originalFaces; f++) {
    faceVerts.push([mesh.indices[f * 3], mesh.indices[f * 3 + 1], mesh.indices[f * 3 + 2]]);
  }
  const faceComp = Int32Array.from(faceComponents);

  // 顶点 -> 面集合、邻接顶点集合
  const vertFaces = Array.from({ length: n }, () => new Set());
  const adj = Array.from({ length: n }, () => new Set());
  const edgeFaces = new Map(); // edgeKey -> 面数
  const edgeKey = (a, b) => (a < b ? a * n + b : b * n + a);
  faceVerts.forEach((fv, f) => {
    const [a, b, c] = fv;
    vertFaces[a].add(f); vertFaces[b].add(f); vertFaces[c].add(f);
    adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
    edgeFaces.set(edgeKey(a, b), (edgeFaces.get(edgeKey(a, b)) || 0) + 1);
    edgeFaces.set(edgeKey(b, c), (edgeFaces.get(edgeKey(b, c)) || 0) + 1);
    edgeFaces.set(edgeKey(a, c), (edgeFaces.get(edgeKey(a, c)) || 0) + 1);
  });

  // 顶点二次误差
  const quadrics = Array.from({ length: n }, () => new Float64Array(10));
  faceVerts.forEach((fv) => {
    const [a, b, c] = fv;
    const ux = positions[b * 3] - positions[a * 3];
    const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-18) return; // 退化面对 Q 无贡献
    nx /= len; ny /= len; nz /= len;
    const d = -(nx * positions[a * 3] + ny * positions[a * 3 + 1] + nz * positions[a * 3 + 2]);
    const q = faceQuadric(0, 0, 0, nx, ny, nz, d);
    for (const v of fv) for (let i = 0; i < 10; i++) quadrics[v][i] += q[i];
  });

  // 边界边约束平面：位于入射面内、垂直于边方向
  if (boundaryWeight > 0) {
    for (const [key, count] of edgeFaces) {
      if (count !== 1) continue;
      const a = Math.floor(key / n), b = key % n;
      let faceId = null;
      for (const f of vertFaces[a]) if (vertFaces[b].has(f)) { faceId = f; break; }
      if (faceId === null) continue;
      const fv = faceVerts[faceId];
      const third = fv.find((v) => v !== a && v !== b);
      const ex = positions[b * 3] - positions[a * 3];
      const ey = positions[b * 3 + 1] - positions[a * 3 + 1];
      const ez = positions[b * 3 + 2] - positions[a * 3 + 2];
      const el = Math.hypot(ex, ey, ez) || 1;
      // 面法线
      const ux = positions[third * 3] - positions[a * 3];
      const uy = positions[third * 3 + 1] - positions[a * 3 + 1];
      const uz = positions[third * 3 + 2] - positions[a * 3 + 2];
      let nx = (ey / el) * uz - (ez / el) * uy;
      let ny = (ez / el) * ux - (ex / el) * uz;
      let nz = (ex / el) * uy - (ey / el) * ux;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-18) continue;
      nx /= nl; ny /= nl; nz /= nl;
      const d = -(nx * positions[a * 3] + ny * positions[a * 3 + 1] + nz * positions[a * 3 + 2]);
      const q = faceQuadric(0, 0, 0, nx, ny, nz, d);
      for (const v of [a, b]) for (let i = 0; i < 10; i++) quadrics[v][i] += boundaryWeight * q[i];
    }
  }

  const active = new Uint8Array(n).fill(1);
  const version = new Int32Array(n);
  const heap = new MinHeap();

  const pointOf = (v) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
  const pushEdge = (a, b) => {
    const q = addQuadric(quadrics[a], quadrics[b]);
    const p = optimalPosition(q, pointOf(a), pointOf(b));
    const cost = Math.max(0, quadricCost(q, p[0], p[1], p[2]));
    heap.push({ cost, a, b, va: version[a], vb: version[b] });
  };
  for (const [key] of edgeFaces) {
    pushEdge(Math.floor(key / n), key % n);
  }

  let liveFaces = originalFaces;
  let collapses = 0;
  let stopReason = null;

  while (liveFaces > targetFaces && heap.size > 0) {
    const entry = heap.pop();
    const { a, b, va, vb } = entry;
    if (!active[a] || !active[b] || version[a] !== va || version[b] !== vb || a === b) continue;

    const comp = vertexComponents[a]; // 分量不会合并，静态归属始终有效
    if (compFaceCount[comp] <= budget[comp]) continue; // 该分量已到预算，跳过其内部折叠

    const q = addQuadric(quadrics[a], quadrics[b]);
    const p = optimalPosition(q, pointOf(a), pointOf(b));

    // 执行折叠：b 并入 a
    let deadFaces = 0;
    for (const f of [...vertFaces[b]]) {
      const fv = faceVerts[f];
      if (fv.includes(a)) {
        fv.forEach((v) => vertFaces[v].delete(f));
        faceVerts[f] = null;
        deadFaces++;
      } else {
        const k = fv.indexOf(b);
        fv[k] = a;
        vertFaces[a].add(f);
      }
    }
    vertFaces[b].clear();

    positions[a * 3] = p[0]; positions[a * 3 + 1] = p[1]; positions[a * 3 + 2] = p[2];
    quadrics[a] = q;
    active[b] = 0;
    version[a]++; version[b]++;
    compFaceCount[comp] -= deadFaces;
    liveFaces -= deadFaces;
    collapses++;

    // 合并邻接关系
    for (const w of [...adj[b]]) {
      adj[w].delete(b);
      if (w !== a) {
        adj[w].add(a);
        adj[a].add(w);
      }
    }
    adj[b].clear();
    // a 的位置与误差都变了，所有关联边重新估价
    for (const w of adj[a]) pushEdge(a, w);
  }

  if (liveFaces > targetFaces) {
    stopReason = `堆已空，提前停止（分量预算或拓扑限制），实际面数 ${liveFaces} > 目标 ${targetFaces}`;
  }

  // 紧凑化输出
  const remap = new Int32Array(n).fill(-1);
  const outPositions = [];
  for (let v = 0; v < n; v++) {
    if (active[v]) {
      remap[v] = outPositions.length / 3;
      outPositions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    }
  }
  const outIndices = [];
  const outComp = [];
  const finalCompFaces = new Array(compCount).fill(0);
  for (let f = 0; f < originalFaces; f++) {
    const fv = faceVerts[f];
    if (!fv) continue;
    outIndices.push(remap[fv[0]], remap[fv[1]], remap[fv[2]]);
    outComp.push(faceComp[f]);
    finalCompFaces[faceComp[f]]++;
  }

  const result = new Mesh({
    positions: Float32Array.from(outPositions),
    indices: Uint32Array.from(outIndices),
    name: mesh.name,
  });
  computeVertexNormals(result);
  return {
    mesh: result,
    targetFaceCount: targetFaces,
    collapses,
    componentBudgets: budget,
    componentFacesAfter: finalCompFaces,
    error: stopReason,
  };
}

function componentFaceCounts(cc) {
  const counts = new Array(cc.count).fill(0);
  for (const c of cc.faceComponents) counts[c]++;
  return counts;
}
