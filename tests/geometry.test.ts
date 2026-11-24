import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMesh, effectiveFrame } from '../src/core/geometry.ts';
import { type Vec2, type Vec3, v3 } from '../src/core/math.ts';
import { generateTexture, sampleRaw, rawToTangentVector, applyConvention } from '../src/core/textures.ts';
import { shadePoint, buildWorldMesh, type WorldFace } from '../src/core/world.ts';
import { defaultState } from '../src/core/state.ts';
import { buildSeamReport } from '../src/core/report.ts';
import { computeFaceFrame, type FaceFrame } from '../src/core/tangent.ts';

test('正确预设：两半各 8 个面，镜像半为左手系', () => {
  const mesh = buildMesh('correct');
  assert.equal(mesh.faces.length, 16);
  const left = mesh.faces.filter((f) => f.half === 'normalUV');
  const right = mesh.faces.filter((f) => f.half === 'mirrorUV');
  assert.equal(left.length, 8);
  assert.equal(right.length, 8);
  assert.ok(left.every((f) => effectiveFrame(f).handedness === 1));
  assert.ok(right.every((f) => effectiveFrame(f).handedness === -1));
});

test('镜像接缝存在且两侧面分属不同半区', () => {
  const mesh = buildMesh('correct');
  const seam = mesh.edges.find((e) => e.kind === 'mirror');
  assert.ok(seam);
  const halves = new Set(seam!.faceIds.map((id) => mesh.faces[id].half));
  assert.equal(halves.size, 2);
});

test('折痕硬边数量：每半 3 条内部折痕', () => {
  const mesh = buildMesh('correct');
  const folds = mesh.edges.filter((e) => e.kind === 'fold');
  assert.equal(folds.length, 6);
});

test('重合空间顶点带着不同贴图方向（接缝拆点）', () => {
  const mesh = buildMesh('correct');
  const conflicts = mesh.coincident.filter((g) => g.directionConflict);
  assert.ok(conflicts.length >= 2, '中心缝上下端点都应方向冲突');
});

test('刻意设错预设：镜像半 B 被翻向，与正确预设符号相反', () => {
  const good = buildMesh('correct');
  const bad = buildMesh('broken-seam');
  const goodFace = good.faces.find((f) => f.half === 'mirrorUV')!;
  const badFace = bad.faces.find((f) => f.half === 'mirrorUV')!;
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(effectiveFrame(badFace).B[i] + effectiveFrame(goodFace).B[i]) < 1e-9 ||
        Math.abs(effectiveFrame(badFace).B[i]) < 1e-9,
    );
  }
});

test('同一盏灯下，B 翻向的切线基让同一张图的高光明显翻转（受控平面）', () => {
  // 用几何完全相同的平面三角形，仅切线基的 B 相反，隔离出“贴图方向”这一个变量。
  const p: [Vec3, Vec3, Vec3] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ];
  const uv: [Vec2, Vec2, Vec2] = [
    [0, 0],
    [1, 0],
    [0, 1],
  ];
  const good = computeFaceFrame(0, 'normalUV', 0, p, uv);
  const broken: FaceFrame = { ...good, B: v3.neg(good.B), handedness: -1 };
  const toWorldFace = (frame: FaceFrame): WorldFace => ({
    id: 0,
    half: 'normalUV',
    panelId: 0,
    positions: p,
    uvs: uv,
    frame: { T: frame.T, B: frame.B, N: frame.N, handedness: frame.handedness },
    source: frame,
    valid: true,
  });
  const tex = generateTexture('directional');
  const yaw = (80 * Math.PI) / 180;
  const pitch = (35 * Math.PI) / 180;
  const light: Vec3 = v3.normalize([
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  ]);
  const sampleUV: Vec2 = [0.8, 0.15];
  const sGood = shadePoint({
    face: toWorldFace(good),
    uv: sampleUV,
    texture: tex,
    convention: 'opengl',
    lightDir: light,
    viewDir: [0, 0, 1],
    diffuse: 0.85,
    specular: 0.6,
    shininess: 24,
  });
  const sBroken = shadePoint({
    face: toWorldFace(broken),
    uv: sampleUV,
    texture: tex,
    convention: 'opengl',
    lightDir: light,
    viewDir: [0, 0, 1],
    diffuse: 0.85,
    specular: 0.6,
    shininess: 24,
  });
  // 同一像素、同一盏灯：正确基几乎无高光，翻 B 后出现明显高光 —— 亮边翻暗边。
  assert.ok(sGood.spec < 0.02, `good spec ${sGood.spec}`);
  assert.ok(sBroken.spec > 0.1, `broken spec ${sBroken.spec}`);
});

test('退化预设：存在无效面且报告中列出', () => {
  const state = defaultState();
  state.preset = 'degenerate';
  const mesh = buildMesh('degenerate');
  const world = buildWorldMesh(mesh, state.model);
  const tex = generateTexture('flat');
  const invalid = mesh.faces.filter((f) => !effectiveFrame(f).valid);
  assert.equal(invalid.length, 1);
  const report = buildSeamReport(mesh, world, tex, state);
  assert.ok(report);
  assert.ok(report!.notes.some((n) => n.includes('无法决定')));
});

test('平法线纹理：中心纹素为 (128,128,255)', () => {
  const tex = generateTexture('flat', 64);
  const rgba = sampleRaw(tex, 0.5, 0.5);
  assert.deepEqual([rgba[0], rgba[1], rgba[2]], [128, 128, 255]);
});

test('绿通道约定切换只翻 Y，且不改动原始字节', () => {
  const tex = generateTexture('directional', 32);
  const raw = sampleRaw(tex, 0.3, 0.7);
  const gl = applyConvention(rawToTangentVector(raw), 'opengl');
  const dx = applyConvention(rawToTangentVector(raw), 'directx');
  assert.equal(gl[0], dx[0]);
  assert.equal(gl[1], -dx[1]);
  assert.equal(gl[2], dx[2]);
  // 原始字节不变
  const raw2 = sampleRaw(tex, 0.3, 0.7);
  assert.deepEqual(raw, raw2);
});

test('定向纹理不是平法线：存在明显 X/Y 扰动', () => {
  const tex = generateTexture('directional', 64);
  let perturbed = 0;
  for (let i = 0; i < 200; i++) {
    const u = ((i * 37) % 64) / 64;
    const v = ((i * 53) % 64) / 64;
    const [r, g] = sampleRaw(tex, u, v);
    if (Math.abs(r - 128) > 4 || Math.abs(g - 128) > 4) perturbed++;
  }
  assert.ok(perturbed > 50);
});

test('报告同时记录两侧贴图方向与着色数值', () => {
  const state = defaultState();
  const mesh = buildMesh('correct');
  const world = buildWorldMesh(mesh, state.model);
  const tex = generateTexture('directional');
  const report = buildSeamReport(mesh, world, tex, state);
  assert.equal(report!.sides.length, 2);
  for (const s of report!.sides) {
    assert.ok(v3.len(s.T) > 0.99 && v3.len(s.B) > 0.99);
    assert.ok(typeof s.shading.lambert === 'number');
    assert.ok(typeof s.shading.spec === 'number');
  }
});
