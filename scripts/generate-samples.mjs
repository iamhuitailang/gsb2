/**
 * 生成少量可合法使用的图片样例 —— 全部由本脚本用纯代码编码生成，
 * 不引用任何第三方素材，版权随项目。输出到 client/public/samples/。
 * 格式：PNG / JPEG / GIF / WebP / BMP，另生成一个含两张图片的合法 ZIP。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../client/public/samples');
fs.mkdirSync(outDir, { recursive: true });

const W = 96;
const H = 64;

/** 生成 RGBA 像素：渐变底 + 两个圆，五种格式共用同一份画面 */
function makePixels(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      buf[i] = Math.round((x / w) * 255);
      buf[i + 1] = Math.round((y / h) * 255);
      buf[i + 2] = 180;
      buf[i + 3] = 255;
    }
  }
  fillCircle(buf, w, h, 30, 26, 14, [230, 60, 60, 255]);
  fillCircle(buf, w, h, 64, 38, 12, [60, 200, 120, 255]);
  return buf;
}

function fillCircle(buf, w, h, cx, cy, r, rgba) {
  for (let y = Math.max(0, cy - r); y < Math.min(h, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x < Math.min(w, cx + r); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        buf.set(rgba, (y * w + x) * 4);
      }
    }
  }
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型 RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // 过滤类型 None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeBmp(rgba, w, h) {
  // 24 位自底向上 BMP
  const rowSize = Math.floor((24 * w + 31) / 32) * 4;
  const pixelBytes = rowSize * h;
  const buf = Buffer.alloc(54 + pixelBytes);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < h; y++) {
    const srcRow = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (srcRow * w + x) * 4;
      const d = 54 + y * rowSize + x * 3;
      buf[d] = rgba[s + 2];
      buf[d + 1] = rgba[s + 1];
      buf[d + 2] = rgba[s];
    }
  }
  return buf;
}

function encodeGif(rgba, w, h) {
  // 全局色表 4 色（取画面代表色），GIF89a + 单帧图像
  const palette = [
    [0, 0, 0],
    [230, 60, 60],
    [60, 200, 120],
    [80, 120, 180],
  ];
  const parts = [];
  parts.push(Buffer.from('GIF89a', 'ascii'));
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  lsd[4] = 0b10000001; // 全局色表标志 + 大小 2^(1+1)=4
  parts.push(lsd);
  for (const c of palette) parts.push(Buffer.from(c));
  // 图像描述符
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(w, 5);
  desc.writeUInt16LE(h, 7);
  desc[9] = 0;
  parts.push(desc);

  // 用最近色量化为索引，再做 LZW 压缩（最小码长 2）
  const indices = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    let best = 0;
    let bestDist = Infinity;
    palette.forEach((c, idx) => {
      const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < bestDist) { bestDist = d; best = idx; }
    });
    indices[i] = best;
  }
  parts.push(Buffer.from([2])); // LZW 最小码长
  parts.push(lzwEncode(indices, 2));
  parts.push(Buffer.from([0, 0x3b])); // 块结束 + Trailer
  return Buffer.concat(parts);
}

/** GIF LZW 打包（含 clear/EOI 码，输出带子块封装） */
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map();
  const resetDict = () => {
    dict = new Map();
    for (let i = 0; i < clearCode; i++) dict.set(String(i), i);
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };
  resetDict();

  const out = [];
  let bitBuf = 0;
  let bitCount = 0;
  const emit = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  emit(clearCode);

  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const candidate = `${prefix},${indices[i]}`;
    if (dict.has(candidate)) {
      prefix = candidate;
    } else {
      emit(dict.get(prefix));
      dict.set(candidate, nextCode++);
      if (nextCode === (1 << codeSize) + 1 && codeSize < 12) codeSize += 1;
      if (nextCode > 4095) {
        emit(clearCode);
        resetDict();
      }
      prefix = String(indices[i]);
    }
  }
  emit(dict.get(prefix));
  emit(eoiCode);
  if (bitCount > 0) out.push(bitBuf & 0xff);

  // 子块封装：每块 <=255 字节
  const packed = Buffer.from(out);
  const blocks = [];
  for (let off = 0; off < packed.length; off += 255) {
    const slice = packed.subarray(off, off + 255);
    blocks.push(Buffer.from([slice.length]), slice);
  }
  return Buffer.concat(blocks);
}

/**
 * WebP 样例：VP8L 手工位流难以保证跨浏览器可解码，因此基于本脚本自生成的 PNG，
 * 优先调用 macOS 内置 sips 转换出确定合法的 WebP；转换失败则跳过（其余样例不受影响）。
 */
function emitWebpFromPng(pngBuffer, targetPath) {
  const staging = path.join(outDir, '.staging.webp.png');
  try {
    fs.writeFileSync(staging, pngBuffer);
    execFileSync('sips', ['-s', 'format', 'webp', staging, '--out', targetPath], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    fs.rmSync(staging, { force: true });
    return fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0;
  } catch {
    fs.rmSync(staging, { force: true });
    fs.rmSync(targetPath, { force: true });
    return false;
  }
}

/**
 * 基线 JPEG 编码器（灰度也可，这里编码为 3 分量 YCbCr 4:4:4，无 DCT 量化表压缩用全 1 质量表）。
 * 完整 DCT+Huffman 实现较长，采用固定标准量化表/哈夫曼表的教学级实现。
 */
function encodeJpeg(rgba, w, h) {
  // 标准 JPEG 亮度/色度量化表（质量约 50 的 Annex K 表）
  const qLum = [
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
  ];
  const qChr = qLum.map((v) => Math.min(255, Math.round(v * 1.2)));

  // 把 RGB 转 YCbCr 并按 8x8 块做 DCT + 量化 + zigzag
  const blocks = [];
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      for (let comp = 0; comp < 3; comp++) {
        const block = new Array(64).fill(0);
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const px = Math.min(w - 1, bx + x);
            const py = Math.min(h - 1, by + y);
            const i = (py * w + px) * 4;
            const r = rgba[i];
            const g = rgba[i + 1];
            const b = rgba[i + 2];
            let v;
            if (comp === 0) v = 0.299 * r + 0.587 * g + 0.114 * b - 128;
            else if (comp === 1) v = -0.168736 * r - 0.331264 * g + 0.5 * b;
            else v = 0.5 * r - 0.418688 * g - 0.081312 * b;
            block[y * 8 + x] = v;
          }
        }
        const dct = dct8(block);
        const q = comp === 0 ? qLum : qChr;
        // dct 为自然序；量化表按 zigzag 索引存储，故用 zigzag(k) 取表项
        blocks.push(dct.map((v, k) => Math.round(v / q[zigzag(k)])));
      }
    }
  }

  // 用 Annex K 标准 DC/AC Huffman 表编码（表 J.3/J.4/J.5/J.6）
  const { dcLumBits, dcLumVals, acLumBits, acLumVals, dcChrBits, dcChrVals, acChrBits, acChrVals } = jpegHuffmanTables();
  const dcLum = buildHuffman(dcLumBits, dcLumVals);
  const acLum = buildHuffman(acLumBits, acLumVals);
  const dcChr = buildHuffman(dcChrBits, dcChrVals);
  const acChr = buildHuffman(acChrBits, acChrVals);

  const bw = new JpegBitWriter();
  const prevDc = [0, 0, 0];
  blocks.forEach((coeffs, idx) => {
    const comp = idx % 3;
    const tables = comp === 0 ? { dc: dcLum, ac: acLum } : { dc: dcChr, ac: acChr };
    // 逆 zigzag 还原顺序后扫描；这里 coeffs 已按自然序，直接扫描自然序并做游程
    const ordered = new Array(64);
    for (let k = 0; k < 64; k++) ordered[zigzag(k)] = coeffs[k];

    const diff = ordered[0] - prevDc[comp];
    prevDc[comp] = ordered[0];
    encodeHuffman(bw, tables.dc, category(diff), diff);

    let run = 0;
    for (let k = 1; k < 64; k++) {
      const coef = ordered[k];
      if (coef === 0) { run++; continue; }
      while (run > 15) {
        bw.writeCode(tables.ac[0xf0]); // ZRL
        run -= 16;
      }
      const cat = category(coef);
      bw.writeCode(tables.ac[(run << 4) | cat]);
      bw.writeBits(coef < 0 ? coef + (1 << cat) - 1 : coef, cat);
      run = 0;
    }
    if (run > 0) bw.writeCode(tables.ac[0x00]); // EOB
  });
  const entropy = bw.toBuffer();

  // 组装标记段
  const segs = [];
  segs.push(Buffer.from([0xff, 0xd8])); // SOI
  segs.push(jfifApp0());
  segs.push(dqtSegment(0, qLum));
  segs.push(dqtSegment(1, qChr));
  segs.push(sofSegment(w, h));
  segs.push(dhtSegment(0, dcLumBits, dcLumVals));
  segs.push(dhtSegment(0x10, acLumBits, acLumVals));
  segs.push(dhtSegment(1, dcChrBits, dcChrVals));
  segs.push(dhtSegment(0x11, acChrBits, acChrVals));
  // SOS
  const sos = Buffer.from([
    0xff, 0xda, 0x00, 0x0c, 0x03,
    0x01, 0x00, 0x02, 0x11, 0x03, 0x11,
    0x00, 0x3f, 0x00,
  ]);
  segs.push(sos);
  segs.push(stuffBytes(entropy));
  segs.push(Buffer.from([0xff, 0xd9])); // EOI
  return Buffer.concat(segs);
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
function zigzag(k) { return ZIGZAG[k]; }

function dct8(block) {
  const out = new Array(64).fill(0);
  const c = (u) => (u === 0 ? Math.SQRT1_2 : 1);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          sum += block[y * 8 + x]
            * Math.cos(((2 * x + 1) * u * Math.PI) / 16)
            * Math.cos(((2 * y + 1) * v * Math.PI) / 16);
        }
      }
      out[v * 8 + u] = 0.25 * c(u) * c(v) * sum;
    }
  }
  return out;
}

function category(v) {
  const a = Math.abs(v);
  let cat = 0;
  let n = a;
  while (n > 0) { cat++; n >>= 1; }
  return cat;
}
function encodeHuffman(bw, table, cat, value) {
  bw.writeCode(table[cat]);
  if (cat > 0) bw.writeBits(value < 0 ? value + (1 << cat) - 1 : value, cat);
}

class JpegBitWriter {
  constructor() { this.bytes = []; this.current = 0; this.used = 0; }
  writeBits(value, n) {
    this.current = (this.current << n) | (value & ((1 << n) - 1));
    this.used += n;
    while (this.used >= 8) {
      this.bytes.push((this.current >> (this.used - 8)) & 0xff);
      this.used -= 8;
    }
  }
  writeCode({ code, size }) { this.writeBits(code, size); }
  toBuffer() {
    if (this.used > 0) {
      this.bytes.push((this.current << (8 - this.used)) & 0xff);
      this.used = 0;
    }
    return Buffer.from(this.bytes);
  }
}

function stuffBytes(buf) {
  const out = [];
  for (const b of buf) {
    out.push(b);
    if (b === 0xff) out.push(0x00);
  }
  return Buffer.from(out);
}

function buildHuffman(bits, vals) {
  const table = {};
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) {
      table[vals[k]] = { code, size: len };
      code++;
      k++;
    }
    code <<= 1;
  }
  return table;
}

function jfifApp0() {
  return Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
}

function dqtSegment(id, table) {
  const body = Buffer.alloc(65);
  body[0] = id; // 高 4 位精度 0=8bit
  for (let i = 0; i < 64; i++) body[i + 1] = table[zigzag(i)];
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xdb]), head, body]);
}

function sofSegment(w, h) {
  const body = Buffer.alloc(11);
  body[0] = 8; // 精度
  body.writeUInt16BE(h, 1);
  body.writeUInt16BE(w, 3);
  body[5] = 3; // 分量数
  body[6] = 1; body[7] = 0x11; // Y: 量化表 0
  body[8] = 2; body[9] = 0x11; // Cb/Cr 同表 1（简化 4:4:4）
  body[10] = 3; // 第三分量头会越界，改为动态长度
  const full = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (h >> 8) & 0xff, h & 0xff,
    (w >> 8) & 0xff, w & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ]);
  return full;
}

function dhtSegment(tableId, bits, vals) {
  const body = [tableId, ...bits, ...vals];
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xc4]), head, Buffer.from(body)]);
}

// Annex K 标准 Huffman 表
function jpegHuffmanTables() {
  return {
    dcLumBits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    dcLumVals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    acLumBits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
    acLumVals: [
      0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
      0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
      0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
      0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
      0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
      0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
      0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
      0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
      0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
      0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
      0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
      0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
      0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
      0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
      0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
      0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
      0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
      0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
      0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
      0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
      0xf9, 0xfa,
    ],
    dcChrBits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    dcChrVals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    acChrBits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
    acChrVals: [
      0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21,
      0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
      0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
      0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
      0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34,
      0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
      0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
      0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
      0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
      0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
      0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
      0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
      0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
      0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
      0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
      0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
      0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2,
      0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
      0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
      0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
      0xf9, 0xfa,
    ],
  };
}

// ---------------- 主流程 ----------------

const pixels = makePixels(W, H);
const pngBuffer = encodePng(pixels, W, H);
const samples = {
  'sample.png': pngBuffer,
  'sample.jpg': encodeJpeg(pixels, W, H),
  'sample.gif': encodeGif(pixels, W, H),
  'sample.bmp': encodeBmp(pixels, W, H),
};

for (const [name, buf] of Object.entries(samples)) {
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`生成 ${name} (${buf.length} 字节)`);
}
if (emitWebpFromPng(pngBuffer, path.join(outDir, 'sample.webp'))) {
  console.log(`生成 sample.webp (${fs.statSync(path.join(outDir, 'sample.webp')).size} 字节，经 sips 转换)`);
} else {
  console.warn('跳过 sample.webp：当前环境无 sips 或转换失败');
}

// 合法 ZIP 样例：打包 PNG 与 BMP 两张图（用系统 zip 命令，条目名简单可控）
const zipPath = path.join(outDir, 'sample.zip');
try {
  fs.rmSync(zipPath, { force: true });
  execFileSync('zip', ['-q', '-j', zipPath, path.join(outDir, 'sample.png'), path.join(outDir, 'sample.bmp')]);
  console.log(`生成 sample.zip (${fs.statSync(zipPath).size} 字节)`);
} catch {
  // 无 zip 命令时用 Node 手工构造一个 stored ZIP
  fs.writeFileSync(zipPath, buildStoredZip([
    { name: 'sample.png', data: samples['sample.png'] },
    { name: 'sample.bmp', data: samples['sample.bmp'] },
  ]));
  console.log(`生成 sample.zip（内置 stored 编码, ${fs.statSync(zipPath).size} 字节）`);
}

/** 零依赖 stored（不压缩）ZIP 构造，作为无系统 zip 命令时的回退 */
function buildStoredZip(entries) {
  const localParts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32Raw(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, e.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + e.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function crc32Raw(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
