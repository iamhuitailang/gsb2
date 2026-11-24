import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWavPcm16, encodeWavPcm16 } from '../src/audio/wav.ts';

test('WAV 编码后可严格解码，采样值保持 PCM16 精度', () => {
  const input = new Float32Array([0, 0.25, -0.5, 1, -1, 0.003]);
  const buf = encodeWavPcm16(input, 44100);
  const decoded = decodeWavPcm16(new Uint8Array(buf));
  assert.equal(decoded.sampleRate, 44100);
  assert.equal(decoded.samples.length, input.length);
  for (let i = 0; i < input.length; i++) {
    assert.ok(Math.abs(decoded.samples[i] - input[i]) < 1 / 32768 + 1e-9);
  }
});

test('损坏文件被严格解码器拒绝', () => {
  const garbage = new Uint8Array(400);
  garbage.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  assert.throws(() => decodeWavPcm16(garbage));
});

test('过短文件被拒绝', () => {
  assert.throws(() => decodeWavPcm16(new Uint8Array([1, 2, 3])));
});
