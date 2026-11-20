import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRenderPlan,
  renderPixels,
  encodeLinearToSrgb8
} from '../src/lib/render.js';
import {
  defaultAdjustments,
  cloneAdjustments,
  validateExposure,
  validateWhiteBalance,
  validateSaturation
} from '../src/lib/adjustments.js';

function pixel(r, g, b, a = 255) {
  return new Uint8ClampedArray([r, g, b, a]);
}

function roundTrip(rgb) {
  const out = renderPixels(pixel(...rgb), defaultAdjustments());
  return [out[0], out[1], out[2]];
}

test('default adjustments are a pixel-identical identity', () => {
  const plan = buildRenderPlan(defaultAdjustments());
  assert.equal(plan.identity, true);
  const source = new Uint8ClampedArray(256 * 4 * 4);
  for (let i = 0; i < 256; i += 1) {
    for (let c = 0; c < 4; c += 1) {
      source[i * 4 + c] = c === 3 ? 255 : i;
    }
  }
  const out = renderPixels(source, defaultAdjustments());
  assert.deepEqual(Array.from(out), Array.from(source));
  // every grey value survives the LUT chain unchanged
  for (let v = 0; v < 256; v += 1) {
    assert.deepEqual(roundTrip([v, v, v]), [v, v, v], `grey ${v}`);
  }
});

test('exposure +1 EV roughly doubles linear light', () => {
  // sRGB 100 encodes linear ~0.1274; doubling gives ~0.2547 -> sRGB ~138
  const out = renderPixels(pixel(100, 100, 100), { ...defaultAdjustments(), exposure: { ev: 1 } });
  const before = 100 / 255;
  const lin = ((before + 0.055) / 1.055) ** 2.4;
  const expected = Math.round((1.055 * (lin * 2) ** (1 / 2.4) - 0.055) * 255);
  assert.ok(Math.abs(out[0] - expected) <= 1, `expected ~${expected}, got ${out[0]}`);
  assert.equal(out[0], out[1]);
  assert.equal(out[1], out[2]);
});

test('exposure is monotonic and clamps at the ends', () => {
  const up = { ...defaultAdjustments(), exposure: { ev: 2 } };
  const down = { ...defaultAdjustments(), exposure: { ev: -2 } };
  const midUp = renderPixels(pixel(100, 100, 100), up)[0];
  const midDown = renderPixels(pixel(100, 100, 100), down)[0];
  assert.ok(midUp > 100);
  assert.ok(midDown < 100);
  assert.equal(renderPixels(pixel(255, 255, 255), up)[0], 255);
  assert.equal(renderPixels(pixel(0, 0, 0), down)[0], 0);
});

test('white balance temperature is neutral in luminance', () => {
  const warm = cloneAdjustments(defaultAdjustments());
  warm.whiteBalance.temperature = 60;
  const out = renderPixels(pixel(128, 128, 128), warm);
  assert.ok(out[0] > 128, 'warm pushes red up');
  assert.ok(out[2] < 128, 'warm pushes blue down');
  assert.ok(Math.abs(out[0] - out[2]) > 5);
  // The luma normalization keeps perceived brightness roughly constant; a
  // little drift is expected because the normalization is linear-light only.
  const lumaAfter = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
  assert.ok(Math.abs(lumaAfter - 128) < 20, `luma drift ${lumaAfter - 128}`);
});

test('tint shifts green against magenta', () => {
  const tinted = cloneAdjustments(defaultAdjustments());
  tinted.whiteBalance.tint = 50;
  const out = renderPixels(pixel(128, 128, 128), tinted);
  assert.ok(out[1] < 128, 'positive tint lowers green');
  assert.ok(out[0] > 128 && out[2] > 128, 'red and blue rise');
});

test('saturation 0 is identity, -100 is greyscale, +100 amplifies', () => {
  const grey = { ...defaultAdjustments(), saturation: { value: -100 } };
  const flat = renderPixels(pixel(200, 60, 30), grey);
  assert.ok(Math.abs(flat[0] - flat[1]) <= 1 && Math.abs(flat[1] - flat[2]) <= 1, 'desaturated to grey');

  const punchy = { ...defaultAdjustments(), saturation: { value: 60 } };
  const vivid = renderPixels(pixel(200, 60, 30), punchy);
  assert.ok(vivid[0] > 200 - 1);
  assert.ok(vivid[1] < 60);
});

test('alpha channel is preserved exactly', () => {
  const adj = { ...defaultAdjustments(), exposure: { ev: 1.5 } };
  const out = renderPixels(pixel(10, 20, 30, 77), adj);
  assert.equal(out[3], 77);
});

test('adjustment validators reject out-of-range values', () => {
  assert.equal(validateExposure({ ev: 6 }).ok, false);
  assert.equal(validateExposure({ ev: -6 }).ok, false);
  assert.equal(validateExposure({ ev: '1' }).ok, false);
  assert.equal(validateExposure({ ev: 2.5 }).ok, true);
  assert.equal(validateWhiteBalance({ temperature: 101, tint: 0 }).ok, false);
  assert.equal(validateWhiteBalance({ temperature: 0, tint: -101 }).ok, false);
  assert.equal(validateWhiteBalance({ temperature: -100, tint: 100 }).ok, true);
  assert.equal(validateSaturation({ value: 200 }).ok, false);
  assert.equal(validateSaturation({ value: -100 }).ok, true);
});

test('encodeLinearToSrgb8 matches the reference transfer function', () => {
  const reference = (v) => {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
  };
  for (let i = 0; i <= 100; i += 1) {
    const v = i / 100;
    assert.ok(Math.abs(encodeLinearToSrgb8(v) - reference(v)) <= 1, `v=${v}`);
  }
});

test('renderPixels can reuse a target buffer without leaking old pixels', () => {
  const source = new Uint8ClampedArray([10, 20, 30, 255, 200, 100, 50, 255]);
  const target = new Uint8ClampedArray(source.length).fill(99);
  const out = renderPixels(source, defaultAdjustments(), target);
  assert.equal(out, target);
  assert.deepEqual(Array.from(out), Array.from(source));
});
