/* Node 算法测试：node --test tests/
 * 覆盖：分析引擎的颜色差/走势差判定、边段与角点、
 * 修正后接缝在强度 100% 时严格匹配、保护区像素不变、示例纹理的接缝性质。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require(path.join(__dirname, '..', 'public', 'js', 'core.js'));
const A = require(path.join(__dirname, '..', 'public', 'js', 'analysis.js'));
const R = require(path.join(__dirname, '..', 'public', 'js', 'correction.js'));
const S = require(path.join(__dirname, '..', 'public', 'js', 'samples.js'));

const W = 32, H = 32;

function solidBuffer(w, h, fill) {
  const buf = C.makeBuffer(w, h);
  for (let i = 0; i < w * h; i++) {
    buf.data[i * 4] = fill[0];
    buf.data[i * 4 + 1] = fill[1];
    buf.data[i * 4 + 2] = fill[2];
    buf.data[i * 4 + 3] = 255;
  }
  return buf;
}

/** 在纯色底上制造仅影响左右边缘的竖向亮带（接缝电平差） */
function verticalSeamBuffer(w, h, jump) {
  const buf = solidBuffer(w, h, [128, 128, 128]);
  for (let y = 0; y < h; y++) {
    const i = C.idx(w - 1, y, w);
    buf.data[i] = 128 + jump;
    buf.data[i + 1] = 128 + jump;
    buf.data[i + 2] = 128 + jump;
  }
  return buf;
}

function horizontalSeamBuffer(w, h, jump) {
  const buf = solidBuffer(w, h, [120, 120, 120]);
  for (let x = 0; x < w; x++) {
    const i = C.idx(x, h - 1, w);
    buf.data[i] = 120 + jump;
    buf.data[i + 1] = 120 + jump;
    buf.data[i + 2] = 120 + jump;
  }
  return buf;
}

test('纯色图：纵横接缝均无异常边段、无异常角点', () => {
  const res = A.analyzeSeams(solidBuffer(W, H, [100, 110, 120]), 2.5);
  assert.equal(res.vertical.segments.length, 0);
  assert.equal(res.horizontal.segments.length, 0);
  assert.ok(res.corners.every((c) => !c.bad));
  assert.equal(res.vertical.meanColor, 0);
});

test('竖向接缝：只在 vertical 上检出异常边段，horizontal 干净', () => {
  const res = A.analyzeSeams(verticalSeamBuffer(W, H, 40), 2.5);
  assert.ok(res.vertical.segments.length >= 1);
  assert.equal(res.horizontal.segments.length, 0);
  const seg = res.vertical.segments[0];
  assert.equal(seg.axis, 'v');
  assert.equal(seg.start, 0);
  assert.equal(seg.end, H - 1);
  assert.ok(seg.colorFlag);
  // 竖向缝贯穿全部行 → 四个角都落在这条缝上；但每个角的横向分量必须为 0
  assert.equal(res.corners.length, 4);
  assert.ok(res.corners.every((c) => c.bad));
  assert.ok(res.corners.every((c) => c.hColor === 0 && c.hTrend === 0),
    '竖向接缝不应在角点产生横向分量');
  assert.ok(res.corners.every((c) => c.vColor > 0));
});

test('横向接缝：只在 horizontal 上检出，vertical 干净', () => {
  const res = A.analyzeSeams(horizontalSeamBuffer(W, H, 40), 2.5);
  assert.ok(res.horizontal.segments.length >= 1);
  assert.equal(res.vertical.segments.length, 0);
  // 横向缝贯穿全部列 → 四角均落在缝上，但角点的竖向分量必须为 0
  assert.ok(res.corners.every((c) => c.bad));
  assert.ok(res.corners.every((c) => c.vColor === 0 && c.vTrend === 0));
});

test('局部边段：只把异常行段标出来，正常行不进段', () => {
  const buf = solidBuffer(W, H, [128, 128, 128]);
  for (let y = 10; y <= 15; y++) {
    const i = C.idx(W - 1, y, W);
    buf.data[i] = buf.data[i + 1] = buf.data[i + 2] = 200;
  }
  const res = A.analyzeSeams(buf, 2.5);
  assert.equal(res.vertical.segments.length, 1);
  const seg = res.vertical.segments[0];
  assert.equal(seg.start, 10);
  assert.equal(seg.end, 15);
});

test('修正：强度 100% + 足够宽度时，接缝两侧像素严格相等，内部像素不变', () => {
  const original = verticalSeamBuffer(W, H, 40);
  const before = A.analyzeSeams(original, 2.5);
  assert.ok(before.vertical.meanColor > 30);

  const out = R.applyCorrection(original,
    { vStrength: 1, vWidth: 8, hStrength: 0, hWidth: 1 }, null);

  for (let y = 0; y < H; y++) {
    const iL = C.idx(0, y, W);
    const iR = C.idx(W - 1, y, W);
    for (let c = 0; c < 3; c++) {
      assert.equal(out.data[iL + c], out.data[iR + c],
        `接缝两侧 y=${y} c=${c} 应相等`);
    }
  }
  // 中间区域（宽度之外）逐像素保持
  for (let y = 0; y < H; y++) {
    for (let x = 8; x < W - 8; x++) {
      const i = C.idx(x, y, W);
      for (let c = 0; c < 4; c++) {
        assert.equal(out.data[i + c], original.data[i + c]);
      }
    }
  }
  const after = A.analyzeSeams(out, 2.5);
  assert.equal(after.vertical.segments.length, 0);
  assert.ok(after.vertical.meanColor < before.vertical.meanColor);
});

test('修正：强度 0 时输出与原图一致', () => {
  const original = verticalSeamBuffer(W, H, 40);
  const out = R.applyCorrection(original,
    { vStrength: 0, vWidth: 8, hStrength: 0, hWidth: 8 }, null);
  assert.deepEqual(Array.from(out.data), Array.from(original.data));
});

test('保护区：mask=0 的边缘像素完全不被修改', () => {
  const original = verticalSeamBuffer(W, H, 40);
  // 同时保护左右两列：整条接缝被保护区覆盖，两侧像素都应原样保留
  const mask = new Uint8ClampedArray(W * H).fill(255);
  for (let y = 0; y < H; y++) {
    mask[y * W] = 0;
    mask[y * W + (W - 1)] = 0;
  }
  const out = R.applyCorrection(original,
    { vStrength: 1, vWidth: 8, hStrength: 0, hWidth: 1 }, mask);
  for (let y = 0; y < H; y++) {
    for (const x of [0, W - 1]) {
      const i = C.idx(x, y, W);
      for (let c = 0; c < 3; c++) {
        assert.equal(out.data[i + c], original.data[i + c], '保护区像素不变');
      }
    }
  }

  // 只保护右列：右列不动，左列被推向中点
  const mask2 = new Uint8ClampedArray(W * H).fill(255);
  for (let y = 0; y < H; y++) mask2[y * W + (W - 1)] = 0;
  const out2 = R.applyCorrection(original,
    { vStrength: 1, vWidth: 8, hStrength: 0, hWidth: 1 }, mask2);
  for (let y = 0; y < H; y++) {
    const iR = C.idx(W - 1, y, W);
    for (let c = 0; c < 3; c++) {
      assert.equal(out2.data[iR + c], original.data[iR + c], '受保护的右列不变');
    }
    const iL = C.idx(0, y, W);
    assert.notEqual(out2.data[iL], original.data[iL], '未保护的左列参与修正');
  }
});

test('横向修正：强度 100% 时上下边缘严格相等', () => {
  const original = horizontalSeamBuffer(W, H, 36);
  const out = R.applyCorrection(original,
    { vStrength: 0, vWidth: 1, hStrength: 1, hWidth: 8 }, null);
  for (let x = 0; x < W; x++) {
    const iT = C.idx(x, 0, W);
    const iB = C.idx(x, H - 1, W);
    for (let c = 0; c < 3; c++) assert.equal(out.data[iT + c], out.data[iB + c]);
  }
});

test('示例布纹：纵横接缝均无异常（可严格平铺）', () => {
  const img = S.generateCloth(64);
  const buf = { data: img.data, width: 64, height: 64 };
  const res = A.analyzeSeams(buf, 2.5);
  assert.equal(res.vertical.segments.length, 0);
  assert.equal(res.horizontal.segments.length, 0);
  assert.ok(res.corners.every((c) => !c.bad));
});

test('示例地砖：竖向接缝有异常边段，横向接缝无异常，角点异常只来自竖向分量', () => {
  const img = S.generateFloor(64);
  const buf = { data: img.data, width: 64, height: 64 };
  const res = A.analyzeSeams(buf, 2.5);
  assert.ok(res.vertical.segments.length >= 1, '应检出竖向边段');
  assert.equal(res.horizontal.segments.length, 0, '横向不应有边段');
  // 竖向缝贯穿全部行 → 四个角都落在该缝上；但角点的横向分量必须全部为 0
  const badCorners = res.corners.filter((c) => c.bad);
  assert.equal(badCorners.length, 4);
  assert.ok(res.corners.every((c) => c.hColor === 0 && c.hTrend === 0),
    '竖向露缝不应在角点产生横向分量');
  assert.ok(res.corners.every((c) => c.vColor > 0));
});

test('地砖修正后：竖向接缝指标显著下降且横向不被破坏', () => {
  const img = S.generateFloor(64);
  const buf = { data: new Uint8ClampedArray(img.data), width: 64, height: 64 };
  const before = A.analyzeSeams(buf, 2.5);
  const out = R.applyCorrection(buf,
    { vStrength: 1, vWidth: 12, hStrength: 0, hWidth: 1 }, null);
  const after = A.analyzeSeams(out, 2.5);
  assert.ok(after.vertical.meanColor < before.vertical.meanColor * 0.15);
  assert.equal(after.horizontal.segments.length, 0);
});

test('smoothstep：端点为 0/1 且单调', () => {
  assert.equal(C.smoothstep(0), 0);
  assert.equal(C.smoothstep(1), 1);
  assert.equal(C.smoothstep(-2), 0);
  assert.equal(C.smoothstep(2), 1);
  let prev = -1;
  for (let i = 0; i <= 20; i++) {
    const v = C.smoothstep(i / 20);
    assert.ok(v >= prev);
    prev = v;
  }
});

test('分析与显示尺寸无关：同一张图任意“缩放”不改变诊断数值', () => {
  const buf = verticalSeamBuffer(W, H, 40);
  const r1 = A.analyzeSeams(buf, 2.5);
  const r2 = A.analyzeSeams(buf, 4.0); // 模拟不同查看条件，仅阈值参数变
  assert.deepEqual(Array.from(r1.vertical.color), Array.from(r2.vertical.color));
  assert.deepEqual(Array.from(r1.vertical.trend), Array.from(r2.vertical.trend));
});

test('走势指标：线性斜坡跨缝产生显著趋势；纯色电平台阶由颜色差主导', () => {
  // 线性斜坡（每行沿 x 递增），首尾电平差固定，拼接点两侧斜率不同 → 趋势指标捕捉到
  const ramp = solidBuffer(W, H, [0, 0, 0]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = C.idx(x, y, W);
      const v = 100 + x * 2;
      ramp.data[i] = ramp.data[i + 1] = ramp.data[i + 2] = v;
    }
  }
  const res = A.analyzeSeams(ramp, 2.5);
  assert.ok(res.vertical.meanColor > 50);
  assert.ok(res.vertical.maxTrend > 0, '斜坡拼接点应有走势差');

  // 纯色电平台阶：异常主要由颜色差解释，颜色差标志位置位、内部区域趋势为 0
  const step = verticalSeamBuffer(W, H, 40);
  const stepRes = A.analyzeSeams(step, 2.5);
  const seg = stepRes.vertical.segments[0];
  assert.ok(seg.colorFlag, '电平台阶必须由颜色差检出');
  // 台阶两侧内部（远离边缘）是平的，内部基线趋势为 0
  assert.equal(stepRes.baselines.trend, 0);
});

test('分位数基线：高噪纹理的噪声地板显著高于纯色，阈值随纹理自适应', () => {
  const flat = solidBuffer(48, 48, [128, 128, 128]);
  const noisy = C.makeBuffer(48, 48);
  // 确定性伪随机噪声
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 48 * 48; i++) {
    const v = 128 + (rnd() - 0.5) * 60;
    noisy.data[i * 4] = noisy.data[i * 4 + 1] = noisy.data[i * 4 + 2] = v;
    noisy.data[i * 4 + 3] = 255;
  }
  const bFlat = A.interiorBaselines(flat);
  const bNoisy = A.interiorBaselines(noisy);
  assert.equal(bFlat.color, 0);
  assert.ok(bNoisy.color > bFlat.color);
  assert.ok(bNoisy.trend > bFlat.trend);
});

test('修正不改变 alpha 通道', () => {
  const buf = verticalSeamBuffer(24, 24, 30);
  for (let i = 3; i < buf.data.length; i += 4) buf.data[i] = 200;
  const out = R.applyCorrection(buf,
    { vStrength: 1, vWidth: 6, hStrength: 1, hWidth: 6 }, null);
  for (let i = 3; i < out.data.length; i += 4) {
    assert.equal(out.data[i], 200);
  }
});
