// WAV 解码/编码（PCM 8/16/24/32 位与 IEEE float32），纯函数无 DOM 依赖。
(function (root) {
  const RL = root.RoomLab || (root.RoomLab = {});

  function readAscii(dv, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    return s;
  }

  // 解码：返回 { channels: Float32Array[], sampleRate, bitDepth, formatTag }
  function decodeWav(buffer) {
    const dv = new DataView(buffer);
    if (readAscii(dv, 0, 4) !== 'RIFF' || readAscii(dv, 8, 4) !== 'WAVE') {
      throw new Error('不是 WAV 文件（缺少 RIFF/WAVE 标识）');
    }
    let off = 12;
    let fmt = null;
    let dataOff = -1;
    let dataLen = 0;
    while (off + 8 <= dv.buffer.byteLength) {
      const id = readAscii(dv, off, 4);
      const size = dv.getUint32(off + 4, true);
      const body = off + 8;
      if (id === 'fmt ') {
        fmt = {
          formatTag: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bitsPerSample: dv.getUint16(body + 14, true),
          extTag: size >= 40 ? dv.getUint16(body + 24, true) : null,
        };
      } else if (id === 'data') {
        dataOff = body;
        dataLen = size;
        break; // 解析到 data 即停，尾部不关心
      }
      off = body + size + (size & 1); // chunk 按字对齐
    }
    if (!fmt) throw new Error('WAV 缺少 fmt 块');
    if (dataOff < 0) throw new Error('WAV 缺少 data 块');
    const tag = fmt.formatTag === 0xFFFE && fmt.extTag != null ? fmt.extTag : fmt.formatTag;
    const ch = Math.min(fmt.channels, 2); // 本工具只处理单/立体声
    const frames = Math.floor(dataLen / fmt.channels / (fmt.bitsPerSample / 8));
    const channels = Array.from({ length: ch }, () => new Float32Array(frames));
    const bytes = fmt.bitsPerSample / 8;

    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < fmt.channels; c++) {
        const p = dataOff + (f * fmt.channels + c) * bytes;
        let v = 0;
        if (tag === 3 && fmt.bitsPerSample === 32) {
          v = dv.getFloat32(p, true);
        } else if (fmt.bitsPerSample === 8) {
          v = (dv.getUint8(p) - 128) / 128;
        } else if (fmt.bitsPerSample === 16) {
          v = dv.getInt16(p, true) / 32768;
        } else if (fmt.bitsPerSample === 24) {
          const b0 = dv.getUint8(p), b1 = dv.getUint8(p + 1), b2 = dv.getUint8(p + 2);
          let raw = b0 | (b1 << 8) | (b2 << 16);
          if (raw & 0x800000) raw |= ~0xFFFFFF; // 符号扩展
          v = raw / 8388608;
        } else if (fmt.bitsPerSample === 32) {
          v = dv.getInt32(p, true) / 2147483648;
        } else {
          throw new Error('不支持的位深：' + fmt.bitsPerSample);
        }
        if (c < ch) channels[c][f] = v;
      }
    }
    return {
      channels,
      sampleRate: fmt.sampleRate,
      channelsRaw: fmt.channels,
      bitDepth: fmt.bitsPerSample,
      formatTag: tag,
      duration: frames / fmt.sampleRate,
    };
  }

  function interleave(channels) {
    const frames = channels[0].length;
    const ch = channels.length;
    const out = new Float32Array(frames * ch);
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < ch; c++) out[f * ch + c] = channels[c][f];
    }
    return out;
  }

  // 编码为 WAV ArrayBuffer；bitDepth: 16 | 24 | '32f'（数字或字符串均可）
  function encodeWav(channels, sampleRate, bitDepth) {
    const isFloat = String(bitDepth) === '32f';
    const bd = isFloat ? 32 : Number(bitDepth);
    const ch = channels.length;
    const frames = channels[0].length;
    const bytes = isFloat ? 4 : bd / 8;
    const dataLen = frames * ch * bytes;
    const buffer = new ArrayBuffer(44 + dataLen);
    const dv = new DataView(buffer);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };

    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + dataLen, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, isFloat ? 3 : 1, true);
    dv.setUint16(22, ch, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * ch * bytes, true);
    dv.setUint16(32, ch * bytes, true);
    dv.setUint16(34, bd, true);
    writeStr(36, 'data');
    dv.setUint32(40, dataLen, true);

    const clamp = (v) => Math.max(-1, Math.min(1, v));
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < ch; c++) {
        const p = 44 + (f * ch + c) * bytes;
        const v = clamp(channels[c][f]);
        if (bd === 16) {
          dv.setInt16(p, Math.round(v * 32767), true);
        } else if (bd === 24) {
          const raw = Math.round(v * 8388607);
          dv.setUint8(p, raw & 0xFF);
          dv.setUint8(p + 1, (raw >> 8) & 0xFF);
          dv.setUint8(p + 2, (raw >> 16) & 0xFF);
        } else {
          dv.setFloat32(p, v, true);
        }
      }
    }
    return buffer;
  }

  RL.wav = { decodeWav, encodeWav, interleave };
})(typeof globalThis !== 'undefined' ? globalThis : this);
