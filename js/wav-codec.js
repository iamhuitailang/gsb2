// wav-codec.js — 纯函数 WAV PCM 编解码器，无 DOM 依赖，可同时在浏览器与 Node 中使用。
// 仅处理未压缩 PCM（8/16/24/32-bit 整数）；压缩格式交给浏览器 AudioContext 解码。

export function clampSample(v) {
  // NaN 不当作 0 静默写入：统一钳到 0，避免产生不可预期的导出结果
  if (!Number.isFinite(v)) return 0;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * 将平面声道数组编码为 WAV PCM ArrayBuffer。
 * @param {Float32Array[]} channels 每个元素一个声道，长度必须一致
 * @param {number} sampleRate 采样率
 * @param {16|24} bitDepth 位深
 */
export function encodeWavPCM(channels, sampleRate, bitDepth = 16) {
  if (!channels || channels.length === 0) throw new Error('没有可导出的声道数据');
  const numChannels = channels.length;
  const numFrames = channels[0].length;
  for (const c of channels) {
    if (c.length !== numFrames) throw new Error('各声道长度不一致，无法编码');
  }
  if (bitDepth !== 16 && bitDepth !== 24) throw new Error('仅支持 16/24 bit PCM 导出');

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buffer);
  let p = 0;
  const writeStr = (s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i));
  };
  const u32 = (v) => { dv.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { dv.setUint16(p, v, true); p += 2; };

  writeStr('RIFF'); u32(36 + dataSize); writeStr('WAVE');
  writeStr('fmt '); u32(16); u16(1); u16(numChannels);
  u32(sampleRate); u32(sampleRate * blockAlign); u16(blockAlign); u16(bitDepth);
  writeStr('data'); u32(dataSize);

  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = clampSample(channels[c][i]);
      if (bitDepth === 16) {
        dv.setInt16(p, Math.round(v * 32767), true);
        p += 2;
      } else {
        const n = Math.round(v * 8388607);
        dv.setUint8(p, n & 0xff);
        dv.setUint8(p + 1, (n >> 8) & 0xff);
        dv.setUint8(p + 2, (n >> 16) & 0xff);
        p += 3;
      }
    }
  }
  return buffer;
}

/**
 * 解码 PCM WAV，返回平面声道 Float32 数据（取值 [-1, 1)）。
 * 支持未知块跳过、奇数长度块填充字节、WAVE_FORMAT_EXTENSIBLE(0xFFFE) 中的 PCM 子格式。
 */
export function decodeWav(arrayBuffer) {
  const buf = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer.buffer;
  if (buf.byteLength < 44) throw new Error('文件过小，不是有效 WAV');
  const dv = new DataView(buf);
  const readStr = (off, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    return s;
  };
  if (readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 文件');
  }

  let off = 12;
  let fmt = null;
  let dataOff = 0;
  let dataSize = 0;
  while (off + 8 <= buf.byteLength) {
    const id = readStr(off, 4);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (body + size > buf.byteLength) break;
    if (id === 'fmt ') {
      const format = dv.getUint16(body, true);
      let actualFormat = format;
      if (format === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE：SubFormat GUID 的前两个字节是真实格式码
        actualFormat = dv.getUint16(body + 24, true);
      }
      fmt = {
        format: actualFormat,
        numChannels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitDepth: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataSize = size;
    }
    off = body + size + (size & 1); // 块按字对齐，奇数长度有 1 填充字节
  }

  if (!fmt) throw new Error('WAV 缺少 fmt 块');
  if (!dataSize) throw new Error('WAV 缺少 data 块');
  if (fmt.format !== 1) throw new Error('仅支持未压缩 PCM WAV（该文件可能是压缩格式）');

  const { numChannels, sampleRate, bitDepth } = fmt;
  const bytesPerSample = bitDepth / 8;
  const usable = Math.min(dataSize, buf.byteLength - dataOff);
  const frames = Math.floor(usable / (numChannels * bytesPerSample));
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const pos = dataOff + (i * numChannels + c) * bytesPerSample;
      let v = 0;
      if (bitDepth === 16) {
        v = dv.getInt16(pos, true) / 32768;
      } else if (bitDepth === 24) {
        let n = dv.getUint8(pos) | (dv.getUint8(pos + 1) << 8) | (dv.getUint8(pos + 2) << 16);
        if (n & 0x800000) n |= -1 << 24; // 符号扩展
        v = n / 8388608;
      } else if (bitDepth === 32) {
        v = dv.getInt32(pos, true) / 2147483648;
      } else if (bitDepth === 8) {
        v = (dv.getUint8(pos) - 128) / 128; // 8-bit WAV 为无符号
      } else {
        throw new Error(`不支持的 PCM 位深: ${bitDepth}-bit`);
      }
      channels[c][i] = v;
    }
  }
  return { channels, sampleRate, bitDepth, numChannels, numFrames: frames };
}

/** ArrayBuffer → base64（浏览器环境，工程保存用） */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → ArrayBuffer（工程打开用） */
export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}
