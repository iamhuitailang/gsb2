/*
 * Minimal ZIP writer (STORE / no compression, UTF-8 names).
 * No dependencies: enough to package WAV + CSV + JSON exports into one file.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

function toBytes(data) {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('zip entry data must be string, Uint8Array, or ArrayBuffer');
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

/**
 * Build a ZIP from [{ name, data }] entries.
 * @returns {Uint8Array}
 */
export function zipStore(entries, options = {}) {
  const { date = new Date() } = options;
  const { time, date: dosDate } = dosDateTime(date);
  const names = new Set();
  const prepared = entries.map((entry) => {
    const name = String(entry.name);
    if (names.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    names.add(name);
    const nameBytes = encoder.encode(name);
    const data = toBytes(entry.data);
    return { nameBytes, data, crc: crc32(data) };
  });

  const localSize = prepared.reduce((sum, p) => sum + 30 + p.nameBytes.length + p.data.length, 0);
  const centralSize = prepared.reduce((sum, p) => sum + 46 + p.nameBytes.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let offset = 0;

  for (const p of prepared) {
    const localOffset = offset;
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true); // UTF-8 names
    view.setUint16(offset + 8, 0, true); // store
    view.setUint16(offset + 10, time, true);
    view.setUint16(offset + 12, dosDate, true);
    view.setUint32(offset + 14, p.crc, true);
    view.setUint32(offset + 18, p.data.length, true);
    view.setUint32(offset + 22, p.data.length, true);
    view.setUint16(offset + 26, p.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    offset += 30;
    out.set(p.nameBytes, offset);
    offset += p.nameBytes.length;
    out.set(p.data, offset);
    offset += p.data.length;
    p.localOffset = localOffset;
  }

  const centralStart = offset;
  for (const p of prepared) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, time, true);
    view.setUint16(offset + 14, dosDate, true);
    view.setUint32(offset + 16, p.crc, true);
    view.setUint32(offset + 20, p.data.length, true);
    view.setUint32(offset + 24, p.data.length, true);
    view.setUint16(offset + 28, p.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, p.localOffset, true);
    offset += 46;
    out.set(p.nameBytes, offset);
    offset += p.nameBytes.length;
  }

  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true);

  return out;
}
