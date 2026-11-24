/**
 * 钟声加法合成（Node 端运行，无外部依赖）。
 * 钟声的特点是非谐和泛音列 + 各泛音独立指数衰减；
 * looped 音色让低阶泛音衰减很慢，2 秒后进入近似稳态可做循环段。
 */
import { midiToFreq } from '../src/audio/notes.ts';
import type { VelocityLayer } from '../src/types.ts';

export interface SynthResult {
  samples: Float32Array;
  loopStart?: number;
  loopEnd?: number;
}

interface PartialSpec {
  ratio: number;
  gain: number;
  /** 衰减时间常数（秒），越大余音越长 */
  tau: number;
  /** 双正弦拍频：制造轻微失谐，避免循环段过于“电子味” */
  beat?: number;
}

const BELL_PARTIALS: PartialSpec[] = [
  { ratio: 1.0, gain: 1.0, tau: 9.0, beat: 0.35 },
  { ratio: 2.0, gain: 0.55, tau: 6.0 },
  { ratio: 2.4, gain: 0.38, tau: 3.2 },
  { ratio: 3.0, gain: 0.3, tau: 2.4 },
  { ratio: 4.2, gain: 0.18, tau: 1.6 },
  { ratio: 5.43, gain: 0.12, tau: 1.1 },
  { ratio: 6.8, gain: 0.07, tau: 0.7 },
];

const LAYER_PARAMS: Record<
  VelocityLayer,
  { peak: number; strike: number; highCut: number; attack: number; tauScale: number }
> = {
  // 轻敲：高频泛音被锤毡滤掉、起音软、整体更轻
  soft: { peak: 0.45, strike: 0.0, highCut: 0.45, attack: 0.008, tauScale: 1.25 },
  // 重敲：金属高频充分激发、带敲击噪声、更响
  hard: { peak: 0.9, strike: 0.25, highCut: 1.0, attack: 0.002, tauScale: 0.9 },
};

/** 确定性伪随机，保证每次生成的试听素材可复现 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function synthBell(
  rootMidi: number,
  layer: VelocityLayer,
  looped: boolean,
  sampleRate: number,
): SynthResult {
  const f0 = midiToFreq(rootMidi);
  const params = LAYER_PARAMS[layer];
  const duration = looped ? 5.0 : 3.5;
  const total = Math.floor(duration * sampleRate);
  const out = new Float32Array(total);
  const rng = makeRng(rootMidi * 7919 + (layer === 'hard' ? 131 : 17));

  for (let p = 0; p < BELL_PARTIALS.length; p++) {
    const spec = BELL_PARTIALS[p];
    // 轻敲时高阶泛音按序号衰减
    const layerGain = spec.gain * Math.pow(params.highCut, p);
    const tau = spec.tau * params.tauScale * (looped && p < 2 ? 1.8 : 1);
    const freq = f0 * spec.ratio;
    const beatGain = spec.beat ? 0.5 : 0;
    for (let i = 0; i < total; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t / tau);
      let v = Math.sin(2 * Math.PI * freq * t);
      if (spec.beat) {
        v = (1 - beatGain) * v + beatGain * Math.sin(2 * Math.PI * (freq + spec.beat) * t);
      }
      out[i] += layerGain * env * v;
    }
  }

  // 敲击噪声：仅重敲，5ms 内快速衰减
  if (params.strike > 0) {
    for (let i = 0; i < sampleRate * 0.02; i++) {
      const t = i / sampleRate;
      out[i] += params.strike * (rng() * 2 - 1) * Math.exp(-t / 0.004);
    }
  }

  // 起音轮廓，避免第一采样点突变
  const attackFrames = Math.max(2, Math.floor(params.attack * sampleRate));
  for (let i = 0; i < attackFrames; i++) {
    out[i] *= i / attackFrames;
  }

  // 归一化到目标峰值
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  const scale = params.peak / peak;
  for (let i = 0; i < total; i++) out[i] *= scale;

  if (!looped) return { samples: out };

  // 循环点取在稳态段；长度故意不与基频周期对齐，
  // 交叉淡化为 0 时能听到接头咔哒声，方便试听接头设置的影响。
  const loopStart = Math.floor(2.0 * sampleRate);
  const loopEnd = Math.floor(3.15 * sampleRate);
  return { samples: out, loopStart, loopEnd };
}

/** 生成一段无法被 decodeAudioData 解码的“坏 WAV” */
export function synthCorruptWav(seed: number): Uint8Array {
  const rng = makeRng(seed);
  const bytes = new Uint8Array(400);
  const head = 'RIFF????WAVE';
  for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i);
  for (let i = head.length; i < bytes.length; i++) bytes[i] = Math.floor(rng() * 256);
  return bytes;
}
