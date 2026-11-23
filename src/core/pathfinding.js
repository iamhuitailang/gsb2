// A* 寻路（8 方向，禁止对角穿墙角），代价由三段组成：
//   距离段  = len * w.distance
//   地形段  = len * w.terrain * 地形乘数(road 0.6 / walk 1 / mud 2.5)
//   贴墙段  = len * w.wall    * 1 / clearance^2（离障碍/边界越近压力越大）
// 三段始终非负，便于在 UI 中解释「为什么走这条路线」。

import { CELL, TERRAIN_MULT, inBounds } from './geometry.js';

const INF = 1e18;
const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export const WEIGHT_PRESETS = {
  shortest: { label: '最短距离', weights: { distance: 1, terrain: 0, wall: 0 } },
  terrain: { label: '地形优先', weights: { distance: 1, terrain: 1, wall: 0 } },
  safe: { label: '贴墙规避', weights: { distance: 1, terrain: 0.5, wall: 2 } },
};

class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, val) {
    const { keys, vals } = this;
    keys.push(key);
    vals.push(val);
    let i = keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (vals[p] <= vals[i]) break;
      [vals[p], vals[i]] = [vals[i], vals[p]];
      [keys[p], keys[i]] = [keys[i], keys[p]];
      i = p;
    }
  }

  pop() {
    const { keys, vals } = this;
    const topKey = keys[0];
    const topVal = vals[0];
    const lastKey = keys.pop();
    const lastVal = vals.pop();
    if (keys.length) {
      keys[0] = lastKey;
      vals[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < keys.length && vals[l] < vals[smallest]) smallest = l;
        if (r < keys.length && vals[r] < vals[smallest]) smallest = r;
        if (smallest === i) break;
        [vals[smallest], vals[i]] = [vals[i], vals[smallest]];
        [keys[smallest], keys[i]] = [keys[i], keys[smallest]];
        i = smallest;
      }
    }
    return [topKey, topVal];
  }
}

function edgeFactor(cells, clearance, ni, w) {
  const terrainFactor = TERRAIN_MULT[cells[ni]] ?? 1;
  const c = Math.max(clearance[ni], 0.25);
  const wallPressure = 1 / (c * c);
  return { terrainFactor, wallPressure };
}

/**
 * @returns {{found:boolean, path:number[], edges:Array, cost:number,
 *   breakdown:{distance:number,terrain:number,wall:number},
 *   gScore:Float64Array, closed:Uint8Array, explored:number}}
 */
export function findPath(grid, start, goal, weights) {
  const { cells, passable, clearance, w, h } = grid;
  const n = w * h;
  const gScore = new Float64Array(n).fill(INF);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const result = {
    found: false, path: [], edges: [], cost: 0,
    breakdown: { distance: 0, terrain: 0, wall: 0 },
    gScore, closed, explored: 0,
  };

  if (!passable[start] || !passable[goal]) return result;
  // 启发式取每单位长度的最小可能代价因子，保证 h 可纳（不高估）
  const hFactor = Math.max(weights.distance + weights.terrain * TERRAIN_MULT[CELL.ROAD], 1e-6);
  const hx = goal % w;
  const hy = (goal / w) | 0;
  const heuristic = (i) => {
    const dx = (i % w) - hx;
    const dy = ((i / w) | 0) - hy;
    return hFactor * Math.hypot(dx, dy);
  };

  gScore[start] = 0;
  const heap = new MinHeap();
  heap.push(start, heuristic(start));

  while (heap.size) {
    const [cur] = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    result.explored++;
    if (cur === goal) {
      result.found = true;
      break;
    }
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (const [dx, dy, len] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(w, h, nx, ny)) continue;
      const ni = ny * w + nx;
      if (!passable[ni] || closed[ni]) continue;
      // 对角移动要求两个正交邻居都可通行，防止从墙角斜穿
      if (dx !== 0 && dy !== 0) {
        const orthoX = cur + dx; // (nx, cy)
        const orthoY = cur + dy * w; // (cx, ny)
        if (!inBounds(w, h, nx, cy) || !inBounds(w, h, cx, ny)
          || !passable[orthoX] || !passable[orthoY]) continue;
      }
      const { terrainFactor, wallPressure } = edgeFactor(cells, clearance, ni, w);
      const factor = weights.distance
        + weights.terrain * terrainFactor
        + weights.wall * wallPressure;
      const tentative = gScore[cur] + len * factor;
      if (tentative < gScore[ni]) {
        gScore[ni] = tentative;
        came[ni] = cur;
        heap.push(ni, tentative + heuristic(ni));
      }
    }
  }

  if (!result.found) return result;

  // 回溯路径并重建逐边代价分解
  const path = [goal];
  let cur = goal;
  while (cur !== start) {
    cur = came[cur];
    path.push(cur);
  }
  path.reverse();

  const edges = [];
  const breakdown = { distance: 0, terrain: 0, wall: 0 };
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    const diag = Math.abs(a % w - b % w) + Math.abs(((a / w) | 0) - ((b / w) | 0)) === 2;
    const len = diag ? Math.SQRT2 : 1;
    const { terrainFactor, wallPressure } = edgeFactor(cells, clearance, b, w);
    const cDist = len * weights.distance;
    const cTerrain = len * weights.terrain * terrainFactor;
    const cWall = len * weights.wall * wallPressure;
    breakdown.distance += cDist;
    breakdown.terrain += cTerrain;
    breakdown.wall += cWall;
    edges.push({
      from: a, to: b, len, terrainFactor, wallPressure,
      cost: cDist + cTerrain + cWall,
      parts: { distance: cDist, terrain: cTerrain, wall: cWall },
    });
  }
  result.path = path;
  result.edges = edges;
  result.breakdown = breakdown;
  result.cost = breakdown.distance + breakdown.terrain + breakdown.wall;
  return result;
}
