// 内置样例与调色板。
// 墙刻意跨在区块边界(x=7/8)上, 挖空后能看到边界两侧区块各自刷新出内表面。

import { World, CHUNK } from './world.js';

export const PALETTE = [
  { id: 'red', name: '红', color: '#e2543e' },
  { id: 'orange', name: '橙', color: '#f0932b' },
  { id: 'yellow', name: '黄', color: '#f4d03f' },
  { id: 'green', name: '绿', color: '#4caf6d' },
  { id: 'cyan', name: '青', color: '#35b6c9' },
  { id: 'blue', name: '蓝', color: '#3d7ee2' },
  { id: 'purple', name: '紫', color: '#8e5bd6' },
  { id: 'white', name: '白', color: '#e8eaed' },
];

/** 实心 8^3 立方体, 正好填满一个区块: 外表面应只剩 6 个大四边形。 */
export function buildSolidCube() {
  const world = new World(PALETTE.map((p) => ({ ...p })));
  const id = world.materialId(0);
  for (let x = 0; x < CHUNK; x++) {
    for (let y = 0; y < CHUNK; y++) {
      for (let z = 0; z < CHUNK; z++) {
        world.setVoxel(x, y, z, id);
      }
    }
  }
  return world;
}

/**
 * 跨区块彩色墙: 沿 x=4..11 排列(跨过 x=7/8 的区块边界),
 * 每个 x 列一种颜色, 中段挖空。挖空位置同样跨过边界,
 * 暴露出的内表面分属两个区块, 边缘修改时两侧一起刷新。
 */
export function buildColorWall() {
  const world = new World(PALETTE.map((p) => ({ ...p })));
  const x0 = 4;
  const x1 = 11;
  const y0 = 0;
  const y1 = 7;
  const z = 0;

  // 挖空区域(跨边界的门洞 + 一个侧窗)
  const hollow = (x, y) => {
    const door = x >= 7 && x <= 8 && y >= 0 && y <= 3;
    const window = x >= 5 && x <= 6 && y >= 5 && y <= 6;
    return door || window;
  };

  for (let x = x0; x <= x1; x++) {
    const matIndex = (x - x0) % PALETTE.length;
    const id = world.materialId(matIndex);
    for (let y = y0; y <= y1; y++) {
      if (hollow(x, y)) continue;
      world.setVoxel(x, y, z, id);
    }
  }
  return world;
}

/** 演示用: 对当前墙在边界处再挖掉一格, 返回受影响区块 key 列表。 */
export function hollowOneMore(world) {
  const affected = new Set();
  // 门洞上方再掏空边界两侧各一格, 制造新的内表面。
  // 逐格累积受影响集合: 每格都可能带出不同方向的邻居区块, 不能互相覆盖。
  for (const x of [7, 8]) {
    const one = world.setVoxel(x, 4, 0, 0);
    for (const key of one) affected.add(key);
  }
  return [...affected];
}
