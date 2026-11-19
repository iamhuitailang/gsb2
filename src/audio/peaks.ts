/** 波形峰值提取：把 AudioBuffer 降采样为固定数量的 min/max 峰值对，供 Canvas 绘制。 */

export interface WaveformPeaks {
  /** 每对两个数：负向峰值、正向峰值，长度 = 2 * buckets */
  data: Float32Array;
  buckets: number;
  duration: number;
}

const PEAK_BUCKETS = 480;
const cache = new WeakMap<AudioBuffer, WaveformPeaks>();

export function computePeaks(buffer: AudioBuffer): WaveformPeaks {
  const cached = cache.get(buffer);
  if (cached) return cached;

  // 混合所有声道为单声道用于显示
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }
  const frames = buffer.length;
  const buckets = PEAK_BUCKETS;
  const data = new Float32Array(buckets * 2);
  const samplesPerBucket = Math.max(1, Math.floor(frames / buckets));

  for (let b = 0; b < buckets; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(frames, start + samplesPerBucket);
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i++) {
      let v = 0;
      for (let ch = 0; ch < channels.length; ch++) v += channels[ch][i];
      v /= channels.length;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    data[b * 2] = min;
    data[b * 2 + 1] = max;
  }

  const peaks: WaveformPeaks = { data, buckets, duration: buffer.duration };
  cache.set(buffer, peaks);
  return peaks;
}
