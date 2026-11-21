import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampMinRegionArea,
  clampSensitivity,
  computeDiff,
  sensitivityToThreshold,
} from '../src/core/diff.js';

/** Build a solid-colour RGBA buffer with an optional painted rectangle. */
function makeImage(width, height, bg, rects = []) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    data[o] = bg[0];
    data[o + 1] = bg[1];
    data[o + 2] = bg[2];
    data[o + 3] = 255;
  }
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const o = (y * width + x) * 4;
        data[o] = r.color[0];
        data[o + 1] = r.color[1];
        data[o + 2] = r.color[2];
        data[o + 3] = r.color[3] ?? 255;
      }
    }
  }
  return data;
}

const WHITE = [245, 245, 245];

test('identical images produce no change', () => {
  const a = makeImage(64, 48, WHITE);
  const b = makeImage(64, 48, WHITE);
  const result = computeDiff({ aPixels: a, bPixels: b, width: 64, height: 48 });
  assert.equal(result.stats.changedPixels, 0);
  assert.equal(result.stats.changedArea, 0);
  assert.equal(result.regions.length, 0);
  assert.equal(result.stats.comparedPixels, 64 * 48);
});

test('a solid rectangle is detected as one region with the right area', () => {
  const a = makeImage(80, 60, WHITE);
  const b = makeImage(80, 60, WHITE, [{ x: 10, y: 12, w: 20, h: 16, color: [20, 20, 20] }]);
  const result = computeDiff({
    aPixels: a,
    bPixels: b,
    width: 80,
    height: 60,
    sensitivity: 55,
    minRegionArea: 0,
  });
  assert.equal(result.regions.length, 1);
  const region = result.regions[0];
  assert.equal(region.type, 'color');
  assert.equal(Math.round(region.area), 20 * 16);
  assert.deepEqual(
    { x: region.bbox.x, y: region.bbox.y, w: region.bbox.width, h: region.bbox.height },
    { x: 10, y: 12, w: 20, h: 16 },
  );
  assert.ok(result.stats.changedArea >= 20 * 16);
});

test('sensitivity raises and lowers the detection threshold', () => {
  assert.ok(sensitivityToThreshold(0) > sensitivityToThreshold(50));
  assert.ok(sensitivityToThreshold(50) > sensitivityToThreshold(100));
  assert.equal(sensitivityToThreshold(100), 4);
  assert.equal(sensitivityToThreshold(0), 80);
});

test('low sensitivity ignores subtle tint changes', () => {
  const width = 60;
  const height = 40;
  const a = makeImage(width, height, [200, 200, 200]);
  const b = makeImage(width, height, [190, 190, 190]);
  const strict = computeDiff({
    aPixels: a,
    bPixels: b,
    width,
    height,
    sensitivity: 10,
    minRegionArea: 0,
  });
  const loose = computeDiff({
    aPixels: a,
    bPixels: b,
    width,
    height,
    sensitivity: 100,
    minRegionArea: 0,
  });
  assert.equal(strict.stats.changedPixels, 0);
  assert.ok(loose.stats.changedPixels > 0);
});

test('ignore mask removes the change from stats and regions', () => {
  const width = 64;
  const height = 64;
  const a = makeImage(width, height, WHITE);
  const b = makeImage(width, height, WHITE, [
    { x: 4, y: 4, w: 20, h: 20, color: [0, 0, 0] },
    { x: 40, y: 40, w: 16, h: 16, color: [0, 0, 0] },
  ]);
  const ignoreMask = new Uint8Array(width * height);
  for (let y = 0; y < 26; y++) {
    for (let x = 0; x < 26; x++) ignoreMask[y * width + x] = 1;
  }
  const result = computeDiff({
    aPixels: a,
    bPixels: b,
    width,
    height,
    ignoreMask,
    minRegionArea: 0,
  });
  assert.equal(result.regions.length, 1);
  assert.equal(Math.round(result.regions[0].area), 16 * 16);
  assert.equal(result.stats.ignoredPixels, 26 * 26);
  // Ignored pixels must not be highlighted either.
  const ignoredPixel = (5 * width + 5) * 4;
  assert.equal(result.overlayPixels[ignoredPixel + 3], 0);
});

test('isolated speckle is filtered out', () => {
  const width = 40;
  const height = 40;
  const a = makeImage(width, height, WHITE);
  const b = makeImage(width, height, WHITE, [
    { x: 20, y: 20, w: 1, h: 1, color: [0, 0, 0] },
  ]);
  const result = computeDiff({
    aPixels: a,
    bPixels: b,
    width,
    height,
    minRegionArea: 0,
  });
  assert.equal(result.stats.changedPixels, 0);
});

test('minRegionArea drops regions below the threshold', () => {
  const width = 80;
  const height = 80;
  const a = makeImage(width, height, WHITE);
  const b = makeImage(width, height, WHITE, [
    { x: 5, y: 5, w: 4, h: 4, color: [0, 0, 0] },
    { x: 30, y: 30, w: 20, h: 20, color: [0, 0, 0] },
  ]);
  const result = computeDiff({
    aPixels: a,
    bPixels: b,
    width,
    height,
    minRegionArea: 50,
  });
  assert.equal(result.regions.length, 1);
  assert.equal(Math.round(result.regions[0].area), 400);
});

test('uncovered content is optional', () => {
  const width = 50;
  const height = 50;
  const a = makeImage(width, height, WHITE);
  const b = makeImage(width, height, WHITE);
  // Punch a transparent hole into B's top-left 10x10.
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const o = (y * width + x) * 4;
      b[o] = 0;
      b[o + 1] = 0;
      b[o + 2] = 0;
      b[o + 3] = 0;
    }
  }
  const off = computeDiff({ aPixels: a, bPixels: b, width, height, minRegionArea: 0 });
  const on = computeDiff({
    aPixels: a,
    bPixels: b,
    width,
    height,
    minRegionArea: 0,
    includeUncovered: true,
  });
  assert.equal(off.stats.changedPixels, 0);
  assert.equal(on.regions.length, 1);
  assert.equal(on.regions[0].type, 'coverage');
  assert.equal(Math.round(on.regions[0].area), 100);
});

test('changedPct is relative to the compared overlap', () => {
  const width = 100;
  const height = 100;
  const a = makeImage(width, height, WHITE);
  const b = makeImage(width, height, WHITE, [
    { x: 0, y: 0, w: 50, h: 100, color: [0, 0, 0] },
  ]);
  const result = computeDiff({ aPixels: a, bPixels: b, width, height, minRegionArea: 0 });
  assert.ok(Math.abs(result.stats.changedPct - 50) < 0.2);
});

test('sensitivity and min area clamp to sane ranges', () => {
  assert.equal(clampSensitivity(-10), 0);
  assert.equal(clampSensitivity(500), 100);
  assert.equal(clampSensitivity(55.4), 55);
  assert.equal(clampSensitivity('abc'), 55);
  assert.equal(clampMinRegionArea(-5), 0);
  assert.equal(clampMinRegionArea(1e9), 100000);
});

test('diff factor scales pixel statistics back to world units', () => {
  const width = 100;
  const height = 100;
  const a = makeImage(width, height, WHITE);
  const b = makeImage(width, height, WHITE, [
    { x: 20, y: 20, w: 20, h: 20, color: [0, 0, 0] },
  ]);
  const result = computeDiff({
    aPixels: a,
    bPixels: b,
    width,
    height,
    factor: 0.5,
    bounds: { minX: 0, minY: 0, width: 200, height: 200 },
    minRegionArea: 0,
  });
  // 20x20 diff pixels at 0.5 px/world -> 40x40 world area.
  assert.equal(Math.round(result.stats.changedArea), 1600);
  assert.equal(Math.round(result.regions[0].area), 1600);
});

test('composite output keeps the base layer when the overlay is hidden', () => {
  const width = 32;
  const height = 32;
  const a = makeImage(width, height, WHITE);
  const b = makeImage(width, height, WHITE, [
    { x: 8, y: 8, w: 8, h: 8, color: [255, 0, 0] },
  ]);
  const result = computeDiff({ aPixels: a, bPixels: b, width, height, minRegionArea: 0 });
  assert.equal(result.compositePixels.length, width * height * 4);
  assert.equal(result.basePixels.length, width * height * 4);
  assert.equal(result.overlayPixels.length, width * height * 4);
  const basePixel = (2 * width + 2) * 4;
  assert.equal(result.basePixels[basePixel + 3], 255);
});

test('alpha-only differences count as changes', () => {
  const width = 40;
  const height = 40;
  const a = makeImage(width, height, [0, 0, 0]);
  const b = makeImage(width, height, [0, 0, 0]);
  // Lower the opacity of a solid 8x8 block in B.
  for (let y = 10; y < 18; y++) {
    for (let x = 10; x < 18; x++) {
      b[(y * width + x) * 4 + 3] = 40;
    }
  }
  const result = computeDiff({
    aPixels: a,
    bPixels: b,
    width,
    height,
    minRegionArea: 0,
    sensitivity: 90,
  });
  assert.ok(result.stats.changedPixels > 0);
  assert.equal(result.regions.length, 1);
  assert.equal(Math.round(result.regions[0].area), 64);
});
