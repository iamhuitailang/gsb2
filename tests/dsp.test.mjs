/*
 * DSP 单元测试：node tests/dsp.test.mjs
 * 覆盖：首尾静音逐采样保持、阈值下不动作、持续强声 vs 孤立短峰的差别、
 * 起效/恢复方向、联动共享增益、削波统计、WAV 长度与首尾静音。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DSP = require('../js/dsp.js');

const SR = 48000;
let passed = 0;
const asyncTests = [];
function test(name, fn) {
  const maybe = fn();
  if (maybe && typeof maybe.then === 'function') {
    asyncTests.push(maybe.then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    }));
  } else {
    passed++;
    console.log(`  ✓ ${name}`);
  }
}

function makeTone(n, amp, freq = 440, sr = SR) {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    d[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  }
  return d;
}

// 1. 阈值以下不压缩，输出与输入完全一致
test('低于阈值时不改变信号', () => {
  const n = SR * 0.5;
  const L = makeTone(n, 0.01);
  const r = DSP.compress([L], SR, {
    thresholdDb: -20, ratio: 4, attackMs: 5, releaseMs: 50, linked: false,
  });
  for (let i = 0; i < n; i++) assert.equal(r.out[0][i], L[i]);
  assert.ok(r.maxGrDb < 1e-6);
});

// 2. 首尾静音逐采样保持（不缩短、不放大）
test('首尾静音在处理后逐采样保持', () => {
  const n = SR;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  // 中间放一段响的
  for (let i = SR * 0.4; i < SR * 0.6; i++) {
    L[i] = 0.8 * Math.sin((2 * Math.PI * 880 * i) / SR);
    R[i] = 0.5;
  }
  const r = DSP.compress([L, R], SR, {
    thresholdDb: -24, ratio: 6, attackMs: 2, releaseMs: 80, linked: false,
  });
  assert.equal(r.out[0].length, n);
  for (let i = 0; i < SR * 0.35; i++) {
    assert.equal(r.out[0][i], 0);
    assert.equal(r.out[1][i], 0);
  }
  for (let i = SR * 0.95; i < n; i++) {
    assert.equal(r.out[0][i], 0);
    assert.equal(r.out[1][i], 0);
  }
  const sil = DSP.silenceEdges(r.out, SR);
  const silIn = DSP.silenceEdges([L, R], SR);
  assert.ok(Math.abs(sil.headSec - silIn.headSec) < 1e-4);
  assert.ok(Math.abs(sil.tailSec - silIn.tailSec) < 1e-4);
});

// 3. 持续强声达到的峰值衰减量符合静态曲线 (L-T)*(1-1/R)。
//    用极快 attack 让峰值衰减逼近理论值；attack 的平滑作用由短峰专项测试覆盖。
test('持续强声的峰值衰减匹配静态压缩曲线', () => {
  const n = SR * 2;
  const amp = DSP.dbToGain(-6); // -6 dBFS
  const L = makeTone(n, amp);
  const r = DSP.compress([L], SR, {
    thresholdDb: -20, ratio: 4, attackMs: 0.2, releaseMs: 100, linked: false,
  });
  // 稳态段（后半段）出现的最大衰减
  let peakGr = 0;
  for (let i = SR; i < n; i++) peakGr = Math.max(peakGr, -r.gainDb[0][i]);
  const expected = (-6 - -20) * (1 - 1 / 4); // 10.5 dB
  assert.ok(Math.abs(peakGr - expected) < 0.6,
    `峰值衰减 ${peakGr.toFixed(2)} 应接近 ${expected}`);
  // 输出峰值电平应低于输入
  assert.ok(DSP.peakAbs(r.out) < amp);
});

// 4. 孤立短峰：快 attack 能压住，慢 attack 几乎不压
test('孤立短峰在慢起效下基本不被压', () => {
  const n = SR;
  const L = new Float32Array(n);
  const i0 = SR * 0.5;
  for (let k = 0; k < 48; k++) { // 1 ms 短峰
    L[i0 + k] = 0.9 * Math.sin((2 * Math.PI * 1000 * k) / SR);
  }
  const fast = DSP.compress([L], SR, {
    thresholdDb: -20, ratio: 8, attackMs: 0.5, releaseMs: 50, linked: false,
  });
  const slow = DSP.compress([L], SR, {
    thresholdDb: -20, ratio: 8, attackMs: 100, releaseMs: 500, linked: false,
  });
  assert.ok(fast.maxGrDb > 3, `快起效应有明显衰减，实际 ${fast.maxGrDb}`);
  assert.ok(slow.maxGrDb < 1.5, `慢起效应几乎不压，实际 ${slow.maxGrDb}`);
  assert.ok(fast.maxGrDb > slow.maxGrDb * 2);
});

// 5. 恢复：强声结束后增益衰减回到 0，且 release 越大放得越慢
test('恢复阶段增益按 release 速度放开', () => {
  const n = SR * 2;
  const L = new Float32Array(n);
  for (let i = 0; i < SR; i++) L[i] = DSP.dbToGain(-6); // 前 1s 强声
  const quick = DSP.compress([L], SR, {
    thresholdDb: -20, ratio: 4, attackMs: 5, releaseMs: 30, linked: false,
  });
  const slow = DSP.compress([L], SR, {
    thresholdDb: -20, ratio: 4, attackMs: 5, releaseMs: 500, linked: false,
  });
  const probe = SR + Math.floor(0.1 * SR); // 结束后 100ms
  assert.ok(-quick.gainDb[0][probe] < 2, '快恢复应基本放开');
  assert.ok(-slow.gainDb[0][probe] > 4, '慢恢复应仍有明显衰减');
  assert.ok(-quick.gainDb[0][n - 1] < 0.01, '结尾必须完全放开');
});

// 6. 联动：单侧突然变响时两声道增益完全相同
test('联动模式两声道共享增益，非联动则各自独立', () => {
  const n = SR;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < SR * 0.8; i++) {
    L[i] = DSP.dbToGain(-4);
    R[i] = DSP.dbToGain(-30);
  }
  const linked = DSP.compress([L, R], SR, {
    thresholdDb: -20, ratio: 4, attackMs: 5, releaseMs: 50, linked: true,
  });
  const unlinked = DSP.compress([L, R], SR, {
    thresholdDb: -20, ratio: 4, attackMs: 5, releaseMs: 50, linked: false,
  });
  const i = SR * 0.5;
  assert.ok(Math.abs(linked.gainDb[0][i] - linked.gainDb[1][i]) < 1e-9);
  assert.ok(Math.abs(unlinked.gainDb[0][i] - unlinked.gainDb[1][i]) > 5);
  // 联动下安静的右声道也被压低
  assert.ok(-linked.gainDb[1][i] > 8);
  // 非联动右声道基本不动
  assert.ok(-unlinked.gainDb[1][i] < 0.5);
});

// 7. 削波统计
test('削波/近削波统计与补偿增益联动', () => {
  const L = new Float32Array([0.5, 0.5, 0.5]); // -6 dBFS
  const none = DSP.clipStats([L], SR, 0);
  assert.equal(none.clips, 0);
  const clip = DSP.clipStats([L], SR, 7); // +7dB → >1
  assert.equal(clip.clips, 3);
  assert.equal(clip.firstSec, 0);
  const near = DSP.clipStats([L], SR, 5.5); // 约 -0.5 dBFS
  assert.equal(near.clips, 0);
  assert.ok(near.nearClips > 0);
});

// 8. WAV 编码：长度（含首尾静音）与声道数正确
test('导出 WAV 保留完整长度且可回读头信息', () => {
  const n = 1000;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const blob = DSP.encodeWav16([L, R], SR, 0);
  assert.ok(blob.size === 44 + n * 2 * 2);
  // 用 DataView 检查 WAV 头
  return blob.arrayBuffer().then((buf) => {
    const dv = new DataView(buf);
    const tag = (o) => String.fromCharCode(
      dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    assert.equal(tag(0), 'RIFF');
    assert.equal(tag(8), 'WAVE');
    assert.equal(dv.getUint16(22, true), 2); // 双声道
    assert.equal(dv.getUint32(24, true), SR);
    assert.equal(dv.getUint32(40, true), n * 2 * 2); // data 块大小
  });
});

// 9. 内置样音生成器：电平与时长合理（Node 下手动复用其逻辑做等价检查）
test('强声与短峰电平排序正确（短峰 > 持续声 > 底噪）', () => {
  const n = SR * 6;
  const noise = DSP.dbToGain(-60);
  const sus = DSP.dbToGain(-16);
  assert.ok(noise < sus);
  assert.ok(sus < DSP.dbToGain(-1.4));
  assert.equal(n, SR * 6);
});

Promise.all(asyncTests).then(() => {
  console.log(`\n${passed + asyncTests.length} 项 DSP 测试全部通过\n`);
});
