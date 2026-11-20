// 网格基础数据结构与几何/拓扑工具（纯逻辑，不依赖 DOM）
// 所有网格均为三角面：positions 为 n*3 浮点数组，indices 为 m*3  uint32 数组。

export class Mesh {
  /**
   * @param {object} p
   * @param {Float32Array|number[]} p.positions 顶点坐标，长度 n*3
   * @param {Uint32Array|number[]} p.indices   三角面索引，长度 m*3
   * @param {Float32Array|number[]|null} [p.normals] 可选顶点法线，长度 n*3
   * @param {string} [p.name]
   */
  constructor({ positions, indices, normals = null, name = 'mesh' }) {
    this.positions = positions instanceof Float32Array ? positions : new Float32Array(positions);
    this.indices = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
    this.normals = normals ? (normals instanceof Float32Array ? normals : new Float32Array(normals)) : null;
    this.name = name;
    if (this.indices.length % 3 !== 0) throw new Error('索引长度必须为 3 的倍数（仅支持三角面）');
  }

  get vertexCount() { return this.positions.length / 3; }
  get faceCount() { return this.indices.length / 3; }

  clone() {
    return new Mesh({
      positions: new Float32Array(this.positions),
      indices: new Uint32Array(this.indices),
      normals: this.normals ? new Float32Array(this.normals) : null,
      name: this.name,
    });
  }
}

export function boundingBox(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const diagonal = Math.hypot(size[0], size[1], size[2]);
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return { min, max, size, diagonal, center };
}

/** 面积加权顶点法线（与 Three.js computeVertexNormals 口径一致）。 */
export function computeVertexNormals(mesh) {
  const n = mesh.vertexCount;
  const normals = new Float32Array(n * 3);
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const vi of [a, b, c]) {
      normals[vi] += nx; normals[vi + 1] += ny; normals[vi + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (l > 1e-12) { normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l; }
  }
  mesh.normals = normals;
  return normals;
}

/**
 * 连通分量：基于面的顶点邻接做 BFS。
 * @returns {{vertexComponents:Int32Array, faceComponents:Int32Array, count:number, isolated:number[]}}
 * 没有被任何面引用的顶点记为 -1，并收入 isolated 列表。
 */
export function connectedComponents(mesh) {
  const n = mesh.vertexCount;
  const adj = Array.from({ length: n }, () => []);
  const used = new Uint8Array(n);
  const idx = mesh.indices;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f], b = idx[f + 1], c = idx[f + 2];
    used[a] = used[b] = used[c] = 1;
    adj[a].push(b, c); adj[b].push(a, c); adj[c].push(a, b);
  }
  const comp = new Int32Array(n).fill(-1);
  const isolated = [];
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (!used[s]) { isolated.push(s); continue; }
    if (comp[s] !== -1) continue;
    const queue = [s];
    comp[s] = count;
    while (queue.length) {
      const v = queue.pop();
      for (const w of adj[v]) {
        if (comp[w] === -1) { comp[w] = count; queue.push(w); }
      }
    }
    count++;
  }
  const faceComp = new Int32Array(mesh.faceCount);
  for (let f = 0; f < mesh.faceCount; f++) faceComp[f] = comp[idx[f * 3]];
  return { vertexComponents: comp, faceComponents: faceComp, count, isolated };
}

/** 重复顶点检测：按容差量化坐标分组（不修改网格）。 */
export function findDuplicateVertices(mesh, tolerance = 1e-6) {
  const groups = new Map();
  const p = mesh.positions;
  const inv = tolerance > 0 ? 1 / tolerance : 1e12;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const key = `${Math.round(p[v * 3] * inv)}|${Math.round(p[v * 3 + 1] * inv)}|${Math.round(p[v * 3 + 2] * inv)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const duplicateGroups = [];
  for (const list of groups.values()) {
    if (list.length > 1) duplicateGroups.push({ vertices: list, representative: list[0] });
  }
  const duplicateVertexCount = duplicateGroups.reduce((s, g) => s + g.vertices.length - 1, 0);
  return { duplicateGroups, duplicateVertexCount };
}

/** 退化面检测：重复索引或零面积。返回面序号数组。 */
export function findDegenerateFaces(mesh, eps = 1e-12) {
  const { diagonal } = boundingBox(mesh);
  const areaEps = eps * diagonal * diagonal;
  const idx = mesh.indices, p = mesh.positions;
  const degenerate = [];
  for (let f = 0; f < mesh.faceCount; f++) {
    const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
    if (a === b || b === c || a === c) { degenerate.push(f); continue; }
    const pa = a * 3, pb = b * 3, pc = c * 3;
    const ux = p[pb] - p[pa], uy = p[pb + 1] - p[pa + 1], uz = p[pb + 2] - p[pa + 2];
    const vx = p[pc] - p[pa], vy = p[pc + 1] - p[pa + 1], vz = p[pc + 2] - p[pa + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz <= areaEps * areaEps) degenerate.push(f);
  }
  return degenerate;
}

/** 孤立点：未被任何面引用的顶点。 */
export function findIsolatedVertices(mesh) {
  const used = new Uint8Array(mesh.vertexCount);
  for (const i of mesh.indices) used[i] = 1;
  const isolated = [];
  for (let v = 0; v < mesh.vertexCount; v++) if (!used[v]) isolated.push(v);
  return isolated;
}

/**
 * 完整体检报告（只读，不修改网格）。
 */
export function inspectMesh(mesh, tolerance = 1e-6) {
  const { count, isolated } = connectedComponents(mesh);
  const dup = findDuplicateVertices(mesh, tolerance);
  const degenerateFaces = findDegenerateFaces(mesh);
  return {
    componentCount: count,
    isolated,
    isolatedVertexCount: isolated.length,
    duplicateGroups: dup.duplicateGroups,
    duplicateVertexCount: dup.duplicateVertexCount,
    degenerateFaces,
    degenerateFaceCount: degenerateFaces.length,
    before: { vertexCount: mesh.vertexCount, faceCount: mesh.faceCount },
  };
}

/**
 * 按坐标焊接重复顶点。
 * 安全边界：只有坐标在容差内重合的顶点才会合并；互不接触的对象
 * （坐标不重合）保持独立，绝不会被焊到一起。若两个对象本来就有
 * 重合坐标点，焊接后会连通——这是几何事实而非误焊。
 * 焊接后变为退化的面会被剔除；孤立点默认保留（由 removeIsolatedVertices 单独处理）。
 */
export function weldVertices(mesh, tolerance = 1e-6) {
  const n = mesh.vertexCount;
  const inv = tolerance > 0 ? 1 / tolerance : 1e12;
  const p = mesh.positions;
  const repByKey = new Map();
  const remap = new Int32Array(n);
  const keptOld = [];
  for (let v = 0; v < n; v++) {
    const key = `${Math.round(p[v * 3] * inv)}|${Math.round(p[v * 3 + 1] * inv)}|${Math.round(p[v * 3 + 2] * inv)}`;
    if (repByKey.has(key)) {
      remap[v] = repByKey.get(key);
    } else {
      remap[v] = keptOld.length;
      repByKey.set(key, remap[v]);
      keptOld.push(v);
    }
  }
  const positions = new Float32Array(keptOld.length * 3);
  const oldToNewNormals = mesh.normals ? new Float32Array(keptOld.length * 3) : null;
  keptOld.forEach((oldV, newV) => {
    positions.set(p.subarray(oldV * 3, oldV * 3 + 3), newV * 3);
    if (oldToNewNormals) oldToNewNormals.set(mesh.normals.subarray(oldV * 3, oldV * 3 + 3), newV * 3);
  });
  const indices = [];
  let collapsedFaces = 0;
  for (let f = 0; f < mesh.faceCount; f++) {
    const a = remap[mesh.indices[f * 3]];
    const b = remap[mesh.indices[f * 3 + 1]];
    const c = remap[mesh.indices[f * 3 + 2]];
    if (a === b || b === c || a === c) { collapsedFaces++; continue; }
    indices.push(a, b, c);
  }
  const result = new Mesh({
    positions,
    indices: Uint32Array.from(indices),
    normals: oldToNewNormals,
    name: mesh.name,
  });
  return {
    mesh: result,
    removedVertices: n - result.vertexCount,
    collapsedFaces,
    remap, // 旧顶点 -> 新顶点
  };
}

/** 删除退化面，返回新网格。 */
export function removeDegenerateFaces(mesh) {
  const deg = new Set(findDegenerateFaces(mesh));
  if (deg.size === 0) return { mesh: mesh.clone(), removedFaces: 0 };
  const indices = [];
  for (let f = 0; f < mesh.faceCount; f++) {
    if (deg.has(f)) continue;
    indices.push(mesh.indices[f * 3], mesh.indices[f * 3 + 1], mesh.indices[f * 3 + 2]);
  }
  return {
    mesh: new Mesh({ positions: mesh.positions, indices: Uint32Array.from(indices), normals: mesh.normals, name: mesh.name }),
    removedFaces: deg.size,
  };
}

/** 删除孤立点，返回紧凑化后的新网格与旧->新映射。 */
export function removeIsolatedVertices(mesh) {
  const isolated = new Set(findIsolatedVertices(mesh));
  if (isolated.size === 0) return { mesh: mesh.clone(), removedVertices: 0, remap: null };
  const remap = new Int32Array(mesh.vertexCount).fill(-1);
  const kept = [];
  for (let v = 0; v < mesh.vertexCount; v++) {
    if (!isolated.has(v)) { remap[v] = kept.length; kept.push(v); }
  }
  const positions = new Float32Array(kept.length * 3);
  const normals = mesh.normals ? new Float32Array(kept.length * 3) : null;
  kept.forEach((oldV, newV) => {
    positions.set(mesh.positions.subarray(oldV * 3, oldV * 3 + 3), newV * 3);
    if (normals) normals.set(mesh.normals.subarray(oldV * 3, oldV * 3 + 3), newV * 3);
  });
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = remap[mesh.indices[i]];
  return {
    mesh: new Mesh({ positions, indices, normals, name: mesh.name }),
    removedVertices: isolated.size,
    remap,
  };
}

/**
 * 执行清理，每一步都可独立开关；原始网格由调用方保留，本函数只返回新版本。
 */
export function cleanMesh(mesh, { weld = true, removeDegenerate = true, removeIsolated = true, tolerance = 1e-6 } = {}) {
  const report = inspectMesh(mesh, tolerance);
  let current = mesh.clone();
  const steps = [];
  if (weld && report.duplicateVertexCount > 0) {
    const r = weldVertices(current, tolerance);
    steps.push({ action: 'weld', removedVertices: r.removedVertices, collapsedFaces: r.collapsedFaces });
    current = r.mesh;
  }
  if (removeDegenerate) {
    const r = removeDegenerateFaces(current);
    if (r.removedFaces > 0) steps.push({ action: 'removeDegenerate', removedFaces: r.removedFaces });
    current = r.mesh;
  }
  if (removeIsolated) {
    const r = removeIsolatedVertices(current);
    if (r.removedVertices > 0) steps.push({ action: 'removeIsolated', removedVertices: r.removedVertices });
    current = r.mesh;
  }
  computeVertexNormals(current);
  report.after = { vertexCount: current.vertexCount, faceCount: current.faceCount };
  report.steps = steps;
  return { mesh: current, report };
}
