/*
 * wav-codec.js — 无依赖 WAV 解析 / 封装 / 回读核对
 * UMD：浏览器挂到 window.WAV，Node 下 module.exports。
 *
 * 解码支持：PCM 8/16/24/32-bit、IEEE float 32/64-bit、单声道及多声道
 * （业务层只接受双声道，声道校验在 app 层做）。
 * 编码支持：16-bit PCM、32-bit IEEE float。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WAV = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PCM = 1;
  const FLOAT = 3;
  // WAVE_FORMAT_EXTENSIBLE 的子格式 GUID 前两个字节即格式码
  const KSDATAFORMAT_SUBTYPE_PCM = '00000001';
  const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = '00000003';

  function readAscii(view, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  }

  /**
   * 解码 WAV ArrayBuffer。
   * 返回 { sampleRate, channels, bitsPerSample, isFloat, length(每声道帧数), data: Float32Array[channels] }
   */
  function decodeWav(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (arrayBuffer.byteLength < 44 || readAscii(view, 0, 4) !== 'RIFF' ||
        readAscii(view, 8, 4) !== 'WAVE') {
      throw new Error('不是合法的 WAVE 文件（缺少 RIFF/WAVE 标识）');
    }

    let offset = 12;
    let fmt = null;
    let dataOffset = -1;
    let dataLength = 0;

    while (offset + 8 <= view.buffer.byteLength) {
      const id = readAscii(view, offset, 4);
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (id === 'fmt ') {
        fmt = parseFmt(view, body, size);
      } else if (id === 'data') {
        dataOffset = body;
        dataLength = size;
        break; // 所需块已齐，忽略其后的元数据块
      }
      offset = body + size + (size & 1); // 块按字对齐
    }

    if (!fmt) throw new Error('WAV 中缺少 fmt 块');
    if (dataOffset < 0) throw new Error('WAV 中缺少 data 块');

    const { audioFormat, channels, sampleRate, bitsPerSample, isFloat } = fmt;
    if (audioFormat !== PCM && audioFormat !== FLOAT) {
      throw new Error('暂不支持的 WAV 格式码：' + audioFormat + '（仅支持 PCM 与 IEEE float）');
    }
    const frameBytes = (bitsPerSample / 8) * channels;
    if (frameBytes <= 0) throw new Error('非法的位深/声道数');
    const length = Math.floor(dataLength / frameBytes);
    if (length === 0) throw new Error('WAV 数据块为空');

    const data = new Array(channels);
    for (let c = 0; c < channels; c++) data[c] = new Float32Array(length);

    let p = dataOffset;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channels; c++) {
        data[c][i] = readSample(view, p, bitsPerSample, isFloat);
        p += bitsPerSample / 8;
      }
    }

    return { sampleRate, channels, bitsPerSample, isFloat, length, data };
  }

  function parseFmt(view, off, size) {
    const rawFormat = view.getUint16(off, true);
    const channels = view.getUint16(off + 2, true);
    const sampleRate = view.getUint32(off + 4, true);
    const bitsPerSample = view.getUint16(off + 14, true);
    let audioFormat = rawFormat;

    if (rawFormat === 0xFFFE && size >= 40) {
      // WAVE_FORMAT_EXTENSIBLE：子格式 GUID 前 4 字节为小端格式码
      const guid = view.getUint32(off + 24, true);
      const tag = ('00000000' + guid.toString(16)).slice(-8);
      if (tag === KSDATAFORMAT_SUBTYPE_PCM) audioFormat = PCM;
      else if (tag === KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) audioFormat = FLOAT;
    }
    return {
      audioFormat,
      channels,
      sampleRate,
      bitsPerSample,
      isFloat: audioFormat === FLOAT,
    };
  }

  function readSample(view, off, bits, isFloat) {
    if (isFloat) {
      if (bits === 32) return view.getFloat32(off, true);
      if (bits === 64) return view.getFloat64(off, true);
      throw new Error('不支持的浮点位深：' + bits);
    }
    switch (bits) {
      case 8: // 8-bit PCM 为无符号
        return (view.getUint8(off) - 128) / 128;
      case 16:
        return view.getInt16(off, true) / 32768;
      case 24: {
        const b0 = view.getUint8(off);
        const b1 = view.getUint8(off + 1);
        const b2 = view.getUint8(off + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xFFFFFF; // 符号扩展
        return v / 8388608;
      }
      case 32:
        return view.getInt32(off, true) / 2147483648;
      default:
        throw new Error('不支持的 PCM 位深：' + bits);
    }
  }

  /**
   * 编码 16-bit PCM WAV。
   * @param channelsData Float32Array[]，每个数组等长
   */
  function encodeWavPcm16(channelsData, sampleRate) {
    return encodeWav(channelsData, sampleRate, 16, false);
  }

  /** 编码 32-bit IEEE float WAV */
  function encodeWavFloat32(channelsData, sampleRate) {
    return encodeWav(channelsData, sampleRate, 32, true);
  }

  function encodeWav(channelsData, sampleRate, bitsPerSample, isFloat) {
    const channels = channelsData.length;
    const length = channelsData[0].length;
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, isFloat ? FLOAT : PCM, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let p = 44;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channels; c++) {
        let s = channelsData[c][i];
        if (isFloat) {
          view.setFloat32(p, s, true);
          p += 4;
        } else {
          s = Math.max(-1, Math.min(1, s));
          view.setInt16(p, Math.round(s * 32767), true);
          p += 2;
        }
      }
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function writeAscii(view, off, s) {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  }

  /** 各声道峰值与全文件峰值（绝对值最大采样） */
  function peakInfo(decoded) {
    const channels = decoded.data.map(function (ch) {
      let peak = 0;
      let peakIndex = 0;
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]);
        if (a > peak) { peak = a; peakIndex = i; }
      }
      return { peak: peak, peakIndex: peakIndex };
    });
    let peak = 0;
    for (const c of channels) if (c.peak > peak) peak = c.peak;
    return { channels: channels, peak: peak };
  }

  /**
   * 回读核对：重新解码刚导出的 ArrayBuffer，与期望参数比对。
   * 返回 { ok, errors[], actual:{...} }
   */
  function verifyExport(arrayBuffer, expect) {
    const decoded = decodeWav(arrayBuffer);
    const errors = [];
    if (decoded.channels !== expect.channels) {
      errors.push('声道数不符：回读 ' + decoded.channels + '，期望 ' + expect.channels);
    }
    if (decoded.sampleRate !== expect.sampleRate) {
      errors.push('采样率不符：回读 ' + decoded.sampleRate + '，期望 ' + expect.sampleRate);
    }
    if (decoded.length !== expect.length) {
      errors.push('帧数不符：回读 ' + decoded.length + '，期望 ' + expect.length);
    }
    const info = peakInfo(decoded);
    const tol = expect.bitsPerSample === 16 ? 1 / 32767 + 1e-9 : 1e-6;
    if (Math.abs(info.peak - expect.peak) > tol) {
      errors.push('峰值不符：回读 ' + info.peak.toFixed(6) +
        '，期望 ' + expect.peak.toFixed(6) + '（容差 ' + tol.toExponential(1) + '）');
    }
    return {
      ok: errors.length === 0,
      errors: errors,
      actual: {
        channels: decoded.channels,
        sampleRate: decoded.sampleRate,
        length: decoded.length,
        bitsPerSample: decoded.bitsPerSample,
        isFloat: decoded.isFloat,
        peak: info.peak,
      },
    };
  }

  return {
    decodeWav: decodeWav,
    encodeWavPcm16: encodeWavPcm16,
    encodeWavFloat32: encodeWavFloat32,
    peakInfo: peakInfo,
    verifyExport: verifyExport,
  };
});
