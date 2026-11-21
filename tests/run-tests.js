/* Node 测试：node tests/run-tests.js（无需浏览器、无需依赖） */
'use strict';
const assert = require('assert');
const V = require('../src/vec3.js');
const Spline = require('../src/spline.js');
const Road = require('../src/road.js');
const Demo = require('../src/demo.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

/* ---------- 1. 弧长参数化：等弧长布站，直线/弯道不被等参数化 ---------- */
test('样条弧长表单调且总长为正', () => {
  const sp = Spline.build(Demo.controlPoints, true);
  assert.ok(sp.totalLength > 100);
  for (let i = 1; i < sp.arc.length; i++) assert.ok(sp.arc[i].s >= sp.arc[i - 1].s);
});

test('等弧长采样间距基本一致（与参数 t 无关）', () => {
  const sp = Spline.build(Demo.controlPoints, true);
  const step = 4;
  const ds = [];
  for (let s = 0; s < sp.totalLength - step; s += step) {
    const a = sp.sampleAtDistance(s).pos, b = sp.sampleAtDistance(s + step).pos;
    ds.push(V.dist(a, b));
  }
  const mean = ds.reduce((x, y) => x + y, 0) / ds.length;
  approx(mean, step, 0.05);
  assert.ok(Math.max(...ds) - Math.min(...ds) < 0.1, '间距应几乎相等');
});

test('急弯处自适应加密：转角受限并在最小步长处收敛', () => {
  const sp = Spline.build(Demo.controlPoints, true);
  const minStep = 0.3;
  const stations = Spline.sampleStations(sp, { arcLengthStep: 6, minStep, maxTurnAngleDeg: 3 });
  // 基准：同等弧长步长但关闭转角加密（给一个不可能触发的大角度）
  const base = Spline.sampleStations(sp, { arcLengthStep: 6, minStep, maxTurnAngleDeg: 179 });
  assert.ok(stations.length > base.length * 1.2, `急弯应产生明显额外站点: ${stations.length} vs ${base.length}`);
  // 闭合路线最后一对是 s=L→s=0 接缝对，统计时排除
  let maxTurn = 0, minGap = Infinity;
  for (let i = 0; i < stations.length - 2; i++) {
    const cos = V.dot(stations[i].tangent, stations[i + 1].tangent);
    maxTurn = Math.max(maxTurn, Math.acos(Math.max(-1, Math.min(1, cos))));
    minGap = Math.min(minGap, stations[i + 1].s - stations[i].s);
  }
  // 几何下限：实测最紧弯半径，minStep 下转角 ≈ minStep/r；允许 2.2 倍余量
  let minR = Infinity;
  for (let s = 0; s < sp.totalLength; s += 0.2) {
    const r = sp.sampleAtDistance(s).radius;
    if (isFinite(r)) minR = Math.min(minR, r);
  }
  const limit = 2.2 * minStep / minR;
  assert.ok(maxTurn <= limit + 1e-9, `加密后最大转角 ${(maxTurn * 180 / Math.PI).toFixed(2)}° 超过几何下限 ${(limit * 180 / Math.PI).toFixed(2)}°`);
  assert.ok(minGap >= minStep * 0.9, '加密不应把区间切到 minStep 以下（允许闭合收尾余段）');
});

test('长直段与短弯段按实际里程分配站点（非等参数）', () => {
  // 开口折线：长直道接直角弯再直道，直段上采样点应按长度分布而非参数均匀
  const pts = [[0, 0, 0], [50, 0, 0], [50, 25, 0], [20, 25, 0]];
  const sp = Spline.build(pts, false);
  const stations = Spline.sampleStations(sp, { arcLengthStep: 2, minStep: 0.25, maxTurnAngleDeg: 2 });
  const straight = stations.filter((s) => s.pos[0] > 8 && s.pos[0] < 42 && Math.abs(s.pos[1]) < 3);
  assert.ok(straight.length >= 12, `长直段站点不足: ${straight.length}`);
  // 直段中部相邻站真实弧长≈2m
  const mid = straight[Math.floor(straight.length / 2)];
  const prev = stations.find((x) => Math.abs(x.s - (mid.s - 2)) < 0.3);
  assert.ok(prev && V.dist(prev.pos, mid.pos) < 2.15, '弧长间距失真');
});

/* ---------- 2. 段参数独立性 ---------- */
test('编辑某一段后其余段参数保持原值', () => {
  const spans = Demo.makeSpans();
  const before = spans.map((s) => ({ ...s }));
  spans[3].width = 15;
  spans[3].crossfall = 9;
  spans.forEach((s, i) => {
    if (i === 3) return;
    assert.deepStrictEqual(s, before[i], `段 ${i} 被意外修改`);
  });
  assert.strictEqual(spans[3].width, 15);
});

test('段中点处取到该段自身参数', () => {
  const spans = Demo.makeSpans();
  const sp = Spline.build(Demo.controlPoints, true);
  const sampler = Road.makeParamSampler(sp, spans);
  const mid = sampler.mids[5];
  const p = sampler.at(mid);
  approx(p.width, spans[5].width, 1e-9);
  approx(p.crossfall, spans[5].crossfall, 1e-9);
});

/* ---------- 3. 横坡与路面架 ---------- */
test('正横坡使左缘抬高、右缘下沉', () => {
  const sample = { pos: [0, 0, 0], tangent: [1, 0, 0], curvature: 0, radius: Infinity, s: 0, span: 0, t: 0 };
  const flat = Road.frameAt(sample, { width: 8, height: 0, crossfall: 0 });
  const banked = Road.frameAt(sample, { width: 8, height: 0, crossfall: 8 });
  const left = Road.sectionPoint(banked, 1), right = Road.sectionPoint(banked, -1);
  assert.ok(left[2] > 0 && right[2] < 0, '横坡方向错误');
  const flatLeft = Road.sectionPoint(flat, 1);
  approx(flatLeft[2], 0, 1e-9);
  approx(Math.hypot(left[0], left[1], left[2]), 4, 1e-9); // 半幅宽不变
});

/* ---------- 4. 折叠/自交检测 ---------- */
test('正常演示路线无折叠', () => {
  const { road, issues } = Road.analyze(Demo.controlPoints, true, Demo.makeSpans(),
    { arcLengthStep: 2, minStep: 0.3, maxTurnAngleDeg: 3 });
  const hard = issues.filter((i) => i.type === 'inner-edge-fold' || i.type === 'surface-self-intersection');
  assert.strictEqual(hard.length, 0, `正常路线不应折叠: ${JSON.stringify(hard)}`);
});

test('加宽回头弯触发折叠并报告里程位置', () => {
  const spans = Demo.makeSpans(Demo.foldOverride);
  const { issues } = Road.analyze(Demo.controlPoints, true, spans,
    { arcLengthStep: 2, minStep: 0.3, maxTurnAngleDeg: 3 });
  const fold = issues.find((i) => i.type === 'inner-edge-fold' || i.type === 'surface-self-intersection');
  assert.ok(fold, '应检测到折叠');
  assert.ok(/里程/.test(fold.message), '提示应含里程位置');
  assert.ok(fold.point || fold.station !== undefined, '应给出位置');
});

test('中心线自交可被定位（自交折线）', () => {
  // 开口折线：两段曲线在中部横切
  const crossing = [[0, -40, 0], [0, 40, 0], [40, 0, 0], [-40, 0, 0], [20, -30, 0]];
  const sp = Spline.build(crossing, false);
  const hits = Road.centerlineSelfIntersections(sp);
  assert.ok(hits.length >= 1, '应报告中心线自交');
  assert.ok(hits[0].stationA >= 0 && hits[0].stationB > hits[0].stationA);
  assert.ok(hits[0].point && Number.isFinite(hits[0].point[0]));
});

/* ---------- 5. 闭合接缝 ---------- */
test('闭合路线首末环顶点/法线/横向量接顺', () => {
  const { road, seam } = Road.analyze(Demo.controlPoints, true, Demo.makeSpans(),
    { arcLengthStep: 2, minStep: 0.3, maxTurnAngleDeg: 3 });
  assert.ok(seam, '闭合路线应给出接缝诊断');
  assert.ok(seam.ok, seam.message);
  assert.ok(seam.positionError < 0.05);
  assert.ok(seam.normalError < 0.02);
});

test('开口路线不产生闭合接缝', () => {
  const openPts = Demo.controlPoints.slice(0, 5);
  const spans = openPts.map(() => Road.defaultSpanParams());
  const result = Road.analyze(openPts, false, spans, { arcLengthStep: 3 });
  assert.strictEqual(result.seam, null);
  assert.ok(result.road.rings[0].s === 0);
  assert.ok(result.road.rings[result.road.rings.length - 1].s > 0);
});

/* ---------- 6. 两种细度 ---------- */
test('粗/细两种网格细度产生不同环数与三角形数', () => {
  const spans = Demo.makeSpans();
  const coarse = Road.buildRoad(Demo.controlPoints, true, spans,
    { arcLengthStep: 8, minStep: 1, maxTurnAngleDeg: 8 });
  const fine = Road.buildRoad(Demo.controlPoints, true, spans,
    { arcLengthStep: 1, minStep: 0.2, maxTurnAngleDeg: 2 });
  assert.ok(fine.rings.length > coarse.rings.length * 2,
    `细网格环数应明显更多: ${fine.rings.length} vs ${coarse.rings.length}`);
  assert.ok(fine.indices.length > coarse.indices.length);
  // 两者总里程一致
  approx(fine.spline.totalLength, coarse.spline.totalLength, 1e-9);
});

/* ---------- 7. 导出可对应控制点与里程 ---------- */
test('OBJ 含路面与路肩分组，元数据里程/控制点齐全', () => {
  const road = Road.buildRoad(Demo.controlPoints, true, Demo.makeSpans(), { arcLengthStep: 4 });
  const obj = Road.toOBJ(road);
  assert.ok(/g pavement/.test(obj) && /g shoulder_left/.test(obj) && /g shoulder_right/.test(obj));
  // 标准单行三角面
  const faceLines = obj.split('\n').filter((l) => l.startsWith('f '));
  assert.ok(faceLines.length > 100);
  assert.ok(faceLines.every((l) => l.trim().split(/\s+/).length === 4), '每个 f 应含 3 个顶点');
  // 面索引全部落在已声明顶点范围内
  const vCount = (obj.match(/^v /gm) || []).length;
  const maxIdx = Math.max(...faceLines.flatMap((l) => l.trim().split(/\s+/).slice(1).map((t) => +t.split('//')[0])));
  assert.ok(maxIdx <= vCount, `面索引 ${maxIdx} 超出顶点数 ${vCount}`);
  const meta = Road.exportMeta(road, Demo.controlPoints, true);
  assert.strictEqual(meta.controlPoints.length, Demo.controlPoints.length);
  assert.ok(meta.stations.length === road.rings.length);
  approx(meta.totalLength, road.spline.totalLength, 1e-3);
  approx(meta.stations[0].station, 0, 1e-9);
  // 元数据中心坐标与网格顶点一致
  const c0 = meta.stations[0].center;
  const ringMid = road.ringIndex[0] + Math.floor(road.vPerRing / 2);
  approx(c0[0], road.vertices[ringMid][0], 1e-3);
});

test('路肩可关闭', () => {
  const road = Road.buildRoad(Demo.controlPoints, true, Demo.makeSpans(), { includeShoulders: false });
  assert.strictEqual(road.shoulders.left, null);
  assert.strictEqual(road.shoulders.right, null);
});

console.log(`\n${passed} 项测试通过${process.exitCode ? '（存在失败）' : ''}`);
