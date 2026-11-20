// 半边风格的拓扑结构：以“角点(corner)”为基本单位。
// 每个三角形面有 3 个 corner，corner c 对应 face = floor(c/3)，
// 在面内的序号 = c%3，顶点 = faces[face][c%3]。

const edgeKey = (a, b) => `${a}_${b}`;

/**
 * 构建拓扑查询表。
 * @param {number[][]} faces 三角形索引数组
 * @returns {{cornerFace:number[], cornerVertex:number[], opposite:Int32Array,
 *            halfedges:Map<string,number>, boundaryEdges:[number,number][]}}
 */
export function buildTopology(faces) {
  const cornerCount = faces.length * 3;
  const cornerFace = new Int32Array(cornerCount);
  const cornerVertex = new Int32Array(cornerCount);
  const opposite = new Int32Array(cornerCount).fill(-1);
  const halfedges = new Map(); // 有向边 a->b => 以该边为出边的 corner

  for (let f = 0; f < faces.length; f++) {
    for (let k = 0; k < 3; k++) {
      const c = f * 3 + k;
      cornerFace[c] = f;
      cornerVertex[c] = faces[f][k];
      halfedges.set(edgeKey(faces[f][k], faces[f][(k + 1) % 3]), c);
    }
  }

  const boundaryEdges = [];
  for (const [key, c] of halfedges) {
    const [a, b] = key.split('_').map(Number);
    const back = halfedges.get(edgeKey(b, a));
    if (back === undefined) {
      opposite[c] = -1;
      boundaryEdges.push([a, b]);
    } else {
      opposite[c] = back;
    }
  }

  return { cornerFace, cornerVertex, opposite, halfedges, boundaryEdges };
}

/** 找到以有向边 a->b 为出边的 corner，不存在返回 -1。 */
export function cornerOfEdge(topo, a, b) {
  return topo.halfedges.get(edgeKey(a, b)) ?? -1;
}

/**
 * 把一条边标记/取消切缝。边界边恒为切缝，无需标记。
 * 内部边同时对应两个 corner，切缝集合存“无向边 key（小顶点_大顶点）”。
 */
export function undirectedKey(a, b) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export function toggleSeam(seamSet, topo, a, b) {
  const c1 = cornerOfEdge(topo, a, b);
  const c2 = cornerOfEdge(topo, b, a);
  if (c1 < 0 || c2 < 0) return false; // 边界边不能取消切缝属性
  const key = undirectedKey(a, b);
  if (seamSet.has(key)) seamSet.delete(key);
  else seamSet.add(key);
  return true;
}

export function isSeam(seamSet, topo, a, b) {
  if (cornerOfEdge(topo, b, a) < 0) return true; // 边界
  return seamSet.has(undirectedKey(a, b));
}

/** corner c 所在面的相邻面（共享出边的另一个面），无则 -1。 */
export function adjacentFace(topo, c) {
  const o = topo.opposite[c];
  return o < 0 ? -1 : Math.floor(o / 3);
}

/**
 * 计算 UV 岛：在“非切缝且 UV 相连”的面上做 BFS。
 * 非切缝的共享边两端 UV 若不重合，也视为断开（UV 层的真实缝隙）。
 *
 * @returns {{islands:number[][], faceIsland:Int32Array}}
 *   islands 每个元素是面索引数组；faceIsland 面 -> 岛编号
 */
export function findIslands(mesh, uvSetIndex = 0) {
  const { faces, topology, seams } = mesh;
  const uvs = mesh.uvSets[uvSetIndex];
  const faceCount = faces.length;
  const faceIsland = new Int32Array(faceCount).fill(-1);
  const islands = [];

  const uvConnected = (c) => {
    const o = topology.opposite[c];
    if (o < 0) return false;
    const f1 = Math.floor(c / 3);
    const f2 = Math.floor(o / 3);
    const eps = 1e-7;
    // 共享边的两个端点按“顶点索引”配对，避免手算 corner 偏移；
    // 再额外检查第三个顶点，保证整个三角形 UV 一致
    const verts1 = faces[f1];
    const verts2 = faces[f2];
    for (let i = 0; i < 3; i++) {
      const v = verts1[i];
      const j = verts2.indexOf(v);
      if (j < 0) continue;
      const ua = uvs[f1][i];
      const ub = uvs[f2][j];
      if (Math.abs(ua[0] - ub[0]) > eps || Math.abs(ua[1] - ub[1]) > eps) return false;
    }
    return true;
  };

  for (let seed = 0; seed < faceCount; seed++) {
    if (faceIsland[seed] !== -1) continue;
    const id = islands.length;
    const stack = [seed];
    const members = [];
    faceIsland[seed] = id;
    while (stack.length) {
      const f = stack.pop();
      members.push(f);
      for (let k = 0; k < 3; k++) {
        const c = f * 3 + k;
        const a = faces[f][k];
        const b = faces[f][(k + 1) % 3];
        if (isSeam(seams, topology, a, b)) continue;
        if (!uvConnected(c)) continue;
        const nf = adjacentFace(topology, c);
        if (nf >= 0 && faceIsland[nf] === -1) {
          faceIsland[nf] = id;
          stack.push(nf);
        }
      }
    }
    islands.push(members);
  }
  return { islands, faceIsland };
}
