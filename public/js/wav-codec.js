/*
 * wav-codec.js —— 纯 JS WAV 编解码（零依赖，浏览器 / Node 通用）
 *
 * decodeWav(ArrayBuffer|Uint8Array):
 *   支持 PCM 8/16/24/32-bit 与 IEEE float32，单/双声道；
 *   返回 { sampleRate, channels: [Float32Array, ...], numberOfChannels }
 *
 * encodeWav(channels, sampleRate):
 *   输出 16-bit PCM WAV 的 ArrayBuffer
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WavCodec = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function asUint8(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new Error('WAV 输入需要是 ArrayBuffer 或 Uint8Array');
  }

  function decodeWav(data) {
    const bytes = asUint8(data);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 44 || dv.getUint32(0, false) !== 0x52494646 /* RIFF */) {
      throw new Error('不是合法的 WAV 文件（缺少 RIFF 头）');
    }
    if (dv.getUint32(8, false) !== 0x57415645 /* WAVE */) {
      throw new Error('不是合法的 WAV 文件（缺少 WAVE 标识）');
    }

    let offset = 12;
    let fmt = null;
    let dataChunk = null;

    while (offset + 8 <= bytes.length) {
      const id = dv.getUint32(offset, false);
      const size = dv.getUint32(offset + 4, true);
      const body = offset + 8;
      if (body + size > bytes.length) break;
      if (id === 0x666d7420 /* fmt  */) {
        fmt = {
          formatTag: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bitsPerSample: dv.getUint16(body + 14, true),
        };
      } else if (id === 0x64617461 /* data */) {
        dataChunk = { offset: body, size };
      }
      offset = body + size + (size & 1); // chunk 按偶数字节对齐
    }

    if (!fmt) throw new Error('WAV 缺少 fmt 块');
    if (!dataChunk) throw new Error('WAV 缺少 data 块');
    if (fmt.channels < 1 || fmt.channels > 2) {
      throw new Error('仅支持单声道或立体声 WAV，实际声道数：' + fmt.channels);
    }
    const isPcm = fmt.formatTag === 1;
    const isFloat = fmt.formatTag === 3 && fmt.bitsPerSample === 32;
    if (!isPcm && !isFloat) {
      throw new Error('仅支持 PCM 或 IEEE float32 WAV，formatTag=' + fmt.formatTag);
    }

    const { channels: ch, sampleRate, bitsPerSample } = fmt;
    const frameBytes = (bitsPerSample / 8) * ch;
    const frameCount = Math.floor(dataChunk.size / frameBytes);
    if (frameCount <= 0) throw new Error('WAV 中没有音频数据');

    const out = [];
    for (let c = 0; c < ch; c++) out.push(new Float32Array(frameCount));

    let p = dataChunk.offset;
    for (let i = 0; i < frameCount; i++) {
      for (let c = 0; c < ch; c++, p += bitsPerSample / 8) {
        let v;
        if (isFloat) {
          v = dv.getFloat32(p, true);
        } else if (bitsPerSample === 8) {
          v = (dv.getUint8(p) - 128) / 128;
        } else if (bitsPerSample === 16) {
          v = dv.getInt16(p, true) / 32768;
        } else if (bitsPerSample === 24) {
          const lo = dv.getUint8(p);
          const mid = dv.getUint8(p + 1);
          const hi = dv.getUint8(p + 2);
          let int24 = lo | (mid << 8) | (hi << 16);
          if (int24 & 0x800000) int24 |= -1 << 24; // 符号扩展
          v = int24 / 8388608;
        } else if (bitsPerSample === 32) {
          v = dv.getInt32(p, true) / 2147483648;
        } else {
          throw new Error('不支持的位深：' + bitsPerSample + ' bit');
        }
        out[c][i] = Math.max(-1, Math.min(1, v));
      }
    }

    return { sampleRate, numberOfChannels: ch, channels: out };
  }

  function encodeWav(channels, sampleRate) {
    const ch = channels.length;
    if (ch !== 1 && ch !== 2) throw new Error('仅支持单声道或立体声导出');
    const frames = channels[0].length;
    for (let c = 1; c < ch; c++) {
      if (channels[c].length !== frames) throw new Error('各声道长度不一致');
    }
    const dataSize = frames * ch * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    dv.setUint32(0, 0x52494646, false); // RIFF
    dv.setUint32(4, 36 + dataSize, true);
    dv.setUint32(8, 0x57415645, false); // WAVE
    dv.setUint32(12, 0x666d7420, false); // fmt
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, ch, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * ch * 2, true);
    dv.setUint16(32, ch * 2, true);
    dv.setUint16(34, 16, true);
    dv.setUint32(36, 0x64617461, false); // data
    dv.setUint32(40, dataSize, true);

    let p = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < ch; c++) {
        const v = Math.max(-1, Math.min(1, channels[c][i]));
        dv.setInt16(p, v < 0 ? v * 32768 : v * 32767, true);
        p += 2;
      }
    }
    return { buffer: buf, bytes: u8 };
  }

  return { decodeWav, encodeWav };
});
