/**
 * 最小 WAV（PCM 16-bit）读写与起音检测。
 *
 * 示例素材里的“音调标记”由这里合成，核对页再用同一套读取逻辑
 * 找出每个音调真正的起始时刻，和字幕时间轴对比。不依赖 ffmpeg。
 */
import { readFileSync, writeFileSync } from 'node:fs';

export function encodeWav(samples, { sampleRate = 48000, channels = 1 } = {}) {
  const frames = samples.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(clamped * 32767), offset);
    offset += 2;
    for (let c = 1; c < channels; c += 1) {
      buffer.writeInt16LE(Math.round(clamped * 32767), offset);
      offset += 2;
    }
  }
  return buffer;
}

export function writeWav(filePath, samples, options) {
  writeFileSync(filePath, encodeWav(samples, options));
}

export function decodeWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件');
  }
  let cursor = 12;
  let format = null;
  let data = null;

  while (cursor + 8 <= buffer.length) {
    const id = buffer.toString('ascii', cursor, cursor + 4);
    const size = buffer.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    const end = Math.min(start + size, buffer.length);
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(start, end);
    }
    cursor = start + size + (size % 2);
  }

  if (!format || !data) throw new Error('WAV 缺少 fmt 或 data chunk');
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error('仅支持 16-bit PCM WAV');
  }

  const frameCount = Math.floor(data.length / (format.channels * 2));
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    for (let c = 0; c < format.channels; c += 1) {
      sum += data.readInt16LE((i * format.channels + c) * 2) / 32768;
    }
    samples[i] = sum / format.channels;
  }

  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    duration: frameCount / format.sampleRate,
    samples,
  };
}

export function readWav(filePath) {
  return decodeWav(readFileSync(filePath));
}

/**
 * 起音检测：20ms 窗口 RMS，阈值取峰值 25%，连续 120ms 静音后重新触发。
 * 返回值精确到窗口中心，误差在 ±10ms 量级，足够核对“两轨同一时点”。
 */
export function detectOnsets(samples, { sampleRate = 48000, windowMs = 20, thresholdRatio = 0.25, quietMs = 120 } = {}) {
  const windowSize = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const windows = [];
  for (let start = 0; start + windowSize <= samples.length; start += windowSize) {
    let sum = 0;
    for (let i = start; i < start + windowSize; i += 1) sum += samples[i] * samples[i];
    windows.push({ start, rms: Math.sqrt(sum / windowSize) });
  }
  if (!windows.length) return [];

  const peak = Math.max(...windows.map((w) => w.rms));
  if (peak < 1e-4) return [];
  const threshold = peak * thresholdRatio;
  const quietWindows = Math.max(1, Math.round(quietMs / windowMs));

  const onsets = [];
  let above = false;
  let quietRun = quietWindows;
  for (const win of windows) {
    if (win.rms > threshold) {
      if (!above && quietRun >= quietWindows) {
        onsets.push((win.start + windowSize / 2) / sampleRate);
      }
      above = true;
      quietRun = 0;
    } else {
      above = false;
      quietRun += 1;
    }
  }
  return onsets;
}

/** 生成一段带包络的正弦音，句首 / 句尾各 15ms 淡入淡出，避免爆音。 */
export function tone({ frequency, duration, sampleRate = 48000, amplitude = 0.32, pattern = null }) {
  const frames = Math.round(duration * sampleRate);
  const out = new Float32Array(frames);
  const fade = Math.round(0.015 * sampleRate);
  const isOn = typeof pattern === 'function' ? pattern : () => true;

  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    if (!isOn(t)) continue;
    const envelope = Math.min(1, i / fade, (frames - i) / fade);
    out[i] = amplitude * Math.max(0, envelope) * Math.sin(2 * Math.PI * frequency * t);
  }
  return out;
}

export function mixInto(target, source, startFrame) {
  for (let i = 0; i < source.length; i += 1) {
    const index = startFrame + i;
    if (index >= 0 && index < target.length) target[index] += source[i];
  }
  return target;
}
