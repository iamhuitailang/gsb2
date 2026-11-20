// UV 岛变换与自动排布（packing）。
// 岛是面的集合；变换直接改 uvSets 中这些面 corner 的坐标。

import { findIslands } from './topology.js';

/** 岛的 2D 包围盒与面积（由 corner UV 三角面积求和）。 */
export function islandBounds(mesh, islandFaces, setIndex = 0) {
  const uvs = mesh.uvSets[setIndex];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let area = 0;
  for (const f of islandFaces) {
    const tri = uvs[f];
    for (const [u, v] of tri) {
      minX = Math.min(minX, u); minY = Math.min(minY, v);
      maxX = Math.max(maxX, u); maxY = Math.max(maxY, v);
    }
    area += triangleArea(tri);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, area };
}

export function triangleArea(tri) {
  const [[x0, y0], [x1, y1], [x2, y2]] = tri;
  return Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2;
}

/** 平移整个岛。 */
export function translateIsland(mesh, islandId, dx, dy, setIndex = 0) {
  const { islands } = findIslands(mesh, setIndex);
  const faces = islands[islandId];
  if (!faces) return;
  const uvs = mesh.uvSets[setIndex];
  // 同一切缝顶点可能出现在多个面且坐标不同，逐 corner 平移即可
  for (const f of faces) {
    for (const uv of uvs[f]) {
      uv[0] += dx;
      uv[1] += dy;
    }
  }
}

/** 以岛中心为锚点缩放；sx/sy 为比例，可负值翻转。 */
export function scaleIsland(mesh, islandId, sx, sy, setIndex = 0) {
  const { islands } = findIslands(mesh, setIndex);
  const faces = islands[islandId];
  if (!faces) return;
  const b = islandBounds(mesh, faces, setIndex);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const uvs = mesh.uvSets[setIndex];
  for (const f of faces) {
    for (const uv of uvs[f]) {
      uv[0] = cx + (uv[0] - cx) * sx;
      uv[1] = cy + (uv[1] - cy) * sy;
    }
  }
}

/** 绕岛中心旋转 angle 弧度。 */
export function rotateIsland(mesh, islandId, angle, setIndex = 0) {
  const { islands } = findIslands(mesh, setIndex);
  const faces = islands[islandId];
  if (!faces) return;
  const b = islandBounds(mesh, faces, setIndex);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const uvs = mesh.uvSets[setIndex];
  for (const f of faces) {
    for (const uv of uvs[f]) {
      const x = uv[0] - cx, y = uv[1] - cy;
      uv[0] = cx + x * cos - y * sin;
      uv[1] = cy + x * sin + y * cos;
    }
  }
}

/**
 * 自动排布所有 UV 岛：带 90° 旋转的货架（shelf）装箱，
 * 支持留白间距，结果整体缩放并居中到 [0,1] 纹理方框内。
 * 输入坐标保留真实尺寸比例（由 unwrapFaces 整体展开产生），
 * 装箱只负责平移/旋转与最终统一缩放。
 *
 * @param {object} mesh
 * @param {number} setIndex
 * @param {number} margin 留白，纹理空间比例，如 0.02 表示 2%（岛间+边缘）
 * @returns {{islandCount:number, coverage:number}}
 */
export function packIslands(mesh, setIndex, margin = 0.02) {
  const { islands } = findIslands(mesh, setIndex);
  if (!islands.length) return { islandCount: 0, coverage: 0 };

  const boxes = islands.map((faces, id) => ({ id, faces, b: islandBounds(mesh, faces, setIndex) }));
  // 先把每个岛平移到以 (0,0) 为左下的临时坐标
  for (const item of boxes) {
    translateIsland(mesh, item.id, -item.b.minX, -item.b.minY, setIndex);
  }
  for (const item of boxes) item.b = islandBounds(mesh, item.faces, setIndex);

  const gap = margin;
  // 大岛优先：按高度（取旋转后较短边）排序
  const rects = boxes.map((item) => ({
    id: item.id,
    w: item.b.width,
    h: item.b.height,
  }));
  rects.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h));

  // 货架装箱：每个货架固定高度，岛优先放入现有货架，放不下再开新货架；
  // 放置时选择“不旋转/旋转 90°”中占用货架高度更小的方向
  const shelves = []; // {y, height, width}
  const placement = new Map(); // id -> {x,y,rotated}

  for (const r of rects) {
    const options = [
      { w: r.w + gap, h: r.h + gap, rotated: false },
      { w: r.h + gap, h: r.w + gap, rotated: true },
    ];
    let placed = null;
    // 优先尝试塞进现有货架（选剩余宽度够、且方向最贴合货架高度的）
    for (const shelf of shelves) {
      for (const opt of options) {
        if (opt.h <= shelf.height + 1e-9 && shelf.width + opt.w <= shelf.capacity) {
          const candidate = { shelf, opt, waste: shelf.height - opt.h };
          if (!placed || candidate.waste < placed.waste) placed = candidate;
        }
      }
    }
    if (!placed) {
      // 新开货架：取两个方向中较矮的一个，控制货架高度
      const opt = options[0].h <= options[1].h ? options[0] : options[1];
      const y = shelves.reduce((sum, s) => sum + s.height, 0);
      const shelf = { y, height: opt.h, width: 0, capacity: Infinity };
      shelves.push(shelf);
      placed = { shelf, opt, waste: 0 };
    }
    const { shelf, opt } = placed;
    placement.set(r.id, {
      x: shelf.width + gap / 2,
      y: shelf.y + gap / 2,
      rotated: opt.rotated,
    });
    shelf.width += opt.w;
    shelf.height = Math.max(shelf.height, opt.h);
  }

  const usedMaxX = Math.max(...shelves.map((s) => s.width));
  const usedMaxY = shelves.reduce((sum, s) => sum + s.height, 0);
  const scale = Math.min((1 - margin * 2) / (usedMaxX || 1), (1 - margin * 2) / (usedMaxY || 1));
  const offsetX = (1 - usedMaxX * scale) / 2;
  const offsetY = (1 - usedMaxY * scale) / 2;

  // 应用变换：先按需旋转 90°（绕岛中心），再平移到装箱位，最后整体缩放居中
  const uvs = mesh.uvSets[setIndex];
  for (const r of rects) {
    if (placement.get(r.id).rotated) rotateIsland(mesh, r.id, Math.PI / 2, setIndex);
  }
  for (const item of boxes) {
    const b = islandBounds(mesh, item.faces, setIndex);
    const p = placement.get(item.id);
    translateIsland(mesh, item.id, p.x - b.minX, p.y - b.minY, setIndex);
  }
  for (const tri of uvs) {
    for (const uv of tri) {
      uv[0] = offsetX + uv[0] * scale;
      uv[1] = offsetY + uv[1] * scale;
    }
  }

  let areaSum = 0;
  for (const item of boxes) areaSum += islandBounds(mesh, item.faces, setIndex).area;

  return {
    islandCount: islands.length,
    coverage: Math.min(1, areaSum),
  };
}
