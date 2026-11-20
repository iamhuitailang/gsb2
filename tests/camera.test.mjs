import test from 'node:test';
import assert from 'node:assert/strict';
import { PathSpline } from '../dist/core/curve.js';
import { Timeline } from '../dist/core/timeline.js';
import {
  blendAim,
  fovFromFocal,
  orientationFromForward,
  forwardFromQuat,
  AimBlender,
} from '../dist/core/camera.js';
import { CameraFrameField } from '../dist/core/frames.js';
import { evaluateCamera, buildCameraSamples, buildExportPayload } from '../dist/core/evaluate.js';
import { normalizeProject } from '../dist/core/project.js';
import { SAMPLES } from '../dist/samples/index.js';

const P = (x, y, z) => [x, y, z];

function buildContext(project) {
  const normalized = normalizeProject(project);
  const spline = new PathSpline(normalized.path.points.map((p) => p.position), normalized.path.closed);
  const timeline = new Timeline(normalized.timeline, spline.totalLength, normalized.path.closed);
  return { project: normalized, spline, timeline };
}

function quatAngle(a, b) {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot));
}

test('orientationFromForward always produces a unit quaternion facing forward', () => {
  const dirs = [
    P(1, 0, 0), P(-1, 0.2, 0.3), P(0, 0, 1), P(0, -1, 0), P(0, 1, 0),
    P(0.2, 0.98, 0.1), P(-0.3, -0.97, 0.05), P(0, 0.9999999, 0.0001),
  ];
  for (const dir of dirs) {
    const q = orientationFromForward(dir, 0);
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    assert.ok(Math.abs(len - 1) < 1e-6, `non-unit quaternion for ${dir}`);
    const f = forwardFromQuat(q);
    const n = Math.hypot(dir[0], dir[1], dir[2]);
    const dot = (f[0] * dir[0] + f[1] * dir[1] + f[2] * dir[2]) / n;
    assert.ok(dot > 0.999, `forward mismatch for ${dir}: ${dot}`);
  }
});

test('parallel-transported frames stay continuous straight through vertical', () => {
  // A path that goes horizontally, then straight up through a vertical tangent,
  // and continues horizontally: the classic case where a world-up camera flips.
  const points = [
    P(-20, 2, 0),
    P(-4, 2, 0),
    P(0, 10, 0),
    P(4, 2, 0),
    P(20, 2, 0),
  ];
  const spline = new PathSpline(points, false);
  const field = new CameraFrameField(spline);
  let prev = null;
  let maxStep = 0;
  for (let i = 0; i <= 400; i++) {
    const q = field.quaternionAt(i / 400);
    assert.ok(q.every(Number.isFinite));
    if (prev) maxStep = Math.max(maxStep, quatAngle(q, prev));
    prev = q;
  }
  // A roll flip would register a large single-step rotation.
  assert.ok(maxStep < 0.2, `frame jumped by ${maxStep} rad near the vertical tangent`);
});

test('frame field follows the spline tangent everywhere', () => {
  const points = [P(-18, 3, 0), P(-6, 8, 10), P(6, 2, -6), P(18, 7, 4)];
  const spline = new PathSpline(points, false);
  const field = new CameraFrameField(spline);
  for (let i = 0; i <= 60; i++) {
    const s = i / 60;
    const tangent = spline.sampleAt(s).tangent;
    const forward = field.forwardAt(s);
    const dot = forward[0] * tangent[0] + forward[1] * tangent[1] + forward[2] * tangent[2];
    assert.ok(dot > 0.999, `frame forward deviates from tangent at s=${s}: ${dot}`);
  }
});

test('closed-loop frames meet seamlessly at the wrap point', () => {
  const points = [P(-8, 4, -8), P(8, 6, -8), P(10, 5, 7), P(-6, 3, 9)];
  const spline = new PathSpline(points, true);
  const field = new CameraFrameField(spline);
  const start = field.quaternionAt(0);
  const end = field.quaternionAt(1);
  const wrapGap = quatAngle(start, end);
  assert.ok(wrapGap < 1e-4, `closed loop frame seam of ${wrapGap} rad`);
  // And approaching the seam is continuous from the inside.
  const nearEnd = field.quaternionAt(1 - 1e-4);
  assert.ok(quatAngle(nearEnd, start) < 1e-2, 'frame discontinuity just before the seam');
});

test('tangent-to-target mode switch never flips: slerp path is continuous', () => {
  const position = P(0, 4, 0);
  const tangent = P(1, 0.05, 0.1);
  const target = P(12, 6, 4);
  let prev = null;
  let maxStep = 0;
  for (let i = 0; i <= 100; i++) {
    const mix = i / 100;
    const frame = blendAim({ position, tangent, targetPosition: target, rollDeg: 0 }, mix);
    if (prev) maxStep = Math.max(maxStep, quatAngle(frame.quaternion, prev));
    prev = frame.quaternion;
  }
  assert.ok(maxStep < 0.2, `aim blend jumped by ${maxStep} rad`);
});

test('aim blending reaches both endpoints', () => {
  const position = P(0, 3, 0);
  const tangent = P(1, 0, 0);
  const target = P(0, 3, 10);
  const atTangent = blendAim({ position, tangent, targetPosition: target, rollDeg: 0 }, 0);
  const atTarget = blendAim({ position, tangent, targetPosition: target, rollDeg: 0 }, 1);
  const forwardT = forwardFromQuat(atTangent.quaternion);
  const forwardG = forwardFromQuat(atTarget.quaternion);
  assert.ok(forwardT[0] > 0.999, 'tangent endpoint should look along +X');
  assert.ok(forwardG[2] > 0.999, 'target endpoint should look along +Z');
});

test('fov conversion matches sensor geometry', () => {
  const { fovY, fovX } = fovFromFocal(50, 24, 16 / 9);
  const expectedY = 2 * Math.atan(24 / 100);
  assert.ok(Math.abs(fovY - expectedY) < 1e-9);
  assert.ok(fovX > fovY, 'horizontal fov must exceed vertical for a wide frame');
});

test('AimBlender animates and settles deterministically', () => {
  const blender = new AimBlender();
  blender.snapToMode('tangent');
  assert.equal(blender.mix, 0);
  blender.setMode('target', 0, true);
  assert.equal(blender.update(0.2) > 0, true);
  blender.update(10);
  assert.equal(blender.mix, 1);
  blender.setMode('tangent', 10, true);
  blender.update(20);
  assert.equal(blender.mix, 0);
  assert.equal(blender.isAnimating, false);
});

test('camera evaluation is deterministic for scrubbing (position + rotation)', () => {
  const project = normalizeProject(SAMPLES[0].build());
  const ctx = buildContext(project);
  const times = [0, 0.6, 1.4, 2.9, 4.2, 6.0, ctx.timeline.duration];
  for (const t of times) {
    const a = evaluateCamera(ctx, t, { aimMix: 0 });
    const b = evaluateCamera(ctx, t, { aimMix: 0 });
    assert.deepEqual(a.position, b.position);
    assert.deepEqual(a.rotation, b.rotation);
  }
  // Re-evaluating after visiting other times yields identical results.
  const first = evaluateCamera(ctx, 2.2, { aimMix: 0 });
  evaluateCamera(ctx, 5.5, { aimMix: 0 });
  evaluateCamera(ctx, 0.1, { aimMix: 1 });
  const again = evaluateCamera(ctx, 2.2, { aimMix: 0 });
  assert.deepEqual(first, again);
});

test('tracking sample keeps the moving target framed', () => {
  const project = SAMPLES.find((s) => s.id === 'tracking-loop').build();
  const ctx = buildContext(project);
  for (let i = 0; i <= 24; i++) {
    const t = (i / 24) * ctx.timeline.duration;
    const ev = evaluateCamera(ctx, t, { aimMix: 1 });
    assert.ok(ev.target, 'target must be resolvable');
    const forward = forwardFromQuat(ev.rotation);
    const tx = ev.target[0] - ev.position[0];
    const ty = ev.target[1] - ev.position[1];
    const tz = ev.target[2] - ev.position[2];
    const len = Math.hypot(tx, ty, tz);
    const dot = (forward[0] * tx + forward[1] * ty + forward[2] * tz) / len;
    assert.ok(dot > 0.99, `camera not looking at target at t=${t}: dot=${dot}`);
  }
});

test('export payload is frame-indexed and complete', () => {
  const project = normalizeProject(SAMPLES[0].build());
  const ctx = buildContext(project);
  const payload = buildExportPayload(ctx);
  assert.equal(payload.format, 'camera-path-samples');
  assert.equal(payload.fps, project.timeline.fps);
  assert.ok(payload.samples.length > 10);
  assert.equal(payload.samples[0].frame, 0);
  payload.samples.forEach((s, i) => {
    assert.equal(s.frame, i);
    assert.ok(s.position.every(Number.isFinite));
    assert.ok(s.rotation.every(Number.isFinite));
    const len = Math.hypot(...s.rotation);
    assert.ok(Math.abs(len - 1) < 1e-4, `quaternion not normalized at frame ${i}`);
  });
  const last = payload.samples[payload.samples.length - 1];
  assert.ok(Math.abs(last.t - ctx.timeline.duration) < 1 / payload.fps + 1e-6);
});

test('all shipped samples evaluate cleanly and have holds + direction changes', () => {
  for (const sample of SAMPLES) {
    const project = sample.build();
    const ctx = buildContext(project);
    assert.ok(ctx.timeline.duration > 2, `${sample.id} too short`);
    assert.ok(ctx.spline.totalLength > 20, `${sample.id} path too short`);
    const holds = project.timeline.keys.filter((k) => k.hold > 0);
    assert.ok(holds.length > 0, `${sample.id} has no dwell keys`);
    // Sample poses and check for finite, continuous motion.
    let prev = null;
    for (let i = 0; i <= 120; i++) {
      const ev = evaluateCamera(ctx, (i / 120) * ctx.timeline.duration, { aimMix: 0 });
      assert.ok(ev.position.every(Number.isFinite));
      assert.ok(ev.rotation.every(Number.isFinite));
      if (prev) {
        const step = Math.hypot(
          ev.position[0] - prev[0],
          ev.position[1] - prev[1],
          ev.position[2] - prev[2],
        );
        assert.ok(step < 12, `${sample.id} position jump ${step}`);
      }
      prev = ev.position;
    }
  }
});

test('normalizeProject rejects malformed data and fills defaults', () => {
  assert.throws(() => normalizeProject(null));
  assert.throws(() => normalizeProject({ path: { points: [] } }));
  const project = normalizeProject({
    path: { closed: false, points: [{ position: [0, 1, 0] }, { position: [5, 1, 0] }] },
  });
  assert.equal(project.timeline.fps, 30);
  assert.equal(project.camera.focalLengthMm, 35);
  assert.equal(project.camera.aim.mode, 'tangent');
  assert.equal(project.timeline.keys.length, 1);
  assert.ok(project.composition.aspect > 1.7);
});

test('saving and reopening a project preserves evaluated poses', () => {
  const project = SAMPLES[1].build();
  const before = buildContext(project);
  const roundTrip = normalizeProject(JSON.parse(JSON.stringify(project)));
  const after = buildContext(roundTrip);
  assert.ok(Math.abs(before.spline.totalLength - after.spline.totalLength) < 1e-9);
  assert.ok(Math.abs(before.timeline.duration - after.timeline.duration) < 1e-9);
  for (let i = 0; i <= 20; i++) {
    const t = (i / 20) * before.timeline.duration;
    const a = evaluateCamera(before, t, { aimMix: 0 });
    const b = evaluateCamera(after, t, { aimMix: 0 });
    assert.deepEqual(a.position, b.position);
    assert.deepEqual(a.rotation, b.rotation);
  }
});

test('camera samples are stable between repeated exports', () => {
  const ctx = buildContext(SAMPLES[2].build());
  const a = buildCameraSamples(ctx);
  const b = buildCameraSamples(ctx);
  assert.deepEqual(a, b);
});

