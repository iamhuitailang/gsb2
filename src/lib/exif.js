/**
 * Minimal EXIF reader — only what ChromaDeck needs: the orientation tag of a
 * JPEG (APP1/Exif) or a PNG eXIf chunk. Pixels themselves are decoded without
 * browser auto-rotation and drawn upright by `orientation.js`, so preview and
 * export share exactly one orientation path.
 */

function readU16(view, offset, littleEndian) {
  return view.getUint16(offset, littleEndian);
}

function readU32(view, offset, littleEndian) {
  return view.getUint32(offset, littleEndian);
}

function parseTiff(view, base) {
  if (base + 8 > view.byteLength) return null;
  const order = String.fromCharCode(view.getUint8(base), view.getUint8(base + 1));
  const littleEndian = order === 'II';
  if (!littleEndian && order !== 'MM') return null;
  if (readU16(view, base + 2, littleEndian) !== 0x2a) return null;
  const ifdOffset = readU32(view, base + 4, littleEndian);
  if (ifdOffset < 8 || base + ifdOffset + 2 > view.byteLength) return null;
  const count = readU16(view, base + ifdOffset, littleEndian);
  for (let i = 0; i < count; i += 1) {
    const entry = base + ifdOffset + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = readU16(view, entry, littleEndian);
    if (tag !== 0x0112) continue;
    const type = readU16(view, entry + 2, littleEndian);
    const value = type === 3 ? readU16(view, entry + 8, littleEndian) : readU32(view, entry + 8, littleEndian);
    if (value >= 1 && value <= 8) return value;
  }
  return null;
}

function isJpeg(view) {
  return view.byteLength >= 4 && view.getUint8(0) === 0xff && view.getUint8(1) === 0xd8;
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {number|null} 1–8 or null when no orientation tag is present
 */
export function parseExifOrientation(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.byteLength) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: look for an eXIf chunk before the image data.
  if (view.byteLength >= 8 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    let offset = 8;
    while (offset + 8 <= view.byteLength) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );
      const dataStart = offset + 8;
      if (type === 'eXIf') return parseTiff(view, dataStart);
      if (type === 'IDAT' || type === 'IEND') break;
      offset = dataStart + length + 4;
    }
    return null;
  }

  if (!isJpeg(view)) return null;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xd8) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) break;
    if (marker === 0xe1) {
      const payloadStart = offset + 4;
      const hasExif =
        view.byteLength >= payloadStart + 6 &&
        view.getUint8(payloadStart) === 0x45 && // E
        view.getUint8(payloadStart + 1) === 0x78 && // x
        view.getUint8(payloadStart + 2) === 0x69 && // i
        view.getUint8(payloadStart + 3) === 0x66 && // f
        view.getUint8(payloadStart + 4) === 0x00 &&
        view.getUint8(payloadStart + 5) === 0x00;
      if (hasExif) {
        const orientation = parseTiff(view, payloadStart + 6);
        if (orientation) return orientation;
      }
    }
    offset += 2 + length;
  }
  return null;
}

export async function readExifOrientation(blob) {
  try {
    const head = await blob.slice(0, 1024 * 1024).arrayBuffer();
    return parseExifOrientation(head);
  } catch {
    return null;
  }
}
