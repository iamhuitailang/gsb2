/**
 * Pure pixel pipeline shared by the live preview and the full-resolution
 * exporter. One implementation, two resolutions — that is what keeps "what you
 * see" and "what you export" consistent.
 *
 * Pipeline order:
 *   1. sRGB → linear light
 *   2. white-balance gains + exposure (linear light)
 *   3. linear → sRGB 8-bit
 *   4. tone curves: per-channel curve, then master curve
 *   5. saturation around Rec.709 luma
 *
 * Steps 1–4 are channel-independent, so they collapse into three 256-entry
 * lookup tables built once per adjustment set. The per-pixel loop is then just
 * three LUT reads plus (optionally) saturation.
 */

import { buildCurveLut } from './curve.js';
import { cloneAdjustments } from './adjustments.js';

const DECODE = new Float64Array(256);
for (let i = 0; i < 256; i += 1) {
  const v = i / 255;
  DECODE[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

const ENCODE_STEPS = 4096;
const ENCODE_8 = new Uint8Array(ENCODE_STEPS);
for (let i = 0; i < ENCODE_STEPS; i += 1) {
  const v = i / (ENCODE_STEPS - 1);
  const encoded = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  ENCODE_8[i] = Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

export function encodeLinearToSrgb8(value) {
  if (!(value > 0)) return 0;
  if (value >= 1) return 255;
  return ENCODE_8[(value * (ENCODE_STEPS - 1) + 0.5) | 0];
}

function isNeutral(value) {
  return Math.abs(value - 1) < 1e-9;
}

/**
 * @returns {{
 *   lutR: Uint8Array, lutG: Uint8Array, lutB: Uint8Array,
 *   saturation: number, satFactor: number, identity: boolean,
 *   gains: {r:number,g:number,b:number}, curvesLinear: boolean
 * }}
 */
export function buildRenderPlan(inputAdjustments) {
  const adjustments = cloneAdjustments(inputAdjustments);
  const ev = adjustments.exposure.ev;
  const temperature = adjustments.whiteBalance.temperature / 100;
  const tint = adjustments.whiteBalance.tint / 100;

  // Neutral white balance must stay *exactly* 1.0 on every channel, otherwise
  // the sRGB→linear→sRGB round trip can nudge values by one 8-bit level even
  // though the user changed nothing.
  let rMul;
  let gMul;
  let bMul;
  if (temperature === 0 && tint === 0) {
    const exposureGain = 2 ** ev;
    rMul = exposureGain;
    gMul = exposureGain;
    bMul = exposureGain;
  } else {
    // Warm light lifts red / lowers blue; green is the tint axis. A small
    // magenta lift keeps tint from changing overall brightness.
    let gainR = 1 + 0.35 * temperature;
    let gainB = 1 - 0.35 * temperature;
    let gainG = 1 - 0.25 * tint;
    gainR *= 1 + 0.12 * tint;
    gainB *= 1 + 0.12 * tint;
    gainR = Math.max(0.05, gainR);
    gainG = Math.max(0.05, gainG);
    gainB = Math.max(0.05, gainB);

    const luma = 0.2126 * gainR + 0.7152 * gainG + 0.0722 * gainB;
    const norm = luma > 1e-6 ? luma : 1;
    const exposureGain = 2 ** ev;
    rMul = (gainR / norm) * exposureGain;
    gMul = (gainG / norm) * exposureGain;
    bMul = (gainB / norm) * exposureGain;
  }

  const curves = adjustments.toneCurve;
  const masterLut = buildCurveLut(curves.master, 256);
  const redLut = buildCurveLut(curves.red, 256);
  const greenLut = buildCurveLut(curves.green, 256);
  const blueLut = buildCurveLut(curves.blue, 256);

  const buildChannel = (mul, curveLut) => {
    const lut = new Uint8Array(256);
    const neutral = isNeutral(mul);
    for (let i = 0; i < 256; i += 1) {
      const encoded = neutral ? i : encodeLinearToSrgb8(DECODE[i] * mul);
      const curved = curveLut[encoded];
      lut[i] = Math.round(255 * masterLut[Math.round(curved * 255)]);
    }
    return lut;
  };

  const lutR = buildChannel(rMul, redLut);
  const lutG = buildChannel(gMul, greenLut);
  const lutB = buildChannel(bMul, blueLut);

  const saturation = adjustments.saturation.value;
  const satFactor = Math.max(0, 1 + saturation / 100);
  const curvesLinear =
    curves.master.length === 2 && Math.abs(curves.master[0][1]) < 1e-6 && Math.abs(curves.master[1][1] - 1) < 1e-6 &&
    curves.red.length === 2 && Math.abs(curves.red[0][1]) < 1e-6 && Math.abs(curves.red[1][1] - 1) < 1e-6 &&
    curves.green.length === 2 && Math.abs(curves.green[0][1]) < 1e-6 && Math.abs(curves.green[1][1] - 1) < 1e-6 &&
    curves.blue.length === 2 && Math.abs(curves.blue[0][1]) < 1e-6 && Math.abs(curves.blue[1][1] - 1) < 1e-6;
  const gainsNeutral = isNeutral(rMul) && isNeutral(gMul) && isNeutral(bMul);
  const identity = gainsNeutral && curvesLinear && saturation === 0;

  return {
    lutR,
    lutG,
    lutB,
    saturation,
    satFactor,
    identity,
    curvesLinear,
    gainsNeutral,
    gains: { r: rMul, g: gMul, b: bMul }
  };
}

/**
 * @param {Uint8ClampedArray|Uint8Array} source RGBA pixels
 * @param {object} adjustments
 * @param {Uint8ClampedArray} [target]
 * @returns {Uint8ClampedArray}
 */
export function renderPixels(source, adjustments, target) {
  const dst = target && target.length === source.length ? target : new Uint8ClampedArray(source.length);
  const plan = buildRenderPlan(adjustments);

  if (plan.identity) {
    dst.set(source);
    return dst;
  }

  const { lutR, lutG, lutB, satFactor } = plan;
  const useSaturation = plan.saturation !== 0;

  if (!useSaturation) {
    for (let i = 0; i < source.length; i += 4) {
      dst[i] = lutR[source[i]];
      dst[i + 1] = lutG[source[i + 1]];
      dst[i + 2] = lutB[source[i + 2]];
      dst[i + 3] = source[i + 3];
    }
    return dst;
  }

  for (let i = 0; i < source.length; i += 4) {
    let r = lutR[source[i]];
    let g = lutG[source[i + 1]];
    let b = lutB[source[i + 2]];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = luma + (r - luma) * satFactor;
    g = luma + (g - luma) * satFactor;
    b = luma + (b - luma) * satFactor;
    dst[i] = r;
    dst[i + 1] = g;
    dst[i + 2] = b;
    dst[i + 3] = source[i + 3];
  }
  return dst;
}

/**
 * Convenience wrapper for `ImageData` (browser only).
 */
export function renderImageData(imageData, adjustments) {
  const out = new Uint8ClampedArray(imageData.data.length);
  renderPixels(imageData.data, adjustments, out);
  return new ImageData(out, imageData.width, imageData.height);
}

export function averageLuma(pixels) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    sum += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    count += 1;
  }
  return count ? sum / count : 0;
}
