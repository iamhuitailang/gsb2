// 网格基础定义 + 距离场/侵蚀/连通分量
// 全部为纯函数，浏览器与 Node 测试共用。

export const CELL = {
  WALK: 0, // 普通可行走
  BLOCK: 1, // 障碍
  ROAD: 2, // 路面（地形代价低）
  MUD: 3, // 泥泞（地形代价高）
};

// 各地形的通行代价乘数；BLOCK 不可通行
export const TERRAIN_MULT = {
  [CELL.WALK]: 1,
  [CELL.ROAD]: 0.6,
  [CELL.MUD]: 2.5,
};

export function idx(w, x, y) {
  return y * w + x;
}

export function inBounds(w, h, x, y) {
  return x >= 0 && y >= 0 && x < w && y < h;
}

/**
 * 精确欧氏距离变换（Felzenszwalb–Huttenlocher 两遍 1D 抛物线算法）：
 * 每个格子到最近障碍格中心的距离（格距单位）。
 * 地图边界外视为虚拟障碍，因此返回值同时包含到地图边缘的距离。
 * 内部以平方距离运算，最后开平方；侵蚀判断时可直接比较平方值。
 */
export function clearanceField(cells, w, h) {
  const n = w * h;
  const BIG = 1e18;
  // seed 始终以「真实障碍格」为唯一源；两遍变换都基于同一份初始副本，
  // 避免第一遍的中间结果在第二遍中覆盖障碍源（否则障碍格会被算成有距离）。
  const seed = new Float64Array(n);
  for (let i = 0; i < n; i++) seed[i] = cells[i] === CELL.BLOCK ? 0 : BIG;

  // 第一遍：沿列（y 方向）
  const f = new Float64Array(h);
  const v = new Int32Array(h);
  const z = new Float64Array(h + 1);
  const col = new Float64Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = seed[y * w + x];
    edt1d(f, h, v, z);
    for (let y = 0; y < h; y++) col[y * w + x] = f[y];
  }
  // 第二遍：沿行（x 方向），输入取第一遍结果与初始源的逐点最小值
  const fw = new Float64Array(w);
  const vw = new Int32Array(w);
  const zw = new Float64Array(w + 1);
  const d2 = new Float64Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) fw[x] = Math.min(col[row + x], seed[row + x]);
    edt1d(fw, w, vw, zw);
    for (let x = 0; x < w; x++) d2[row + x] = fw[x];
  }

  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % w;
    const y = (i / w) | 0;
    // 地图边界外视为虚拟障碍，与边界格中心相距 1
    const edge = Math.min(x + 1, y + 1, w - x, h - y);
    d[i] = Math.sqrt(Math.min(d2[i], edge * edge));
  }
  return d;
}

// 1D 平方距离变换（Felzenszwalb–Huttenlocher）：
// 输入 f（点上的初始平方距离，障碍为 0，其余为 INF），
// 输出 f[i] = min_q (f[q] + (i-q)^2)。v 为信封下标栈，z 为交点位置。
function edt1d(f, len, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < len; q++) {
    let s;
    // 与当前信封最后一个站点 v[k] 求交点
    s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      // 站点 v[k] 被完全盖住，弹出后重新求交
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let i = 0; i < len; i++) {
    while (z[k + 1] < i) k++;
    const q = v[k];
    f[i] = f[q] + (i - q) * (i - q);
  }
}

/**
 * 按角色半径（格距单位）侵蚀可行走区域。
 * passable[i] = 1 表示角色中心可以停在该格（四周 clearance >= radius）。
 */
export function erode(cells, clearance, radius, w, h) {
  const passable = new Uint8Array(w * h);
  const r2 = radius * radius;
  for (let i = 0; i < w * h; i++) {
    if (cells[i] === CELL.BLOCK) continue; // 障碍格永远不可通行
    if (clearance[i] * clearance[i] >= r2 - 1e-9) passable[i] = 1;
  }
  return passable;
}

/**
 * 8 连通 flood fill 标注连通分量（与 A* 的移动规则一致）。
 * 对角移动同样要求两个正交邻居可通行，避免从单格厚墙的墙角斜穿。
 */
export function labelComponents(passable, w, h) {
  const labels = new Int32Array(w * h);
  const sizes = [0];
  let count = 0;
  const stack = [];
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  for (let i = 0; i < w * h; i++) {
    if (!passable[i] || labels[i] !== 0) continue;
    const label = ++count;
    let size = 0;
    labels[i] = label;
    stack.push(i);
    while (stack.length) {
      const cur = stack.pop();
      size++;
      const cx = cur % w;
      const cy = (cur / w) | 0;
      for (const [dx, dy] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inBounds(w, h, nx, ny)) continue;
        if (dx !== 0 && dy !== 0) {
          // 正交邻居索引：(nx,cy)=cur+dx，(cx,ny)=cur+dy*w
          if (!inBounds(w, h, nx, cy) || !inBounds(w, h, cx, ny)
            || !passable[cur + dx] || !passable[cur + dy * w]) {
            continue;
          }
        }
        const ni = ny * w + nx;
        if (passable[ni] && labels[ni] === 0) {
          labels[ni] = label;
          stack.push(ni);
        }
      }
    }
    sizes[label] = size;
  }
  return { labels, count, sizes };
}

/** 简单 RLE：[value, count, value, count, ...]，用于序列化数组 */
export function rleEncode(arr) {
  const out = [];
  let prev = arr[0];
  let run = 1;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === prev && run < 65535) {
      run++;
    } else {
      out.push(prev, run);
      prev = arr[i];
      run = 1;
    }
  }
  out.push(prev, run);
  return out;
}

export function rleDecode(pairs, Total, TypedArray) {
  const out = new TypedArray(Total);
  let pos = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const value = pairs[i];
    const count = pairs[i + 1];
    out.fill(value, pos, pos + count);
    pos += count;
  }
  return out;
}
