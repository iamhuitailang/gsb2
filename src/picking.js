// Amanatides & Woo 体素 DDA: 沿射线逐格穿越, 第一个命中的实心格就是最前面的。
// 不依赖面数, 镜头任意角度都稳定; 同时返回命中面法线, 用于在相邻空格放置方块。

const MAX_DISTANCE = 256;

/**
 * @param {{x,y,z}} origin 射线起点(世界坐标, 允许小数)
 * @param {{x,y,z}} dir 归一化方向
 * @param {World} world
 * @returns {{voxel:[x,y,z], normal:[nx,ny,nz], distance:number} | null}
 */
export function raycastVoxel(origin, dir, world) {
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  const stepX = dir.x > 0 ? 1 : -1;
  const stepY = dir.y > 0 ? 1 : -1;
  const stepZ = dir.z > 0 ? 1 : -1;

  // 到最近一条体素边界的距离
  const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;

  // 起点所在格 -> 下一条边界的参数距离
  let tMaxX =
    dir.x !== 0
      ? (dir.x > 0 ? x + 1 - origin.x : origin.x - x) * tDeltaX
      : Infinity;
  let tMaxY =
    dir.y !== 0
      ? (dir.y > 0 ? y + 1 - origin.y : origin.y - y) * tDeltaY
      : Infinity;
  let tMaxZ =
    dir.z !== 0
      ? (dir.z > 0 ? z + 1 - origin.z : origin.z - z) * tDeltaZ
      : Infinity;

  let normal = [0, 0, 0];
  let t = 0;

  // 起点本身落在实心格里(例如相机穿模)也算命中, 法线为 0
  if (world.getVoxel(x, y, z) !== 0) {
    return { voxel: [x, y, z], normal, distance: 0 };
  }

  while (t <= MAX_DISTANCE) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      normal = [-stepX, 0, 0];
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      normal = [0, -stepY, 0];
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      normal = [0, 0, -stepZ];
    }
    if (t > MAX_DISTANCE) break;
    if (world.getVoxel(x, y, z) !== 0) {
      return { voxel: [x, y, z], normal, distance: t };
    }
  }
  return null;
}
