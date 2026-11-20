import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeJpeg, encodePng } from '../src/lib/codecs.js';
import { parseExifOrientation } from '../src/lib/exif.js';

function gradientPixels(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      rgba[p] = Math.round((x / (width - 1)) * 255);
      rgba[p + 1] = Math.round((y / (height - 1)) * 255);
      rgba[p + 2] = 128;
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

function readJpegSegments(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segments = [];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xda) {
      segments.push({ marker, offset, length: view.getUint16(offset + 2) });
      break;
    }
    const length = view.getUint16(offset + 2);
    segments.push({ marker, offset, length });
    offset += 2 + length;
  }
  return segments;
}

test('JPEG starts with SOI and ends with EOI', () => {
  const pixels = gradientPixels(17, 11); // deliberately not a multiple of 8
  const jpeg = encodeJpeg(pixels, { width: 17, height: 11, quality: 90 });
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.equal(jpeg[jpeg.length - 2], 0xff);
  assert.equal(jpeg[jpeg.length - 1], 0xd9);
});

test('JPEG carries the EXIF orientation it was asked for', () => {
  const pixels = gradientPixels(16, 16);
  for (const orientation of [1, 3, 6, 8]) {
    const jpeg = encodeJpeg(pixels, { width: 16, height: 16, orientation });
    assert.equal(parseExifOrientation(jpeg), orientation, `orientation ${orientation}`);
  }
});

test('JPEG contains the required marker segments', () => {
  const jpeg = encodeJpeg(gradientPixels(32, 24), { width: 32, height: 24, orientation: 6 });
  const markers = readJpegSegments(jpeg).map((segment) => segment.marker);
  assert.ok(markers.includes(0xe1), 'APP1/EXIF present');
  assert.ok(markers.includes(0xdb), 'DQT present');
  assert.ok(markers.includes(0xc0), 'SOF0 present');
  assert.equal(markers.filter((marker) => marker === 0xc4).length, 4, 'four DHT tables');
  assert.ok(markers.includes(0xda), 'SOS present');
});

test('JPEG chroma tables include ZRL so sparse blocks are encodable', () => {
  // A flat (all-zero chroma) image compresses to blocks whose AC coefficients
  // are all zero; with >15 leading zeros the encoder must emit ZRL (0xF0).
  // The standard chroma AC table lacks it, so this asserts our tables cover it.
  const flat = new Uint8Array(32 * 32 * 4);
  for (let i = 0; i < flat.length; i += 4) {
    flat[i] = 128;
    flat[i + 1] = 128;
    flat[i + 2] = 128;
    flat[i + 3] = 255;
  }
  const jpeg = encodeJpeg(flat, { width: 32, height: 32, quality: 92 });
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.equal(jpeg[jpeg.length - 1], 0xd9);
  const dhtSegments = readJpegSegments(jpeg).filter((segment) => segment.marker === 0xc4);
  assert.equal(dhtSegments.length, 4);
  // Table 0x10 (AC luma) and 0x11 (AC chroma) must both declare a ZRL symbol.
  for (const dht of dhtSegments) {
    const id = jpeg[dht.offset + 4];
    if (id !== 0x10 && id !== 0x11) continue;
    const counts = Array.from(jpeg.subarray(dht.offset + 5, dht.offset + 21));
    const total = counts.reduce((sum, n) => sum + n, 0);
    const values = Array.from(jpeg.subarray(dht.offset + 21, dht.offset + 21 + total));
    assert.ok(values.includes(0xf0), `table 0x${id.toString(16)} must contain ZRL`);
    assert.ok(values.includes(0x00), `table 0x${id.toString(16)} must contain EOB`);
  }
});

test('JPEG DQT declares both quantization tables with spec bytes', () => {
  const jpeg = encodeJpeg(gradientPixels(8, 8), { width: 8, height: 8 });
  const dqt = readJpegSegments(jpeg).find((segment) => segment.marker === 0xdb);
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  const payloadStart = dqt.offset + 4;
  assert.equal(dqt.length, 2 + 65 + 65);
  assert.equal(jpeg[payloadStart], 0x00, 'table 0 spec byte');
  assert.equal(jpeg[payloadStart + 65], 0x01, 'table 1 spec byte');
  assert.equal(view.getUint16(dqt.offset + 2), 132);
});

test('JPEG image dimensions in SOF match the input, including odd sizes', () => {
  for (const [width, height] of [[13, 7], [8, 8], [33, 17]]) {
    const jpeg = encodeJpeg(gradientPixels(width, height), { width, height });
    const sof = readJpegSegments(jpeg).find((segment) => segment.marker === 0xc0);
    const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
    const precision = jpeg[sof.offset + 4];
    const h = view.getUint16(sof.offset + 5);
    const w = view.getUint16(sof.offset + 7);
    assert.equal(precision, 8);
    assert.equal(w, width);
    assert.equal(h, height);
  }
});

test('JPEG entropy data never contains a raw 0xFF (byte stuffing)', () => {
  const jpeg = encodeJpeg(gradientPixels(64, 64), { width: 64, height: 64 });
  const segments = readJpegSegments(jpeg);
  const sos = segments[segments.length - 1];
  const scanStart = sos.offset + 2 + sos.length;
  for (let i = scanStart; i < jpeg.length - 2; i += 1) {
    if (jpeg[i] === 0xff) assert.equal(jpeg[i + 1], 0x00, `stuffed byte at ${i}`);
  }
});

test('PNG has a valid signature, IHDR, IDAT and IEND', () => {
  const png = encodePng(gradientPixels(9, 5), { width: 9, height: 5 });
  assert.deepEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assert.equal(view.getUint32(8), 13, 'IHDR length');
  assert.equal(String.fromCharCode(...png.subarray(12, 16)), 'IHDR');
  assert.equal(view.getUint32(16), 9);
  assert.equal(view.getUint32(20), 5);
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 6, 'colour type RGBA');
  const text = new TextDecoder('latin1').decode(png);
  assert.ok(text.includes('IDAT'));
  assert.ok(text.endsWith('IEND®B`\u0082'));
  assert.equal(parseExifOrientation(png), null);
});

test('EXIF parser ignores unrelated or truncated data', () => {
  assert.equal(parseExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.equal(parseExifOrientation(new Uint8Array([])), null);
  assert.equal(parseExifOrientation(new Uint8Array(16)), null);
});
