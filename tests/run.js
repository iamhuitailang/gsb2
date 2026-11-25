// 纯 Node 运行的单元测试（node tests/run.js），不依赖浏览器环境。
import {
  fft, nextPow2, estimateOffset, estimateDrift,
  sourceTimeFromAnchors, projectTimeFromAnchors,
  sourceTimeSimple, detectSilence,
} from '../public/js/dsp.js';
import { buildZip } from '../public/js/zip.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// ---------- FFT 与 IFFT 互逆 ----------
{
  const n = 64;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const orig = [];
  for (let i = 0; i < n; i++) {
    re[i] = Math.sin(2 * Math.PI * 3 * i / n) + 0.5 * Math.cos(2 * Math.PI * 7 * i / n);
    orig.push(re[i]);
  }
  const re2 = new Float64Array(re);
  fft(re, im);
  // 3 与 7 频点应有能量
  const mag3 = Math.hypot(re[3], im[3]);
  const mag7 = Math.hypot(re[7], im[7]);
  assert(mag3 > 5 && mag7 > 3, `FFT 频点能量异常 mag3=${mag3} mag7=${mag7}`);
  fft(re, im, true);
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - orig[i]));
  assert(maxErr < 1e-10, `IFFT 重构误差过大: ${maxErr}`);
  assert(nextPow2(1000) === 1024 && nextPow2(1024) === 1024, 'nextPow2 错误');
}

// ---------- 合成信号工具 ----------
const SR = 48000;
// 类语音测试信号：基频缓慢漂移的谐波复合音 + 缓变幅度包络。
// 谐波结构提供抗微时钟漂移的局部相关性（真实语音/音乐特性），
// 而基频漂移与非周期包络抑制远距离自相关假峰，兼顾“唯一峰”与“可跟踪漂移”。
function voicedLike(n, seed) {
  const out = new Float32Array(n);
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  // 缓慢起伏的非周期包络线。
  const env = new Float32Array(n);
  let e = 0.3;
  for (let i = 0; i < n; i++) {
    e += 0.002 * rnd();
    e = Math.max(0.12, Math.min(0.5, e));
    env[i] = e;
  }
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    // 基频在 110–150Hz 间缓慢变化（含非周期扰动），避免固定周期产生远距离旁瓣。
    const f0 = 130 + 18 * Math.sin(2 * Math.PI * 0.05 * tt) + 6 * Math.sin(2 * Math.PI * 0.173 * tt);
    phase += (2 * Math.PI * f0) / SR;
    // 前 5 次谐波，幅度随频率递减。
    let v = 0;
    for (let h = 1; h <= 5; h++) v += (1 / h) * Math.sin(h * phase);
    out[i] = env[i] * v * 0.25;
  }
  return out;
}

function makeSignal(durationSec, events) {
  const n = Math.floor(durationSec * SR);
  const x = voicedLike(n, 12345);
  // 叠加少量非周期敲击作为瞬态标记。
  for (const [t0, freq, amp = 0.35] of events) {
    const base = Math.floor(t0 * SR);
    const len = Math.floor(0.3 * SR);
    for (let k = 0; k < len && base + k < n; k++) {
      const env = Math.exp(-k / (0.06 * SR));
      x[base + k] += amp * env * Math.sin(2 * Math.PI * freq * k / SR);
    }
  }
  // 低噪声
  let nseed = 42;
  const nrnd = () => { nseed = (nseed * 1103515245 + 12345) & 0x7fffffff; return nseed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) x[i] += nrnd() * 0.003;
  return x;
}

// 按有符号 lag 构造目标信号：y[q]=x[p] 时 q = p + lagSamples（lag>0 内容在文件中更晚，前置静音）。
// rate≠1 时设备时钟伸缩：目标采样 j 对应源索引 (j - lagSamples)/rate。
function transform(x, lagSec, rate) {
  const lag = Math.round(lagSec * SR);
  const n = Math.max(1, Math.floor(x.length / rate) + lag + SR);
  const y = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const srcIdx = (j - lag) / rate;
    const i0 = Math.floor(srcIdx);
    if (i0 < 0 || i0 + 1 >= x.length) continue; // 越界处保持静音
    const frac = srcIdx - i0;
    y[j] = x[i0] * (1 - frac) + x[i0 + 1] * frac;
  }
  return y;
}

// ---------- estimateOffset：不同起始时间 ----------
{
  const events = [];
  let t = 2.0;
  let fi = 0;
  const freqs = [300, 440, 370, 520, 350, 480];
  while (t < 40) {
    events.push([t, freqs[fi % freqs.length]]);
    t += 2.3 + (fi % 3) * 0.61;
    fi++;
  }
  const ref = makeSignal(45, events);
  for (const offsetSec of [1.25, -0.8, 0.45, 2.0]) {
    const tgt = transform(ref, offsetSec, 1.0);
    const r = estimateOffset(ref, tgt, SR);
    // lag 约定：target 晚 offset>0 时 lag ≈ offset*SR
    assert(approx(r.lagSamples / SR, offsetSec, 0.01),
      `offset=${offsetSec}s 估计得 ${(r.lagSamples / SR).toFixed(4)}s`);
    assert(r.coeff > 0.8, `offset=${offsetSec}s 相关系数过低: ${r.coeff}`);
  }
}

// ---------- estimateDrift：轻微速度差 ----------
{
  // 非周期事件（时间间隔与频率都变化），避免自相关旁瓣造成假峰。
  const events = [];
  let t = 2.0;
  let fi = 0;
  const freqs = [261, 392, 311, 466, 349, 523, 294, 440];
  while (t < 55) {
    events.push([t, freqs[fi % freqs.length]]);
    t += 1.7 + (fi % 5) * 0.43;
    fi++;
  }
  const ref = makeSignal(60, events);
  const ppm = 350e-6;
  const tgt = transform(ref, 0.5, 1 + ppm);
  const res = estimateDrift(ref, tgt, SR);
  assert(res.points.length >= 4, `漂移窗口数不足: ${res.points.length}`);
  assert(approx(res.driftPpm, 350, 80), `漂移估计 ${res.driftPpm.toFixed(1)} ppm，期望 ~350`);
  // 局部偏差（残差）：6kHz 抽取量化 + 峰抖动，30ms 内仍属可靠的局部校准。
  const maxRes = Math.max(...res.points.map((p) => Math.abs(p.localMs)));
  assert(maxRes < 30, `局部残差过大: ${maxRes.toFixed(2)} ms`);
}

// ---------- 锚点映射正反互逆 ----------
{
  const anchors = [
    { projectSec: 5, sourceSec: 6.2 },
    { projectSec: 20, sourceSec: 21.25 },
    { projectSec: 40, sourceSec: 41.31 },
  ];
  for (const p of [5, 12.5, 20, 33, 40]) {
    const s = sourceTimeFromAnchors(p, anchors);
    const back = projectTimeFromAnchors(s, anchors);
    assert(approx(back, p, 1e-9), `锚点逆映射失败 p=${p} back=${back}`);
  }
  // 外推不返回 NaN
  const s = sourceTimeFromAnchors(60, anchors);
  assert(Number.isFinite(s), '锚点外推出现非有限值');
  // 无锚点退化为恒等
  assert(sourceTimeFromAnchors(10, []) === 10, '空锚点应为恒等映射');
}

// ---------- 简单模式偏移+漂移 ----------
{
  const s = sourceTimeSimple(100, 0.5, 200);
  assert(approx(s, 100 + 0.5 + 0.02, 1e-9), '简单映射计算错误');
}

// ---------- 静音检测：开头静音样音 ----------
{
  const sr = 16000;
  const x = new Float32Array(5 * sr);
  for (let i = 2 * sr; i < 2.1 * sr; i++) x[i] = Math.sin(i * 0.3) * 0.4;
  const ranges = detectSilence(x, sr, -45, 300);
  assert(ranges.length >= 1, '未检测到静音段');
  assert(ranges[0][0] === 0, `首段静音起点错误: ${ranges[0][0]}`);
}

// ---------- 端到端：模拟“多设备”录音并自动对齐 ----------
{
  const events = [];
  let t = 1.5;
  let fi = 0;
  const freqs = [240, 370, 300, 510, 420, 600, 280, 470];
  while (t < 30) {
    events.push([t, freqs[fi % freqs.length]]);
    t += 1.3 + (fi % 4) * 0.37;
    fi++;
  }
  const master = makeSignal(32, events);
  // [lagSec, rate, 可接受的中段映射误差(秒)]
  const devices = [
    { sig: transform(master, 0.5, 1.0), lag: 0.5, rate: 1.0, tol: 0.02 },
    { sig: transform(master, 1.2, 1 + 300e-6), lag: 1.2, rate: 1 + 300e-6, tol: 0.05 },
    { sig: transform(master, -0.7, 1 - 180e-6), lag: -0.7, rate: 1 - 180e-6, tol: 0.05 },
  ];
  let allOk = true;
  for (const dev of devices) {
    const r = estimateOffset(master, dev.sig, SR);
    // 整轨偏移应落在真实起始 lag 附近。
    if (!approx(r.lagSamples / SR, dev.lag, 0.05)) {
      console.error(`    整轨偏移 ${(r.lagSamples / SR).toFixed(3)}s，期望 ${dev.lag}s`);
      allOk = false;
    }
    const res = estimateDrift(master, dev.sig, SR, 4, 2, 10, r.lagSamples / SR);
    const anchors = res.points
      .filter((p) => p.coeff > 0.5)
      .map((p) => ({ projectSec: p.t, sourceSec: p.t + p.lagSec }));
    if (anchors.length < 2) { allOk = false; continue; }
    // 在录音中段，理论 source-project 偏移 = lag + (rate-1)*t。
    const mid = anchors[Math.floor(anchors.length / 2)].projectSec;
    const mapped = sourceTimeFromAnchors(mid, anchors) - mid;
    const expected = dev.lag + (dev.rate - 1) * mid;
    if (!approx(mapped, expected, dev.tol)) {
      console.error(`    中段映射 ${mapped.toFixed(4)}s，期望 ${expected.toFixed(4)}s`);
      allOk = false;
    }
  }
  assert(allOk, '端到端多设备锚点对齐误差超限');
}

// ---------- ZIP 结构完整性（签名 + 可被系统 unzip 读取） ----------
{
  const files = [
    { name: 'a.txt', data: new TextEncoder().encode('hello world '.repeat(100)) },
    { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 255, 254, 253]) },
  ];
  const blob = buildZip(files);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const sig = (i) => [0x50, 0x4b, 0x03, 0x04].every((b, k) => buf[i + k] === b);
  assert(sig(0), 'ZIP 本地文件头签名错误');
  const eocd = buf.length - 22;
  const eocdSig = [0x50, 0x4b, 0x05, 0x06].every((b, k) => buf[eocd + k] === b);
  assert(eocdSig, 'ZIP EOCD 签名错误');
  // 写入临时文件，用系统 unzip 验证真实兼容性。
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ziptest-'));
  const zpath = join(dir, 'test.zip');
  writeFileSync(zpath, buf);
  const { execFileSync } = await import('node:child_process');
  const listing = execFileSync('unzip', ['-l', zpath], { encoding: 'utf-8' });
  assert(listing.includes('a.txt') && listing.includes('dir/b.bin'), 'unzip 无法列出 ZIP 内容');
  execFileSync('unzip', ['-o', '-q', zpath, '-d', dir]);
  const { readFileSync } = await import('node:fs');
  const back = new TextEncoder().encode(readFileSync(join(dir, 'a.txt'), 'utf-8'));
  assert(back.length === files[0].data.length, 'ZIP 解压后长度不一致');
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
