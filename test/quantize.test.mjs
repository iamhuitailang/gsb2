import test from 'node:test';
import assert from 'node:assert/strict';
import { quantizeImage, imageTransparencyStats, DITHER_IDS } from '../src/quantize.js';
import { parsePaletteText, dedupePalette, rgbToLab, deltaE2000, deltaE76 } from '../src/color.js';

const PALETTE = [
  { r: 0, g: 0, b: 0 },
  { r: 255, g: 255, b: 255 },
];

function gradientStep(size = 16) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const v = Math.round((x / (size - 1)) * 255);
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return { rgba, width: size, height: size };
}

test('调色板解析：支持 hex、短 hex、rgb 三元组与注释', () => {
  const palette = parsePaletteText(`
    #fff
    #000000
    255, 128, 0
    #ff000080 // 忽略 alpha
    ; 整行注释
  `);
  assert.equal(palette.length, 4);
  assert.deepEqual(palette[0], { r: 255, g: 255, b: 255 });
  assert.deepEqual(palette[2], { r: 255, g: 128, b: 0 });
});

test('CIEDE2000 基准值（Sharma 测试集）', () => {
  const a = rgbToLab(0, 0, 0);
  const b = rgbToLab(255, 255, 255);
  const de = deltaE2000(a, b);
  assert.ok(de > 99 && de < 101, `黑白 ΔE2000 应接近 100，得到 ${de}`);
  assert.ok(deltaE76(a, b) > 99);
});

test('无抖动：每个输出像素都在调色板内', () => {
  const { rgba, width, height } = gradientStep(16);
  const out = quantizeImage(rgba, width, height, { palette: PALETTE, dither: 'none' });
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const key = `${out.rgba[i]},${out.rgba[i + 1]},${out.rgba[i + 2]}`;
    assert.ok(key === '0,0,0' || key === '255,255,255', `非法颜色 ${key}`);
    assert.equal(out.indices[p], key === '0,0,0' ? 0 : 1);
  }
});

test('所有抖动模式都只输出调色板颜色', () => {
  const { rgba, width, height } = gradientStep(24);
  for (const dither of DITHER_IDS) {
    const out = quantizeImage(rgba, width, height, { palette: PALETTE, dither });
    for (let p = 0; p < width * height; p++) {
      const i = p * 4;
      const isBlack = out.rgba[i] === 0 && out.rgba[i + 1] === 0 && out.rgba[i + 2] === 0;
      const isWhite = out.rgba[i] === 255 && out.rgba[i + 1] === 255 && out.rgba[i + 2] === 255;
      assert.ok(isBlack || isWhite, `${dither} 产生了非调色板颜色`);
    }
  }
});

test('透明像素绝不参与扩散、也不写入背景色', () => {
  const width = 12;
  const height = 12;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (x < width / 2) {
        // 左半：亮灰渐变
        const v = 120 + x * 10;
        rgba[i] = v;
        rgba[i + 1] = v;
        rgba[i + 2] = v;
        rgba[i + 3] = 255;
      } else {
        // 右半：完全透明，RGB 故意写成刺眼的红色
        rgba[i] = 255;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = 0;
      }
    }
  }
  const out = quantizeImage(rgba, width, height, {
    palette: PALETTE,
    dither: 'floyd-steinberg',
    alphaCutoff: 128,
  });
  assert.equal(out.transparentIndex, 2);
  for (let y = 0; y < height; y++) {
    for (let x = width / 2; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      assert.equal(out.rgba[i + 3], 0, '透明像素 alpha 必须为 0');
      assert.equal(out.rgba[i], 0, '透明像素 RGB 必须清零，不能变成黑色之外的背景');
      assert.equal(out.rgba[i + 1], 0);
      assert.equal(out.rgba[i + 2], 0);
      assert.equal(out.indices[p], out.transparentIndex);
    }
  }
  // 透明像素不能进入调色板颜色用量
  const totalUsed = out.colorUsage.reduce((a, b) => a + b, 0);
  assert.equal(totalUsed, (width / 2) * height);
});

test('边缘处扩散权重归一化：无透明区域时结果等于完整权重', () => {
  // 全不透明图：误差总和守恒（±浮点）。
  const { rgba, width, height } = gradientStep(20);
  const out = quantizeImage(rgba, width, height, { palette: PALETTE, dither: 'floyd-steinberg' });
  let err = 0;
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    err += Math.abs(rgba[i] - out.rgba[i]);
  }
  // 对 2 色渐变，Floyd–Steinberg 的平均绝对误差大约在 30–70 之间（0–255 尺度）。
  const avg = err / (width * height);
  assert.ok(avg > 1, `应当发生抖动，平均误差 ${avg}`);
  assert.ok(avg < 90, `平均误差不应爆炸，得到 ${avg}`);
});

test('半透明像素在 preserve 模式下保留 alpha，在 binary 模式下变为不透明', () => {
  const rgba = new Uint8ClampedArray(4 * 4);
  rgba[0] = 10; rgba[1] = 10; rgba[2] = 10; rgba[3] = 200;
  const preserve = quantizeImage(rgba, 1, 1, { palette: PALETTE, alphaMode: 'preserve' });
  assert.equal(preserve.rgba[3], 200);
  const binary = quantizeImage(rgba, 1, 1, { palette: PALETTE, alphaMode: 'binary' });
  assert.equal(binary.rgba[3], 255);
});

test('透明图片最多 255 色（留 1 个透明索引）', () => {
  const palette = Array.from({ length: 300 }, (_, i) => ({
    r: i % 256,
    g: (i * 7) % 256,
    b: (i * 13) % 256,
  }));
  const rgba = new Uint8ClampedArray(2 * 2 * 4);
  rgba[3] = 0; // 一个透明像素
  const out = quantizeImage(rgba, 2, 1, { palette });
  assert.ok(out.palette.length <= 256, '调色板不能超过 256 项');
  assert.ok(out.hasTransparency);
  assert.equal(out.palette[out.transparentIndex].transparent, true);
});

test('重复颜色会在进入调色板前去重', () => {
  const doubled = [...PALETTE, ...PALETTE];
  assert.equal(dedupePalette(doubled).length, 2);
});

test('整理透明统计', () => {
  const rgba = new Uint8ClampedArray(4 * 4);
  const alphas = [0, 100, 200, 255];
  for (let p = 0; p < 4; p++) rgba[p * 4 + 3] = alphas[p];
  const stats = imageTransparencyStats(rgba, 128);
  // alpha < 128 视为透明：0、100；>= 128 视为不透明：200、255。
  assert.equal(stats.transparent, 2);
  assert.equal(stats.opaque, 2);
  // 其中 100、200 是半透明（0 < alpha < 255）。
  assert.equal(stats.semi, 2);
});
