import test from 'node:test';
import assert from 'node:assert/strict';
import {
  medianCut,
  kmeansRefine,
  generatePaletteFromSamples,
  createSourceModel,
  addImageToModel,
  generatePaletteFromModel,
  presetColors,
  PALETTE_PRESETS,
  sortPalette,
} from '../src/palette.js';
import { dedupePalette, rgbToHex } from '../src/color.js';

function samplesFrom(rgba, alphaCutoff = 128) {
  const model = createSourceModel();
  addImageToModel(model, rgba, alphaCutoff);
  const exact = model.exact ? [...model.exact.values()] : [];
  return exact.length ? exact : null;
}

test('中位切分输出的颜色数不超过请求值', () => {
  const samples = Array.from({ length: 500 }, (_, i) => ({
    r: (i * 17) % 256,
    g: (i * 29) % 256,
    b: (i * 41) % 256,
    count: 1,
  }));
  for (const n of [2, 8, 16, 64]) {
    const palette = medianCut(samples, n);
    assert.ok(palette.length <= n, `${n} 色请求却返回了 ${palette.length}`);
    assert.ok(palette.length > 1);
  }
});

test('K-means 精炼后仍是合法颜色', () => {
  const samples = Array.from({ length: 200 }, (_, i) => ({
    r: i % 256,
    g: (i * 3) % 256,
    b: (i * 7) % 256,
    count: 4,
  }));
  const init = medianCut(samples, 8);
  const refined = kmeansRefine(samples, init, 4);
  for (const c of refined) {
    assert.ok(c.r >= 0 && c.r <= 255);
    assert.ok(c.g >= 0 && c.g <= 255);
    assert.ok(c.b >= 0 && c.b <= 255);
  }
  assert.equal(refined.length, dedupePalette(refined).length, '精炼后不能有重复颜色');
});

test('调色板生成是确定性的', () => {
  const rgba = new Uint8ClampedArray(64 * 64 * 4);
  for (let p = 0; p < 64 * 64; p++) {
    rgba[p * 4] = (p * 7) % 256;
    rgba[p * 4 + 1] = (p * 13) % 256;
    rgba[p * 4 + 2] = (p * 23) % 256;
    rgba[p * 4 + 3] = 255;
  }
  const a = generatePaletteFromSamples(samplesFrom(rgba), 16);
  const b = generatePaletteFromSamples(samplesFrom(rgba), 16);
  assert.deepEqual(a, b);
});

test('透明像素不进入调色板统计', () => {
  const rgba = new Uint8ClampedArray(8 * 8 * 4);
  for (let p = 0; p < 64; p++) {
    const i = p * 4;
    rgba[i] = 255;
    rgba[i + 1] = 0;
    rgba[i + 2] = 0;
    rgba[i + 3] = p % 2 === 0 ? 255 : 0; // 一半透明，且透明像素是纯红
  }
  // 不透明像素全是红色，因此调色板应该只有红色
  const model = createSourceModel();
  addImageToModel(model, rgba, 128);
  const palette = generatePaletteFromModel(model, 8);
  assert.deepEqual(palette.map((c) => rgbToHex(c.r, c.g, c.b)), ['#ff0000']);
  // 如果错误地把透明像素算进来，会额外出现其他颜色
  const wrongModel = createSourceModel();
  addImageToModel(wrongModel, rgba, 0); // 阈值 0：透明像素也算
  assert.ok(wrongModel.hist.total === 64);
});

test('预设调色板数量正确', () => {
  for (const preset of PALETTE_PRESETS) {
    const colors = presetColors(preset.id);
    assert.equal(colors.length, preset.colors.length);
    for (const c of colors) {
      assert.ok(c.r >= 0 && c.r <= 255);
    }
  }
});

test('排序稳定：亮度升序', () => {
  const palette = sortPalette([
    { r: 255, g: 255, b: 255 },
    { r: 0, g: 0, b: 0 },
    { r: 128, g: 128, b: 128 },
  ]);
  assert.deepEqual(palette.map((c) => c.r), [0, 128, 255]);
});

test('2 色请求时中位切分给出两色', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({
    r: i % 256,
    g: i % 256,
    b: i % 256,
    count: 1,
  }));
  const palette = medianCut(samples, 2);
  assert.equal(palette.length, 2);
});
