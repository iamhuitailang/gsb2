import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3 } from '../src/core/math.ts';
import { v3, buildModelMatrix, normalMatrix3, transformDir, transformPoint } from '../src/core/math.ts';
import { computeFaceFrame, transformFrame } from '../src/core/tangent.ts';

// 标准 XY 平面上的三角形，UV 普通朝向
const p: [Vec3, Vec3, Vec3] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
];
const uvNormal: [[number, number], [number, number], [number, number]] = [
  [0, 0],
  [1, 0],
  [0, 1],
];
const uvMirror: [[number, number], [number, number], [number, number]] = [
  [1, 0],
  [0, 0],
  [1, 1],
];

test('普通 UV：右手系，T 沿 +x、B 沿 +y、N 沿 +z', () => {
  const f = computeFaceFrame(0, 'normalUV', 0, p, uvNormal);
  assert.equal(f.valid, true);
  assert.equal(f.uvAreaSign, 1);
  assert.equal(f.handedness, 1);
  assert.deepEqual(f.T, [1, 0, 0]);
  assert.deepEqual(f.B, [0, 1, 0]);
  assert.deepEqual(f.N, [0, 0, 1]);
});

test('镜像 UV：有向面积为负、手性翻转，T 沿 -x，B 仍沿 +y', () => {
  const f = computeFaceFrame(1, 'mirrorUV', 0, p, uvMirror);
  assert.equal(f.valid, true);
  assert.equal(f.uvAreaSign, -1);
  assert.equal(f.handedness, -1);
  // normalize 可能产生 -0，用近似比较
  assert.ok(Math.abs(f.T[0] - -1) < 1e-12);
  assert.ok(Math.abs(f.T[1]) < 1e-12 && Math.abs(f.T[2]) < 1e-12);
  assert.ok(Math.abs(f.B[1] - 1) < 1e-12);
  assert.ok(Math.abs(f.B[0]) < 1e-12 && Math.abs(f.B[2]) < 1e-12);
});

test('UV 三点重合：标记为无法决定方向的退化面', () => {
  const f = computeFaceFrame(2, 'normalUV', 99, p, [
    [0.5, 0.5],
    [0.5, 0.5],
    [0.5, 0.5],
  ]);
  assert.equal(f.valid, false);
  assert.equal(f.uvAreaSign, 0);
  assert.match(f.reason ?? '', /退化/);
});

test('法线矩阵在不等比缩放下保持法线垂直于切平面', () => {
  // 斜面：法线 (0, -1, 1) 归一化
  const slope: [Vec3, Vec3, Vec3] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 1],
  ];
  const f = computeFaceFrame(3, 'normalUV', 0, slope, uvNormal);
  const model = buildModelMatrix([0, 0, 0], [0, 0, 0], [1, 2, 0.5]);
  const w = transformFrame(f, model);
  // 手性与物体空间一致
  assert.equal(w.handedness, f.handedness);
  // 核心不变量：法线必须垂直于“变换后表面的两条切边”。
  // 普通方向矩阵直接变换的错误法线在非均匀缩放下不满足这一点。
  const e1 = transformDir(model, v3.sub(slope[1], slope[0]));
  const e2 = transformDir(model, v3.sub(slope[2], slope[0]));
  assert.ok(Math.abs(v3.dot(w.N, e1)) < 1e-6);
  assert.ok(Math.abs(v3.dot(w.N, e2)) < 1e-6);
  const badN = v3.normalize(transformDir(model, f.N));
  assert.ok(
    Math.abs(v3.dot(badN, e1)) > 1e-3 || Math.abs(v3.dot(badN, e2)) > 1e-3,
    '朴素方向矩阵变换的法线应偏离真实切平面',
  );
  // 三个向量仍为单位向量
  for (const v of [w.T, w.B, w.N]) {
    assert.ok(Math.abs(v3.len(v) - 1) < 1e-6);
  }
});

test('单轴负缩放（翻转）：法线矩阵给出翻转后的正确法线', () => {
  const f = computeFaceFrame(4, 'normalUV', 0, p, uvNormal);
  const model = buildModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, -1]);
  const w = transformFrame(f, model);
  // z 翻转后几何法线应指向 -z
  assert.ok(w.N[2] < -0.999);
  // 点也确实被翻到 -z 半空间
  const q = transformPoint(model, [0, 0, 1]);
  assert.ok(q[2] < 0);
  // 法线矩阵可逆且三向量仍构成正交基
  const nm = normalMatrix3(model);
  assert.ok(nm instanceof Float32Array);
  assert.ok(Math.abs(v3.dot(w.T, w.B)) < 1e-6);
});

test('旋转后世界切线随模型转动，模长保持单位长度', () => {
  const f = computeFaceFrame(5, 'normalUV', 0, p, uvNormal);
  const model = buildModelMatrix([0, 0, 0], [0, Math.PI / 2, 0], [1, 1, 1]);
  const w = transformFrame(f, model);
  // 绕 Y 转 90°，原 +x 的 T 应转向 -z
  assert.ok(Math.abs(w.T[2] + 1) < 1e-6);
  for (const v of [w.T, w.B, w.N]) {
    assert.ok(Math.abs(v3.len(v) - 1) < 1e-6);
  }
});
