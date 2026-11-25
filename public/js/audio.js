// 音频文件加载、解码与 WAV 编码，全部在浏览器本地完成。
let sharedCtx = null;

export function getAudioContext() {
  if (!sharedCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    sharedCtx = new AC();
  }
  if (sharedCtx.state === 'suspended') sharedCtx.resume();
  return sharedCtx;
}

export async function decodeAudioFile(file) {
  const ctx = getAudioContext();
  const buf = await file.arrayBuffer();
  const audio = await ctx.decodeAudioData(buf);
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    buffer: audio,
  };
}

// 多声道混合为单声道，供相关性分析使用。
export function mixToMono(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  const ch = buffer.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i] / ch;
  }
  return out;
}

// 利用浏览器离线渲染做高质量重采样。
export async function resampleBuffer(buffer, targetRate) {
  if (buffer.sampleRate === targetRate) return buffer;
  const duration = buffer.duration;
  const off = new OfflineAudioContext(buffer.numberOfChannels,
    Math.ceil(duration * targetRate), targetRate);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start(0);
  return off.startRendering();
}

function clamp16(v) {
  v = Math.max(-1, Math.min(1, v));
  return v < 0 ? v * 0x8000 : v * 0x7fff;
}

// 将 AudioBuffer 编码为 16-bit PCM WAV（保留原声道数）。
export function encodeWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * numCh * bytesPerSample;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * numCh * bytesPerSample, true);
  dv.setUint16(32, numCh * bytesPerSample, true);
  dv.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);
  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      dv.setInt16(off, clamp16(channels[c][i]), true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
