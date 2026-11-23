import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELL, TERRAIN_MULT, clearanceField, erode, labelComponents, rleEncode, rleDecode } from '../src/core/geometry.js';
import { findPath, WEIGHT_PRESETS } from '../src/core/pathfinding.js';
import { NavEngine } from '../src/core/engine.js';
import { serializeProject, deserializeProject, exportNavData } from '../src/core/serialize.js';

function makeGrid(w, h, fill = CELL.WALK) {
  return new Uint8Array(w * h).fill(fill);
}
function setBlock(cells, w, x, y) {
  cells[y * w + x] = CELL.BLOCK;
}

test('clearance: 障碍格为 0，空地距离正确，地图边界也计入', () => {
  const w = 5;
  const h = 5;
  const cells = makeGrid(w, h);
  setBlock(cells, w, 2, 2);
  const d = clearanceField(cells, w, h);
  assert.equal(d[2 * w + 2], 0); // 障碍本身
  assert.equal(d[2 * w + 1], 1); // 相邻格
  assert.equal(d[0], 1); // 左上角到边界距离 1
  // (4,2)：到障碍横向距离 2，到右边界距离 1，取较小值
  assert.equal(d[2 * w + 4], 1);
  // (1,4)：到障碍 (2,2) 距离 √5，到下边界 1、左边界 2
  assert.ok(Math.abs(d[4 * w + 1] - 1) < 1e-9);
});

test('erode: 角色半径 1.5 会封死窄走廊', () => {
  // 走廊净高 2 格：墙在 y=2 与 y=5，可走行为 y=3,4，中格到墙面距离 1
  const w = 13;
  const h = 9;
  const cells = makeGrid(w, h);
  for (let x = 0; x < w; x++) {
    setBlock(cells, w, x, 2);
    setBlock(cells, w, x, 5);
  }
  const d = clearanceField(cells, w, h);
  assert.equal(d[4 * w + 6], 1, '走廊中格到墙面距离应为 1');
  assert.ok(erode(cells, d, 1, w, h)[4 * w + 6], '半径1 时净高 2 格走廊可通行');
  assert.ok(!erode(cells, d, 1.5, w, h)[4 * w + 6], '半径1.5 时净高 2 格走廊被封死');

  // 加宽到净高 4 格：墙在 y=1 与 y=6，可走行 y=2..5，中格到墙面距离 2
  const cells2 = makeGrid(w, h);
  for (let x = 0; x < w; x++) {
    setBlock(cells2, w, x, 1);
    setBlock(cells2, w, x, 6);
  }
  const d2 = clearanceField(cells2, w, h);
  assert.equal(d2[3 * w + 6], 2);
  assert.ok(erode(cells2, d2, 1.5, w, h)[3 * w + 6], '半径1.5 时净高 4 格走廊可通行');
});

test('components: 孤立可行走区域被单独标为一个分量', () => {
  const w = 9;
  const h = 9;
  const cells = makeGrid(w, h, CELL.BLOCK);
  // 主区域 0..3 x 0..3；孤岛 6..8 x 6..8
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cells[y * w + x] = CELL.WALK;
  for (let y = 6; y < 9; y++) for (let x = 6; x < 9; x++) cells[y * w + x] = CELL.WALK;
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0 });
  assert.equal(engine.componentCount, 2);
  assert.notEqual(engine.labels[0], engine.labels[8 * w + 8]);
  assert.equal(engine.componentSizes[engine.labels[8 * w + 8]], 9);
});

test('A*: 无障碍时走出近似直线，对角与正交步数正确', () => {
  const w = 10;
  const h = 10;
  const cells = makeGrid(w, h);
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0 });
  const r = engine.computePath(WEIGHT_PRESETS.shortest.weights, 0, 9 * w + 9);
  assert.ok(r.found);
  assert.equal(r.path[0], 0);
  assert.equal(r.path.at(-1), 9 * w + 9);
  // 9 个对角 + 0 正交 ≈ 长度 9√2
  assert.ok(Math.abs(r.cost - 9 * Math.SQRT2) < 1e-9);
});

test('A*: 障碍墙迫使绕行，代价高于直线', () => {
  const w = 11;
  const h = 11;
  const cells = makeGrid(w, h);
  for (let y = 0; y < h; y++) setBlock(cells, w, 5, y); // 整面竖墙，两侧完全隔开
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0 });
  const r = engine.computePath(WEIGHT_PRESETS.shortest.weights, 2 * w, 2 * w + 10);
  assert.equal(r.found, false, '整面墙不可达');
  // 在墙上开一个口子，路径必须从该口子绕行
  engine.paint(5, 5, CELL.WALK);
  const r2 = engine.computePath(WEIGHT_PRESETS.shortest.weights, 2 * w, 2 * w + 10);
  assert.ok(r2.found);
  for (const i of r2.path) {
    const x = i % w;
    const y = (i / w) | 0;
    if (x === 5 && y !== 5) assert.fail('路径在开口之外穿过障碍墙');
  }
  assert.ok(r2.cost > 10, '绕行代价应大于直线 10');
});

test('A*: 禁止对角穿墙角（两正交邻居有障碍时不能斜走）', () => {
  // 5x5 中心障碍，(1,1) 到 (3,3)：直接斜走会穿墙角，必须绕外圈
  const w = 5;
  const h = 5;
  const cells = makeGrid(w, h);
  setBlock(cells, w, 2, 2);
  const d = clearanceField(cells, w, h);
  const passable = erode(cells, d, 0, w, h);
  const start = 1 * w + 1;
  const goal = 3 * w + 3;
  const r = findPath({ cells, passable, clearance: d, w, h }, start, goal, WEIGHT_PRESETS.shortest.weights);
  assert.ok(r.found);
  // 直线斜走 2 步即达；禁止穿墙角后至少 4 步
  assert.ok(r.path.length >= 5, `不应两步斜穿，实际步数 ${r.path.length}`);
  // 路径上的每个对角步，两个正交邻居必须可通行
  for (let k = 1; k < r.path.length; k++) {
    const a = r.path[k - 1];
    const b = r.path[k];
    const ax = a % w, ay = (a / w) | 0;
    const bx = b % w, by = (b / w) | 0;
    if (ax !== bx && ay !== by) {
      assert.ok(passable[ay * w + bx] && passable[by * w + ax], '存在穿墙角的对角步');
    }
  }
});

test('A*: 地形权重下优先绕开泥泞、选择路面', () => {
  const w = 9;
  const h = 5;
  const cells = makeGrid(w, h);
  // 直路上铺泥泞；上方一行铺路面（稍长但地形便宜）
  for (let x = 1; x < 8; x++) cells[2 * w + x] = CELL.MUD;
  for (let x = 1; x < 8; x++) cells[1 * w + x] = CELL.ROAD;
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0 });
  const start = 2 * w + 0;
  const goal = 2 * w + 8;
  const rShort = engine.computePath(WEIGHT_PRESETS.shortest.weights, start, goal);
  const rTerrain = engine.computePath(WEIGHT_PRESETS.terrain.weights, start, goal);
  // 最短模式走直线穿过泥泞（允许对角步，始终沿第 2 行）
  assert.ok(rShort.path.every((i) => ((i / w) | 0) === 2));
  // 地形模式绕到路面行
  assert.ok(rTerrain.path.some((i) => ((i / w) | 0) === 1));
  // 直接验证：直穿泥泞的地形代价 > 绕行路面的地形代价
  const straightMudCost = rShort.path.slice(1).reduce((s, i) =>
    s + (cells[i] === CELL.MUD ? TERRAIN_MULT[CELL.MUD] : TERRAIN_MULT[CELL.WALK]), 0);
  const roadRouteTerrain = rTerrain.path.slice(1).reduce((s, i) => {
    const f = TERRAIN_MULT[cells[i]] ?? 1;
    return s + f;
  }, 0);
  assert.ok(roadRouteTerrain < straightMudCost,
    `路面路线地形代价 ${roadRouteTerrain} 应低于泥泞直线 ${straightMudCost}`);
});

test('A*: 贴墙权重下路径远离障碍，代价三段分解自洽', () => {
  const w = 12;
  const h = 7;
  const cells = makeGrid(w, h);
  for (let x = 2; x < 10; x++) setBlock(cells, w, x, 1); // 上方一堵墙
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0 });
  const start = 3 * w;
  const goal = 3 * w + 11;
  const r = engine.computePath(WEIGHT_PRESETS.safe.weights, start, goal);
  assert.ok(r.found);
  assert.ok(r.breakdown.wall > 0, '贴墙段应有代价');
  const sum = r.breakdown.distance + r.breakdown.terrain + r.breakdown.wall;
  assert.ok(Math.abs(sum - r.cost) < 1e-9);
  // 逐边代价之和等于总成本
  assert.ok(Math.abs(r.edges.reduce((s, e) => s + e.cost, 0) - r.cost) < 1e-9);
});

test('A*: 起点终点被整面墙隔开时 found=false', () => {
  const w = 7;
  const h = 7;
  const cells = makeGrid(w, h);
  for (let y = 0; y < h; y++) setBlock(cells, w, 3, y); // 整面竖墙，无对角缝
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0 });
  assert.equal(engine.componentCount, 2);
  const r = engine.computePath(WEIGHT_PRESETS.shortest.weights, 1 * w + 1, 1 * w + 5);
  assert.equal(r.found, false);
});

test('RLE 往返一致', () => {
  const arr = new Uint8Array([0, 0, 0, 1, 1, 2, 2, 2, 2, 0]);
  const back = rleDecode(rleEncode(arr), arr.length, Uint8Array);
  assert.deepEqual(Array.from(back), Array.from(arr));
});

test('工程保存/载入后状态一致，标注保留', () => {
  const w = 8;
  const h = 8;
  const cells = makeGrid(w, h);
  setBlock(cells, w, 4, 4);
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 1.2 });
  engine.addAnnotation(2, 3, '这里以后放宝箱');
  const json = serializeProject(engine);
  const { engine: engine2 } = deserializeProject(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(Array.from(engine2.cells), Array.from(engine.cells));
  assert.equal(engine2.agentRadius, 1.2);
  assert.equal(engine2.start, engine.start);
  assert.equal(engine2.annotations.length, 1);
  assert.equal(engine2.annotations[0].text, '这里以后放宝箱');
  assert.equal(engine2.componentCount, engine.componentCount);
});

test('局部涂障碍后重算：不相关标注仍在，连通关系及时更新', () => {
  const w = 9;
  const h = 9;
  const cells = makeGrid(w, h);
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0 });
  engine.addAnnotation(0, 0, '标注A');
  engine.addAnnotation(8, 8, '标注B');
  // 整面竖墙把地图一分为二（禁止穿墙角规则下不会有对角缝）
  engine.paintRect(4, 0, 4, 8, CELL.BLOCK);
  assert.equal(engine.componentCount, 2);
  assert.equal(engine.annotations.length, 2, '编辑不能清空标注');
  // 再打通一格
  engine.paint(4, 4, CELL.WALK);
  assert.equal(engine.componentCount, 1, '边界修改后连通关系应更新');
});

test('边界情况：全障碍地图没有可通行格，寻路安全返回不可达', () => {
  const w = 6;
  const h = 6;
  const cells = makeGrid(w, h, CELL.BLOCK);
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0 });
  assert.equal(engine.componentCount, 0);
  assert.equal(engine.passable.reduce((s, v) => s + v, 0), 0);
  const r = engine.computePath(WEIGHT_PRESETS.shortest.weights, 0, 35);
  assert.equal(r.found, false);
  assert.equal(r.explored, 0);
});

test('边界情况：零半径时空地全部可通行，贴墙代价随 clearance 变化', () => {
  const w = 5;
  const h = 5;
  const cells = makeGrid(w, h);
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0 });
  assert.equal(engine.passable.reduce((s, v) => s + v, 0), 25);
  const r = engine.computePath(WEIGHT_PRESETS.safe.weights, 0, 24);
  assert.ok(r.found);
  assert.ok(r.breakdown.wall > 0);
});

test('导出 graph 导航数据：节点均为可通行格，边不穿墙', () => {
  const w = 6;
  const h = 6;
  const cells = makeGrid(w, h);
  setBlock(cells, w, 3, 3);
  const engine = new NavEngine({ width: w, height: h, cells, agentRadius: 0 });
  const nav = exportNavData(engine, WEIGHT_PRESETS.shortest.weights, 'graph');
  assert.equal(nav.nodes.length, engine.passable.reduce((s, v) => s + v, 0));
  for (const e of nav.edges) {
    const a = nav.nodes[e.from];
    const b = nav.nodes[e.to];
    assert.ok(engine.passable[b.y * w + b.x]);
    if (a.x !== b.x && a.y !== b.y) {
      assert.ok(engine.passable[a.y * w + b.x] && engine.passable[b.y * w + a.x],
        '对角边不能穿墙角');
    }
    assert.ok(e.weight > 0);
  }
});
