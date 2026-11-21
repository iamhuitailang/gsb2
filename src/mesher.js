// 区块网格生成: 隐藏面剔除 + 分材质贪婪合并(greedy meshing)
// 只输出暴露在空气/不同材质旁的面; 同材质共面的相邻面合并成大四边形,
// 不同材质交界处不合并, 因此颜色边界与原始方块轮廓都保持正确。

import { CHUNK } from './world.js';

// 6 个面: 法线方向 + 4 个角点相对方块原点的偏移。
// 角点顺序统一为「从面外侧看逆时针」(front-facing, CCW),
// 公式: 取面内两个基轴 s=(d+1)%3, t=(d+2)%3,
// 角点 = 法线偏移 + (0,0),(0,t),(s,t),(s,0)。
function makeFaces() {
  const dirs = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  return dirs.map((dir) => {
    const d = dir.findIndex((n) => n !== 0);
    const s = (d + 1) % 3;
    const t = (d + 2) % 3;
    const base = (su, tv) => {
      const c = [0, 0, 0];
      c[d] = dir[d] > 0 ? 1 : 0;
      c[s] = su;
      c[t] = tv;
      return c;
    };
    let corners = [base(0, 0), base(0, 1), base(1, 1), base(1, 0)];
    // 该顺序的叉积法线朝 -d; 法线在 +d 的面反转 winding
    if (dir[d] > 0) corners = corners.reverse();
    return {
      dir,
      corners,
    };
  });
}

export const FACES = makeFaces();

/**
 * 对单个区块做网格生成。
 * @param {object} chunk { cx, cy, cz, data }
 * @param {World} world 用来查询跨区块邻居(区块边缘的面要看到隔壁区块)
 * @returns {{positions, normals, colors, indices, gridPositions, rawFaceCount, quadCount}}
 *   rawFaceCount: 合并前的可见小面数; 每个四边形 2 个三角形
 */
export function buildChunkMesh(chunk, world) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const edgeSet = new Set();
  let rawFaceCount = 0;
  let quadCount = 0;

  const baseX = chunk.cx * CHUNK;
  const baseY = chunk.cy * CHUNK;
  const baseZ = chunk.cz * CHUNK;

  const getVoxel = (x, y, z) => world.getVoxel(x, y, z);

  for (let faceIdx = 0; faceIdx < FACES.length; faceIdx++) {
    const face = FACES[faceIdx];
    const [dx, dy, dz] = face.dir;

    // 面所在层的轴向 d, 另外两个扫描轴 u/v
    const d = face.dir.findIndex((n) => n !== 0);
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const delta = face.dir[d]; // +1 / -1

    // mask[dLayer][v][u] = 该位置暴露面的材质 id, 0 表示没有面
    const mask = new Array(CHUNK);
    for (let i = 0; i < CHUNK; i++) mask[i] = new Int16Array(CHUNK * CHUNK);

    for (let layer = 0; layer < CHUNK; layer++) {
      for (let j = 0; j < CHUNK; j++) {
        for (let i = 0; i < CHUNK; i++) {
          const local = [0, 0, 0];
          local[d] = layer;
          local[u] = i;
          local[v] = j;
          const id = chunk.data[local[0] + CHUNK * (local[1] + CHUNK * local[2])];
          if (id === 0) continue;

          // 注意要用世界坐标查邻居, 区块边缘的面才能看到隔壁区块
          const wx = baseX + local[0] + dx;
          const wy = baseY + local[1] + dy;
          const wz = baseZ + local[2] + dz;
          const neighbor = getVoxel(wx, wy, wz);
          // 邻居是空气 -> 暴露; 不同材质之间也各自保留表面(颜色交界正确)
          if (neighbor !== id) {
            mask[layer][j * CHUNK + i] = id;
            rawFaceCount++;
          }
        }
      }
    }
    // 贪婪合并: 在每一层的 2D mask 上, 按相同材质 id 合并矩形
    for (let layer = 0; layer < CHUNK; layer++) {
      const m = mask[layer];
      let j = 0;
      while (j < CHUNK) {
        let i = 0;
        while (i < CHUNK) {
          const id = m[j * CHUNK + i];
          if (id === 0) {
            i++;
            continue;
          }

          // 沿 u 方向扩展宽度
          let w = 1;
          while (i + w < CHUNK && m[j * CHUNK + i + w] === id) w++;

          // 沿 v 方向扩展高度: 接下来 h 行的同样区间材质必须一致
          let h = 1;
          outer: while (j + h < CHUNK) {
            for (let k = 0; k < w; k++) {
              if (m[(j + h) * CHUNK + i + k] !== id) break outer;
            }
            h++;
          }

          // 清掉被合并的区域
          for (let lj = 0; lj < h; lj++) {
            for (let li = 0; li < w; li++) m[(j + lj) * CHUNK + i + li] = 0;
          }

          emitQuad(face, d, u, v, layer, i, j, w, h, delta, id);
          i += w;
        }
        j++;
      }
    }
  }

  function emitQuad(face, d, u, v, layer, u0, v0, w, h, delta, id) {
    // 四边形在 d 轴上的世界坐标层
    const dCoord = delta > 0 ? layer + 1 : layer;

    // 直接复用 face.corners 的朝外逆时针顺序:
    // 角点在 u/v 轴上的偏移是 0/1, 乘上合并后的宽高即得到大四边形角点
    const start = positions.length / 3;
    const verts = face.corners.map((c) => {
      const local = [0, 0, 0];
      local[d] = dCoord;
      local[u] = u0 + c[u] * w;
      local[v] = v0 + c[v] * h;
      const p = [baseX + local[0], baseY + local[1], baseZ + local[2]];
      positions.push(p[0], p[1], p[2]);
      normals.push(face.dir[0], face.dir[1], face.dir[2]);
      const color = world.palette[world.paletteIndex(id)]?.color || '#ff00ff';
      const rgb = hexToRgb(color);
      colors.push(rgb.r / 255, rgb.g / 255, rgb.b / 255);
      return p;
    });
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    quadCount++;

    // 合并后大四边形的 4 条边作为网格线(Set 去重, 相邻四边形共用边只画一次)
    const edgeKeys = [
      [verts[0], verts[1]],
      [verts[1], verts[2]],
      [verts[2], verts[3]],
      [verts[3], verts[0]],
    ];
    for (const [a, b] of edgeKeys) {
      edgeSet.add(edgeKey(a, b));
    }
  }

  const gridPositions = [];
  for (const key of edgeSet) {
    const [a, b] = key.split('|');
    const pa = a.split(',').map(Number);
    const pb = b.split(',').map(Number);
    gridPositions.push(...pa, ...pb);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: indices.length ? new Uint32Array(indices) : new Uint32Array(0),
    gridPositions: new Float32Array(gridPositions),
    rawFaceCount,
    quadCount,
  };
}

function edgeKey(a, b) {
  const ka = `${a[0]},${a[1]},${a[2]}`;
  const kb = `${b[0]},${b[1]},${b[2]}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
