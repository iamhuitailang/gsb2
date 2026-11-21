import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, computeEdgeMetrics, computeSSIM } from '../src/metrics.js';
import { quantizeImage } from '../src/quantize.js';
import { makeGradient, makeTransparentEdge } from '../scripts/test-fixtures.mjs';

const BW = [
  { r: 0, g: 0, b: 0 },
  { r: 255, g: 255, b: 255 },
];

test('参考图与结果图完全相同时误差为零', () => {
  const image = makeGradient(32, 24);
  const metrics = computeMetrics(image.rgba, image.rgba, image.width, image.height);
  assert.equal(metrics.mae, 0);
  assert.equal(metrics.mse, 0);
  assert.equal(metrics.deltaE76Mean, 0);
  assert.equal(metrics.psnr, 99);
  assert.equal(metrics.alphaMismatchPixels, 0);
});

test('透明像素不计入颜色误差', () => {
  const width = 8;
  const height = 8;
  const reference = new Uint8ClampedArray(width * height * 4);
  const quantized = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    // 透明像素的 RGB 可以任意不同，不应影响指标
    reference[i] = 255;
    reference[i + 3] = 0;
    quantized[i] = 0;
    quantized[i + 3] = 0;
  }
  const metrics = computeMetrics(reference, quantized, width, height, { alphaCutoff: 128 });
  assert.equal(metrics.mae, 0);
  assert.equal(metrics.transparentPixels, width * height);
  assert.equal(metrics.sampledPixels, 0);
});

test('透明/不透明不一致会单独计数', () => {
  const width = 4;
  const height = 1;
  const reference = new Uint8ClampedArray(width * height * 4);
  const quantized = new Uint8ClampedArray(width * height * 4);
  // 参考图：像素 0 透明，其余不透明。
  for (let p = 0; p < width; p++) reference[p * 4 + 3] = p === 0 ? 0 : 255;
  // 结果图：全部不透明 → 像素 0 判定不一致。
  for (let p = 0; p < width; p++) quantized[p * 4 + 3] = 255;
  const metrics = computeMetrics(reference, quantized, width, height);
  assert.equal(metrics.alphaMismatchPixels, 1);
  assert.equal(metrics.transparentPixels, 1);
});

test('MAE 与 PSNR 对黑→白错误的数值符合定义', () => {
  const width = 2;
  const height = 1;
  const reference = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
  const quantized = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  const metrics = computeMetrics(reference, quantized, width, height);
  assert.ok(Math.abs(metrics.mae - 0.5) < 1e-9, `MAE 应为 0.5，得到 ${metrics.mae}`);
  assert.ok(Math.abs(metrics.mse - 65025 / 2) < 1e-6);
  // 一半像素完全一致 → PSNR 由 MSE 决定：10log10(65025/(65025/2)) ≈ 3.01 dB
  assert.ok(Math.abs(metrics.psnr - 3.0103) < 0.001);
});

test('边缘指标识别掩码不一致', () => {
  const width = 4;
  const height = 1;
  const reference = new Uint8ClampedArray(width * height * 4);
  const quantized = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width; p++) {
    reference[p * 4 + 3] = p < 2 ? 255 : 0;
    quantized[p * 4 + 3] = p < 2 ? 255 : 0;
  }
  const same = computeEdgeMetrics(reference, quantized, width, height, 128);
  assert.equal(same.maskMismatchPixels, 0);
  assert.ok(same.edgePixels > 0);
  assert.equal(same.edgeMismatchPixels, 0);

  // 把像素 1 在结果里改成透明 → 产生一个不一致，且它紧邻透明区，应算作边缘不一致。
  quantized[1 * 4 + 3] = 0;
  const diff = computeEdgeMetrics(reference, quantized, width, height, 128);
  assert.equal(diff.maskMismatchPixels, 1);
  assert.equal(diff.edgeMismatchPixels, 1);
});

test('SSIM 对相同图像为 1', () => {
  const image = makeGradient(16, 16);
  const ssim = computeSSIM(image.rgba, image.rgba, image.width, image.height);
  assert.ok(ssim > 0.9999, `SSIM 应接近 1，得到 ${ssim}`);
});

test('量化后指标合理：2 色重编码误差存在但不为 NaN', () => {
  const image = makeGradient(48, 32);
  const result = quantizeImage(image.rgba, image.width, image.height, { palette: BW, dither: 'none' });
  const metrics = computeMetrics(image.rgba, result.rgba, image.width, image.height);
  for (const key of ['mae', 'mse', 'rmse', 'psnr', 'deltaE76Mean', 'deltaE76Max']) {
    assert.ok(Number.isFinite(metrics[key]), `${key} 不是有限值`);
  }
  assert.ok(metrics.mae > 0);
});

test('透明边缘图的指标不会把透明区当成色差', () => {
  const image = makeTransparentEdge(40);
  const result = quantizeImage(image.rgba, image.width, image.height, { palette: BW, dither: 'atkinson' });
  const metrics = computeMetrics(image.rgba, result.rgba, image.width, image.height, { alphaCutoff: 128 });
  assert.ok(metrics.transparentPixels > 0);
  assert.equal(metrics.alphaMismatchPixels, 0, '透明判定不应改变');
  assert.ok(metrics.mae >= 0);
});
