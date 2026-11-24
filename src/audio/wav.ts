/**
 * 最小 WAV (PCM16, 单声道) 编解码。
 * 生成器写文件用 encode；测试与加载器的校验路径用 decode 读回。
 */

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeStr = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return bytes;
}

export interface DecodedWav {
  sampleRate: number;
  samples: Float32Array;
}

/** 严格解码：头不合法直接抛错，用于测试与“坏样本”识别 */
export function decodeWavPcm16(bytes: Uint8Array): DecodedWav {
  if (bytes.length < 44) throw new Error('文件过短，不是合法 WAV');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'RIFF') throw new Error('缺少 RIFF 头');
  if (String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== 'WAVE') {
    throw new Error('缺少 WAVE 标识');
  }
  let offset = 12;
  let foundFmt = false;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (view.getUint16(body, true) !== 1) throw new Error('仅支持 PCM 格式');
      if (view.getUint16(body + 2, true) !== 1) throw new Error('仅支持单声道');
      if (view.getUint16(body + 14, true) !== 16) throw new Error('仅支持 16-bit PCM');
      foundFmt = true;
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
    }
    offset = body + size + (size % 2);
  }
  if (!foundFmt) throw new Error('缺少 fmt 块');
  if (dataOffset < 0) throw new Error('缺少 data 块');
  if (dataOffset + dataLength > bytes.length) throw new Error('data 块长度超出文件');
  const frameCount = Math.floor(dataLength / 2);
  const out = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    out[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
  }
  return { sampleRate: view.getUint32(24, true), samples: out };
}
