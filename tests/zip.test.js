import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip, crc32, uniqueNames } from '../src/lib/zip.js';

function bytesOf(blob) {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function readU16(view, offset) {
  return view.getUint16(offset, true);
}

function readU32(view, offset) {
  return view.getUint32(offset, true);
}

const utf8 = (text) => new TextEncoder().encode(text);

test('crc32 matches the known check value', () => {
  // Standard CRC-32 of "123456789" is 0xCBF43926.
  assert.equal(crc32(utf8('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('zip contains every entry with correct headers and payload', async () => {
  const a = utf8('hello world');
  const b = utf8('second file');
  const blob = createZip([
    { name: 'a.txt', bytes: a },
    { name: 'nested/b.txt', bytes: b }
  ]);
  const bytes = await bytesOf(blob);
  const view = new DataView(bytes.buffer);

  // End of central directory
  const eocdOffset = bytes.length - 22;
  assert.equal(readU32(view, eocdOffset), 0x06054b50);
  assert.equal(readU16(view, eocdOffset + 8), 2);
  assert.equal(readU16(view, eocdOffset + 10), 2);

  // Local header #1
  assert.equal(readU32(view, 0), 0x04034b50);
  assert.equal(readU16(view, 8), 0, 'STORE method');
  const nameLen = readU16(view, 26);
  assert.equal(new TextDecoder().decode(bytes.subarray(30, 30 + nameLen)), 'a.txt');
  assert.equal(readU32(view, 14), crc32(a));
  assert.equal(readU32(view, 18), a.length);
  assert.deepEqual(Array.from(bytes.subarray(30 + nameLen, 30 + nameLen + a.length)), Array.from(a));

  // Central directory is present and references both names
  const centralOffset = readU32(view, eocdOffset + 16);
  assert.equal(readU32(view, centralOffset), 0x02014b50);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('a.txt'));
  assert.ok(text.includes('nested/b.txt'));
});

test('empty entry list still yields a valid empty archive', async () => {
  const bytes = await bytesOf(createZip([]));
  assert.equal(bytes.length, 22);
  const view = new DataView(bytes.buffer);
  assert.equal(readU32(view, 0), 0x06054b50);
  assert.equal(readU16(view, 8), 0);
});

test('uniqueNames disambiguates duplicate file names', () => {
  const names = uniqueNames([{ name: 'photo.jpg' }, { name: 'photo.jpg' }, { name: 'photo.jpg' }]);
  assert.deepEqual(names.map((entry) => entry.name), ['photo.jpg', 'photo-2.jpg', 'photo-3.jpg']);
  const noExt = uniqueNames([{ name: 'README' }, { name: 'README' }]);
  assert.deepEqual(noExt.map((entry) => entry.name), ['README', 'README-2']);
});

test('zip entry count and offsets stay consistent for many entries', async () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({
    name: `image-${i}.jpg`,
    bytes: utf8(`payload-${i}`.repeat(i + 1))
  }));
  const bytes = await bytesOf(createZip(entries));
  const view = new DataView(bytes.buffer);
  const eocdOffset = bytes.length - 22;
  assert.equal(readU16(view, eocdOffset + 8), 12);

  // Walk local headers and verify each offset points at a valid signature.
  let offset = 0;
  for (const entry of entries) {
    assert.equal(readU32(view, offset), 0x04034b50, `header at ${offset}`);
    const nameLen = readU16(view, offset + 26);
    const extraLen = readU16(view, offset + 28);
    const size = readU32(view, offset + 18);
    assert.equal(size, entry.bytes.length);
    offset += 30 + nameLen + extraLen + size;
  }
  assert.equal(readU32(view, offset), 0x02014b50, 'central directory follows locals');
});
