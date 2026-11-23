// 生成内置本地样例：窄通道 / 死路 / 孤立区域 / 综合演示。
// 运行：npm run generate:samples（输出到 samples/，随仓库提交）
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CELL } from '../src/core/geometry.js';
import { NavEngine } from '../src/core/engine.js';
import { serializeProject } from '../src/core/serialize.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');

function blank(w, h) {
  return new Uint8Array(w * h);
}
function rect(cells, w, x0, y0, x1, y1, v) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) cells[y * w + x] = v;
  }
}

// 1) 窄通道：两道带开口的墙，第二个开口只有 1 格宽，调大角色半径会被封死
function narrowPass() {
  const w = 26;
  const h = 18;
  const cells = blank(w, h);
  rect(cells, w, 0, 0, w - 1, 0, CELL.BLOCK);
  rect(cells, w, 0, h - 1, w - 1, h - 1, CELL.BLOCK);
  rect(cells, w, 0, 0, 0, h - 1, CELL.BLOCK);
  rect(cells, w, w - 1, 0, w - 1, h - 1, CELL.BLOCK);
  // 第一堵竖墙（x=9），开口 y=8..10（3 格宽）
  for (let y = 1; y < h - 1; y++) if (!(y >= 8 && y <= 10)) cells[y * w + 9] = CELL.BLOCK;
  // 第二堵竖墙（x=17），仅 y=9 一个 1 格宽开口
  for (let y = 1; y < h - 1; y++) if (y !== 9) cells[y * w + 17] = CELL.BLOCK;
  // 通往窄口的地面铺路面，另一侧铺泥泞，方便切换地形权重看差异
  for (let y = 7; y <= 11; y++) for (let x = 10; x <= 16; x++) cells[y * w + x] = CELL.ROAD;
  for (let y = 7; y <= 11; y++) for (let x = 18; x <= 22; x++) cells[y * w + x] = CELL.MUD;
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0.5 });
  engine.setEndpoint('start', 2, 9);
  engine.setEndpoint('goal', 23, 9);
  engine.addAnnotation(17, 9, '1 格宽窄口：角色半径 ≥1 时封死');
  return { engine, name: 'narrow-pass', title: '窄通道', desc: '两堵墙夹出宽度 3 与宽度 1 的开口，调大角色半径观察侵蚀封路' };
}

// 2) 死路：一条主路分出三个死胡同，其中一个藏在障碍背后
function deadEnd() {
  const w = 24;
  const h = 20;
  const cells = blank(w, h);
  rect(cells, w, 0, 0, w - 1, 0, CELL.BLOCK);
  rect(cells, w, 0, h - 1, w - 1, h - 1, CELL.BLOCK);
  rect(cells, w, 0, 0, 0, h - 1, CELL.BLOCK);
  rect(cells, w, w - 1, 0, w - 1, h - 1, CELL.BLOCK);
  // 横向主通道（y=10，墙在 y=6 与 y=14），向上/下开三个死胡同
  rect(cells, w, 2, 0, 21, 6, CELL.BLOCK);
  rect(cells, w, 2, 14, 21, 18, CELL.BLOCK);
  // 死胡同 1：上方 x=5..7 挖到底
  rect(cells, w, 5, 2, 7, 6, CELL.WALK);
  // 死胡同 2：上方 x=14..15
  rect(cells, w, 14, 4, 15, 6, CELL.WALK);
  // 死胡同 3：下方 x=10..12
  rect(cells, w, 10, 14, 12, 17, CELL.WALK);
  // 死胡同 1 尽头放泥泞（检查时容易误以为是目标点）
  rect(cells, w, 5, 2, 7, 3, CELL.MUD);
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0.5 });
  engine.setEndpoint('start', 2, 10);
  engine.setEndpoint('goal', 21, 10);
  engine.addAnnotation(6, 2, '死路尽头：寻路不会进入此分支');
  engine.addAnnotation(14, 5, '短死胡同');
  return { engine, name: 'dead-end', title: '死路', desc: '主通道分出三个死胡同，验证 A* 不会探索无出口分支' };
}

// 3) 孤立区域：墙内庭院与两个被完全隔开的小岛
function isolated() {
  const w = 24;
  const h = 20;
  const cells = blank(w, h);
  rect(cells, w, 0, 0, w - 1, 0, CELL.BLOCK);
  rect(cells, w, 0, h - 1, w - 1, h - 1, CELL.BLOCK);
  rect(cells, w, 0, 0, 0, h - 1, CELL.BLOCK);
  rect(cells, w, w - 1, 0, w - 1, h - 1, CELL.BLOCK);
  // 封闭庭院（厚 2 的围墙，无开口）
  rect(cells, w, 4, 4, 11, 4, CELL.BLOCK);
  rect(cells, w, 4, 9, 11, 9, CELL.BLOCK);
  rect(cells, w, 4, 4, 4, 9, CELL.BLOCK);
  rect(cells, w, 11, 4, 11, 9, CELL.BLOCK);
  // 小岛 A：3x3 全围
  rect(cells, w, 16, 3, 20, 3, CELL.BLOCK);
  rect(cells, w, 16, 7, 20, 7, CELL.BLOCK);
  rect(cells, w, 16, 3, 16, 7, CELL.BLOCK);
  rect(cells, w, 20, 3, 20, 7, CELL.BLOCK);
  // 小岛 B：右下 2x2
  rect(cells, w, 17, 13, 20, 13, CELL.BLOCK);
  rect(cells, w, 17, 16, 20, 16, CELL.BLOCK);
  rect(cells, w, 17, 13, 17, 16, CELL.BLOCK);
  rect(cells, w, 20, 13, 20, 16, CELL.BLOCK);
  rect(cells, w, 7, 6, 8, 7, CELL.ROAD);
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0.5 });
  engine.setEndpoint('start', 2, 17);
  engine.setEndpoint('goal', 7, 6); // 目标点放在封闭庭院内部 → 不可达
  engine.addAnnotation(7, 6, '孤立庭院：与外部不连通，终点不可达');
  engine.addAnnotation(18, 5, '孤立小岛 A');
  return { engine, name: 'isolated', title: '孤立区域', desc: '封闭庭院与两个孤岛，演示连通分量标注与不可达提示' };
}

// 4) 综合演示：窄通道 + 死路 + 孤岛 + 三种地形
function showcase() {
  const w = 32;
  const h = 22;
  const cells = blank(w, h);
  rect(cells, w, 0, 0, w - 1, 0, CELL.BLOCK);
  rect(cells, w, 0, h - 1, w - 1, h - 1, CELL.BLOCK);
  rect(cells, w, 0, 0, 0, h - 1, CELL.BLOCK);
  rect(cells, w, w - 1, 0, w - 1, h - 1, CELL.BLOCK);
  // 中部竖墙，留两个开口：宽口 y=4..6，窄口 y=15
  for (let y = 1; y < h - 1; y++) {
    if (!((y >= 4 && y <= 6) || y === 15)) cells[y * w + 15] = CELL.BLOCK;
  }
  // 左侧死胡同
  rect(cells, w, 4, 11, 10, 11, CELL.BLOCK);
  rect(cells, w, 4, 11, 4, 18, CELL.BLOCK);
  rect(cells, w, 10, 11, 10, 18, CELL.BLOCK);
  rect(cells, w, 4, 18, 10, 18, CELL.BLOCK);
  // 右侧孤岛
  rect(cells, w, 22, 9, 27, 9, CELL.BLOCK);
  rect(cells, w, 22, 13, 27, 13, CELL.BLOCK);
  rect(cells, w, 22, 9, 22, 13, CELL.BLOCK);
  rect(cells, w, 27, 9, 27, 13, CELL.BLOCK);
  // 路面引导走宽口；窄口外铺泥泞
  for (let y = 4; y <= 6; y++) for (let x = 12; x <= 18; x++) cells[y * w + x] = CELL.ROAD;
  for (let y = 14; y <= 16; y++) for (let x = 16; x <= 20; x++) cells[y * w + x] = CELL.MUD;
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0.5 });
  engine.setEndpoint('start', 2, 3);
  engine.setEndpoint('goal', 29, 3);
  engine.addAnnotation(15, 15, '1 格窄口');
  engine.addAnnotation(7, 15, '死胡同（内含泥泞）');
  engine.addAnnotation(24, 11, '孤立区域');
  return { engine, name: 'showcase', title: '综合演示', desc: '窄通道、死路、孤立区域与三种地形同屏，适合对比三套寻路权重' };
}

const samples = [narrowPass(), deadEnd(), isolated(), showcase()];
await mkdir(outDir, { recursive: true });
for (const s of samples) {
  const json = serializeProject(s.engine, { sampleName: s.name, title: s.title, desc: s.desc });
  await writeFile(join(outDir, `${s.name}.json`), JSON.stringify(json, null, 2));
  console.log(`生成 samples/${s.name}.json（${s.engine.w}x${s.engine.h}，分量数 ${s.engine.componentCount}）`);
}
