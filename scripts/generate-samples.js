/**
 * 生成一组演示音效到 public/samples/：
 *  - 不同时长 / 采样率 / 声道 / 位深 / 格式（wav/mp3/ogg/flac/m4a）
 *  - 含无缝循环素材（环境风声、引擎声、脚步声）与单发音效（爆炸、拾取、激光、UI）
 *  - 附带一个损坏文件 corrupted_demo.wav，用于演示「单文件解析失败不影响整批索引」
 *
 * WAV 由本脚本直接写 PCM；mp3/ogg/flac/m4a 需要系统里有 ffmpeg（没有则跳过，不影响 WAV 生成）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples');
fs.mkdirSync(OUT, { recursive: true });

// ---------- WAV 写入 ----------
function writeWav(file, { sampleRate, channels, bitDepth = 16 }, samples) {
  // samples: Float32Array 交错数据 [-1, 1]
  const bytesPerSample = bitDepth / 8;
  const dataSize = samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bitDepth, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    if (bitDepth === 16) buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    else buf.writeUInt8(Math.round((v * 0.5 + 0.5) * 255), 44 + i);
  }
  fs.writeFileSync(file, buf);
}

// ---------- 合成工具 ----------
const sr = (n, rate) => Math.floor(n * rate);

function tone(freq, t) { return Math.sin(2 * Math.PI * freq * t); }

function envelope(t, dur, attack = 0.005, release = 0.1) {
  const a = Math.min(1, t / attack);
  const r = Math.min(1, Math.max(0, (dur - t) / release));
  return a * r;
}

/** 让首尾无缝衔接：内容取整数个周期，最后 crossfade 回开头 */
function makeLoopable(samples, rate, fadeSec = 0.05) {
  const n = sr(fadeSec, rate);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    const j = samples.length - n + i;
    samples[j] = samples[j] * (1 - g) + samples[i] * g;
  }
  return samples;
}

let seed = 42;
function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; }

// ---------- 各种音效 ----------
function genUiClick() { // 0.12s 44.1k 单声道 16bit
  const rate = 44100, dur = 0.12, n = sr(dur, rate);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    s[i] = (tone(1800, t) * 0.6 + tone(2400, t) * 0.4) * envelope(t, dur, 0.001, 0.09) * 0.8;
  }
  return [{ rate, ch: 1, bits: 16 }, s];
}

function genExplosion() { // 2.2s 48k 立体声
  const rate = 48000, dur = 2.2, n = sr(dur, rate);
  const s = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const boom = tone(55 - t * 20, t) * Math.exp(-t * 3);
    const noise = rand() * Math.exp(-t * 2.2) * 0.8;
    const crackle = rand() * Math.exp(-t * 8) * 0.5;
    const v = (boom * 0.9 + noise + crackle) * 0.8;
    s[i * 2] = v * (0.9 + 0.1 * Math.sin(t * 7));
    s[i * 2 + 1] = v * (0.9 + 0.1 * Math.cos(t * 6));
  }
  return [{ rate, ch: 2, bits: 16 }, s];
}

function genCoin() { // 0.5s 44.1k 单声道
  const rate = 44100, dur = 0.5, n = sr(dur, rate);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = t < 0.08 ? 988 : 1319; // B5 -> E6 经典拾取音
    s[i] = tone(f, t) * envelope(t, dur, 0.002, 0.35) * 0.6;
  }
  return [{ rate, ch: 1, bits: 16 }, s];
}

function genLaser() { // 0.8s 44.1k 单声道 下滑音
  const rate = 44100, dur = 0.8, n = sr(dur, rate);
  const s = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = 2400 * Math.pow(0.12, t / dur);
    phase += (2 * Math.PI * f) / rate;
    s[i] = Math.sin(phase) * envelope(t, dur, 0.002, 0.25) * 0.7;
  }
  return [{ rate, ch: 1, bits: 16 }, s];
}

function genWindLoop() { // 8s 44.1k 立体声 无缝循环环境风
  const rate = 44100, dur = 8, n = sr(dur, rate);
  const s = new Float32Array(n * 2);
  let lpL = 0, lpR = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // 用整数个周期的低频调制保证循环点平滑
    const gust = 0.55 + 0.3 * Math.sin(2 * Math.PI * 2 * t / dur) + 0.15 * Math.sin(2 * Math.PI * 5 * t / dur);
    lpL += 0.04 * (rand() - lpL); lpR += 0.04 * (rand() - lpR);
    s[i * 2] = lpL * gust * 1.6;
    s[i * 2 + 1] = lpR * gust * 1.6;
  }
  return [{ rate, ch: 2, bits: 16 }, makeLoopable(s, rate, 0.2)];
}

function genEngineLoop() { // 3s 22050 单声道 无缝循环引擎
  const rate = 22050, dur = 3, n = sr(dur, rate);
  const s = new Float32Array(n);
  const cycles = 240; // 80Hz * 3s = 整数周期，天然无缝
  for (let i = 0; i < n; i++) {
    const t = i / n; // 0..1
    const ph = 2 * Math.PI * cycles * t;
    s[i] = (Math.sin(ph) * 0.5 + Math.sin(ph * 2.01) * 0.2 + Math.sin(ph * 0.5) * 0.3 + rand() * 0.06) * 0.7;
  }
  return [{ rate, ch: 1, bits: 16 }, makeLoopable(s, rate, 0.05)];
}

function genFootstepLoop() { // 2s 44.1k 单声道 四步循环
  const rate = 44100, dur = 2, n = sr(dur, rate);
  const s = new Float32Array(n);
  for (let step = 0; step < 4; step++) {
    const start = Math.floor((step * n) / 4);
    const len = sr(0.09, rate);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / rate;
      s[start + i] += (rand() * 0.7 + tone(90 + step * 8, t) * 0.5) * Math.exp(-t * 45) * 0.8;
    }
  }
  return [{ rate, ch: 1, bits: 16 }, makeLoopable(s, rate, 0.03)];
}

function genJump8bit() { // 0.35s 22050 单声道 8bit 复古跳跃
  const rate = 22050, dur = 0.35, n = sr(dur, rate);
  const s = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = 220 + 660 * (t / dur);
    phase += (2 * Math.PI * f) / rate;
    s[i] = (Math.sin(phase) > 0 ? 0.5 : -0.5) * envelope(t, dur, 0.005, 0.12);
  }
  return [{ rate, ch: 1, bits: 8 }, s];
}

// ---------- 生成 ----------
const jobs = {
  'ui_click.wav': genUiClick,
  'explosion.wav': genExplosion,
  'coin_pickup.wav': genCoin,
  'laser_sweep.wav': genLaser,
  'ambient_wind_loop.wav': genWindLoop,
  'engine_loop_22k.wav': genEngineLoop,
  'footstep_loop.wav': genFootstepLoop,
  'jump_8bit.wav': genJump8bit,
};

for (const [name, gen] of Object.entries(jobs)) {
  const [cfg, samples] = gen();
  writeWav(path.join(OUT, name), { sampleRate: cfg.rate, channels: cfg.ch, bitDepth: cfg.bits }, samples);
  console.log(`生成 ${name} (${cfg.rate}Hz ${cfg.ch}ch ${cfg.bits}bit)`);
}

// 格式转换（可选，依赖 ffmpeg）
let ffmpeg = null;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpeg = 'ffmpeg'; } catch {}
if (ffmpeg) {
  const conversions = [
    ['explosion.wav', 'explosion.mp3', ['-codec:a', 'libmp3lame', '-q:a', '4']],
    ['ambient_wind_loop.wav', 'ambient_wind_loop.ogg', ['-codec:a', 'libopus', '-b:a', '96k']],
    ['coin_pickup.wav', 'coin_pickup.m4a', ['-codec:a', 'aac', '-b:a', '128k']],
    ['laser_sweep.wav', 'laser_sweep.flac', ['-codec:a', 'flac']],
  ];
  for (const [src, dst, args] of conversions) {
    try {
      execFileSync(ffmpeg, ['-y', '-i', path.join(OUT, src), ...args, path.join(OUT, dst)], { stdio: 'ignore' });
      console.log(`转换 ${dst}`);
    } catch (e) {
      console.warn(`跳过 ${dst}: ${e.message}`);
    }
  }
} else {
  console.log('未检测到 ffmpeg，仅生成 WAV（mp3/ogg/flac/m4a 示例已跳过）');
}

// 损坏文件：演示索引容错
fs.writeFileSync(path.join(OUT, 'corrupted_demo.wav'), Buffer.from('RIFF')); // 截断的 RIFF 头，解析器会报错
console.log('生成 corrupted_demo.wav（故意损坏，用于演示容错）');
console.log(`\n完成，素材目录: ${OUT}`);
