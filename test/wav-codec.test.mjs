import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJs } from './helpers/paths.mjs';

const { decodeWav, encodeWav } = loadJs('wav-codec.js');

function tone(frames, sr, freq = 440, amp = 0.5) {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = amp * Math.sin(2 * Math.PI * freq * i / sr);
  return ch;
}

test('WAV 立体声编码后解码，帧数/采样率/声道一致且内容量化误差有界', () => {
  const sr = 44100;
  const left = tone(sr, sr, 440);
  const right = tone(sr, sr, 660, 0.3);
  const { buffer } = encodeWav([left, right], sr);

  const dec = decodeWav(buffer);
  assert.equal(dec.sampleRate, sr);
  assert.equal(dec.numberOfChannels, 2);
  assert.equal(dec.channels[0].length, sr);

  let maxErr = 0;
  for (let i = 0; i < sr; i++) {
    maxErr = Math.max(maxErr, Math.abs(dec.channels[0][i] - left[i]));
    maxErr = Math.max(maxErr, Math.abs(dec.channels[1][i] - right[i]));
  }
  // 编码器正负量程不对称（负 32768 / 正 32767），最坏误差约 1.5 个量化级
  assert.ok(maxErr <= 1.5 / 32768 + 1e-9, '16bit 量化误差应 <= 1.5/32768，实际 ' + maxErr);
});

test('WAV 单声道往返', () => {
  const sr = 22050;
  const ch = tone(8000, sr, 300);
  const dec = decodeWav(encodeWav([ch], sr).buffer);
  assert.equal(dec.numberOfChannels, 1);
  assert.equal(dec.channels[0].length, 8000);
});

test('非法文件与不支持声道被拒绝并给出说明', () => {
  assert.throws(() => decodeWav(new Uint8Array([1, 2, 3, 4, 5]).buffer), /RIFF/);
  // 手工拼一个 3 声道的 WAV 头
  const sr = 8000;
  const frames = 2048;
  const ch = 3;
  const dataSize = frames * ch * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x52494646); dv.setUint32(4, 36 + dataSize, true);
  dv.setUint32(8, 0x57415645); dv.setUint32(12, 0x666d7420);
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true); dv.setUint32(36, 0x64617461);
  dv.setUint32(40, dataSize, true);
  assert.throws(() => decodeWav(buf), /单声道或立体声/);
});

test('8/16/24/32-bit PCM 与 float32 均可解码', () => {
  const sr = 8000;
  const frames = 2048;
  for (const bits of [8, 16, 24, 32]) {
    const dataSize = frames * (bits / 8);
    const buf = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x52494646); dv.setUint32(4, 36 + dataSize, true);
    dv.setUint32(8, 0x57415645); dv.setUint32(12, 0x666d7420);
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * bits / 8, true); dv.setUint16(32, bits / 8, true);
    dv.setUint16(34, bits, true); dv.setUint32(36, 0x64617461);
    dv.setUint32(40, dataSize, true);
    for (let i = 0; i < frames; i++) {
      const v = Math.sin(2 * Math.PI * 220 * i / sr) * 0.5;
      const p = 44 + i * bits / 8;
      if (bits === 8) dv.setUint8(p, Math.round(v * 127 + 128));
      if (bits === 16) dv.setInt16(p, v * 32767, true);
      if (bits === 24) {
        const int24 = Math.round(v * 8388607);
        dv.setUint8(p, int24 & 0xff);
        dv.setUint8(p + 1, (int24 >> 8) & 0xff);
        dv.setUint8(p + 2, (int24 >> 16) & 0xff);
      }
      if (bits === 32) dv.setInt32(p, Math.round(v * 2147483647), true);
    }
    const dec = decodeWav(buf);
    assert.equal(dec.channels[0].length, frames, bits + 'bit 帧数');
    assert.ok(Math.abs(dec.channels[0][100]) > 0.01, bits + 'bit 有信号');
  }

  // float32
  const dataSize = frames * 4;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x52494646); dv.setUint32(4, 36 + dataSize, true);
  dv.setUint32(8, 0x57415645); dv.setUint32(12, 0x666d7420);
  dv.setUint32(16, 16, true); dv.setUint16(20, 3, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true);
  dv.setUint16(34, 32, true); dv.setUint32(36, 0x64617461);
  dv.setUint32(40, dataSize, true);
  for (let i = 0; i < frames; i++) dv.setFloat32(44 + i * 4, 0.4 * Math.sin(i / 10), true);
  const dec = decodeWav(buf);
  assert.equal(dec.channels[0].length, frames);
});
