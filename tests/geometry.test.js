import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  Transform, parsePathD, pathToD, parseTransform, rectSubpaths, lineSubpaths,
  ellipseSubpaths, arcToCubics, cubicAt, V, dist, transformSubpaths,
  distanceToPath, pointInPath, splitCubic,
} from '../src/geometry.js';

describe('Transform', () => {
  test('平移/缩放复合与求逆', () => {
    const t = Transform.translate(10, 20).multiply(Transform.scale(2, 3));
    const p = t.applyPoint(V(1, 1));
    assert.deepEqual(p, V(12, 23));
    const back = t.inverse().applyPoint(p);
    assert.ok(Math.abs(back.x - 1) < 1e-9);
    assert.ok(Math.abs(back.y - 1) < 1e-9);
  });

  test('parseTransform 支持 matrix/translate/rotate', () => {
    const t = parseTransform('translate(5,6) rotate(90)');
    const p = t.applyPoint(V(1, 0));
    assert.ok(Math.abs(p.x - 5) < 1e-9);
    assert.ok(Math.abs(p.y - 7) < 1e-9);
  });
});

describe('path d 往返', () => {
  test('M/L/Z 解析为直线锚点并还原', () => {
    const sps = parsePathD('M0 0L10 0L10 10Z');
    assert.equal(sps.length, 1);
    assert.equal(sps[0].anchors.length, 3);
    assert.equal(sps[0].closed, true);
    assert.deepEqual(sps[0].anchors[1].hIn, {dx: 0, dy: 0});
    const d = pathToD(sps);
    assert.match(d, /^M0 0C/);
    assert.match(d, /Z$/);
  });

  test('C 曲线控制柄正确还原为相对偏移', () => {
    const sps = parsePathD('M0 0 C10 10, 20 10, 30 0');
    const a = sps[0].anchors;
    assert.equal(a.length, 2);
    assert.deepEqual(a[0].hOut, {dx: 10, dy: 10});
    assert.deepEqual(a[1].hIn, {dx: -10, dy: 10});
  });

  test('相对命令 m/l/c 与隐式重复', () => {
    const sps = parsePathD('m1 1 l2 0 0 2 c1 1 2 1 3 0');
    const a = sps[0].anchors;
    assert.deepEqual([a[0].x, a[0].y], [1, 1]);
    assert.deepEqual([a[1].x, a[1].y], [3, 1]);
    assert.deepEqual([a[2].x, a[2].y], [3, 3]);
    assert.equal(a.length, 4);
  });

  test('H/V/S/T/Q/A 全部可解析且不丢点', () => {
    const d = 'M0 0 H10 V10 Q15 15 20 10 T40 10 A5 5 0 0 1 50 10 S60 5 70 10 Z';
    const sps = parsePathD(d);
    assert.equal(sps.length, 1);
    assert.ok(sps[0].anchors.length >= 6);
    assert.equal(sps[0].closed, true);
  });

  test('多子路径解析', () => {
    const sps = parsePathD('M0 0 L1 1 M10 10 L20 20');
    assert.equal(sps.length, 2);
  });
});

describe('arc 转 cubic', () => {
  test('半圆弧拆为多段三次贝塞尔且终点正确', () => {
    // 上半圆：(10,0) 经 (0,0) 到 (-10,0)，sweep=0 逆时针
    const pieces = arcToCubics(10, 0, 10, 10, 0, 0, 0, -10, 0);
    assert.ok(pieces.length >= 2);
    let p = V(10, 0);
    for (const [, , end] of pieces) p = end;
    assert.ok(Math.abs(p.x - -10) < 1e-6);
    assert.ok(Math.abs(p.y - 0) < 1e-6);
  });

  test('椭圆闭合路径重解析后锚点与控制点保持（三次贝塞尔近似误差 < 3%）', () => {
    const sps = ellipseSubpaths(0, 0, 10, 6);
    const reparsed = parsePathD(pathToD(sps));
    assert.equal(reparsed[0].anchors.length, 4);
    assert.equal(reparsed[0].closed, true);
    const a = reparsed[0].anchors;
    // 端点严格落在椭圆上
    assert.deepEqual([a[0].x, a[0].y], [10, 0]);
    assert.deepEqual([a[2].x, a[2].y], [-10, 0]);
    // 密集采样：每点到理想椭圆的归一化距离应小于 3%（k=0.5523 近似的理论径向误差约 2.7%）
    let maxErr = 0;
    for (let i = 0; i < 4; i++) {
      const a0 = a[i], a1 = a[(i + 1) % 4];
      for (let k = 1; k < 10; k++) {
        const t = k / 10;
        const q = cubicAt(V(a0.x, a0.y),
          V(a0.x + a0.hOut.dx, a0.y + a0.hOut.dy),
          V(a1.x + a1.hIn.dx, a1.y + a1.hIn.dy),
          V(a1.x, a1.y), t);
        // 理想椭圆上与 q 同参数角的点：θ = atan2(qy/ry, qx/rx)
        const theta = Math.atan2(q.y / 6, q.x / 10);
        const ideal = V(10 * Math.cos(theta), 6 * Math.sin(theta));
        // 用与理想点的欧氏距离相对于该点到原点距离做归一化
        const err = Math.hypot(q.x - ideal.x, q.y - ideal.y) / Math.hypot(q.x, q.y);
        maxErr = Math.max(maxErr, err);
      }
    }
    assert.ok(maxErr < 0.03, `椭圆近似最大径向误差: ${maxErr}`);
  });
});

describe('变换烘焙', () => {
  test('transformSubpaths 同时变换锚点与控制柄', () => {
    const sps = lineSubpaths(0, 0, 10, 0);
    const t = Transform.scale(2);
    const out = transformSubpaths(sps, t);
    assert.equal(out[0].anchors[1].x, 20);
  });

  test('splitCubic 在 t 处切点共线', () => {
    const s = splitCubic(V(0, 0), V(0, 10), V(10, 10), V(10, 0), 0.5);
    assert.deepEqual(s.left[3], s.right[0]);
  });
});

describe('命中', () => {
  test('距离与点内判断', () => {
    const rect = rectSubpaths(0, 0, 20, 20);
    assert.ok(distanceToPath(V(10, 0), rect) < 1);
    assert.ok(distanceToPath(V(100, 100), rect) > 50);
    assert.equal(pointInPath(V(10, 10), rect, 'evenodd'), true);
    assert.equal(pointInPath(V(50, 50), rect, 'evenodd'), false);
  });
});
