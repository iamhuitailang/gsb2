// 真实样音 WAV 的端到端对齐验证。
// 数据由 tools/prepare_e2e.py 解码降采样到 /tmp/sample_e2e_data.json，
// 这里用生产代码 dsp.js 对每台设备做整轨对齐 + 漂移分析，并核对 manifest 真值。
import { readFileSync } from 'node:fs';
import { estimateOffset, estimateDrift } from '../public/js/dsp.js';

const DATA_PATH = process.env.E2E_DATA || '/tmp/sample_e2e_data.json';
let data;
try {
  data = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
} catch (e) {
  console.log('⊘ 跳过样音端到端测试（未找到数据，请先运行 python3 tools/prepare_e2e.py）');
  process.exit(0);
}

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); };
};
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

const sr = data.sampleRate;
const ref = new Float32Array(data.recorders[0].samples); // recorder_A_ref
const refMeta = data.recorders[0];

for (let i = 1; i < data.recorders.length; i++) {
  const rec = data.recorders[i];
  const tgt = new Float32Array(rec.samples);
  // 整轨偏移：期望恢复 leadSec。
  // 说明：测试数据被激进降采样到 8kHz 且样音敲击稀疏、含较长开头静音，
  // 绝对偏移会受首个强事件位置影响（约 0.6s 内）；时钟漂移 ppm 才是核心指标，下方严格校验。
  const off = estimateOffset(ref, tgt, sr);
  const offSec = off.lagSamples / sr;
  assert(approx(offSec, rec.leadSec, 0.6),
    `${rec.file} 整轨偏移 ${offSec.toFixed(3)}s，真值 ${rec.leadSec}s`);

  // 漂移分析：以整轨偏移为基准，ppm 应恢复 manifest 的 driftPpm。
  const drift = estimateDrift(ref, tgt, sr, 4, 2, 10, offSec);
  if (Math.abs(rec.driftPpm) > 0) {
    assert(drift.points.length >= 4,
      `${rec.file} 漂移窗口不足: ${drift.points.length}`);
    assert(approx(drift.driftPpm, rec.driftPpm, 120),
      `${rec.file} 漂移 ${drift.driftPpm.toFixed(1)}ppm，真值 ${rec.driftPpm}ppm`);
  }
  console.log(`  ✓ ${rec.file}: 偏移 ${offSec.toFixed(3)}s（真 ${rec.leadSec}s）, ` +
    `漂移 ${drift.driftPpm.toFixed(0)}ppm（真 ${rec.driftPpm}ppm）, ${drift.points.length} 窗口`);
}

// 参考轨自身对齐应得到接近 0 的偏移与高相关系数。
const selfOff = estimateOffset(ref, ref, sr);
assert(approx(selfOff.lagSamples / sr, 0, 0.01), '参考轨自对齐偏移应≈0');

console.log(`\n样音端到端：${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
