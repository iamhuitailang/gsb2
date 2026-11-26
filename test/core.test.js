/**
 * test/core.test.js — 纯 Node 单测（node --test），不依赖浏览器/DOM
 * 运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/color');
const Geo = require('../js/geometry');
const Analysis = require('../js/analysis');

// Sharma et al. (2005) CIEDE2000 标准测试数据（容差 1e-4）
const SHARMA = [
  [{ L: 50, a: 2.6772, b: -79.7751 }, { L: 50, a: 0, b: -82.7485 }, 2.0425],
  [{ L: 50, a: 3.1571, b: -77.2803 }, { L: 50, a: 0, b: -82.7485 }, 2.8615],
  [{ L: 50, a: 2.8361, b: -74.0200 }, { L: 50, a: 0, b: -82.7485 }, 3.4412],
  [{ L: 50, a: -1.3802, b: -84.2814 }, { L: 50, a: 0, b: -82.7485 }, 1.0000],
  [{ L: 50, a: -1.1848, b: -84.8006 }, { L: 50, a: 0, b: -82.7485 }, 1.0000],
  [{ L: 50, a: -0.9009, b: -85.5211 }, { L: 50, a: 0, b: -82.7485 }, 1.0000],
  [{ L: 50, a: 0, b: 0 }, { L: 50, a: -1, b: 2 }, 2.3669],
  [{ L: 50, a: -1, b: 2 }, { L: 50, a: 0, b: 0 }, 2.3669],
  [{ L: 50, a: 2.5, b: 0 }, { L: 73, a: 25, b: -18 }, 27.1492],
  [{ L: 60.2574, a: -34.0099, b: 36.2677 }, { L: 60.4626, a: -34.1751, b: 39.4387 }, 1.2644],
  [{ L: 63.0109, a: -31.0961, b: -5.8663 }, { L: 62.8187, a: -29.7946, b: -4.0864 }, 1.2630],
  [{ L: 61.2901, a: 3.7196, b: -5.3901 }, { L: 61.4292, a: 2.2480, b: -4.9620 }, 1.8731],
  [{ L: 35.0831, a: -44.1164, b: 3.7933 }, { L: 35.0232, a: -40.0716, b: 1.5901 }, 1.8645],
  [{ L: 22.7233, a: 20.0904, b: -46.6940 }, { L: 23.0331, a: 14.9730, b: -42.5619 }, 2.0373],
  [{ L: 36.4612, a: 47.8580, b: 18.3852 }, { L: 36.2715, a: 50.5065, b: 21.2231 }, 1.4146],
  [{ L: 90.8027, a: -2.0831, b: 1.4410 }, { L: 91.1528, a: -1.6435, b: 0.0447 }, 1.4441],
  [{ L: 90.9257, a: -0.5406, b: -0.9208 }, { L: 88.6381, a: -0.8985, b: -0.7239 }, 1.5381],
  [{ L: 6.7747, a: -0.2908, b: -2.4247 }, { L: 5.8714, a: -0.0985, b: -2.2280 }, 0.6378],
  // 末两组为 Sharma 原表低明度数据，采用 CIE 官方勘误后的修正值
  [{ L: 2.0776, a: 0.0795, b: -1.1350 }, { L: 0.9033, a: -0.0636, b: -0.5514 }, 0.9082],
];

test('CIEDE2000 与 Sharma 标准数据一致', () => {
  for (const [l1, l2, expected] of SHARMA) {
    assert.ok(Math.abs(C.deltaE2000(l1, l2) - expected) < 1e-4,
      `got ${C.deltaE2000(l1, l2)} want ${expected}`);
  }
});

test('Lab 往返转换在 sRGB 色域内近似可逆', () => {
  for (const [r, g, b] of [[224, 68, 62], [63, 157, 77], [255, 255, 255], [0, 0, 0], [58, 111, 224]]) {
    const lab = C.rgbToLab(r, g, b);
    const back = C.labToRgb(lab.L, lab.a, lab.b);
    assert.ok(Math.abs(back.r - r) < 1.2 && Math.abs(back.g - g) < 1.2 && Math.abs(back.b - b) < 1.2,
      `roundtrip ${[r, g, b]} -> ${[back.r, back.g, back.b]}`);
  }
});

test('同色色差为 0，黑白色差很大', () => {
  const red = C.rgbToLab(224, 68, 62);
  assert.equal(C.deltaE2000(red, red), 0);
  const white = C.rgbToLab(255, 255, 255);
  const black = C.rgbToLab(0, 0, 0);
  assert.ok(C.deltaE2000(white, black) > 90);
});

test('WCAG 对比度：白黑 21:1，同色 1:1', () => {
  assert.ok(Math.abs(C.contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }) - 21) < 0.01);
  assert.equal(C.contrastRatio({ r: 100, g: 100, b: 100 }, { r: 100, g: 100, b: 100 }), 1);
});

test('绿色盲模拟把红/绿推向相近色相，二者 Lab 色差较正常明显缩小', () => {
  const red = C.simulateCVD(224, 68, 62, 'deutan');
  const green = C.simulateCVD(63, 157, 77, 'deutan');
  const dNormal = C.deltaE2000(C.rgbToLab(224, 68, 62), C.rgbToLab(63, 157, 77));
  const dCvd = C.deltaE2000(
    C.rgbToLab(C.clamp255(red.r), C.clamp255(red.g), C.clamp255(red.b)),
    C.rgbToLab(C.clamp255(green.r), C.clamp255(green.g), C.clamp255(green.b)),
  );
  assert.ok(dCvd < dNormal, `CVD ΔE ${dCvd} 应小于正常 ΔE ${dNormal}`);
  assert.ok(dCvd < 12, '红色盲易混色对在乙型模拟下应接近');
});

test('灰度输出三通道相等且保持亮度次序', () => {
  const gy = C.grayscale(224, 68, 62);
  assert.ok(Math.abs(gy.r - gy.g) < 1e-9 && Math.abs(gy.g - gy.b) < 1e-9);
  const dark = C.grayscale(10, 10, 10);
  assert.ok(gy.r > dark.r);
});

test('transformFrame 保持 alpha 通道不变', () => {
  const data = new Uint8ClampedArray([224, 68, 62, 128, 0, 0, 0, 0, 255, 255, 255, 255]);
  for (const mode of ['protan', 'deutan', 'tritan', 'gray']) {
    const out = C.transformFrame(data, mode);
    assert.deepEqual([out[3], out[7], out[11]], [128, 0, 255]);
  }
});

test('alpha 分类区分全透明/边缘/不透明', () => {
  assert.equal(Geo.alphaClass(0), 'transparent');
  assert.equal(Geo.alphaClass(5), 'transparent');
  assert.equal(Geo.alphaClass(128), 'edge');
  assert.equal(Geo.alphaClass(250), 'full');
  assert.equal(Geo.alphaClass(255), 'full');
});

test('距离变换：每个像素找到最近目标', () => {
  const W = 5, H = 5;
  const target = new Uint8Array(W * H);
  target[12] = 1; // 中心点 (2,2)
  const { dist, nearest } = Geo.nearestTarget(W, H, target);
  assert.equal(dist[12], 0);
  assert.equal(nearest[12], 12);
  assert.equal(nearest[0], 12);            // 左上角最近点也是中心
  // (2,1) 距中心 (2,2) 正交一格
  assert.ok(Math.abs(dist[1 * W + 2] - 1) < 1e-9);
  // (1,1) 距中心斜向一格（chamfer 近似 ≈ √2）
  assert.ok(Math.abs(dist[1 * W + 1] - Math.SQRT2) < 0.02);
});

test('summarize 统计量正确', () => {
  const s = Geo.summarize([1, 2, 3, 4, 5]);
  assert.equal(s.count, 5);
  assert.equal(s.min, 1);
  assert.equal(s.mean, 3);
  assert.equal(s.p50, 3);
});

// 构造一帧：白背景上一个红方块（含半透明边与透明孔）
function makeFrame(W, H, draw) {
  const frame = new Uint8ClampedArray(W * H * 4).fill(0);
  for (let p = 0; p < W * H; p++) {
    frame[p * 4] = 255; frame[p * 4 + 1] = 255; frame[p * 4 + 2] = 255; frame[p * 4 + 3] = 255;
  }
  draw(frame);
  return frame;
}

test('analyzeIcon：高对比图标 ΔE 大，全透明像素不计入，边缘单独统计', () => {
  const W = 20, H = 20;
  const alpha = new Uint8ClampedArray(W * H);
  const frame = makeFrame(W, H, (d) => {
    for (let y = 6; y < 14; y++) {
      for (let x = 6; x < 14; x++) {
        const p = y * W + x;
        if (x === 10 && y === 10) continue; // 全透明孔
        const edge = x === 6 || x === 13 || y === 6 || y === 13;
        const a = edge ? 128 : 255;
        alpha[p] = a;
        // 红色按 alpha 合成到白底
        const fr = 224 * (a / 255) + 255 * (1 - a / 255);
        d[p * 4] = fr; d[p * 4 + 1] = 68 * (a / 255) + 255 * (1 - a / 255);
        d[p * 4 + 2] = 62 * (a / 255) + 255 * (1 - a / 255);
        d[p * 4 + 3] = 255;
      }
    }
  });
  const lut = Analysis.makeLabLut(frame);
  const covered = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) if (alpha[p] > Geo.ALPHA_EDGE_LO) covered[p] = 1;
  const r = Analysis.analyzeIcon(frame, lut, W, H, { id: 't', x0: 0, y0: 0, W, H, alpha }, covered, '2000');
  assert.ok(r.summary.full.count > 0);
  assert.ok(r.summary.edge.count > 0);
  assert.ok(r.summary.transparentCount >= 1, '透明孔应被计入 transparentCount');
  assert.ok(r.summary.full.mean > 15, '红 vs 白应明显可辨');
  assert.ok(r.summary.edge.mean < r.summary.full.mean, '半透明边缘与背景更接近');
  assert.ok(r.worst.length > 0 && r.worst[0].bgRgb.length === 3 && r.worst[0].fgRgb.length === 3);
  assert.ok(r.worst[0].dE <= r.worst[r.worst.length - 1].dE, 'worst 列表应按色差升序');
});

test('analyzeIcon：与背景同色的图标 ΔE 接近 0（难分场景）', () => {
  const W = 12, H = 12;
  const alpha = new Uint8ClampedArray(W * H);
  const frame = makeFrame(W, H, (d) => {
    for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) {
      const p = y * W + x;
      alpha[p] = 255;
      d[p * 4] = 255; d[p * 4 + 1] = 255; d[p * 4 + 2] = 255; d[p * 4 + 3] = 255;
    }
  });
  const lut = Analysis.makeLabLut(frame);
  const covered = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) if (alpha[p]) covered[p] = 1;
  const r = Analysis.analyzeIcon(frame, lut, W, H, { id: 't', x0: 0, y0: 0, W, H, alpha }, covered, '2000');
  assert.ok(r.summary.full.mean < 1, '白底白图应几乎无色差');
  assert.ok(r.thresholds.lt5 > 0.99);
});

test('analyzePair：重叠区逐像素色差，不重叠时返回边缘间距', () => {
  const W = 20, H = 20;
  function solo(color) {
    const d = new Uint8ClampedArray(W * H * 4);
    const cov = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) { d[p * 4 + 3] = 255; }
    for (let y = 5; y < 12; y++) for (let x = 5; x < 12; x++) {
      const p = y * W + x;
      d[p * 4] = color[0]; d[p * 4 + 1] = color[1]; d[p * 4 + 2] = color[2];
      cov[p] = 1;
    }
    return { d, cov };
  }
  const A = solo([224, 68, 62]), B = solo([63, 157, 77]);
  const full = new Uint8ClampedArray(W * H * 4);
  full.set(A.d);
  const r = Analysis.analyzePair(full, A.d, B.d,
    Analysis.makeLabLut(A.d), Analysis.makeLabLut(B.d), W, H,
    { id: 'a' }, { id: 'b' }, A.cov, B.cov, '2000');
  assert.ok(r.overlapCount > 0);
  assert.ok(r.full.mean > 10, '红 vs 绿在正常视图下应可区分');

  // 不重叠：B 右移 10px
  const B2d = new Uint8ClampedArray(W * H * 4);
  const B2cov = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) B2d[p * 4 + 3] = 255;
  for (let y = 5; y < 12; y++) for (let x = 15; x < Math.min(20, 22); x++) {
    const p = y * W + x;
    B2d[p * 4] = 63; B2d[p * 4 + 1] = 157; B2d[p * 4 + 2] = 77;
    B2cov[p] = 1;
  }
  const r2 = Analysis.analyzePair(full, A.d, B2d,
    Analysis.makeLabLut(A.d), Analysis.makeLabLut(B2d), W, H,
    { id: 'a' }, { id: 'b2' }, A.cov, B2cov, '2000');
  assert.equal(r2.overlapCount, 0);
  assert.ok(r2.minGap >= 3, '两掩膜最近间距应被正确量出');
});

test('scanWorstPositions：渐变背景上能定位到与图标颜色最接近的位置', async () => {
  const W = 40, H = 40, iconW = 8, iconH = 8;
  // 背景从左(白)到右(红)渐变；红色图标在最右侧 ΔE 最低
  function renderAt(x, y) {
    const frame = new Uint8ClampedArray(W * H * 4);
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
      const p = yy * W + xx;
      const t = xx / (W - 1);
      frame[p * 4] = 255;
      frame[p * 4 + 1] = Math.round(255 * (1 - t) + 68 * t);
      frame[p * 4 + 2] = Math.round(255 * (1 - t) + 62 * t);
      frame[p * 4 + 3] = 255;
    }
    const iconAlpha = new Uint8ClampedArray(iconW * iconH);
    for (let yy = 0; yy < iconH; yy++) for (let xx = 0; xx < iconW; xx++) {
      const fx = x + xx, fy = y + yy;
      iconAlpha[yy * iconW + xx] = 255;
      const p = fy * W + fx;
      frame[p * 4] = 224; frame[p * 4 + 1] = 68; frame[p * 4 + 2] = 62;
    }
    return Promise.resolve({ frame, iconAlpha });
  }
  const result = await Analysis.scanWorstPositions(renderAt, {
    W, H, iconW, iconH, step: 4, metric: '76',
  });
  assert.ok(result.hardest.x > result.easiest.x, '最难位置应在更靠近红色的右侧');
  assert.ok(result.hardest.score < result.easiest.score);
  assert.equal(result.grid.length, result.cols * result.rows);
});

test('色相旋转：红色旋转约 120° 后落在绿色域', () => {
  const out = C.rotateHueRGBA(224, 68, 62, 120, 1);
  assert.ok(out.g > out.r, '旋转后绿通道应占主导');
});
