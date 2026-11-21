import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { encodePng, Raster } from '../scripts/lib/raster.mjs';
import {
  SCENES,
  renderSceneVersion,
  sceneAlignment,
  sceneCornerPoints,
} from '../scripts/lib/scenes.mjs';
import { generateSamples } from '../scripts/generate-samples.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sampleRoot = join(repoRoot, 'public', 'samples');

/** Minimal PNG reader for the generator's own RGBA, non-interlaced output. */
function decodePng(buffer) {
  assert.equal(buffer[1], 0x50, 'PNG signature');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'bit depth');
      assert.equal(data[9], 6, 'RGBA colour type');
      assert.equal(data[12], 0, 'no interlace');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    assert.equal(raw[rowStart], 0, 'filter type none');
    pixels.set(raw.subarray(rowStart + 1, rowStart + 1 + stride), y * stride);
  }
  return { width, height, pixels };
}

test('encodePng round-trips pixel data', () => {
  const raster = new Raster(7, 5);
  raster.fill([12, 34, 56, 255]);
  raster.fillRect(2, 1, 3, 2, [255, 0, 0, 255]);
  const decoded = decodePng(encodePng(raster));
  assert.equal(decoded.width, 7);
  assert.equal(decoded.height, 5);
  const px = (x, y) => {
    const o = (y * 7 + x) * 4;
    return [...decoded.pixels.subarray(o, o + 4)];
  };
  assert.deepEqual(px(0, 0), [12, 34, 56, 255]);
  assert.deepEqual(px(2, 1), [255, 0, 0, 255]);
  assert.deepEqual(px(4, 2), [255, 0, 0, 255]);
  assert.deepEqual(px(6, 4), [12, 34, 56, 255]);
});

test('raster fillRect clips to the canvas', () => {
  const raster = new Raster(10, 10);
  raster.fillRect(-5, -5, 8, 8, [255, 255, 255, 255]);
  const o = 0;
  assert.equal(raster.data[o], 255);
  assert.equal(raster.data[(2 * 10 + 2) * 4], 255);
  assert.equal(raster.data[(5 * 10 + 5) * 4], 0);
});

test('raster downsample averages blocks', () => {
  const raster = new Raster(4, 4);
  raster.fillRect(0, 0, 2, 2, [255, 0, 0, 255]);
  const small = raster.downsample(2);
  assert.equal(small.width, 2);
  assert.equal(small.height, 2);
  assert.equal(small.data[0], 255);
  assert.equal(small.data[(1 * 2 + 1) * 4], 0);
});

test('every scene renders at the declared dimensions', () => {
  for (const scene of SCENES) {
    const a = renderSceneVersion(scene, 'a');
    const b = renderSceneVersion(scene, 'b');
    assert.equal(a.width, scene.a.width, `${scene.id} A width`);
    assert.equal(a.height, scene.a.height, `${scene.id} A height`);
    assert.equal(b.width, scene.b.width, `${scene.id} B width`);
    assert.equal(b.height, scene.b.height, `${scene.id} B height`);
    assert.notEqual(
      `${a.width}x${a.height}`,
      `${b.width}x${b.height}`,
      `${scene.id} must have different sizes`,
    );
  }
});

test('scene rendering is deterministic', () => {
  const scene = SCENES[0];
  const first = renderSceneVersion(scene, 'b');
  const second = renderSceneVersion(scene, 'b');
  assert.deepEqual(Buffer.from(first.data), Buffer.from(second.data));
});

test('scenes differ from A to B in a meaningful number of pixels', () => {
  for (const scene of SCENES) {
    const a = renderSceneVersion(scene, 'a');
    const b = renderSceneVersion(scene, 'b');
    // Compare the top-left common area, resampling B onto A's grid roughly by
    // nearest neighbour at the design scale ratio (enough to prove the two
    // versions are not accidentally identical).
    const ratio = a.width / b.width;
    const w = Math.min(a.width, Math.floor(b.width * ratio));
    const h = Math.min(a.height, Math.floor(b.height * ratio));
    let changed = 0;
    let sampled = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const ao = (y * a.width + x) * 4;
        const bx = Math.min(b.width - 1, Math.round(x / ratio));
        const by = Math.min(b.height - 1, Math.round(y / ratio));
        const bo = (by * b.width + bx) * 4;
        const diff =
          Math.abs(a.data[ao] - b.data[bo]) +
          Math.abs(a.data[ao + 1] - b.data[bo + 1]) +
          Math.abs(a.data[ao + 2] - b.data[bo + 2]);
        sampled += 1;
        if (diff > 40) changed += 1;
      }
    }
    assert.ok(sampled > 100, `${scene.id} should have a comparable area`);
    assert.ok(
      changed > 20,
      `${scene.id} should have localised changes (found ${changed}/${sampled})`,
    );
  }
});

test('scene alignment maps B pixels onto A pixels', () => {
  for (const scene of SCENES) {
    const alignment = sceneAlignment(scene);
    const expected = scene.a.width / scene.b.width;
    assert.ok(Math.abs(alignment.scale - expected) < 1e-9, `${scene.id} scale`);
    const offset = scene.offset || { x: 0, y: 0 };
    const designScaleB = scene.b.width / scene.design.width;
    const aScale = scene.a.width / scene.design.width;
    assert.ok(
      Math.abs(alignment.tx - -offset.x * designScaleB * (aScale / designScaleB)) < 1e-9,
      `${scene.id} tx`,
    );
  }
});

test('scene corner points satisfy the recommended alignment', () => {
  for (const scene of SCENES) {
    const points = sceneCornerPoints(scene);
    assert.equal(points.length, 4);
    const alignment = sceneAlignment(scene);
    const cos = Math.cos(alignment.rotation);
    const sin = Math.sin(alignment.rotation);
    for (const p of points) {
      const x = alignment.scale * (cos * p.bx - sin * p.by) + alignment.tx;
      const y = alignment.scale * (sin * p.bx + cos * p.by) + alignment.ty;
      assert.ok(Math.abs(x - p.ax) < 0.05, `${scene.id} corner x`);
      assert.ok(Math.abs(y - p.ay) < 0.05, `${scene.id} corner y`);
    }
  }
});

test('generated sample files and manifest exist and are valid PNGs', async () => {
  // Ensure assets exist even on a fresh checkout.
  try {
    await access(join(sampleRoot, 'manifest.json'));
  } catch {
    await generateSamples({ quiet: true });
  }
  const manifestRaw = await readFile(join(sampleRoot, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.scenes.length, SCENES.length);
  for (const entry of manifest.scenes) {
    for (const side of ['a', 'b']) {
      const file = join(sampleRoot, `${entry.id}/${side}.png`);
      await access(file);
      const info = await stat(file);
      assert.ok(info.size > 1000, `${file} should not be empty`);
      const buffer = await readFile(file);
      const decoded = decodePng(buffer);
      assert.equal(decoded.width, entry[side].width);
      assert.equal(decoded.height, entry[side].height);
    }
    assert.equal(entry.a.width === entry.b.width && entry.a.height === entry.b.height, false);
    assert.ok(entry.changes.length >= 3);
    assert.ok(entry.cornerPoints.length >= 4);
  }
});

test('sample manifest lists locally served relative paths', async () => {
  await access(join(sampleRoot, 'manifest.json')).catch(() =>
    generateSamples({ quiet: true }),
  );
  const manifest = JSON.parse(
    await readFile(join(sampleRoot, 'manifest.json'), 'utf8'),
  );
  for (const scene of manifest.scenes) {
    // Manifest paths are repo-relative; the app prefix with /public/.
    assert.match(scene.a.file, /^samples\/[^/]+\/a\.png$/);
    assert.match(scene.b.file, /^samples\/[^/]+\/b\.png$/);
  }
});
