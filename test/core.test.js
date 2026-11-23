'use strict';
/*
 * test/core.test.js — 零依赖的自动化测试（node test/core.test.js）
 *
 * 覆盖：
 *   1) 面基向量 r×u=n、6 个面朝向自洽
 *   2) 12 条邻接边、端点与角点对应
 *   3) makeSampler / invertSampler 严格互逆
 *   4) 经纬投影 ⇄ 方向向量往返
 *   5) 十字展开图物理相邻与横带首尾一致
 *   6) 渲染→接缝比较：正确朝向全部对齐；故意转错一面能被判为“只需转向”，修正后恢复
 *   7) 经纬图往返：六面 → 经纬 → 六面，误差在容差内
 *   8) 缺面/尺寸诊断点名具体面
 */
const assert = require('assert');
const C = require('../src/cube.js');
const Samples = require('../src/samples.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('  ✓ ' + name + '\n');
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write('  ✗ ' + name + '\n      ' + err.message + '\n');
  }
}
function group(name) {
  process.stdout.write('\n' + name + '\n');
}
function approx(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= (eps == null ? 1e-9 : eps), (msg || '') + ' expected ' + a + ' ≈ ' + b);
}

// 用纯色面构造纹理
function solidTex(r, g, b, size) {
  const n = size || 64;
  const data = new Uint8ClampedArray(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width: n, height: n };
}

// 用“世界方向 → 颜色”构造跨面连续的纹理
function dirTex(faceId, size) {
  const n = size || 64;
  const data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    const v = 1 - (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const P = C.facePoint3(faceId, u, v);
      const cx = Math.round((P[0] * 0.5 + 0.5) * 255);
      const cy = Math.round((P[1] * 0.5 + 0.5) * 255);
      const cz = Math.round((P[2] * 0.5 + 0.5) * 255);
      const i = (y * n + x) * 4;
      data[i] = cx;
      data[i + 1] = cy;
      data[i + 2] = cz;
      data[i + 3] = 255;
    }
  }
  return { data, width: n, height: n };
}

function makeContinuousFaces(size) {
  const faces = {};
  for (const f of C.FACES) faces[f.id] = { tex: dirTex(f.id, size || 64), rot: 0, flipH: false };
  return faces;
}

// ---------------------------------------------------------------------------
group('1. 面基向量');
for (const f of C.FACES) {
  test('面 ' + f.id + ' ' + f.name + ' 满足 r × u = n（内部视角）', () => {
    const c = C.cross(f.r, f.u);
    for (let i = 0; i < 3; i++) assert.strictEqual(c[i], f.n[i], 'axis ' + i);
  });
  test('面 ' + f.id + ' 中心点等于法线', () => {
    const P = C.facePoint3(f.id, 0.5, 0.5);
    for (let i = 0; i < 3; i++) assert.strictEqual(P[i], f.n[i]);
  });
  test('面 ' + f.id + ' 三个基向量两两正交', () => {
    assert.strictEqual(C.dot(f.n, f.r), 0);
    assert.strictEqual(C.dot(f.n, f.u), 0);
    assert.strictEqual(C.dot(f.r, f.u), 0);
  });
}

// ---------------------------------------------------------------------------
group('2. 邻接与角点');
test('恰好 12 条接缝', () => assert.strictEqual(C.SEAMS.length, 12));
test('每个面 4 个邻居', () => {
  for (const f of C.FACES) assert.deepStrictEqual(C.neighbors(f.id), C.neighbors(f.id).slice().sort((a, b) => a - b));
  for (const f of C.FACES) assert.strictEqual(C.neighbors(f.id).length, 4, 'face ' + f.id);
});
test('接缝端点 P0/P1 确实同时落在两面平面上', () => {
  for (const s of C.SEAMS) {
    for (const P of [s.P0, s.P1]) {
      const a = C.faceUVFrom3D(s.faceA, P);
      const b = C.faceUVFrom3D(s.faceB, P);
      for (const q of [a, b]) {
        approx(q.s, Math.round(q.s), 1e-9);
        approx(q.t, Math.round(q.t), 1e-9);
        assert.ok(Math.abs(q.u - 0) < 1e-9 || Math.abs(q.u - 1) < 1e-9 || Math.abs(q.v - 0) < 1e-9 || Math.abs(q.v - 1) < 1e-9);
      }
    }
  }
});
test('seamCornerInfo 给出两面的角名与原图像素', () => {
  const faces = makeContinuousFaces(64);
  const info = C.seamCornerInfo(faces, C.SEAMS[0]);
  assert.strictEqual(info.length, 2);
  for (const end of info) {
    assert.strictEqual(end.faces.length, 2);
    for (const fc of end.faces) {
      assert.ok(fc.px >= 0 && fc.px <= 64);
      assert.ok(fc.py >= 0 && fc.py <= 64);
      assert.ok(/角/.test(fc.corner));
    }
  }
});

// ---------------------------------------------------------------------------
group('3. 采样变换互逆');
for (let rot = 0; rot < 4; rot++) {
  for (const flip of [false, true]) {
    test('rot=' + rot + ' flip=' + flip + ' 采样与反演互逆', () => {
      const uv = [
        [0.1, 0.2],
        [0.8, 0.15],
        [0.25, 0.9],
        [0.5, 0.5],
        [0.0, 0.0],
        [1.0, 1.0],
      ];
      for (const [u, v] of uv) {
        const P = C.uvToSourcePixel(rot, flip, u, v, 128, 128);
        const back = C.sourcePixelToUV(rot, flip, P.x, P.y, 128, 128);
        approx(back.u, u, 1e-12, 'u');
        approx(back.v, v, 1e-12, 'v');
      }
    });
  }
}
test('rot 四次回到原位', () => {
  const p = { x: 0.3, y: 0.7 };
  let cur = { u: p.x, v: p.y };
  for (let i = 0; i < 4; i++) {
    const s = C.uvToSourcePixel(1, false, cur.u, cur.v, 1, 1);
    cur = { u: s.su, v: s.sv };
  }
  approx(cur.u, p.x, 1e-12);
  approx(cur.v, p.y, 1e-12);
});
test('水平翻转两次等于未翻转', () => {
  const p = C.uvToSourcePixel(0, true, 0.2, 0.3, 1, 1);
  const q = C.invertSampler(0, true, p.su, p.sv);
  approx(q[0], 0.2, 1e-12);
  approx(q[1], 0.3, 1e-12);
});

// ---------------------------------------------------------------------------
group('4. 经纬投影');
test('经度 0 / 纬度 0 指向 +Z', () => {
  const d = C.dirFromLonLat(0, 0);
  approx(d[0], 0, 1e-12);
  approx(d[1], 0, 1e-12);
  approx(d[2], 1, 1e-12);
});
test('方向 → 经纬 → 方向 往返', () => {
  const dirs = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0.5, 0.3, -0.8],
    [-0.2, 0.9, 0.4],
  ];
  for (const d of dirs) {
    const ll = C.lonLatFromDir(d);
    const back = C.dirFromLonLat(ll.lon, ll.lat);
    const nd = C.norm(d);
    for (let i = 0; i < 3; i++) approx(back[i], nd[i], 1e-9, 'dir' + i);
  }
});
test('六个面中心在经纬图上的位置正确', () => {
  const W = 360;
  const H = 180;
  const centers = {};
  for (const f of C.FACES) centers[f.id] = C.dirToEquirectPixel(f.n, W, H);
  const uOf = (id) => (centers[id].x + 0.5) / W;
  // 前面 +Z 在中央（u=0.5）
  approx(uOf(4), 0.5, 1e-9, 'front u');
  // 上面在顶部、下面在底部
  assert.ok((centers[2].y + 0.5) / H < 0.05, 'top near top');
  assert.ok((centers[3].y + 0.5) / H > 0.95, 'bottom near bottom');
  // 内部视角：向右是 +X，所以右面 +X 在 u=0.75、左面 -X 在 u=0.25
  approx(uOf(0), 0.75, 1e-9, 'right +X u');
  approx(uOf(1), 0.25, 1e-9, 'left -X u');
});
test('dirToFace 与 facePoint3 互逆', () => {
  for (const f of C.FACES) {
    for (const uv of [[0.5, 0.5], [0.2, 0.35], [0.9, 0.1]]) {
      const P = C.facePoint3(f.id, uv[0], uv[1]);
      const hit = C.dirToFace(P);
      assert.strictEqual(hit.faceId, f.id);
      approx(hit.u, uv[0], 1e-9);
      approx(hit.v, uv[1], 1e-9);
    }
  }
});

// ---------------------------------------------------------------------------
group('5. 十字展开图');
test('六个面各占一格且无重叠', () => {
  const seen = new Set();
  for (const c of C.NET_LAYOUT) {
    const k = c.col + ',' + c.row;
    assert.ok(!seen.has(k), 'overlap at ' + k);
    seen.add(k);
  }
  assert.strictEqual(seen.size, 6);
});
test('横带首尾接缝是 左1 / 后5', () => {
  assert.ok(C.BAND_WRAP_SEAM);
  const pair = [C.BAND_WRAP_SEAM.faceA, C.BAND_WRAP_SEAM.faceB].sort((a, b) => a - b);
  assert.deepStrictEqual(pair, [1, 5]);
});
test('展开图中物理相邻的边数合理（十字形为 5 条）', () => {
  const physical = C.SEAMS.filter((s) => C.netPhysical(s));
  assert.strictEqual(physical.length, 5, '十字展开图应有 5 条直接相邻（含 top/bottom 各 1、横带 3）');
});

// ---------------------------------------------------------------------------
group('6. 接缝判定（合成连续纹理）');
const contFaces = makeContinuousFaces(96);
test('正确朝向：12 条全部 aligned', () => {
  const res = C.classifyAllSeams(contFaces);
  for (const r of res) {
    assert.strictEqual(r.kind, 'aligned', r.seam.key + ' → ' + r.kind + ' (direct=' + r.direct + ')');
  }
});
test('把一面转 90°：与它相关的 4 条被判为 turnable/paired，指出修法', () => {
  const broken = Object.assign({}, contFaces);
  broken[0] = Object.assign({}, contFaces[0], { rot: 1 });
  const res = C.classifyAllSeams(broken);
  const touched = res.filter((r) => r.seam.faceA === 0 || r.seam.faceB === 0);
  assert.strictEqual(touched.length, 4);
  for (const r of touched) {
    assert.ok(['turnable', 'paired', 'reversed', 'content'].indexOf(r.kind) >= 0);
    assert.notStrictEqual(r.kind, 'aligned', 'rotated face seam should not be aligned: ' + r.seam.key);
  }
  const fixable = touched.filter((r) => r.kind === 'turnable' || r.kind === 'reversed' || r.kind === 'paired');
  assert.ok(fixable.length >= 1, '至少有一条能给出转向修法');
});
test('suggestOrientations 能把转错的一面找回 rot=0', () => {
  const broken = {};
  for (const f of C.FACES) broken[f.id] = Object.assign({}, contFaces[f.id]);
  broken[2] = Object.assign({}, contFaces[2], { rot: 1, flipH: false });
  const res = C.suggestOrientations(broken);
  assert.strictEqual(res.configs[2].rot, 0, '应找回 rot=0, 实际 ' + res.configs[2].rot);
  assert.strictEqual(res.configs[2].flipH, false);
});
test('镜像一面会被识别为需翻转或转向', () => {
  const broken = {};
  for (const f of C.FACES) broken[f.id] = Object.assign({}, contFaces[f.id]);
  broken[4] = Object.assign({}, contFaces[4], { rot: 0, flipH: true });
  const res = C.classifyAllSeams(broken);
  const touched = res.filter((r) => r.seam.faceA === 4 || r.seam.faceB === 4);
  assert.ok(touched.some((r) => r.kind !== 'aligned'), '镜像面应至少让一条边不再 aligned');
});
test('内容不连续的面被判为 content', () => {
  const a = solidTex(255, 0, 0);
  const b = solidTex(0, 0, 255);
  const faces = {};
  for (const f of C.FACES) faces[f.id] = { tex: a, rot: 0, flipH: false };
  // 让 4 号面变成纯蓝，它的 4 条边都不连续；纯色面之间别的边仍对齐
  faces[4] = { tex: b, rot: 0, flipH: false };
  const res = C.classifyAllSeams(faces);
  const touched = res.filter((r) => r.seam.faceA === 4 || r.seam.faceB === 4);
  for (const r of touched) {
    assert.strictEqual(r.kind, 'content', '纯色差异应判 content，实际 ' + r.kind + ' @ ' + r.seam.key);
  }
});

// ---------------------------------------------------------------------------
group('7. 经纬图往返');
test('六面 → 经纬 → 六面，中心区域误差小', () => {
  const eq = C.renderEquirectFromFaces({ width: 512, height: 256, faces: contFaces, bilinear: true });
  const back = C.extractFacesFromEquirect({ equirect: eq, size: 96, bilinear: true });
  for (const f of C.FACES) {
    let sum = 0;
    let cnt = 0;
    // 只比较面中心 50% 区域，避开边缘像素混叠
    for (let y = 24; y < 72; y++) {
      for (let x = 24; x < 72; x++) {
        const i = (y * 96 + x) * 4;
        const j = (y * 96 + x) * 4;
        for (let c = 0; c < 3; c++) {
          sum += Math.abs(back[f.id].data[i + c] - contFaces[f.id].tex.data[j + c]);
          cnt++;
        }
      }
    }
    const mean = sum / cnt;
    assert.ok(mean < 6, '面 ' + f.id + ' 往返平均误差 ' + mean.toFixed(2) + ' 应 < 6');
  }
});
test('经纬图首尾列（±180°）靠近后面中心', () => {
  const W = 360;
  const H = 180;
  // ±180° 处方向是 -Z，属于 5 号后面
  const dLeft = C.dirFromLonLat(-Math.PI + 1e-6, 0);
  const dRight = C.dirFromLonLat(Math.PI - 1e-6, 0);
  assert.strictEqual(C.dirToFace(dLeft).faceId, 5);
  assert.strictEqual(C.dirToFace(dRight).faceId, 5);
});
test('两极附近是上/下面', () => {
  assert.strictEqual(C.dirToFace(C.dirFromLonLat(0, Math.PI / 2 - 0.01)).faceId, 2);
  assert.strictEqual(C.dirToFace(C.dirFromLonLat(0, -Math.PI / 2 + 0.01)).faceId, 3);
});

// ---------------------------------------------------------------------------
group('8. 诊断');
test('缺面会点名缺哪几个面', () => {
  const faces = makeContinuousFaces(64);
  delete faces[1];
  delete faces[3];
  const d = C.diagnose(faces);
  assert.strictEqual(d.ok, false);
  assert.deepStrictEqual(d.missing.sort((a, b) => a - b), [1, 3]);
  assert.ok(/缺少/.test(d.messages[0].text));
  assert.ok(d.messages[0].faces.indexOf(1) >= 0);
});
test('尺寸不一致会指出离群的面', () => {
  const faces = makeContinuousFaces(64);
  faces[2] = { tex: solidTex(1, 2, 3, 128), rot: 0, flipH: false };
  const d = C.diagnose(faces);
  assert.strictEqual(d.ok, false);
  assert.ok(d.mixed);
  const msg = d.messages.find((m) => m.kind === 'mixed');
  assert.ok(msg);
  assert.ok(msg.faces.indexOf(2) >= 0, '应点名 2 号面');
});
test('非正方形会被指出', () => {
  const faces = makeContinuousFaces(64);
  faces[5] = { tex: { data: solidTex(0, 0, 0, 64).data, width: 80, height: 64 }, rot: 0, flipH: false };
  const d = C.diagnose(faces);
  assert.ok(d.nonSquare.some((x) => x.id === 5));
});
test('六面齐全且尺寸一致时 ok', () => {
  const d = C.diagnose(makeContinuousFaces(64));
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.messages.length, 0);
});

// ---------------------------------------------------------------------------
group('9. 文件名识别');
test('常见命名都能认出面号', () => {
  const cases = {
    'front.png': 4,
    'px.jpg': 0,
    'negz.png': 5,
    'cube_top.png': 2,
    'Bottom.png': 3,
    'left_2048.png': 1,
    'back.webp': 5,
    'face-0-right.png': 0,
  };
  for (const name of Object.keys(cases)) {
    assert.strictEqual(C.guessFaceFromName(name), cases[name], name);
  }
});

// ---------------------------------------------------------------------------
group('10. 样例生成与故意转错');
test('样例六面齐全、尺寸一致、0 号面 initial rot=1', () => {
  const s = Samples.makeSampleFaces({ size: 128, equirectWidth: 384 });
  for (const f of C.FACES) {
    assert.ok(s.faces[f.id] && s.faces[f.id].tex, 'face ' + f.id);
    assert.strictEqual(s.faces[f.id].tex.width, 128);
  }
  assert.strictEqual(s.configs[0].rot, 1);
  for (let i = 1; i < 6; i++) assert.strictEqual(s.configs[i].rot, 0);
});
test('样例按初始配置载入后，0 号面的边被判为可修正', () => {
  const s = Samples.makeSampleFaces({ size: 128, equirectWidth: 384 });
  const faces = {};
  for (const f of C.FACES) {
    faces[f.id] = { tex: s.faces[f.id].tex, rot: s.configs[f.id].rot, flipH: s.configs[f.id].flipH };
  }
  const res = C.classifyAllSeams(faces);
  const touched = res.filter((r) => r.seam.faceA === 0 || r.seam.faceB === 0);
  const fixable = touched.filter((r) => r.kind === 'turnable' || r.kind === 'reversed' || r.kind === 'paired');
  const aligned = touched.filter((r) => r.kind === 'aligned');
  assert.ok(fixable.length >= 2, '转错的面至少两条边可修复，实际 fixable=' + fixable.length + ' aligned=' + aligned.length);
});
test('把样例 0 号面改回 rot=0 后，0 号面的边全部对齐', () => {
  const s = Samples.makeSampleFaces({ size: 128, equirectWidth: 384 });
  const faces = {};
  for (const f of C.FACES) {
    faces[f.id] = { tex: s.faces[f.id].tex, rot: f.id === 0 ? 0 : s.configs[f.id].rot, flipH: false };
  }
  const res = C.classifyAllSeams(faces);
  // 修正后 0 号右面的 4 条棱应全部对齐
  const face0 = res.filter((r) => r.seam.faceA === 0 || r.seam.faceB === 0);
  const bad0 = face0.filter((r) => r.kind !== 'aligned');
  assert.strictEqual(
    bad0.length,
    0,
    '修正后 0 号面的棱应全部 aligned，实际: ' + bad0.map((r) => r.seam.key + '=' + r.kind).join(', ')
  );
  // 整体也应是绝大多数对齐（样例网格线连续）
  const badAll = res.filter((r) => r.kind !== 'aligned');
  assert.ok(badAll.length <= 2, '整体最多容忍 2 条因取样误差未对齐，实际 ' + badAll.length + ': ' + badAll.map((r) => r.seam.key + '=' + r.kind).join(', '));
});

// ---------------------------------------------------------------------------
process.stdout.write('\n' + '─'.repeat(56) + '\n');
process.stdout.write('通过 ' + passed + '，失败 ' + failed + '\n');
if (failed) {
  process.stdout.write('\n失败详情:\n');
  for (const f of failures) {
    process.stdout.write('  • ' + f.name + '\n    ' + f.err.stack.split('\n').slice(0, 3).join('\n    ') + '\n');
  }
  process.exit(1);
}
