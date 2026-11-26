/* WAV 编码：把各声道 Float32 数据写成 16/24-bit PCM 或 32-bit float 的 WAV 文件。 */
"use strict";

function encodeWAV(channels, sampleRate, format) {
  const numCh = channels.length;
  const numFrames = channels[0].length;
  const isFloat = format === "32f";
  const bits = isFloat ? 32 : parseInt(format, 10);
  const bytesPerSample = bits / 8;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  let o = 0;
  const wStr = (s) => { for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); };
  const wU16 = (x) => { v.setUint16(o, x, true); o += 2; };
  const wU32 = (x) => { v.setUint32(o, x, true); o += 4; };

  wStr("RIFF"); wU32(36 + dataSize); wStr("WAVE");
  wStr("fmt "); wU32(16);
  wU16(isFloat ? 3 : 1);          // 音频格式: 1=PCM, 3=IEEE float
  wU16(numCh); wU32(sampleRate);
  wU32(sampleRate * blockAlign);  // 字节率
  wU16(blockAlign); wU16(bits);
  wStr("data"); wU32(dataSize);

  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i]));
      if (isFloat) { v.setFloat32(o, x, true); o += 4; }
      else if (bits === 16) { v.setInt16(o, Math.round(x * 32767), true); o += 2; }
      else { // 24-bit
        let s = Math.round(x * 8388607);
        if (s < 0) s += 1 << 24;
        v.setUint8(o++, s & 0xff);
        v.setUint8(o++, (s >> 8) & 0xff);
        v.setUint8(o++, (s >> 16) & 0xff);
      }
    }
  }
  return buf;
}

/* 解析 WAV 文件头，返回 {numChannels, sampleRate}；不完整或无法解析时返回 null。
   用于读回校验时先快速核对格式（内容比对走 decodeAudioData）。 */
function parseWavHeader(buf) {
  try {
    const v = new DataView(buf);
    if (v.getUint32(0, false) !== 0x52494646) return null; // "RIFF"
    if (v.getUint32(8, false) !== 0x57415645) return null; // "WAVE"
    let o = 12;
    while (o + 8 <= buf.byteLength) {
      const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
      const size = v.getUint32(o + 4, true);
      if (id === "fmt ") {
        return { numChannels: v.getUint16(o + 10, true), sampleRate: v.getUint32(o + 12, true) };
      }
      o += 8 + size + (size % 2);
    }
    return null;
  } catch (e) { return null; }
}
