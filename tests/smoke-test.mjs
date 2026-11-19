// smoke-test.mjs — 零依赖冒烟测试：node tests/smoke-test.mjs
// 验证核心纯函数模块（wav-codec / audio-engine），浏览器 UI 不在此处测试。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeWavPCM, decodeWav } from '../js/wav-codec.js';
import {
  createOp, applyOps, computeStats, planNormalize,
  activeCutIntervals, originalToCurrentTime, currentToOriginalTime,
  visibleMarkers, currentDuration, isInCut,
  formatTime,
} from '../js/audio-engine.js';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
}
function approx(a, b, eps = 1e-4) { return Math.abs(a - b) <= eps; }

// ---------- 1. WAV 编码/解码往返 ----------
console.log('1) WAV PCM 编解码往返');
{
  const sr = 8000;
  const n = sr; // 1 秒
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
  for (const bits of [16, 24]) {
    const buf = encodeWavPCM([ch], sr, bits);
    const dec = decodeWav(buf);
    ok(`${bits}-bit 采样率/声道/帧数一致`,
      dec.sampleRate === sr && dec.numChannels === 1 && dec.numFrames === n);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(dec.channels[0][i] - ch[i]));
    ok(`${bits}-bit 往返误差符合量化精度`, maxErr < (bits === 16 ? 2e-4 : 1e-6), `maxErr=${maxErr}`);
  }
}

// ---------- 2. 处理链：非破坏性 + 顺序组合 + 可回退 ----------
console.log('2) 非破坏性处理链');
{
  const sr = 1000;
  const n = 1000;
  const src = [new Float32Array(n).fill(0.5)];
  const ops = [
    createOp('mute', 0.1, 0.2),
    createOp('gain', 0.0, 1.0, { gainDb: 6 }),
    createOp('fadeIn', 0.2, 0.4, { curve: 'linear' }),
    createOp('cut', 0.6, 0.8),
  ];
  const out = applyOps(src[0] ? src : src, sr, ops);
  ok('源数据完全未被修改', src[0].every((v) => v === 0.5));
  ok('剪切后帧数正确（1000 - 200 = 800）', out[0].length === 800, `got ${out[0].length}`);
  ok('静音区间（映射后）为 0', out[0][100] === 0 && out[0][150] === 0);
  ok('增益约 +6dB（系数 ≈ 2）', approx(out[0][50], 1.0, 0.01));
  ok('淡入起点为 0、终点达到增益值', out[0][200] === 0 && approx(out[0][399], 1.0, 0.02));

  // 旁路全部操作 → 与原始一致
  const bypassed = applyOps(src, sr, ops.map((o) => ({ ...o, enabled: false })));
  ok('全部旁路后逐采样等于原始', bypassed[0].every((v, i) => v === src[0][i]));

  // 重复应用不会累积（同样的链重算两次结果一致）
  const again = applyOps(src, sr, ops);
  ok('重复重算结果完全一致（无累积损失）',
    again[0].every((v, i) => v === out[0][i]));

  // 删除中间一步：从原始重算，等价于没有该步
  const ops2 = ops.filter((o) => o.type !== 'gain');
  const out2 = applyOps(src, sr, ops2);
  const expect = applyOps(src, sr, [
    createOp('mute', 0.1, 0.2),
    createOp('fadeIn', 0.2, 0.4, { curve: 'linear' }),
    createOp('cut', 0.6, 0.8),
  ]);
  ok('删除一步后与无该步的链结果一致', out2[0].every((v, i) => approx(v, expect[0][i], 1e-9)));
}

// ---------- 3. 归一化：实际峰值 + 静音文件清楚结果 ----------
console.log('3) 归一化与静音处理');
{
  const sr = 1000;
  const src = [new Float32Array(1000)];
  for (let i = 0; i < 1000; i++) src[0][i] = 0.1 * Math.sin((2 * Math.PI * 10 * i) / 1000);
  const plan = planNormalize(src, sr, [], 0, 1, -3);
  ok('按实际峰值计算增益', approx(plan.measuredPeak, 0.1, 1e-6) && approx(plan.gainDb, 17, 0.01));
  const op = createOp('normalize', 0, 1, { targetDb: -3 });
  const out = applyOps(src, sr, [op]);
  const st = computeStats(out, sr);
  ok('归一化后峰值达到 -3 dBFS', approx(st.globalPeakDb, -3, 0.01), `got ${st.globalPeakDb}`);
  ok('源峰值保持 0.1（非破坏）', approx(computeStats(src, sr).globalPeak, 0.1, 1e-6));

  const silent = [new Float32Array(500)];
  const sp = planNormalize(silent, sr, [], 0, 0.5, -1);
  ok('静音区间明确返回 silent=true 且不产生增益', sp.silent === true && sp.gain === 0);
  const sout = applyOps(silent, sr, [createOp('normalize', 0, 0.5, { targetDb: -1 })]);
  ok('静音归一化后仍为全 0', sout[0].every((v) => v === 0));
  ok('全静音统计 isSilent=true', computeStats(silent, sr).isSilent === true);
}

// ---------- 4. 原始时间线坐标模型（剪切旁路/重排/编辑/多剪切） ----------
console.log('4) 原始时间线坐标模型与标记一致性');
{
  const cuts = [{ start: 1, end: 2 }];
  // 原始 → 当前
  ok('映射：剪切前不变', originalToCurrentTime(0.5, cuts) === 0.5);
  ok('映射：剪切段内吸附到起点', originalToCurrentTime(1.5, cuts) === 1);
  ok('映射：剪切后左移 1s', originalToCurrentTime(3, cuts) === 2);
  ok('映射：剪切起点边界保留', originalToCurrentTime(1, cuts) === 1);
  ok('映射：剪切终点按之后处理', originalToCurrentTime(2, cuts) === 1);
  // 当前 → 原始（用户选区/定位）
  ok('逆映射：剪切前不变', currentToOriginalTime(0.5, cuts) === 0.5);
  ok('逆映射：剪切后补回 1s', currentToOriginalTime(2, cuts) === 3);
  ok('逆映射：界面起点 1s 对应原始 2s', currentToOriginalTime(1, cuts) === 2);
  // 多剪切
  const two = [{ start: 1, end: 2 }, { start: 5, end: 6 }];
  ok('多剪切：原始 7s → 当前 5s', originalToCurrentTime(7, two) === 5);
  ok('多剪切：当前 5s → 原始 7s', currentToOriginalTime(5, two) === 7);
  ok('多剪切合并：activeCutIntervals 合并重叠区间',
    activeCutIntervals([
      { enabled: true, type: 'cut', start: 1, end: 2 },
      { enabled: true, type: 'cut', start: 1.5, end: 2.5 },
    ]).length === 1);
  ok('旁路剪切不进入区间集合',
    activeCutIntervals([{ enabled: false, type: 'cut', start: 1, end: 2 }]).length === 0);
  ok('当前时长扣除全部剪切', currentDuration(8, two) === 6);
  ok('isInCut 判定', isInCut(1.5, cuts) === true && isInCut(2.5, cuts) === false);

  // 标记：存原始坐标，可见性与界面位置由纯函数推导
  const markers = [
    { id: 'a', name: 'A', time: 0.5 },
    { id: 'b', name: 'B', time: 1.5 },
    { id: 'c', name: 'C', time: 3.0 },
  ];
  const vis = visibleMarkers(markers, cuts);
  ok('标记：剪切前的不动', vis.find((m) => m.id === 'a').currentTime === 0.5);
  ok('标记：剪切区间内的隐藏', !vis.find((m) => m.id === 'b'));
  ok('标记：剪切后的界面时间左移', vis.find((m) => m.id === 'c').currentTime === 2.0);
  ok('标记：原始数据不被删除（旁路可恢复）', markers.length === 3);
}

// ---------- 4b. 审查回归：剪切旁路/重排/多剪切下 op 命中正确内容 ----------
console.log('4b) 剪切旁路与重排序的坐标自洽');
{
  const sr = 1000;
  // 8 秒源，用每帧唯一值便于追踪 op 实际命中的原始采样
  const src = [Float32Array.from({ length: 8000 }, (_, i) => i / 8000)];

  // cut[1,2] + gain 作用在"界面 3s"（=原始 4s）
  const cut = createOp('cut', 1, 2);
  const gainOrigStart = currentToOriginalTime(3, [{ start: 1, end: 2 }]); // = 4
  ok('界面 3s 换算到原始 4s', gainOrigStart === 4);
  const gain = createOp('gain', gainOrigStart, gainOrigStart + 1, { gainDb: 6 });
  const out = applyOps(src, sr, [cut, gain]);
  // 输出时间线 3.5s 对应原始 4.5s（落在增益区内，应被放大约 2 倍）
  const outFrame = Math.round(3.5 * sr);
  ok('剪切+增益：增益命中原始 4.5s 内容',
    approx(out[0][outFrame] / src[0][Math.round(4.5 * sr)], 2, 0.01),
    `ratio=${out[0][outFrame] / src[0][Math.round(4.5 * sr)]}`);
  // 增益区外（输出 0.5s = 原始 0.5s）不应被放大
  ok('增益区外保持原值', approx(out[0][Math.round(0.5 * sr)], src[0][Math.round(0.5 * sr)], 1e-9));

  // 旁路剪切：增益坐标不变，仍命中原始 4.5s（审查缺陷 #1 回归）
  cut.enabled = false;
  const bypassed = applyOps(src, sr, [cut, gain]);
  ok('旁路剪切后增益仍命中同一段原始内容（坐标不漂移）',
    approx(bypassed[0][Math.round(4.5 * sr)] / src[0][Math.round(4.5 * sr)], 2, 0.01));
  ok('旁路剪切后时长恢复为 8s', bypassed[0].length === 8000);
  cut.enabled = true;

  // 重排序：gain 与 cut 交换顺序，因坐标都是原始时间，结果一致（审查缺陷 #2 回归）
  const reordered = applyOps(src, sr, [gain, cut]);
  ok('重排序后输出与原顺序一致',
    reordered[0].every((v, i) => approx(v, out[0][i], 1e-9)));

  // 多段剪切：两段都生效，总时长正确，坐标无需任何手工重映射
  const cut2 = createOp('cut', 2.5, 3.0);
  const multi = applyOps(src, sr, [cut, cut2]);
  ok('两段剪切总帧数 8000-1000-500=6500', multi[0].length === 6500);

  // 删除剪切：直接从 ops 移除即可，其他 op 坐标无需改动（审查缺陷 #3 回归）
  const afterDelete = applyOps(src, sr, [gain]);
  ok('删除剪切后增益位置不变',
    approx(afterDelete[0][Math.round(4.5 * sr)] / src[0][Math.round(4.5 * sr)], 2, 0.01));
}

// ---------- 5. 工具函数 ----------
console.log('5) 工具函数');
ok('formatTime 格式正确', formatTime(65.25) === '01:05.250', formatTime(65.25));
ok('formatTime 毫秒进位到秒', formatTime(0.99996) === '00:01.000', formatTime(0.99996));
ok('formatTime 秒进位到分', formatTime(59.9999) === '01:00.000', formatTime(59.9999));
{
  const withNaN = [new Float32Array([0.1, NaN, 0.2, Infinity])];
  const st = computeStats(withNaN, 1000);
  ok('含 NaN/Infinity 不被误判为全静音', st.isSilent === false);
  ok('统计正确识别非法采样', st.hasInvalidSamples === true && st.invalidCount === 2);
}

// ---------- 6. 真实样音文件（若已生成） ----------
console.log('6) 样音文件解码');
for (const [file, sr, ch, dur] of [
  ['demo-stereo.wav', 44100, 2, 8.0],
  ['demo-silence.wav', 48000, 1, 3.0],
  ['demo-mono.wav', 22050, 1, 6.0],
]) {
  try {
    const buf = readFileSync(join(here, '..', 'samples', file)).buffer;
    const dec = decodeWav(buf);
    ok(`${file} 参数正确`,
      dec.sampleRate === sr && dec.numChannels === ch &&
      approx(dec.numFrames / sr, dur, 1e-3));
    const st = computeStats(dec.channels, sr);
    if (file === 'demo-silence.wav') {
      ok(`${file} 识别为全静音`, st.isSilent);
    } else {
      ok(`${file} 含明显峰值（>0.9）`, st.globalPeak > 0.9, `peak=${st.globalPeak}`);
    }
  } catch (e) {
    ok(`${file} 可读（先运行 python3 samples/generate_samples.py）`, false, e.message);
  }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
