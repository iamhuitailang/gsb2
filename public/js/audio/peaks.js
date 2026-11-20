/**
 * 波形峰值缓存。
 * 原始采样只用于高倍缩放；常规缩放读取按 BLOCK 采样的 min/max 峰值。
 */

export const BLOCK_SIZE = 256;
/** 超过该采样数时丢弃原始采样，仅保留峰值，避免长录音占用过多内存。 */
const RAW_SAMPLE_LIMIT = 24_000_000;

export class PeaksCache {
  constructor({ blockSize = BLOCK_SIZE } = {}) {
    this.blockSize = blockSize;
    this.min = null;
    this.max = null;
    this.raw = null;
    this.sampleRate = 0;
    this.duration = 0;
    this.length = 0;
  }

  static async build(buffer, { blockSize = BLOCK_SIZE } = {}) {
    const cache = new PeaksCache({ blockSize });
    const channels = buffer.numberOfChannels;
    const length = buffer.length;
    const data = [];
    for (let c = 0; c < channels; c += 1) data.push(buffer.getChannelData(c));
    const blocks = Math.ceil(length / blockSize);
    const min = new Float32Array(blocks);
    const max = new Float32Array(blocks);
    const usableRaw = length <= RAW_SAMPLE_LIMIT;
    const raw = usableRaw ? new Float32Array(length) : null;
    const channelScale = 1 / Math.max(1, channels);

    // 分块计算，避免长时间阻塞界面
    const chunk = 240;
    for (let b = 0; b < blocks; b += chunk) {
      const endBlock = Math.min(blocks, b + chunk);
      for (let block = b; block < endBlock; block += 1) {
        const start = block * blockSize;
        const end = Math.min(length, start + blockSize);
        let lo = 0;
        let hi = 0;
        for (let c = 0; c < channels; c += 1) {
          const channel = data[c];
          for (let i = start; i < end; i += 1) {
            const value = channel[i];
            if (value < lo) lo = value;
            if (value > hi) hi = value;
          }
        }
        min[block] = lo * channelScale;
        max[block] = hi * channelScale;
        if (raw) {
          for (let i = start; i < end; i += 1) {
            let value = 0;
            for (let c = 0; c < channels; c += 1) value += data[c][i];
            raw[i] = value * channelScale;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    cache.min = min;
    cache.max = max;
    cache.raw = raw;
    cache.sampleRate = buffer.sampleRate;
    cache.duration = buffer.duration;
    cache.length = length;
    return cache;
  }
}

/**
 * 查询 [startSample, endSample) 的极值。返回 { min, max }；
 * 缩放足够大（区间小于一个 block）时退回原始采样，保证波形细腻。
 */
export function peakInRange(cache, startSample, endSample) {
  if (!cache || !cache.min) return { min: 0, max: 0 };
  const blockSize = cache.blockSize;
  const from = Math.max(0, Math.floor(startSample / blockSize));
  const to = Math.max(from, Math.min(cache.min.length - 1, Math.floor((endSample - 1) / blockSize)));
  if (cache.raw && endSample - startSample <= blockSize * 1.5) {
    let lo = 0;
    let hi = 0;
    const start = Math.max(0, Math.floor(startSample));
    const end = Math.min(cache.raw.length, Math.max(start + 1, Math.ceil(endSample)));
    for (let i = start; i < end; i += 1) {
      const value = cache.raw[i];
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
    return { min: lo, max: hi };
  }
  let lo = 0;
  let hi = 0;
  for (let b = from; b <= to; b += 1) {
    if (cache.min[b] < lo) lo = cache.min[b];
    if (cache.max[b] > hi) hi = cache.max[b];
  }
  return { min: lo, max: hi };
}

/** 供全局缩略图使用的低分辨率包络。 */
export function buildEnvelope(cache, buckets = 800) {
  const envelope = new Array(buckets).fill(null).map(() => ({ min: 0, max: 0 }));
  if (!cache || !cache.min || !cache.duration) return envelope;
  const totalBlocks = cache.min.length;
  for (let i = 0; i < buckets; i += 1) {
    const from = Math.floor((i / buckets) * totalBlocks);
    const to = Math.max(from, Math.floor(((i + 1) / buckets) * totalBlocks) - 1);
    let lo = 0;
    let hi = 0;
    for (let b = from; b <= to; b += 1) {
      if (cache.min[b] < lo) lo = cache.min[b];
      if (cache.max[b] > hi) hi = cache.max[b];
    }
    envelope[i] = { min: lo, max: hi };
  }
  return envelope;
}
