// Node 无头自测：node --check 之外的功能验证。运行：node test/selftest.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// 浏览器脚本以 globalThis 为根挂在 RoomLab 上，vm 沙箱里等价运行
const sandbox = { globalThis: {}, console, Math, Float32Array, Float64Array, performance: { now: () => Date.now() } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['dsp.js', 'wav.js', 'generators.js', 'analyze.js', 'render.js']) {
  vm.runInContext(readFileSync(join(root, 'js', f), 'utf8'), sandbox, { filename: f });
}
const RL = sandbox.RoomLab;

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
async function main() {
  const { dsp, wav, generators, analyze, render } = RL;

  console.log('1. FFT 卷积 vs 朴素卷积（含 overlap-save 路径）');
  {
    const rng = dsp.makeRng(7);
    const x = Float32Array.from({ length: 5000 }, () => rng() * 2 - 1);
    const h = Float32Array.from({ length: 300 }, () => rng() * 2 - 1);
    const naive = new Float32Array(x.length + h.length - 1);
    for (let i = 0; i < x.length; i++)
      for (let k = 0; k < h.length; k++) naive[i + k] += x[i] * h[k];
    const full = dsp.convolveFull(x, h);
    const os = dsp.convolveOverlapSave(x, h);
    let errFull = 0, errOS = 0;
    for (let i = 0; i < naive.length; i++) {
      errFull = Math.max(errFull, Math.abs(full[i] - naive[i]));
      errOS = Math.max(errOS, Math.abs(os[i] - naive[i]));
    }
    // float32 FFT 累积误差在 5000×300 规模下约 1e-5 量级
    check('单次 FFT 卷积误差 < 5e-5', errFull < 5e-5, `err=${errFull}`);
    check('overlap-save 与朴素卷积一致（误差 < 1e-4）', errOS < 1e-4, `err=${errOS}`);
    check('输出长度 = N+M-1', full.length === x.length + h.length - 1);
    // 单位脉冲卷积恒等
    const delta = new Float32Array(1); delta[0] = 1;
    const id = dsp.convolve(x, delta);
    check('单位脉冲卷积恒等', id.length === x.length && id.every((v, i) => Math.abs(v - x[i]) < 1e-9));
  }

  console.log('2. 内置素材规格');
  {
    const dry = generators.dry.map((fn) => fn());
    const rooms = generators.rooms.map((fn) => fn());
    check('4 段干声均为 48kHz 单声道', dry.every((d) => d.sampleRate === 48000 && d.channels.length === 1));
    check('2 份房间响应均为 48kHz 立体声', rooms.every((r) => r.sampleRate === 48000 && r.channels.length === 2));
    check('小房间约 1.0s、大厅约 2.6s',
      Math.abs(rooms[0].channels[0].length / 48000 - 1.0) < 0.01 &&
      Math.abs(rooms[1].channels[0].length / 48000 - 2.6) < 0.01);
    check('两份响应长度不同（可对比场景成立）',
      rooms[0].channels[0].length !== rooms[1].channels[0].length);
    const peak = Math.max(...rooms.flatMap((r) => r.channels.map(dsp.peakOf)));
    check('响应已归一化（峰值 0.7）', Math.abs(peak - 0.7) < 1e-6, `peak=${peak}`);
  }

  console.log('3. 分析：首波、反射、RT60、片尾');
  {
    const room = generators.rooms[1]();
    const a = analyze.analyzeIR(room);
    check('首波定位在预延迟 32ms 附近', Math.abs(a.first.timeMs - 32) < 2, `got=${a.first.timeMs}`);
    check('检出主要反射', a.reflections.length >= 3, `n=${a.reflections.length}`);
    // 实测包络受低通阻尼与 2.6s 截断影响，RT60 估计小于理论 tau 设定值，属预期
    check('RT60 可估计且处于大厅量级（0.5~2.0s）',
      a.rt60 != null && a.rt60 > 0.5 && a.rt60 < 2.0, `rt60=${a.rt60}`);
    check('片尾长度 > 0 且不超过总时长', a.tail.tailSec > 0.5 && a.tail.tailSec <= a.durationSec);
    const cmp = analyze.compareIRs(generators.rooms[0](), generators.rooms[1]());
    check('对比报告长度比值 ≈ 2.6', Math.abs(cmp.lengthRatio - 2.6) < 0.05);
  }

  console.log('4. 渲染管线：预延迟、片尾保留、声道映射');
  {
    const dry = generators.dry[1]();
    const room = generators.rooms[0]();
    const r = await render.renderMix(dry, room, { preDelayMs: 50, wetGain: 0.8, normalize: false }, null);
    const sr = 48000;
    const expectedLen = dry.channels[0].length + Math.round(0.05 * sr) + room.channels[0].length - 1;
    check('输出长度 = 干声 + 预延迟 + 响应 - 1（片尾完整）',
      r.verify.frames === expectedLen, `${r.verify.frames} vs ${expectedLen}`);
    check('预延迟偏移前湿声有效为零（第一声不错位）',
      r.wet[0].subarray(0, r.verify.preDelaySamples).every((v) => Math.abs(v) < 1e-10) &&
      r.verify.preDelaySamples === Math.round(0.05 * sr));
    // 用脉冲干声验证湿声对齐：脉冲在 50ms，用户预延迟 50ms，
    // 再加上小房间 IR 自身 12ms 的内置预延迟 → 首峰在 112ms
    const pulse = generators.dry[0]();
    const rp = await render.renderMix(pulse, room, { preDelayMs: 50, wetGain: 1, normalize: false }, null);
    const pulseAt = Math.round(0.05 * sr);
    const irBuiltIn = Math.round(0.012 * sr);
    const expectedWetPeak = pulseAt + rp.verify.preDelaySamples + irBuiltIn;
    let peakIdx = 0, peakVal = 0;
    for (let i = 0; i < rp.wet[0].length; i++) {
      if (Math.abs(rp.wet[0][i]) > peakVal) { peakVal = Math.abs(rp.wet[0][i]); peakIdx = i; }
    }
    check('湿声首峰 = 脉冲 + 用户预延迟 + IR 内置预延迟（第一声严格对齐）',
      peakIdx === expectedWetPeak, `peak@${peakIdx}, expected ${expectedWetPeak}`);
    check('干声 stem 与输入一致（未被延迟移动）',
      r.dry[0].subarray(0, dry.channels[0].length).every((v, i) => Math.abs(v - dry.channels[0][i]) < 1e-9));
    // 立体声独立性：L/R 不完全相同
    let lrDiff = 0;
    for (let i = 0; i < r.wet[0].length; i++) lrDiff = Math.max(lrDiff, Math.abs(r.wet[0][i] - r.wet[1][i]));
    check('立体声 L/R 独立（未串道）', lrDiff > 0.01, `diff=${lrDiff}`);

    // 声道适配：立体声干声 → 单声道响应
    const stereoDry = { name: 's', sampleRate: sr, channels: [dry.channels[0], dry.channels[0].map((v) => -v)] };
    const monoIR = { name: 'm', sampleRate: sr, channels: [room.channels[0]] };
    const adapted = render.adaptChannels(stereoDry.channels, monoIR.channels);
    check('立体声干声 + 单声道响应 → 单声道输出', adapted.outCh === 1 && adapted.log.some((l) => l.includes('叠加')));
    const r2 = await render.renderMix(stereoDry, monoIR, { preDelayMs: 0, wetGain: 1, normalize: false }, null);
    check('单声道输出只有 1 条通道', r2.outCh === 1 && r2.mix.length === 1);
  }

  console.log('5. 采样率不一致的处理（线性回退路径）');
  {
    const dry48 = generators.dry[0]();
    const room = generators.rooms[0]();
    const dry44 = {
      name: '44.1k 干声',
      sampleRate: 44100,
      channels: [dsp.resampleLinear(dry48.channels, 48000, 44100)[0]],
    };
    const r = await render.renderMix(dry44, room, { preDelayMs: 0, wetGain: 1, normalize: true }, null);
    check('目标采样率取较大值 48000', r.sampleRate === 48000);
    check('日志记录了重采样动作', r.log.some((l) => l.includes('重采样')));
    const expected = Math.round(dry44.channels[0].length * 48000 / 44100);
    check('重采样后帧数按比例换算', Math.abs(r.verify.dryFrames - expected) <= 1,
      `${r.verify.dryFrames} vs ${expected}`);
  }

  console.log('6. WAV 导出与回读核对（三种位深）');
  {
    const dry = generators.dry[0]();
    const room = generators.rooms[0]();
    const r = await render.renderMix(dry, room, { preDelayMs: 20, wetGain: 1, normalize: true }, null);
    for (const bd of [16, 24, '32f']) {
      const buf = wav.encodeWav(r.mix, r.sampleRate, bd);
      const dec = wav.decodeWav(buf);
      let maxDiff = 0;
      for (let c = 0; c < dec.channels.length; c++)
        for (let i = 0; i < dec.channels[0].length; i++)
          maxDiff = Math.max(maxDiff, Math.abs(dec.channels[c][i] - r.mix[c][i]));
      const tol = bd === 16 ? 1e-4 : bd === 24 ? 1e-6 : 1e-6;
      check(`WAV ${bd} 回读采样率/声道/帧数一致且误差达标`,
        dec.sampleRate === r.sampleRate && dec.channels.length === r.outCh &&
        dec.channels[0].length === r.mix[0].length && maxDiff < tol, `maxDiff=${maxDiff}`);
    }
    // 回读：干声有效内容之后仍有尾声（用最后一个非零采样定位，不依赖缓冲长度）
    const buf = wav.encodeWav(r.mix, r.sampleRate, 16);
    const dec = wav.decodeWav(buf);
    const env = analyze.envelope({ channels: dec.channels });
    let dryLastNz = 0;
    for (let i = 0; i < r.dry[0].length; i++) if (Math.abs(r.dry[0][i]) > 1e-9) dryLastNz = i;
    check('导出文件干声有效内容后仍有尾声能量',
      env.subarray(dryLastNz + 1).some((v) => v > 0.001),
      `dryLastNz=${dryLastNz}`);
    check('导出总时长 = 渲染总时长（尾声未被截断）',
      Math.abs(dec.channels[0].length / dec.sampleRate - r.verify.durationSec) < 1e-4);
  }

  console.log('7. 停止后无残留：渲染结果不可变（重新渲染产生新缓冲）');
  {
    const dry = generators.dry[1]();
    const room = generators.rooms[0]();
    const r1 = await render.renderMix(dry, room, { preDelayMs: 10, wetGain: 1, normalize: false }, null);
    const snapshot = r1.wet[0].slice();
    const r2 = await render.renderMix(dry, room, { preDelayMs: 20, wetGain: 0.5, normalize: false }, null);
    check('两次渲染的缓冲相互独立', r1.wet[0] !== r2.wet[0]);
    check('旧渲染缓冲未被新参数污染', r1.wet[0].every((v, i) => v === snapshot[i]));
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
