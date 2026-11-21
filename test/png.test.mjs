import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRgbaPng, encodeIndexedPng, encodeGrayPng, decodePng, readPngInfo } from '../src/png.js';
import { quantizeImage } from '../src/quantize.js';
import { encodeResult } from '../src/exporters.js';
import { makeGradient, makeTransparentEdge } from '../scripts/test-fixtures.mjs';

test('RGBA PNG 往返一致', async () => {
  const image = makeGradient(37, 23);
  const bytes = await encodeRgbaPng(image.rgba, image.width, image.height);
  const info = readPngInfo(bytes);
  assert.equal(info.width, 37);
  assert.equal(info.height, 23);
  assert.equal(info.colorType, 6);
  const decoded = await decodePng(bytes);
  assert.equal(decoded.width, 37);
  assert.equal(decoded.height, 23);
  assert.deepEqual(Array.from(decoded.rgba), Array.from(image.rgba));
});

test('索引 PNG 保留透明索引且能被自己解码', async () => {
  const image = makeTransparentEdge(24);
  const result = quantizeImage(image.rgba, image.width, image.height, {
    palette: [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
      { r: 240, g: 120, b: 60 },
    ],
    dither: 'none',
    alphaCutoff: 200,
  });
  const bytes = await encodeIndexedPng(result.indices, image.width, image.height, result.palette);
  const info = readPngInfo(bytes);
  assert.equal(info.isIndexed, true);
  assert.equal(info.paletteSize, result.palette.length);
  assert.equal(info.hasTransparency, true);
  const decoded = await decodePng(bytes);
  // 透明像素解码后必须还是透明，不能变成黑色
  for (let p = 0; p < image.width * image.height; p++) {
    const a = decoded.rgba[p * 4 + 3];
    const expected = result.rgba[p * 4 + 3];
    assert.equal(a, expected, `像素 ${p} 的 alpha 不一致`);
  }
});

test('低位深索引 PNG（2 色 → 1bit，4 色 → 2bit，16 色 → 4bit，其余 8bit）', async () => {
  for (const count of [2, 4, 16, 17, 40]) {
    const palette = Array.from({ length: count }, (_, i) => ({
      r: (i * 37) % 256,
      g: (i * 53) % 256,
      b: (i * 97) % 256,
    }));
    const width = 13;
    const height = 7;
    const indices = new Uint8Array(width * height);
    for (let p = 0; p < indices.length; p++) indices[p] = p % count;
    const bytes = await encodeIndexedPng(indices, width, height, palette);
    const info = readPngInfo(bytes);
    const depth = info.bitDepth;
    if (count <= 2) assert.equal(depth, 1);
    else if (count <= 4) assert.equal(depth, 2);
    else if (count <= 16) assert.equal(depth, 4);
    else assert.equal(depth, 8);
    const decoded = await decodePng(bytes);
    for (let p = 0; p < indices.length; p++) {
      const idx = indices[p];
      assert.equal(decoded.rgba[p * 4], palette[idx].r);
      assert.equal(decoded.rgba[p * 4 + 1], palette[idx].g);
      assert.equal(decoded.rgba[p * 4 + 2], palette[idx].b);
      assert.equal(decoded.rgba[p * 4 + 3], 255);
    }
  }
});

test('索引 PNG 的 tRNS 支持半透明索引（preserve 模式逐像素一致）', async () => {
  const width = 4;
  const height = 1;
  // 后两个都 >= 默认阈值 128，才会作为“半透明像素”保留 alpha。
  const alphas = [255, 192, 160, 0];
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) {
    rgba[x * 4] = 200;
    rgba[x * 4 + 1] = 120;
    rgba[x * 4 + 2] = 60;
    rgba[x * 4 + 3] = alphas[x];
  }
  const result = quantizeImage(rgba, width, height, {
    palette: [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
    ],
    dither: 'none',
    alphaMode: 'preserve',
  });
  const bytes = await encodeResult(result, 'indexed');
  const decoded = await decodePng(bytes);
  for (let x = 0; x < width; x++) {
    assert.equal(decoded.rgba[x * 4 + 3], alphas[x], `像素 ${x} 的 alpha 应保留`);
    // 半透明像素的 RGB 也应当与量化结果一致
    assert.equal(decoded.rgba[x * 4], result.rgba[x * 4]);
    assert.equal(decoded.rgba[x * 4 + 1], result.rgba[x * 4 + 1]);
    assert.equal(decoded.rgba[x * 4 + 2], result.rgba[x * 4 + 2]);
  }
});
  const width = 9;
  const height = 5;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = (i * 13) % 256;
  const bytes = await encodeGrayPng(gray, width, height);
  const decoded = await decodePng(bytes);
  for (let p = 0; p < gray.length; p++) {
    assert.equal(decoded.rgba[p * 4], gray[p]);
    assert.equal(decoded.rgba[p * 4 + 1], gray[p]);
    assert.equal(decoded.rgba[p * 4 + 2], gray[p]);
    assert.equal(decoded.rgba[p * 4 + 3], 255);
  }
});

test('大图 PNG 体积明显小于原始 RGBA', async () => {
  const image = makeGradient(256, 256);
  const bytes = await encodeRgbaPng(image.rgba, image.width, image.height);
  assert.ok(bytes.length < image.rgba.length / 2, `压缩后 ${bytes.length} vs ${image.rgba.length}`);
});
