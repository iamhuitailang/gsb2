/*
 * Node 自动化测试（无第三方依赖）：
 *   node --test tests/
 *
 * 覆盖：WAV 编解码回读、处理链、折叠/相关度、Linkwitz-Riley 三频带、
 * 风险段落扫描、内置样例行为、以及“重设处理链后导出不继承旧设置”。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const WAV = require('../js/wav-codec.js');
const DSP = require('../js/dsp.js');
const Analysis = require('../js/analysis.js');
const Samples = require('../js/samples.js');

const SR = 48000;

function sine(freq, n, amp, phase = 0) {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    buf[i] = amp * Math.sin(2 * Math.PI * freq * i / SR + phase);
  }
  return buf;
}

// ---------------- WAV 编解码 ----------------

test('WAV 16-bit PCM 双声道编解码回读，峰值/帧数/声道数一致', () => {
  const n = SR;
  const l = sine(440, n, 0.8);
  const r = sine(660, n, 0.4);
  const blob = WAV.encodeWavPcm16([l, r], SR);
  // Node 环境下 Blob.arrayBuffer 可用
  return blob.arrayBuffer().then((ab) => {
    const d = WAV.decodeWav(ab);
    assert.equal(d.channels, 2);
    assert.equal(d.sampleRate, SR);
    assert.equal(d.length, n);
    assert.equal(d.bitsPerSample, 16);

    const result = WAV.verifyExport(ab, {
      channels: 2, sampleRate: SR, length: n, peak: 0.8, bitsPerSample: 16,
    });
    assert.ok(result.ok, result.errors.join(';'));
    // 16-bit 量化误差不超过 1 LSB
    assert.ok(Math.abs(d.data[0][100] - l[100]) <= 1 / 32767 + 1e-9);
  });
});

test('WAV 32-bit float 单声道（折叠版）往返无损', () => {
  const n = 24000;
  const mono = sine(300, n, 0.62);
  const blob = WAV.encodeWavFloat32([mono], SR);
  return blob.arrayBuffer().then((ab) => {
    const d = WAV.decodeWav(ab);
    assert.equal(d.channels, 1);
    assert.ok(d.isFloat);
    const result = WAV.verifyExport(ab, {
      channels: 1, sampleRate: SR, length: n, peak: 0.62, bitsPerSample: 32,
    });
    assert.ok(result.ok, result.errors.join(';'));
    assert.ok(Math.abs(d.data[0][123] - mono[123]) < 1e-6);
  });
});

test('非 WAVE 数据应抛出明确错误', () => {
  const bad = new ArrayBuffer(64);
  assert.throws(() => WAV.decodeWav(bad), /RIFF/);
});

// ---------------- 处理链 ----------------

test('反相折叠后单声道接近全静，恢复极性后还原', () => {
  const n = SR;
  const l = sine(240, n, 0.5);
  const r = Float32Array.from(l, (v) => -v);

  const folded = DSP.foldMono(l, r);
  assert.ok(DSP.rms(folded) < 1e-6);
  assert.ok(DSP.correlation(l, r) < -0.999);

  const fixed = DSP.applyChain(l, r, SR,
    Object.assign(DSP.defaultSettings(), { flipR: true }));
  const foldedFixed = DSP.foldMono(fixed.left, fixed.right);
  // 右声道再翻一次 → 与左声道同相
  assert.ok(Math.abs(DSP.rms(foldedFixed) - DSP.rms(l)) < 1e-6);
});

test('处理链不修改输入数组（原始数据不可变）', () => {
  const n = 1000;
  const l = sine(440, n, 0.5);
  const r = sine(440, n, 0.5);
  const l0 = l.slice();
  DSP.applyChain(l, r, SR,
    Object.assign(DSP.defaultSettings(), { flipL: true, delayRMs: 5, widthPct: 150 }));
  assert.deepEqual(Array.from(l), Array.from(l0));
});

test('宽度 0% 时左右声道均为 mid（单声化），100% 时保持原样', () => {
  const n = 1000;
  const l = sine(300, n, 0.6);
  const r = sine(500, n, 0.4);
  const w0 = DSP.applyChain(l, r, SR,
    Object.assign(DSP.defaultSettings(), { widthPct: 0 }));
  const mid = DSP.foldMono(l, r);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(w0.left[i] - mid[i]) < 1e-6);
    assert.ok(Math.abs(w0.right[i] - mid[i]) < 1e-6);
  }
  const w100 = DSP.applyChain(l, r, SR, DSP.defaultSettings());
  assert.deepEqual(Array.from(w100.left), Array.from(l));
  assert.deepEqual(Array.from(w100.right), Array.from(r));
});

test('延时在头部补零、尾部长度不变，延时帧数与 ms 换算正确', () => {
  const n = 2000;
  const l = sine(440, n, 0.5);
  const r = sine(440, n, 0.5);
  const ms = 10;
  const out = DSP.applyChain(l, r, SR,
    Object.assign(DSP.defaultSettings(), { delayLMs: ms }));
  const d = DSP.delaySamples(ms, SR);
  assert.equal(d, SR * ms / 1000);
  for (let i = 0; i < d; i++) assert.equal(out.left[i], 0);
  assert.equal(out.left.length, n);
  assert.ok(Math.abs(out.left[d + 50] - l[50]) < 1e-6);
});

test('等响补偿：单声道折叠变小时补偿增益把 RMS 拉回参考水平', () => {
  const n = SR;
  const l = sine(300, n, 0.5);
  const r = sine(300, n, 0.5);
  const gMono = DSP.compensationGain(l, r, 'mono');
  assert.ok(Math.abs(gMono - 1) < 1e-6); // 同相时折叠无损，无需补偿

  const r2 = Float32Array.from(l, (v) => -v * 0.9);
  const gAnti = DSP.compensationGain(l, r2, 'mono');
  assert.ok(gAnti > 1); // 折叠后能量变小 → 增益 > 1
  assert.ok(gAnti <= Math.pow(10, 12 / 20) + 1e-9); // 限制在 +12 dB 内
});

// ---------------- 频带 ----------------

test('零相位 FFT 三频带相加精确还原原信号', () => {
  const n = SR * 2;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sig[i] = 0.4 * Math.sin(2 * Math.PI * 100 * i / SR)
      + 0.3 * Math.sin(2 * Math.PI * 1000 * i / SR)
      + 0.25 * Math.sin(2 * Math.PI * 8000 * i / SR);
  }
  const bands = DSP.splitBands(sig, SR);
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    const recon = bands.low[i] + bands.mid[i] + bands.high[i];
    maxErr = Math.max(maxErr, Math.abs(recon - sig[i]));
  }
  assert.ok(maxErr < 1e-5, '最大重建误差 ' + maxErr);
});

test('高频反相样例：高频折叠损失严重，低中频保留（区分频带消失与整体变小）', () => {
  const s = Samples.generate('bandcancel');
  const stats = DSP.bandStats(s.left, s.right, s.sampleRate,
    Math.round(SR * 0.3), s.left.length - Math.round(SR * 0.3));
  assert.ok(stats.high.foldDb <= -12, '高频损失应为 ≥12 dB，实际 ' + stats.high.foldDb);
  assert.ok(stats.low.foldDb > -3, '低频应基本无损，实际 ' + stats.low.foldDb);
  assert.ok(stats.mid.foldDb > -3, '中频应基本无损，实际 ' + stats.mid.foldDb);
  const verdict = Analysis.foldVerdict(stats);
  assert.equal(verdict.level, 'danger');
  assert.match(verdict.text, /高频/);
});

test('全反相样例：有内容的频带同时损失，判定为整体变小', () => {
  const s = Samples.generate('antiphase');
  const stats = DSP.bandStats(s.left, s.right, s.sampleRate,
    Math.round(SR * 0.3), s.left.length - Math.round(SR * 0.3));
  ['low', 'mid', 'high'].forEach((band) => {
    // 无内容的频带 foldDb 为 null 是正确行为；有内容的必须严重抵消
    if (stats[band].foldDb !== null) assert.ok(stats[band].foldDb <= -20);
  });
  assert.ok(stats.low.foldDb <= -20 && stats.mid.foldDb <= -20 && stats.high.foldDb <= -20);
  assert.equal(Analysis.foldVerdict(stats).level, 'warn');
});

// ---------------- 段落扫描与样例 ----------------

test('同相样例：无抵消/单边段落，全局状态 ok', () => {
  const s = Samples.generate('inphase');
  const segs = Analysis.scanSegments(s.left, s.right, s.sampleRate);
  assert.ok(!segs.some((x) => x.kind === 'cancel'));
  assert.equal(Analysis.globalState(s.left, s.right).state, 'ok');
});

test('反相样例：扫描出折叠抵消段落，相关度为负且损失 > 6 dB', () => {
  const s = Samples.generate('antiphase');
  const segs = Analysis.scanSegments(s.left, s.right, s.sampleRate);
  const cancel = segs.filter((x) => x.kind === 'cancel');
  assert.ok(cancel.length >= 1);
  assert.ok(cancel[0].maxFoldLossDb <= Analysis.thresholds.CANCEL_FOLD_DB);
  assert.ok(cancel[0].minCorr <= Analysis.thresholds.CANCEL_CORR);
});

test('单边静音样例：识别 one-sided 并指出有效侧为 L', () => {
  const s = Samples.generate('onesided');
  const segs = Analysis.scanSegments(s.left, s.right, s.sampleRate);
  assert.ok(segs.some((x) => x.kind === 'one-sided'));
  const g = Analysis.globalState(s.left, s.right);
  assert.equal(g.state, 'one-sided');
  assert.equal(g.side, 'L');
});

test('样例首尾静音区被识别为 silence 段落', () => {
  const s = Samples.generate('inphase');
  const segs = Analysis.scanSegments(s.left, s.right, s.sampleRate);
  assert.ok(segs.some((x) => x.kind === 'silence'));
});

test('全零信号：全局状态 silence，补偿增益回退为 1', () => {
  const z = new Float32Array(SR);
  assert.equal(Analysis.globalState(z, z).state, 'silence');
  assert.equal(DSP.compensationGain(z, z, 'mono'), 1);
});

// ---------------- 导出不继承旧设置 ----------------

test('重设处理链后重新导出：每次按当前设置现场计算，不继承上一次设置', async () => {
  const n = SR;
  const l = sine(300, n, 0.5);
  const r = sine(310, n, 0.5);

  // 第一次导出：右声道反相 + 延时 5ms + 宽度 140%
  const settingsA = {
    flipL: false, flipR: true, delayLMs: 0, delayRMs: 5, widthPct: 140,
  };
  const outA = DSP.applyChain(l, r, SR, settingsA);
  const blobA = WAV.encodeWavPcm16([outA.left, outA.right], SR);
  const bufA = WAV.decodeWav(await blobA.arrayBuffer());

  // “重设处理链”——回到默认设置，再导出
  const settingsB = DSP.defaultSettings();
  const outB = DSP.applyChain(l, r, SR, settingsB);
  const blobB = WAV.encodeWavPcm16([outB.left, outB.right], SR);
  const bufB = WAV.decodeWav(await blobB.arrayBuffer());

  // 两次导出结果必须不同（旧设置没有被继承）
  let diff = 0;
  for (let i = 0; i < n; i++) {
    diff = Math.max(diff, Math.abs(bufB.data[1][i] - bufA.data[1][i]));
  }
  assert.ok(diff > 0.1, '两次导出应有显著差异，实际最大差 ' + diff);

  // 第二次导出必须等于“原始信号直接编码”的结果
  const blobRef = WAV.encodeWavPcm16([l, r], SR);
  const bufRef = WAV.decodeWav(await blobRef.arrayBuffer());
  let err = 0;
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < n; i++) {
      err = Math.max(err, Math.abs(bufB.data[c][i] - bufRef.data[c][i]));
    }
  }
  assert.ok(err <= 1 / 32767 + 1e-9, '重设后导出应等同原始信号，误差 ' + err);

  // 同设置导出的单声道版与双声道折叠版一致
  const mono = DSP.foldMono(outB.left, outB.right);
  const blobM = WAV.encodeWavPcm16([mono], SR);
  const verify = WAV.verifyExport(await blobM.arrayBuffer(), {
    channels: 1, sampleRate: SR, length: n, peak: DSP.peak(mono), bitsPerSample: 16,
  });
  assert.ok(verify.ok, verify.errors.join(';'));
});

test('总览降采样桶数与每桶字段完整', () => {
  const n = SR * 3;
  const l = sine(440, n, 0.5);
  const r = sine(440, n, 0.5);
  const ov = DSP.buildOverview(l, r, 300);
  assert.equal(ov.length, 300);
  for (const b of ov) {
    assert.ok('peakL' in b && 'corr' in b && 'foldDb' in b && 'rmsM' in b);
  }
});
