import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJs } from './helpers/paths.mjs';

const TS = loadJs('time-stretch.js');
const Samples = loadJs('samples.js');
const AudioAnalyze = loadJs('analyze.js');

const SR = Samples.SR;
const CH_DELAY = Samples.CH_DELAY; // 1323 采样 = 30ms

function middle(arr, lenSec = 1) {
  const len = Math.floor(SR * lenSec);
  const start = Math.floor((arr.length - len) / 2);
  return arr.subarray(start, start + len);
}

test('速度超范围与输入过短被拒绝，并给出可读说明', () => {
  const ch = new Float32Array(44100);
  assert.throws(() => TS.stretch([ch], 0.1, 'pitch'), /超出可用范围/);
  assert.throws(() => TS.stretch([ch], 5, 'pitch'), /超出可用范围/);
  assert.throws(() => TS.stretch([new Float32Array(100)], 1, 'pitch'), /输入过短/);
  assert.throws(() => TS.stretch([ch], NaN, 'pitch'), /速度参数无效/);
});

test('两种模式输出长度都精确等于 round(源长度/rate)', () => {
  const n = 44100;
  const ch = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 220 * i / SR));
  for (const mode of ['pitch', 'resample']) {
    for (const rate of [0.25, 0.5, 0.75, 1, 1.5, 2, 4]) {
      const r = TS.stretch([Float32Array.from(ch)], rate, mode);
      assert.equal(r.outputFrames, Math.round(n / rate),
        mode + ' @ ' + rate + 'x');
      assert.equal(r.channels[0].length, r.outputFrames);
    }
  }
});

test('rate=1 时两种模式均为恒等长度且能量量级正常', () => {
  const s = Samples.buildSustain();
  for (const mode of ['pitch', 'resample']) {
    const r = TS.stretch(s.channels.map((c) => c.slice()), 1, mode);
    assert.equal(r.outputFrames, s.channels[0].length);
    let energy = 0;
    for (const v of r.channels[0]) energy += v * v;
    assert.ok(energy / r.outputFrames > 0.01, mode + ' 信号能量不应消失');
  }
});

test('保音高模式：连续音在 0.5x~2x 下基频漂移 < 3%', () => {
  const s = Samples.buildSustain();
  const srcPitch = AudioAnalyze.estimatePitch(middle(s.channels[0]), SR);
  assert.ok(srcPitch);
  for (const rate of [0.5, 0.75, 1, 1.5, 2]) {
    const r = TS.wsola(s.channels.map((c) => c.slice()), rate);
    const p = AudioAnalyze.estimatePitch(middle(r.channels[0]), SR);
    assert.ok(p, rate + 'x 应能检出基频');
    const drift = Math.abs(p.frequency - srcPitch.frequency) / srcPitch.frequency;
    assert.ok(drift < 0.03,
      'WSOLA ' + rate + 'x 音高漂移 ' + (drift * 100).toFixed(2) + '%');
  }
});

test('原始变速模式：重采样音高随速率变化（0.5x 降八度、2x 升八度）', () => {
  const s = Samples.buildSustain();
  const srcPitch = AudioAnalyze.estimatePitch(middle(s.channels[0]), SR);
  const slow = TS.resample(s.channels.map((c) => c.slice()), 0.5);
  const pSlow = AudioAnalyze.estimatePitch(middle(slow.channels[0], 1.5), SR);
  assert.ok(Math.abs(pSlow.frequency / srcPitch.frequency - 0.5) < 0.03,
    '0.5x 重采样音高应约为一半');

  const fast = TS.resample(s.channels.map((c) => c.slice()), 2);
  const pFast = AudioAnalyze.estimatePitch(middle(fast.channels[0], 0.8), SR);
  assert.ok(Math.abs(pFast.frequency / srcPitch.frequency - 2) < 0.03,
    '2x 重采样音高应约为两倍');
});

test('时长比 ≈ 1/rate（两种模式）', () => {
  const s = Samples.buildSustain();
  const n = s.channels[0].length;
  for (const mode of ['pitch', 'resample']) {
    for (const rate of [0.5, 1, 2]) {
      const r = TS.stretch(s.channels.map((c) => c.slice()), rate, mode);
      const ratio = r.outputFrames / n;
      assert.ok(Math.abs(ratio - 1 / rate) < 1 / n + 1e-9,
        mode + ' @ ' + rate + 'x 时长比 ' + ratio);
    }
  }
});

test('短重音位置随时间轴按 1/rate 平移，重音不丢失', () => {
  const s = Samples.buildAccent();
  const src = AudioAnalyze.findAccents(s.channels[0], SR);
  assert.equal(src.length, 2);
  for (const rate of [0.5, 1, 2]) {
    const r = TS.wsola(s.channels.map((c) => c.slice()), rate);
    const accents = AudioAnalyze.findAccents(r.channels[0], SR);
    assert.ok(accents.length >= 2, rate + 'x 两个重音都应保留');
    for (let k = 0; k < 2; k++) {
      const expected = src[k] / rate;
      const got = accents[k];
      assert.ok(Math.abs(got - expected) < 0.05,
        rate + 'x 重音[' + k + '] 期望 ' + expected.toFixed(3) + 's 实际 ' + got.toFixed(3) + 's');
    }
  }
});

test('立体声脉冲：两声道事件位置各自按 1/rate 映射（含声道间延迟）', () => {
  // 脉冲是时间位置最确定的探针：左声道一个脉冲，右声道同脉冲延迟 d。
  // 处理后两声道的事件时刻都应映射到 1/rate，声道间延迟随之缩放。
  // 脉冲放在中段，避开首尾淡出；WSOLA 加窗会把窄脉冲峰推后约半个
  // 分析帧（~23ms），容差按 FRAME_LEN/SR 给。
  const n = SR * 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const pL = Math.round(0.7 * SR);
  const d = 1323;
  // 短脉冲（占 8 个采样）而非单点：单点脉冲在整数倍重采样步进下
  // 可能被整步跳过，短脉冲对两种算法都稳健，也更贴近真实重音
  for (let k = 0; k < 8; k++) {
    L[pL + k] = 1;
    R[pL + d + k] = 1;
  }
  const frameTol = TS.FRAME_LEN; // 容差以采样计，约 46ms

  for (const mode of ['pitch', 'resample']) {
    for (const rate of [0.5, 1, 2]) {
      const r = TS.stretch([L, R], rate, mode);
      // 找全局最大峰（全零段不会胜出）
      const maxPeak = (ch) => {
        let bi = 0;
        let bv = -Infinity;
        for (let i = 0; i < ch.length; i++) if (ch[i] > bv) { bv = ch[i]; bi = i; }
        return bi;
      };
      const a = maxPeak(r.channels[0]);
      const b = maxPeak(r.channels[1]);
      assert.ok(Math.abs(a - pL / rate) <= frameTol,
        mode + ' @' + rate + ' 左声道事件位置 ' + a + ' 期望 ~' + pL / rate);
      assert.ok(Math.abs(b - (pL + d) / rate) <= frameTol,
        mode + ' @' + rate + ' 右声道事件位置 ' + b + ' 期望 ~' + (pL + d) / rate);
      const lagErr = Math.abs((b - a) - d / rate);
      assert.ok(lagErr <= frameTol,
        mode + ' @' + rate + ' 声道延迟误差 ' + lagErr + ' 采样');
    }
  }
});

test('单声道输入正常处理，输出仍为单声道', () => {
  const mono = new Float32Array(SR);
  for (let i = 0; i < SR; i++) mono[i] = 0.4 * Math.sin(2 * Math.PI * 330 * i / SR);
  const r = TS.wsola([mono], 0.5);
  assert.equal(r.channels.length, 1);
  assert.equal(r.outputFrames, SR * 2);
});
