/**
 * Baseline JPEG + PNG encoders used only to create the bundled sample files.
 * Zero dependencies, Node-only (pulls in `node:zlib` for PNG's IDAT).
 *
 * JPEG: 4:4:4, standard Huffman tables, interleaved (Y,Cb,Cr per MCU), and an
 * optional EXIF APP1 segment carrying the orientation tag so samples exercise
 * the real "camera file rotated by EXIF" path.
 */

import { deflateSync } from 'node:zlib';

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
];

const STD_LUMA_QT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
];

const STD_CHROMA_QT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99
];

const STD_DC_LUMA = {
  bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};
const STD_DC_CHROMA = {
  bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};
const STD_AC_LUMA = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa
  ]
};
const STD_AC_CHROMA = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa
  ]
};

function buildHuffmanTable(spec) {
  const table = new Map();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < spec.bits[length - 1]; i += 1) {
      table.set(spec.vals[k], { code, length });
      k += 1;
      code += 1;
    }
    code <<= 1;
  }
  return table;
}

const DHT_SPECS = [
  // [class<<4 | id, spec]
  [0x00, STD_DC_LUMA], // DC table 0 (luma)
  [0x10, STD_AC_LUMA], // AC table 0 (luma)
  [0x01, STD_DC_LUMA], // DC table 1 (chroma) — shares the luma spec
  [0x11, STD_AC_LUMA] //  AC table 1 (chroma) — shares the luma spec
];

const HUFF = {
  dcLuma: buildHuffmanTable(STD_DC_LUMA),
  dcChroma: buildHuffmanTable(STD_DC_LUMA),
  // The standard *chrominance* AC table has no ZRL (0xF0) symbol, so a block
  // with more than 15 leading zeros would be unencodable. Using the luminance
  // AC table for chroma as well is spec-legal (Td/Ta merely select a table
  // declared in DHT) and guarantees ZRL and EOB are always available.
  acLuma: buildHuffmanTable(STD_AC_LUMA),
  acChroma: buildHuffmanTable(STD_AC_LUMA)
};

class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.count = 0;
  }
  write(code, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      this.count += 1;
      if (this.count === 8) {
        this.bytes.push(this.acc);
        if (this.acc === 0xff) this.bytes.push(0x00);
        this.acc = 0;
        this.count = 0;
      }
    }
  }
  flush() {
    while (this.count > 0) {
      this.acc = (this.acc << 1) | 1;
      this.count += 1;
      if (this.count === 8) {
        this.bytes.push(this.acc);
        if (this.acc === 0xff) this.bytes.push(0x00);
        this.acc = 0;
        this.count = 0;
      }
    }
    return this.bytes;
  }
}

function category(value) {
  let abs = Math.abs(value);
  let bits = 0;
  while (abs) {
    bits += 1;
    abs >>= 1;
  }
  return bits;
}

function amplitudeBits(value, bits) {
  return value >= 0 ? value : value + (1 << bits) - 1;
}

const DCT_COS = (() => {
  const table = new Float64Array(64);
  for (let u = 0; u < 8; u += 1) {
    for (let x = 0; x < 8; x += 1) {
      table[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return table;
})();

const C = (u) => (u === 0 ? Math.SQRT1_2 : 1);

function fdct(block) {
  const out = new Float64Array(64);
  const temp = new Float64Array(64);
  for (let y = 0; y < 8; y += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let x = 0; x < 8; x += 1) sum += block[y * 8 + x] * DCT_COS[u * 8 + x];
      temp[y * 8 + u] = sum * 0.5 * C(u);
    }
  }
  for (let u = 0; u < 8; u += 1) {
    for (let v = 0; v < 8; v += 1) {
      let sum = 0;
      for (let y = 0; y < 8; y += 1) sum += temp[y * 8 + u] * DCT_COS[v * 8 + y];
      out[v * 8 + u] = sum * 0.5 * C(v);
    }
  }
  return out;
}

function quantize(block, qtNatural) {
  const dct = fdct(block);
  // JPEG coefficients are emitted in zigzag order; the DQT stores the table in
  // zigzag order too, so both sides use ZIGZAG[i] as the natural index.
  //
  // Values are clamped to ±1023: that is the largest magnitude the baseline
  // Huffman tables can express (category 10), so a pathological block cannot
  // produce an unencodable symbol.
  const out = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) {
    const natural = ZIGZAG[i];
    const value = Math.round(dct[natural] / qtNatural[natural]);
    out[i] = value < -1023 ? -1023 : value > 1023 ? 1023 : value;
  }
  return out;
}

/**
 * Encode one block. `prevDc` is the DC predictor for this component.
 * Huffman symbols are RS bytes: (run << 4) | size for AC, size alone for DC.
 */
function encodeBlock(writer, coefficients, prevDc, dcTable, acTable) {
  let diff = coefficients[0] - prevDc;
  // Baseline Huffman tables describe DC differences up to category 11; clamp so
  // a predictor/coefficient pair can never overflow the table.
  if (diff > 2047) diff = 2047;
  else if (diff < -2047) diff = -2047;
  const dcCat = category(diff);
  const dcCode = dcTable.get(dcCat);
  if (!dcCode) throw new Error(`DC category out of table: ${dcCat}`);
  writer.write(dcCode.code, dcCode.length);
  if (dcCat > 0) writer.write(amplitudeBits(diff, dcCat), dcCat);

  let run = 0;
  for (let i = 1; i < 64; i += 1) {
    const value = coefficients[i];
    if (value === 0) {
      run += 1;
      continue;
    }
    while (run > 15) {
      const zrl = acTable.get(0xf0);
      writer.write(zrl.code, zrl.length);
      run -= 16;
    }
    const cat = category(value);
    const code = acTable.get((run << 4) | cat);
    if (!code) throw new Error(`AC category out of table ${run}:${cat}`);
    writer.write(code.code, code.length);
    writer.write(amplitudeBits(value, cat), cat);
    run = 0;
  }
  if (run > 0) {
    const eob = acTable.get(0x00);
    writer.write(eob.code, eob.length);
  }
  return coefficients[0];
}

function segment(marker, payload) {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

function exifSegment(orientation) {
  // Big-endian TIFF header + a single IFD holding tag 0x0112.
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // "MM", 42, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, // Orientation
    0x00, 0x03, // SHORT
    0x00, 0x00, 0x00, 0x01, // count 1
    0x00, orientation, 0x00, 0x00, // value (padded)
    0x00, 0x00, 0x00, 0x00 // no next IFD
  ];
  return segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]);
}

function qualityScale(base, quality) {
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  return base.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
}

const zigzagOrder = (table) => ZIGZAG.map((natural) => table[natural]);

/**
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {{width:number,height:number,quality?:number,orientation?:number}} options
 * @returns {Uint8Array}
 */
export function encodeJpeg(rgba, { width, height, quality = 88, orientation = 1 }) {
  if (rgba.length !== width * height * 4) throw new Error('encodeJpeg: 像素缓冲区尺寸不匹配');
  const qtLuma = qualityScale(STD_LUMA_QT, quality);
  const qtChroma = qualityScale(STD_CHROMA_QT, quality);

  const yPlane = new Float64Array(width * height);
  const cbPlane = new Float64Array(width * height);
  const crPlane = new Float64Array(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 1) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    yPlane[p] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    cbPlane[p] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    crPlane[p] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  const blocksX = Math.ceil(width / 8);
  const blocksY = Math.ceil(height / 8);
  const writer = new BitWriter();
  const block = new Float64Array(64);
  let prevY = 0;
  let prevCb = 0;
  let prevCr = 0;

  const fillBlock = (plane, bx, by) => {
    for (let y = 0; y < 8; y += 1) {
      const py = Math.min(height - 1, by * 8 + y);
      for (let x = 0; x < 8; x += 1) {
        const px = Math.min(width - 1, bx * 8 + x);
        block[y * 8 + x] = plane[py * width + px];
      }
    }
  };

  // 4:4:4 → each MCU is exactly one Y, one Cb and one Cr block.
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      fillBlock(yPlane, bx, by);
      prevY = encodeBlock(writer, quantize(block, qtLuma), prevY, HUFF.dcLuma, HUFF.acLuma);
      fillBlock(cbPlane, bx, by);
      prevCb = encodeBlock(writer, quantize(block, qtChroma), prevCb, HUFF.dcChroma, HUFF.acChroma);
      fillBlock(crPlane, bx, by);
      prevCr = encodeBlock(writer, quantize(block, qtChroma), prevCr, HUFF.dcChroma, HUFF.acChroma);
    }
  }
  const scanData = writer.flush();

  const bytes = [0xff, 0xd8];
  if (orientation >= 1 && orientation <= 8) bytes.push(...exifSegment(orientation));
  // DQT: table 0 (luma) then table 1 (chroma); each needs its Pq/Tq spec byte.
  // Tables are stored in zigzag order, matching the coefficient stream.
  bytes.push(...segment(0xdb, [0x00, ...zigzagOrder(qtLuma), 0x01, ...zigzagOrder(qtChroma)]));
  // SOF0: baseline, 8-bit, 3 components, no subsampling (h=1,v=1).
  bytes.push(...segment(0xc0, [
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01
  ]));
  // DHT: four tables. Chroma reuses the luma specs (see HUFF above) so ZRL is
  // always available; the SOS below still selects slot 1 for Cb/Cr.
  for (const [idByte, spec] of DHT_SPECS) {
    bytes.push(...segment(0xc4, [idByte, ...spec.bits, ...spec.vals]));
  }
  // SOS: 3 components, Y→table 0/0, Cb→1/1, Cr→1/1; Ss=0, Se=63, Ah/Al=0.
  bytes.push(...segment(0xda, [0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]));
  for (const byte of scanData) bytes.push(byte);
  bytes.push(0xff, 0xd9);
  return Uint8Array.from(bytes);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32Of(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Uint8Array.from([...[...type].map((ch) => ch.charCodeAt(0)), ...data]);
  const crc = crc32Of(body);
  const length = data.length;
  return Uint8Array.from([
    (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff,
    ...body,
    (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff
  ]);
}

export function encodePng(rgba, { width, height }) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idatData = deflateSync(raw, { level: 9 });
  const ihdr = [
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    0x08, 0x06, 0x00, 0x00, 0x00 // 8-bit, RGBA, deflate, no filter, no interlace
  ];
  const chunks = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr)
  ];
  const CHUNK = 60 * 1024;
  for (let offset = 0; offset < idatData.length; offset += CHUNK) {
    chunks.push(pngChunk('IDAT', idatData.subarray(offset, Math.min(idatData.length, offset + CHUNK))));
  }
  chunks.push(pngChunk('IEND', []));
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

export { ZIGZAG, STD_LUMA_QT, STD_CHROMA_QT };
