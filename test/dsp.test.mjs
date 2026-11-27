// test/dsp.test.mjs — Node 内置测试运行器(node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32, quantizeChannel, quantizeSignal, dequantize,
  encodeWav, decodeWav, generateSignal, blockStats, histogram,
} from '../dsp.js';

test('确定性:同 seed 两次量化整数码逐位一致,换 seed 不同', () => {
  const sr = 8000;
  const sig = generateSignal('combo', sr).channels[0];
  const setting = { mode: 'tpdf', amp: 1, seed: 12345 };
  const a = quantizeSignal([sig], 4, setting);
  const b = quantizeSignal([sig], 4, setting);
  const c = quantizeSignal([sig], 4, { ...setting, seed: 12346 });
  assert.deepEqual(Array.from(a[0].codes), Array.from(b[0].codes));
  assert.equal(a[0].stats.hash, b[0].stats.hash);
  assert.notEqual(a[0].stats.hash, c[0].stats.hash);
});

test('直接量化无随机:扰动关闭时结果与 seed 无关', () => {
  const sig = generateSignal('fade', 8000).channels[0];
  const a = quantizeChannel(sig, 3, { mode: 'off', rng: mulberry32(1) });
  const b = quantizeChannel(sig, 3, { mode: 'off', rng: mulberry32(2) });
  assert.deepEqual(Array.from(a.codes), Array.from(b.codes));
});

test('量化码范围与边界:bits 位有符号整数,越界被截住', () => {
  const x = Float32Array.from([-1.5, -1, -0.999, 0, 0.999, 1, 1.5]);
  const q = quantizeChannel(x, 4, { mode: 'off' });
  assert.ok(q.codes.every((c) => c >= -8 && c <= 7));
  assert.deepEqual(Array.from(q.codes), [-8, -8, -8, 0, 7, 7, 7]);
  // 取整方向不对称:负侧 -7.992 直接落在 -8 轨,正侧 7.992 取整到 8 才越界
  assert.equal(q.stats.clipLo, 1);
  assert.equal(q.stats.clipHi, 3);
  assert.equal(q.stats.railNeg, 3);
  assert.equal(q.stats.railPos, 3);
});

test('TPDF 扰动统计无偏置(弱直流信号,均值误差接近 0)', () => {
  const n = 200000;
  const x = new Float32Array(n).fill(10 ** (-45 / 20)); // -45 dBFS 直流
  const q = quantizeChannel(x, 4, { mode: 'tpdf', amp: 1, rng: mulberry32(7) });
  assert.ok(Math.abs(q.stats.meanErrLsb) < 0.02, `mean=${q.stats.meanErrLsb} LSB`);
  assert.ok(q.stats.changedPct > 0.2, '弱信号应被扰动翻码,而非整段吃掉');
});

test('1 位直接量化把弱信号吃成静音', () => {
  const sig = generateSignal('quiet', 8000).channels[0];
  const q = quantizeChannel(sig, 1, { mode: 'off' });
  assert.equal(q.stats.changed, 0); // round(小量*1)=0,全部与量化零一致
  assert.ok(q.recon.every((v) => v === 0));
});

test('1 位扰动后弱信号重新出现', () => {
  const sig = generateSignal('quiet', 8000).channels[0];
  const q = quantizeChannel(sig, 1, { mode: 'tpdf', amp: 1, rng: mulberry32(9) });
  assert.ok(q.recon.some((v) => v !== 0));
  assert.ok(q.stats.changedPct > 0.1);
});

test('dequantize 与量化器还原一致', () => {
  const sig = generateSignal('combo', 8000).channels[0];
  const q = quantizeChannel(sig, 6, { mode: 'off' });
  const back = dequantize(q.codes, 6);
  assert.deepEqual(Array.from(back), Array.from(q.recon));
});

test('16 位 WAV 往返:偏置/声道/时长/逐样本一致', () => {
  const src = generateSignal('combo', 22050);
  const q = quantizeSignal(src.channels, 16, { mode: 'off', amp: 1, seed: 1 });
  const recon = q.map((r) => r.recon);
  const buf = encodeWav(recon, 22050, 16);
  const decoded = decodeWav(buf);
  assert.equal(decoded.numChannels, 1);
  assert.equal(decoded.sampleRate, 22050);
  assert.equal(decoded.bitsPerSample, 16);
  assert.equal(decoded.numFrames, src.channels[0].length);
  assert.ok(Math.abs(decoded.duration - src.channels[0].length / 22050) < 1e-9);
  let maxDiff = 0;
  for (let i = 0; i < decoded.numFrames; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(decoded.channels[0][i] - recon[0][i]));
  }
  assert.equal(maxDiff, 0, '16 位往返必须逐样本相同');
});

test('8 位 WAV 往返:无符号偏移码、偏置为零、逐样本一致', () => {
  const src = generateSignal('quiet', 16000);
  const q = quantizeSignal(src.channels, 8, { mode: 'off', amp: 1, seed: 1 });
  const buf = encodeWav([q[0].recon], 16000, 8);
  const decoded = decodeWav(buf);
  assert.equal(decoded.bitsPerSample, 8);
  let sum = 0;
  let maxDiff = 0;
  for (let i = 0; i < decoded.numFrames; i++) {
    sum += decoded.channels[0][i];
    maxDiff = Math.max(maxDiff, Math.abs(decoded.channels[0][i] - q[0].recon[i]));
  }
  assert.equal(maxDiff, 0);
  assert.ok(Math.abs(sum / decoded.numFrames) < 1e-6, '8 位偏移码不应产生直流偏置');
});

test('立体声往返保持声道数与各自内容', () => {
  const l0 = generateSignal('fade', 8000).channels[0];
  const r0 = generateSignal('quiet', 8000).channels[0];
  const l = quantizeChannel(l0, 16, { mode: 'off' }).recon;
  const r = quantizeChannel(r0, 16, { mode: 'off' }).recon;
  const buf = encodeWav([l, r], 8000, 16);
  const d = decodeWav(buf);
  assert.equal(d.numChannels, 2);
  let dl = 0, dr = 0;
  for (let i = 0; i < d.numFrames; i++) {
    dl = Math.max(dl, Math.abs(d.channels[0][i] - l[i]));
    dr = Math.max(dr, Math.abs(d.channels[1][i] - r[i]));
  }
  assert.equal(dl, 0);
  assert.equal(dr, 0);
});

test('低位数(4 位)经 16 位 WAV 容器往返保持低位数阶梯', () => {
  const sig = generateSignal('fullscale', 8000).channels[0];
  const q = quantizeChannel(sig, 4, { mode: 'off' });
  const buf = encodeWav([q.recon], 8000, 16);
  const d = decodeWav(buf);
  let maxDiff = 0;
  for (let i = 0; i < d.numFrames; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(d.channels[0][i] - q.recon[i]));
  }
  // 4 位电平是 1/8 的倍数,16 位容器可精确表示
  assert.ok(maxDiff < 1e-7);
  const levels = new Set(Array.from(d.channels[0]));
  assert.ok(levels.size <= 16);
});

test('分块统计覆盖全部采样且按时间标注', () => {
  const sig = generateSignal('combo', 10000).channels[0];
  const q = quantizeChannel(sig, 2, { mode: 'off' });
  const blocks = blockStats(sig, q.recon, 10000, 50);
  assert.equal(blocks[0].startSample, 0);
  assert.equal(blocks[blocks.length - 1].endSample, sig.length);
  assert.ok(blocks.every((b) => b.t1 > b.t0));
});

test('直方图计数守恒', () => {
  const sig = generateSignal('combo', 8000).channels[0];
  const h = histogram(sig, 64);
  const total = h.reduce((a, b) => a + b, 0);
  assert.equal(total, sig.length);
});

test('拒绝非 WAV 输入', () => {
  assert.throws(() => decodeWav(new ArrayBuffer(64)), /RIFF/);
});
