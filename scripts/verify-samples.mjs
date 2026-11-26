// 样例同步精度的端到端校验（Node 环境，无浏览器依赖）。
// 用 ffmpeg 把样例解码为 44.1k 单声道 PCM，包装成 AudioBuffer 形状，
// 复用 src/core/sync.js 的同款包络+互相关算法，验证能否还原设计偏移：
//   camB 比 camA 晚 0.8s   -> B.offset ≈ -0.8
//   reference 比 camA 早 0.5s -> ref.offset ≈ +0.5
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioBufferToEnvelope, estimateOffset, ENVELOPE_RATE } from '../src/core/sync.js';

const SAMPLE_RATE = 44100;

function decodePcm(file) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-verify-'));
  const out = join(dir, 'audio.pcm');
  execFileSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', out],
  );
  const raw = readFileSync(out);
  const buf = new Float32Array(raw.length / 2);
  for (let i = 0; i < buf.length; i++) buf[i] = raw.readInt16LE(i * 2) / 32768;
  // 最小 AudioBuffer 形状
  return {
    sampleRate: SAMPLE_RATE,
    length: buf.length,
    numberOfChannels: 1,
    getChannelData: () => buf,
  };
}

const root = new URL('..', import.meta.url).pathname;
const samples = join(root, 'public', 'samples');
const camA = decodePcm(join(samples, 'camA_synctest_25fps.mp4'));
const camB = decodePcm(join(samples, 'camB_synctest_30fps.mp4'));
const ref = decodePcm(join(samples, 'reference_click.wav'));

const envA = audioBufferToEnvelope(camA);
const envB = audioBufferToEnvelope(camB);
const envRef = audioBufferToEnvelope(ref);

const tolerance = 1.5 / ENVELOPE_RATE; // 允许 1.5 个包络采样（7.5ms）

function check(name, est, expected) {
  const err = Math.abs(est.offset - expected);
  const ok = err <= tolerance;
  console.log(
    `${ok ? '✅' : '❌'} ${name}: 测得 offset=${est.offset.toFixed(3)}s，期望 ${expected}s，` +
      `误差 ${(err * 1000).toFixed(1)}ms，置信度 ${(est.confidence * 100).toFixed(1)}%`,
  );
  if (!ok) process.exitCode = 1;
}

// B 的点击声比 A 晚 0.8s（A 在 2.2s，B 在 3.0s）-> B 的时间线偏移为 -0.8
check('camB 相对 camA（期望 -0.800s）', estimateOffset(envA, envB, 0), -0.8);
// reference 比 A 早 0.5s（ref 在 1.7s，A 在 2.2s）-> ref 的时间线偏移为 +0.5
check('reference 相对 camA（期望 +0.500s）', estimateOffset(envA, envRef, 0), 0.5);
