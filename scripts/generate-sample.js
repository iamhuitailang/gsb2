#!/usr/bin/env node
// 生成一个开箱即用的示例项目文件：程序地形 + 默认规则 + 预绘制的树草分布。
// 运行：npm run generate:sample  →  public/samples/demo-sample.veg.json
// 在应用里点「打开项目」选择该文件即可恢复完全相同的场景。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTerrain } from '../src/core/terrain.js';
import { PaintMask } from '../src/core/mask.js';
import { ScatterLayer } from '../src/core/scatter.js';
import { DEFAULT_RULES } from '../src/core/rules.js';
import { saveProject } from '../src/core/project.js';
import { DEFAULT_SEED, TOOL } from '../src/core/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '..', 'public', 'samples', 'demo-sample.veg.json');

const terrain = generateTerrain({ size: 128, resolution: 129, seed: DEFAULT_SEED });
const mask = new PaintMask({ width: terrain.width, depth: terrain.depth, cellSize: 1 });
const rules = DEFAULT_RULES();
const scatter = new ScatterLayer({ terrain, mask, rules, seed: DEFAULT_SEED });

// 程序化“手绘”：在几片区域刷植被，再擦出一条小路，再涂一块遮罩
for (let x = -48; x <= 48; x += 8) {
  for (let z = -48; z <= 48; z += 8) {
    // 留出对角空地
    if (Math.abs(x - z) < 6) continue;
    scatter.applyBrush(TOOL.PAINT, { x, z }, 11);
  }
}
scatter.applyBrush(TOOL.ERASE, { x: -20, z: -20 }, 7);
scatter.applyBrush(TOOL.ERASE, { x: 24, z: 18 }, 7);
mask.paint({ x: 30, z: -30 }, 14, 1);
scatter.flushDirty();

const project = saveProject({
  name: 'demo-sample',
  terrain,
  mask,
  scatter,
  rules,
});
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(project), 'utf8');

const stats = scatter.getStats();
console.log(`示例已生成：${outPath}`);
console.log(`实例总数 ${stats.total}，规则 ${rules.length} 条，种子 ${scatter.seed}`);
