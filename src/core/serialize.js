// 关卡 / 导航参数的保存、载入与导航数据导出。
// 保存格式为带版本号的 JSON；cell 与标注坐标一一对应，局部编辑不会移除任何标注。

import { NavEngine } from './engine.js';
import { CELL, rleEncode, rleDecode } from './geometry.js';

export const PROJECT_VERSION = 1;

export function serializeProject(engine, meta = {}) {
  return {
    format: 'navmesh-inspector-project',
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    width: engine.w,
    height: engine.h,
    agentRadius: engine.agentRadius,
    start: engine.start,
    goal: engine.goal,
    cellsRle: rleEncode(engine.cells),
    annotations: engine.annotations.map((a) => ({ ...a })),
    meta,
  };
}

export function deserializeProject(data) {
  if (!data || data.format !== 'navmesh-inspector-project') {
    throw new Error('文件格式不识别：缺少 format = navmesh-inspector-project');
  }
  if (data.version !== PROJECT_VERSION) {
    throw new Error(`不支持的工程版本：${data.version}，当前支持 ${PROJECT_VERSION}`);
  }
  const cells = rleDecode(data.cellsRle, data.width * data.height, Uint8Array);
  const engine = new NavEngine({
    width: data.width,
    height: data.height,
    cells,
    agentRadius: data.agentRadius ?? 1,
    start: data.start,
    goal: data.goal,
    annotations: Array.isArray(data.annotations) ? data.annotations : [],
  });
  return { engine, savedAt: data.savedAt, meta: data.meta ?? {} };
}

/**
 * 导出导航数据（供游戏运行时或其他工具消费）。
 * mode = 'grid'：紧凑栅格（RLE）+ 角色尺寸下的可通行位图
 * mode = 'graph'：按连通分量导出邻接图，节点为可通行格，边带权重（距离/地形/贴墙）
 */
export function exportNavData(engine, weights, mode = 'grid') {
  const base = {
    format: `navmesh-inspector-nav-${mode}`,
    version: PROJECT_VERSION,
    width: engine.w,
    height: engine.h,
    agentRadius: engine.agentRadius,
    weights,
    terrainLegend: {
      [CELL.WALK]: 'walk',
      [CELL.BLOCK]: 'block',
      [CELL.ROAD]: 'road',
      [CELL.MUD]: 'mud',
    },
  };

  if (mode === 'grid') {
    return {
      ...base,
      cellsRle: rleEncode(engine.cells),
      passableRle: rleEncode(engine.passable),
      componentLabelsRle: rleEncode(engine.labels),
      components: { count: engine.componentCount, sizes: engine.componentSizes },
    };
  }

  // graph 模式
  const nodes = [];
  const indexToNode = new Map();
  for (let i = 0; i < engine.size; i++) {
    if (!engine.passable[i]) continue;
    indexToNode.set(i, nodes.length);
    nodes.push({
      id: nodes.length,
      x: i % engine.w,
      y: (i / engine.w) | 0,
      component: engine.labels[i],
      terrain: engine.cells[i],
    });
  }
  const edges = [];
  const dirs = [[1, 0, 1], [0, 1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2]];
  for (let i = 0; i < engine.size; i++) {
    if (!engine.passable[i]) continue;
    const cx = i % engine.w;
    const cy = (i / engine.w) | 0;
    for (const [dx, dy, len] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= engine.w || ny >= engine.h) continue;
      const ni = ny * engine.w + nx;
      if (!engine.passable[ni]) continue;
      if (dx !== 0 && dy !== 0 && (
        !engine.passable[cy * engine.w + nx] || !engine.passable[ny * engine.w + cx]
      )) {
        continue; // 与 A* 相同的防穿墙角规则
      }
      const c = Math.max(engine.clearance[ni], 0.25);
      edges.push({
        from: indexToNode.get(i),
        to: indexToNode.get(ni),
        length: len,
        weight: len * (weights.distance
          + weights.terrain * (engine.cells[ni] === CELL.ROAD ? 0.6 : engine.cells[ni] === CELL.MUD ? 2.5 : 1)
          + weights.wall / (c * c)),
      });
    }
  }
  return { ...base, nodes, edges };
}
