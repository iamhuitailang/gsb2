// 纯逻辑测试:确定性时钟、PRNG/抖动序列、场景可复现性、矩阵与重开规则。
// 不触碰 WebGL,直接用 node 运行。
import assert from 'node:assert/strict';
import { mulberry32, hashSeed, frameJitter } from '../js/prng.js';
import { FrameClock, FIXED_DT, MAX_FRAME } from '../js/clock.js';
import { createScene, JUMP_FRAME } from '../js/scene.js';
import { mat4Multiply, mat4Perspective, mat4LookAt, pingPong, smoothstep } from '../js/math.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('PRNG / 抖动');
test('同种子序列一致,不同种子不同', () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(7);
  const sa = Array.from({ length: 100 }, a);
  assert.deepEqual(sa, Array.from({ length: 100 }, b));
  assert.notDeepEqual(sa, Array.from({ length: 100 }, c));
});
test('字符串 seed 哈希稳定', () => {
  assert.equal(hashSeed('fence-0001'), hashSeed('fence-0001'));
  assert.notEqual(hashSeed('a'), hashSeed('b'));
});
test('Halton 抖动范围与重置归零', () => {
  const j0 = frameJitter(0);
  assert.ok(Math.abs(j0.x) <= 1e-8 && Math.abs(j0.y) <= 1e-8, 'index 0 必须为零偏移');
  for (let i = 0; i < 256; i++) {
    const j = frameJitter(i);
    assert.ok(j.x >= -1 && j.x <= 1 && j.y >= -1 && j.y <= 1);
  }
  assert.deepEqual(frameJitter(17), frameJitter(17));
});

console.log('确定性时钟');
test('t = N * FIXED_DT,与调度频率无关', () => {
  const c = new FrameClock();
  assert.equal(c.frame, 0);
  for (let i = 1; i <= 10; i++) c.advance('manual');
  assert.equal(c.frame, 10);
  // 再建一个时钟直接 seek 到同帧号,场景侧时间必须相同
  const c2 = new FrameClock();
  c2.seek(10);
  assert.equal(c.frame * FIXED_DT, c2.frame * FIXED_DT);
});
test('镜头末尾回绕到 0', () => {
  const c = new FrameClock();
  c.seek(MAX_FRAME);
  const r = c.advance('manual');
  assert.equal(c.frame, 0);
  assert.equal(r.wrapped, true);
});
test('stepBack 不越过 0', () => {
  const c = new FrameClock();
  c.stepBack(); c.stepBack();
  assert.equal(c.frame, 0);
});

console.log('场景可复现性');
test('同 seed 同帧号场景状态逐位一致', () => {
  const s1 = createScene('fence-0001');
  const s2 = createScene('fence-0001');
  for (const f of [0, 1, 50, JUMP_FRAME, JUMP_FRAME + 1, 600]) {
    const a = s1.evaluate(f), b = s2.evaluate(f);
    assert.deepEqual(Array.from(a.models.fenceA), Array.from(b.models.fenceA));
    assert.deepEqual(Array.from(a.camera.view), Array.from(b.camera.view));
    assert.equal(a.occluder.coverK, b.occluder.coverK);
  }
});
test('不同 seed 产生不同路径参数', () => {
  const a = createScene('alpha'), b = createScene('beta');
  assert.notDeepEqual(a.params, b.params);
});
test('相机仅在 JUMP_FRAME 触发瞬移标记', () => {
  const s = createScene('fence-0001');
  assert.equal(s.evaluate(JUMP_FRAME - 1).camera.jump, false);
  assert.equal(s.evaluate(JUMP_FRAME).camera.jump, true);
  assert.equal(s.evaluate(JUMP_FRAME + 1).camera.jump, false);
});
test('遮挡物滑入滑出:显露帧之后 coverK 回落', () => {
  const s = createScene('fence-0001');
  const mid = s.evaluate(150).occluder.coverK;
  const after = s.evaluate(260).occluder.coverK;
  assert.ok(mid > 0.99, '停留期应完全盖住');
  assert.ok(after < 0.02, '滑出后应离开画面');
});
test('栅栏 B 速度与栅栏 A 不同(周期不同)', () => {
  const s = createScene('fence-0001');
  const dxA = Math.abs(s.evaluate(20).models.fenceA[12] - s.evaluate(21).models.fenceA[12]);
  const dxB = Math.abs(s.evaluate(20).models.fenceB[12] - s.evaluate(21).models.fenceB[12]);
  assert.ok(Math.abs(dxA - dxB) > 1e-6);
});
test('手动瞬移在 seek 重放中保持同一断点', () => {
  const s = createScene('fence-0001');
  const mj = { frame: 120, offset: 0.7 };
  // 同样的 evaluate 调用两次(模拟重放),断点两侧差值恒定
  const before = s.evaluate(119, mj).camera.eye[0];
  const at = s.evaluate(120, mj).camera.eye[0];
  const before2 = s.evaluate(119, mj).camera.eye[0];
  const at2 = s.evaluate(120, mj).camera.eye[0];
  assert.ok(Math.abs((at - before) - (at2 - before2)) < 1e-12, '重放差值必须一致');
  assert.ok(Math.abs((at - before) - (s.evaluate(120).camera.eye[0] - s.evaluate(119).camera.eye[0]) - 0.7) < 1e-6);
});

console.log('数学工具');
test('透视投影包含 jitter 平移项', () => {
  const j = mat4Perspective(1, 1, 0.1, 10, 0.25, -0.5);
  assert.ok(Math.abs(j[12] - 0.25) < 1e-9);
  assert.ok(Math.abs(j[13] + 0.5) < 1e-9);
});
test('lookAt 与 VP 乘法稳定可复现', () => {
  const vp1 = mat4Multiply(mat4Perspective(0.8, 1.5, 0.1, 20), mat4LookAt([0, 0, 2.1], [0, 0, 0]));
  const vp2 = mat4Multiply(mat4Perspective(0.8, 1.5, 0.1, 20), mat4LookAt([0, 0, 2.1], [0, 0, 0]));
  assert.deepEqual(Array.from(vp1), Array.from(vp2));
});
test('pingPong 边界与往复', () => {
  assert.ok(Math.abs(pingPong(0, 10, -1, 1) + 1) < 1e-9);
  assert.ok(Math.abs(pingPong(5, 10, -1, 1) - 1) < 1e-9);
  assert.ok(Math.abs(pingPong(10, 10, -1, 1) + 1) < 1e-9);
});
test('smoothstep 单调且钳制', () => {
  assert.equal(smoothstep(0, 1, -2), 0);
  assert.equal(smoothstep(0, 1, 2), 1);
  assert.ok(smoothstep(0, 1, 0.6) > smoothstep(0, 1, 0.4));
});

console.log(`\n${passed} 项通过`);
if (process.exitCode) console.error('存在失败项');
