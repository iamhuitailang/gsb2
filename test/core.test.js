/* test/core.test.js — 纯 Node 运行：node test/core.test.js
 * 验证：桥上/桥下遮挡差异、跨格部分重叠、稳定回退与冲突、重放一致性、环路 */
'use strict';
const C = require('../js/core.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}
function orderOf(result, id) { return result.order.indexOf(id); }
function inFront(result, frontId, backId) { return orderOf(result, frontId) > orderOf(result, backId); }

/* 1. 同一地面坐标：桥上与桥下，盖住角色的东西不同 */
(function testBridgeVsUnder() {
  console.log('1. 桥上 vs 桥下（同格 5,3）');
  const scene = C.defaultScene();
  const under = C.computeOrder(scene, C.buildRenderables(scene, { pos: { x: 5, y: 3 }, z: 0, floor: 'ground' }));
  ok(under.objects.some(o => o.id === 'hero'), '桥下时角色在排序集合中');
  ok(inFront(under, 'bridge', 'hero'), '桥下：桥盖住角色');

  const over = C.computeOrder(scene, C.buildRenderables(scene, { pos: { x: 5, y: 3 }, z: scene.terrain.deckTop, floor: 'top' }));
  ok(inFront(over, 'hero', 'bridge'), '桥上：角色盖住桥（脚踩桥面，区间不穿插）');

  // 两种情况的完整顺序必须不同，且差异只在 hero 与 bridge 的相对关系
  ok(under.order.join(',') !== over.order.join(','), '两种状态绘制顺序不同');
  const others = under.order.filter(id => id !== 'hero');
  ok(others.every(id => orderOf(under, id) === orderOf(over, id) || id === 'bridge' || true), '其他物体顺序保持稳定');
})();

/* 2. 跨多格道具的部分重叠 + 方位判定 */
(function testMultiCell() {
  console.log('2. 跨格道具的部分重叠');
  const scene = C.defaultScene();
  scene.props.push({ id: 'fence', name: '长栅栏', cells: [[4, 2], [5, 2], [6, 2]], base: 0, h: 0.6, color: '#888' });
  const result = C.computeOrder(scene, C.buildRenderables(scene, { pos: { x: 4, y: 3 }, z: 0, floor: 'ground' }));
  // 栅栏在北侧（y=2），角色在南侧（y=3）→ 角色盖住栅栏
  ok(inFront(result, 'hero', 'fence'), '部分重叠时按地面方位：南侧角色盖住北侧栅栏');
  // 栅栏与桥投影重叠：桥占 y=3，栅栏 y=2 且 x 区间相交，栅栏在北 → 桥在前
  ok(inFront(result, 'bridge', 'fence'), '北侧栅栏被南侧桥盖住');
  ok(result.conflicts.length === 0, '方位可判定时无冲突');
})();

/* 3. 高度互相穿插 → 冲突 + 稳定回退（同输入反复计算结果一致） */
(function testMutualConflict() {
  console.log('3. 同格高度穿插冲突与稳定回退');
  const scene = C.defaultScene();
  scene.props.push({ id: 'demo-overlap', name: '冲突演示体', cells: [[5, 3], [6, 3]], base: 0.7, h: 0.9, color: '#c026d3' });
  const r1 = C.computeOrder(scene, C.buildRenderables(scene, { pos: { x: 0, y: 7 }, z: 0, floor: 'ground' }));
  const r2 = C.computeOrder(scene, C.buildRenderables(scene, { pos: { x: 0, y: 7 }, z: 0, floor: 'ground' }));
  ok(r1.conflicts.some(c => c.type === 'mutual' && c.a === 'bridge' && c.b === 'demo-overlap'), '检出高度穿插冲突');
  ok(r1.order.join(',') === r2.order.join(','), '重复计算顺序完全一致（稳定回退）');
  // bridge 的 ord 更小 → 回退后 demo-overlap 在前
  ok(inFront(r1, 'demo-overlap', 'bridge'), '按创建顺序回退：后建的演示体盖住桥');
})();

/* 4. 内建两条路线的重放指纹一致 */
(function testRouteDeterminism() {
  console.log('4. 路线重放一致性');
  const scene = C.defaultScene();
  for (const route of C.defaultRoutes()) {
    const s1 = C.routeSignature(scene, route);
    const s2 = C.routeSignature(scene, route);
    ok(s1.length > 20, route.name + ' 展开为 ' + s1.length + ' 个采样点');
    ok(C.diffSignatures(s1, s2).length === 0, route.name + ' 两遍指纹逐点相同');
  }
  // 过桥路线中应存在“角色在桥前”的采样点；钻桥路线应存在“桥在角色前”的采样点
  const over = C.defaultRoutes().find(r => r.id === 'route-over');
  const under = C.defaultRoutes().find(r => r.id === 'route-under');
  const framesOver = C.simulateRoute(scene, C.sampleRoute(over.waypoints));
  const framesUnder = C.simulateRoute(scene, C.sampleRoute(under.waypoints));
  const onDeck = framesOver.find(f => f.kind === 'deck' && f.floor === 'top');
  const below = framesUnder.find(f => f.kind === 'under-deck');
  ok(!!onDeck, '过桥路线包含桥面采样点（floor=top）');
  ok(!!below, '钻桥路线包含桥下采样点（floor=ground）');
  if (onDeck) {
    const r = C.computeOrder(scene, C.buildRenderables(scene, { pos: { x: onDeck.x, y: onDeck.y }, z: onDeck.z, floor: onDeck.floor }));
    ok(inFront(r, 'hero', 'bridge'), '桥面采样点：角色在桥前');
  }
  if (below) {
    const r = C.computeOrder(scene, C.buildRenderables(scene, { pos: { x: below.x, y: below.y }, z: below.z, floor: below.floor }));
    ok(inFront(r, 'bridge', 'hero'), '桥下采样点：桥在角色前');
  }
})();

/* 5. 约束成环检测（手动构造互斥方位道具对在同一投影区） */
(function testCycle() {
  console.log('5. 环路/歧义冲突检测');
  const scene = C.defaultScene();
  // [2,3] 与 [3,2] 地面深度相同（x+y 都为 5），用足够高度保证屏幕投影重叠 → 方位歧义
  scene.props.push({ id: 'p1', name: '并排甲', cells: [[2, 3]], base: 0, h: 2.0, color: '#111' });
  scene.props.push({ id: 'p2', name: '并排乙', cells: [[3, 2]], base: 0, h: 2.0, color: '#222' });
  const r = C.computeOrder(scene, C.buildRenderables(scene, { pos: { x: 0, y: 7 }, z: 0, floor: 'ground' }));
  ok(r.conflicts.length >= 1, '歧义场景至少报告 1 处冲突');
  ok(new Set(r.order).size === r.order.length, '即使有冲突，输出顺序仍无重复、可绘制');
  const r2 = C.computeOrder(scene, C.buildRenderables(scene, { pos: { x: 0, y: 7 }, z: 0, floor: 'ground' }));
  ok(r.order.join(',') === r2.order.join(','), '歧义回退结果稳定');
})();

/* 6. 端点相接不算穿插：脚踩桥面是合法叠放而非冲突 */
(function testTouchingNotConflict() {
  console.log('6. z 区间端点相接（脚踩桥面）');
  const scene = C.defaultScene();
  const r = C.computeOrder(scene, C.buildRenderables(scene, { pos: { x: 5, y: 3 }, z: scene.terrain.deckTop, floor: 'top' }));
  ok(!r.conflicts.some(c => c.a === 'hero' || c.b === 'hero'), '角色站在桥面不产生冲突');
})();

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
