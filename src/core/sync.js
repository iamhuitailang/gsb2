// 基于音频波形的自动同步。
// 思路：解码两段音频 -> 重采样到统一的包络采样率 -> 计算 onset 能量包络
// -> 归一化互相关找到最佳 lag -> 换算为素材时间线偏移。
// 纯数学部分与 AudioContext 解耦，便于用构造数据做单测。

import { clamp } from './time.js';

/** 包络采样率（Hz）：200Hz = 5ms 精度，足够定位掌声/打板/点击声。 */
export const ENVELOPE_RATE = 200;

/**
 * 由 AudioBuffer 计算 mono onset 包络。
 * 返回 Float32Array，长度约 duration * ENVELOPE_RATE。
 * 尖锐瞬态（打板/点击声）随后会被 broadenEnvelope 展宽成小窗，
 * 使互相关对 ±1 个包络采样的抖动不敏感。
 */
export function audioBufferToEnvelope(buffer, rate = ENVELOPE_RATE) {
  const ch0 = buffer.getChannelData(0);
  const mono = buffer.numberOfChannels > 1 ? mixDown(buffer) : ch0;
  const hop = Math.max(1, Math.round(buffer.sampleRate / rate));
  const n = Math.floor(mono.length / hop);
  const env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    // 块内峰值，比 RMS 更能保留瞬态（打板声）
    let peak = 0;
    const start = i * hop;
    const end = Math.min(start + hop, mono.length);
    for (let j = start; j < end; j++) {
      const v = Math.abs(mono[j]);
      if (v > peak) peak = v;
    }
    // onset：只强调能量上升沿，稳态底噪贡献很小
    env[i] = Math.max(0, peak - prev);
    prev = peak;
  }
  return broadenEnvelope(env, rate);
}

/**
 * 把稀疏的尖锐 onset 展宽成 ~30ms 的小窗（保持峰值），
 * 互相关因此对采样级抖动鲁棒，同时仍由上升沿决定精确位置。
 */
export function broadenEnvelope(env, rate = ENVELOPE_RATE) {
  const radius = Math.max(1, Math.round(rate * 0.015)); // 15ms 半径
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    let v = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < env.length) v = Math.max(v, env[j]);
    }
    out[i] = v;
  }
  return out;
}

function mixDown(buffer) {
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

/**
 * 归一化互相关。
 * ref 固定不动，target 相对 ref 滞后 lag 个采样时取相关值。
 * lag < 0 表示 target 内容比 ref 晚出现（target 开头静音更长）。
 *
 * 静音段的归一化相关没有物理意义、会产生接近 1 的伪峰，因此：
 *  1. 先按 ref 包络最大值算出噪声门限，只统计两侧都高于门限的采样（瞬态区）；
 *  2. 要求有效瞬态采样达到最少数量，且重叠覆盖足够的瞬态，否则该 lag 不计分。
 * 返回 { lag, score, candidates: [{lag, score}] }（候选按分数降序，最多 5 个）。
 */
export function bestCorrelation(ref, target) {
  const minLag = -(target.length - 1);
  const maxLag = ref.length - 1;
  const refMax = maxOf(ref);
  const tgtMax = maxOf(target);
  if (refMax <= 0 || tgtMax <= 0) return { lag: 0, score: 0, candidates: [] };
  // 门限取最大瞬态的 12%：点击声之下的稳态底噪基本被滤掉
  const gate = Math.max(refMax, tgtMax) * 0.12;

  const scores = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0;
    let sumR = 0;
    let sumT = 0;
    let hits = 0;
    const rStart = Math.max(0, lag);
    const rEnd = Math.min(ref.length, target.length + lag);
    for (let r = rStart; r < rEnd; r++) {
      const x = ref[r];
      const y = target[r - lag];
      // 能量门限：任一侧进入瞬态区才计入，避免双静音稀释相关值
      if (x < gate && y < gate) continue;
      dot += x * y;
      sumR += x * x;
      sumT += y * y;
      if (x >= gate && y >= gate) hits += 1;
    }
    // 至少 2 个瞬态对齐（点击声为尖锐单采样 onset，一声约 1-2 个采样）
    if (hits < 2 || sumR === 0 || sumT === 0) continue;
    scores.push({ lag, score: dot / Math.sqrt(sumR * sumT), hits });
  }
  scores.sort((a, b) => b.score - a.score || b.hits - a.hits);
  if (scores.length === 0) return { lag: 0, score: 0, candidates: [] };
  // 局部极大值去重：只保留与已选候选相距较远的峰值（>0.25s）
  const candidates = [];
  for (const cand of scores) {
    if (candidates.every((c) => Math.abs(c.lag - cand.lag) > ENVELOPE_RATE * 0.25)) {
      candidates.push(cand);
      if (candidates.length >= 5) break;
    }
  }
  return { lag: scores[0].lag, score: scores[0].score, candidates };
}

function maxOf(arr) {
  let m = 0;
  for (const v of arr) if (v > m) m = v;
  return m;
}

/**
 * 估计 target 相对 reference 的时间线偏移。
 * 约定：reference.offset 已知（默认 0），求 target.offset，
 * 使 target 的声音在时间线上与 reference 对齐。
 *
 * targetT = refT - lag/rate，时间线上 refT + ref.offset = targetT + target.offset
 * => target.offset = ref.offset + lag/rate
 */
export function estimateOffset(refEnvelope, targetEnvelope, referenceOffset = 0) {
  const { lag, score, candidates } = bestCorrelation(refEnvelope, targetEnvelope);
  return {
    offset: referenceOffset + lag / ENVELOPE_RATE,
    lag,
    confidence: clamp(score, 0, 1),
    candidates: candidates.map((c) => ({
      offset: referenceOffset + c.lag / ENVELOPE_RATE,
      confidence: clamp(c.score, 0, 1),
    })),
  };
}

/** 供 UI 画波形：抽稀成最多 maxPoints 个 min/max 点对。 */
export function peaksForDisplay(channelData, maxPoints = 800) {
  const bucket = Math.max(1, Math.floor(channelData.length / maxPoints));
  const points = [];
  for (let i = 0; i < channelData.length; i += bucket) {
    let min = 1;
    let max = -1;
    const end = Math.min(i + bucket, channelData.length);
    for (let j = i; j < end; j++) {
      const v = channelData[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    points.push({ min, max });
  }
  return points;
}
