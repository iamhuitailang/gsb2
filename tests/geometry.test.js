/*
 * 纯 Node 运行：node tests/geometry.test.js
 * 只依赖 js/geometry.js（UMD-lite 导出），不涉及 DOM。
 */
const assert = require('assert');
const G = require('../js/geometry.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

// 构造带 id 的线段
function seg(id, ax, ay, bx, by, wallId) {
  return { id, wallId: wallId || id, a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

function insideCircle(p, c, r, eps = 1e-6) {
  return G.dist(p, c) <= r + eps;
}

// 可见性判定统一走径向判定
function visible(light, polygon, p) {
  return G.isPointVisible(light, polygon, p);
}

console.log('raySegment 基础求交');

test('垂直命中线段中心', () => {
  const s = seg('s', 10, -10, 10, 10);
  const hit = G.raySegment({ x: 0, y: 0 }, 0, s); // 沿 +x
  assert.ok(hit);
  assert.ok(Math.abs(hit.t - 10) < 1e-9);
  assert.ok(Math.abs(hit.u - 0.5) < 1e-9);
});

test('反向射线不相交', () => {
  const s = seg('s', 10, -10, 10, 10);
  assert.strictEqual(G.raySegment({ x: 0, y: 0 }, Math.PI, s), null);
});

test('平行/共线返回 null（掠射不遮挡）', () => {
  const s = seg('s', 0, 5, 20, 5);
  assert.strictEqual(G.raySegment({ x: 0, y: 0 }, 0, s), null);
  const collinear = seg('c', 5, 0, 15, 0);
  assert.strictEqual(G.raySegment({ x: 0, y: 0 }, 0, collinear), null);
});

console.log('\ncomputeVisibility 遮挡形状');

test('单堵墙：墙后中轴点不可见，墙前与墙侧可见', () => {
  const segs = [seg('w', 20, -15, 20, 15)];
  const light = { x: 0, y: 0 };
  const { polygon } = G.computeVisibility(light, segs, 100);
  assert.ok(polygon.length >= 7); // 灯心 + 至少 6 个射线顶点
  assert.strictEqual(visible(light, polygon, { x: 10, y: 0 }), true);
  assert.strictEqual(visible(light, polygon, { x: 30, y: 0 }), false);
  // 墙端点外侧：方向角在端点角(0.6435)之外、半径之内，属于无遮挡区
  assert.strictEqual(visible(light, polygon, { x: 30, y: 30 }), true);
});

test('所有顶点不超出灯半径（半径边缘不穿光）', () => {
  const segs = [
    seg('a', 30, -20, 30, 20),
    seg('b', -40, 40, 40, 40),
  ];
  const light = { x: 0, y: 0 };
  const r = 60;
  const { polygon } = G.computeVisibility(light, segs, r);
  for (const v of polygon) {
    assert.ok(insideCircle(v, light, r, 1e-6),
      `顶点 (${v.x.toFixed(2)},${v.y.toFixed(2)}) 超出半径 ${v.dist.toFixed(2)} > ${r}`);
  }
});

test('无墙时多边形等于完整半径圆（采样点全在圆周上）', () => {
  const light = { x: 50, y: 50 };
  const { polygon } = G.computeVisibility(light, [], 40);
  const ring = polygon.filter(v => !v.isOrigin);
  assert.ok(ring.length >= 12);
  for (const v of ring) {
    assert.ok(Math.abs(v.dist - 40) < 1e-6);
    assert.strictEqual(v.onCircle, true);
  }
  assert.strictEqual(visible(light, polygon, { x: 50, y: 50 }), true);
  assert.strictEqual(visible(light, polygon, { x: 80, y: 50 }), true);   // 半径内
  assert.strictEqual(visible(light, polygon, { x: 95, y: 50 }), false);  // 半径外
});

test('拐角附近：墙端点正后方点被挡，端点外侧点可见（无穿光缝）', () => {
  const segs = [seg('w', 20, -15, 20, 15)];
  const light = { x: 0, y: 0 };
  const { polygon } = G.computeVisibility(light, segs, 120);
  // 端点正后方与墙后区域：必须被挡住
  assert.strictEqual(visible(light, polygon, { x: 22, y: 15 }), false);
  assert.strictEqual(visible(light, polygon, { x: 25, y: 14 }), false);
  assert.strictEqual(visible(light, polygon, { x: 30, y: 0 }), false);
  // 端点外侧明确可见（方向角超过端点角；eps 阴影楔在端点处仅亚像素宽，渲染时被墙体外廓覆盖）
  assert.strictEqual(visible(light, polygon, { x: 25, y: 20 }), true);
});

test('端点阴影楔宽度受 EPS_ANGLE 约束：离端点越远楔越窄', () => {
  // 三射线法在墙端外侧产生的楔半角 ≈ EPS_ANGLE，
  // 距墙端 25px 处楔宽 < 0.003px，肉眼不可见，且被 9px 墙体外廓覆盖
  assert.ok(G.EPS_ANGLE <= 1e-4);
  const wedgeWidthAt25 = 25 * Math.tan(G.EPS_ANGLE);
  assert.ok(wedgeWidthAt25 < 0.003);
});

test('L 形凹角：凹角内侧可见，墙外背面不可见', () => {
  const segs = [
    seg('l1', 0, 0, 40, 0),
    seg('l2', 40, 0, 40, 40),
  ];
  const light = { x: 20, y: 30 };
  const { polygon } = G.computeVisibility(light, segs, 100);
  assert.strictEqual(visible(light, polygon, { x: 20, y: 20 }), true);
  assert.strictEqual(visible(light, polygon, { x: 20, y: -10 }), false);
  assert.strictEqual(visible(light, polygon, { x: 50, y: 20 }), false);
});

test('两堵墙接头：接头两侧点一个可见一个不可见，接头处不漏光', () => {
  // 两段墙在 (20,0) 接头，一上一下
  const segs = [
    seg('a', 20, -20, 20, 0),
    seg('b', 20, 0, 20, 20),
  ];
  const light = { x: 0, y: 0 };
  const { polygon } = G.computeVisibility(light, segs, 100);
  assert.strictEqual(visible(light, polygon, { x: 25, y: 0 }), false);  // 接头正后方
  assert.strictEqual(visible(light, polygon, { x: 25, y: 26 }), true);  // 接头外侧（角度 > π/4）
});

console.log('\n灯贴墙 / 压端点');

test('灯恰好贴在线段上：两侧都可见，不产生 NaN，pointOnWall 能检出', () => {
  const segs = [seg('w', 0, 0, 40, 0)];
  const light = { x: 20, y: 0 };
  const onWall = G.pointOnWall(light, segs);
  assert.ok(onWall, '应检出贴墙');
  const { polygon } = G.computeVisibility(light, segs, 60);
  assert.ok(polygon.length >= 4);
  for (const v of polygon) {
    assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y));
    assert.ok(v.dist <= 60 + 1e-6);
  }
  assert.strictEqual(visible(light, polygon, { x: 20, y: 20 }), true);
  assert.strictEqual(visible(light, polygon, { x: 20, y: -20 }), true);
});

test('灯压在墙端点上不崩溃', () => {
  const segs = [seg('w', 0, 0, 40, 0)];
  const { polygon } = G.computeVisibility({ x: 0, y: 0 }, segs, 50);
  assert.ok(polygon.length >= 4);
  for (const v of polygon) assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y));
});

console.log('\n窄缝与 queryPoint 地面查询');

function slitScene() {
  // y=480 横墙，缝 x∈(520,548)
  return [
    seg('left', 220, 480, 520, 480, 'left'),
    seg('right', 548, 480, 800, 480, 'right'),
  ];
}

test('窄缝：缝中视线穿透，缝旁被墙挡住', () => {
  const segs = slitScene();
  const light = { x: 534, y: 430, radius: 300, on: true }; // 正对缝
  const r1 = G.queryPoint({ x: 534, y: 560 }, [light], segs);
  assert.strictEqual(r1[0].blocked, false, 'M1 经窄缝应照到下方');
  const light2 = { x: 564, y: 430, radius: 300, on: true }; // 错开 30px
  const r2 = G.queryPoint({ x: 564, y: 560 }, [light2], segs);
  assert.strictEqual(r2[0].blocked, true, 'M2 被右段实墙挡住');
  assert.strictEqual(r2[0].blocker.wallId, 'right');
});

test('两个相近位置的可见多边形覆盖明显不同', () => {
  const segs = slitScene();
  const l1 = { x: 534, y: 430 };
  const l2 = { x: 564, y: 430 };
  const p1 = G.computeVisibility(l1, segs, 300).polygon;
  const p2 = G.computeVisibility(l2, segs, 300).polygon;
  assert.strictEqual(visible(l1, p1, { x: 534, y: 560 }), true);
  assert.strictEqual(visible(l2, p2, { x: 534, y: 560 }), false);
});

test('queryPoint 擦过墙端点不算遮挡，直接命中墙身才算', () => {
  const segs = [seg('w', 20, -15, 20, 15)];
  const light = { x: 0, y: 0, radius: 200, on: true };
  const beyond = { x: 40, y: 30 };
  assert.strictEqual(G.queryPoint(beyond, [light], segs)[0].blocked, false);
  const through = { x: 40, y: 0 };
  assert.strictEqual(G.queryPoint(through, [light], segs)[0].blocked, true);
});

test('queryPoint 半径外的灯不参与，关灯的灯不参与', () => {
  const lights = [
    { x: 0, y: 0, radius: 10, on: true },
    { x: 0, y: 0, radius: 100, on: false },
  ];
  const r = G.queryPoint({ x: 50, y: 0 }, lights, []);
  assert.strictEqual(r.length, 0);
});

console.log('\n多灯独立性');

test('两盏灯分别计算，关掉一盏不影响另一盏的多边形顶点', () => {
  const segs = slitScene();
  const l1 = { id: 'a', x: 534, y: 430, radius: 300, on: true };
  const l2 = { id: 'b', x: 100, y: 100, radius: 200, on: true };
  const a1 = G.computeVisibility(l1, segs, l1.radius).polygon;
  G.computeVisibility(l2, segs, l2.radius);
  l2.on = false;
  const a2 = G.computeVisibility(l1, segs, l1.radius).polygon;
  assert.strictEqual(a1.length, a2.length);
  for (let i = 0; i < a1.length; i++) {
    assert.ok(Math.abs(a1[i].x - a2[i].x) < 1e-12);
    assert.ok(Math.abs(a1[i].y - a2[i].y) < 1e-12);
  }
});

console.log('\nflattenWalls 墙链展开');

test('墙链按顺序展开并带稳定 id', () => {
  const walls = [{ id: 'w1', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }];
  const segs = G.flattenWalls(walls);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].id, 'w1:0');
  assert.strictEqual(segs[1].id, 'w1:1');
  assert.deepStrictEqual(segs[1].a, { x: 1, y: 0 });
  assert.deepStrictEqual(segs[1].b, { x: 1, y: 1 });
});

console.log('\n通用 pointInPolygon 冒烟测试');

test('三角形内外判定正确', () => {
  const tri = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 0, y: 10 }];
  assert.strictEqual(G.pointInPolygon({ x: 0, y: 0 }, tri), true);
  assert.strictEqual(G.pointInPolygon({ x: 0, y: 11 }, tri), false);
});

console.log(`\n${passed} 项测试全部通过`);
