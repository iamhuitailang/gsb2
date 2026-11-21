/**
 * 纯 JS PNG 编解码。
 *
 * 编码支持：
 *   - 索引色 PNG（color type 3，位深 8 或 4/2/1 自适应），可带 tRNS 透明索引；
 *   - 真彩 + Alpha PNG（color type 6，位深 8）；
 *   - 灰阶（color type 0，位深 8）。
 *
 * 解码支持所有非隔行 PNG（0/2/3/4/6，位深 1/2/4/8/16），
 * 足以覆盖样图与本工具自己导出的文件；其他格式交给浏览器 ImageBitmap 解码。
 */
import {
  concatBytes,
  crc32,
  u16be,
  u32be,
  readU32be,
  adler32,
  textBytes,
} from './utils.js';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

async function deflateZlib(bytes) {
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { deflateSync } = await import('node:zlib');
    return new Uint8Array(deflateSync(bytes, { level: 9 }));
  }
  return zlibStored(bytes);
}

async function inflateZlib(bytes) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { inflateSync } = await import('node:zlib');
    return new Uint8Array(inflateSync(bytes));
  }
  throw new Error('当前环境不支持 zlib 解压');
}

/** 无压缩的 zlib 流（stored deflate 块），作为最后兜底。 */
function zlibStored(bytes) {
  const blocks = [];
  const max = 65535;
  blocks.push(new Uint8Array([0x78, 0x01]));
  for (let offset = 0; offset < bytes.length; offset += max) {
    const len = Math.min(max, bytes.length - offset);
    const final = offset + len >= bytes.length ? 1 : 0;
    const header = new Uint8Array(5);
    header[0] = final;
    header[1] = len & 0xff;
    header[2] = (len >> 8) & 0xff;
    header[3] = ~len & 0xff;
    header[4] = (~len >> 8) & 0xff;
    blocks.push(header, bytes.subarray(offset, offset + len));
  }
  const out = concatBytes(blocks);
  return concatBytes([out, u32be(adler32(bytes))]);
}

function chunk(type, data) {
  const typeBytes = textBytes(type);
  const body = concatBytes([typeBytes, data]);
  return concatBytes([u32be(data.length), body, u32be(crc32(body))]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 对每一行做过滤器选择（启发式：优先 Paeth/Sub）。
 * filterMode: 'auto' | 'none' | 'sub' | 'up' | 'average' | 'paeth'
 */
function filterRows(raw, width, height, bpp, filterMode = 'auto') {
  const stride = width * bpp;
  const out = new Uint8Array((stride + 1) * height);
  let prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  let offset = 0;

  const apply = (type) => {
    let score = 0;
    for (let i = 0; i < stride; i++) {
      const x = row[i];
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (type === 0) v = x;
      else if (type === 1) v = x - a;
      else if (type === 2) v = x - b;
      else if (type === 3) v = x - ((a + b) >> 1);
      else v = x - paethPredictor(a, b, c);
      v &= 0xff;
      candidate[i] = v;
      score += v < 128 ? v : 256 - v;
    }
    return score;
  };

  for (let y = 0; y < height; y++) {
    row.set(raw.subarray(y * stride, (y + 1) * stride));
    let chosen = 0;
    if (filterMode === 'auto') {
      let bestScore = Infinity;
      for (const type of [0, 1, 2, 4]) {
        const score = apply(type);
        if (score < bestScore) {
          bestScore = score;
          chosen = type;
          best.set(candidate);
        }
      }
    } else {
      chosen = { none: 0, sub: 1, up: 2, average: 3, paeth: 4 }[filterMode] ?? 0;
      apply(chosen);
      best.set(candidate);
    }
    out[offset++] = chosen;
    out.set(best, offset);
    offset += stride;
    prev = row.slice();
  }
  return out;
}

const BIT_DEPTH_CHOICES = [8, 4, 2, 1];

function pickIndexedBitDepth(paletteLength) {
  if (paletteLength <= 2) return 1;
  if (paletteLength <= 4) return 2;
  if (paletteLength <= 16) return 4;
  return 8;
}

/**
 * 编码索引色 PNG。
 * @param {Uint8Array} indices 每像素的调色板索引
 * @param {Array<{r,g,b,transparent?:boolean,a?:number}>} palette 调色板
 *
 * `tRNS` 对索引色 PNG 是「每个调色板索引一个 alpha 值」，因此半透明像素
 * 也能被精确表达：调色板项可以带 a（0–255）。transparent:true 等价于 a=0。
 */
export async function encodeIndexedPng(indices, width, height, palette, options = {}) {
  if (palette.length > 256) throw new Error('索引色 PNG 最多支持 256 色');
  const bitDepth = options.bitDepth || pickIndexedBitDepth(palette.length);
  const bpp = 1;
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  const raw = new Uint8Array(rowBytes * height);
  const mask = (1 << bitDepth) - 1;
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const idx = indices[y * width + x];
      if (bitDepth === 8) {
        raw[rowOffset + x] = idx;
      } else {
        const perByte = 8 / bitDepth;
        const byteIndex = rowOffset + Math.floor(x / perByte);
        const shift = 8 - bitDepth * ((x % perByte) + 1);
        raw[byteIndex] |= (idx & mask) << shift;
      }
    }
  }
  const filtered = filterRows(raw, rowBytes, height, bpp, options.filterMode || 'auto');
  const idat = await deflateZlib(filtered);
  const ihdr = concatBytes([
    u32be(width),
    u32be(height),
    new Uint8Array([bitDepth, 3, 0, 0, 0]),
  ]);
  const plte = new Uint8Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    plte[i * 3] = palette[i].r;
    plte[i * 3 + 1] = palette[i].g;
    plte[i * 3 + 2] = palette[i].b;
  }
  // tRNS 长度只需覆盖到最后一个非完全不透明的索引。
  let lastTranslucent = -1;
  for (let i = 0; i < palette.length; i++) {
    const alpha = palette[i].transparent ? 0 : palette[i].a ?? 255;
    if (alpha !== 255) lastTranslucent = i;
  }
  const chunks = [PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('PLTE', plte)];
  if (lastTranslucent >= 0) {
    const trns = new Uint8Array(lastTranslucent + 1);
    trns.fill(255, 0, lastTranslucent + 1);
    for (let i = 0; i <= lastTranslucent; i++) {
      const alpha = palette[i].transparent ? 0 : palette[i].a ?? 255;
      trns[i] = alpha;
    }
    chunks.push(chunk('tRNS', trns));
  }
  chunks.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
  return concatBytes(chunks);
}

/** 编码 RGBA（color type 6）。 */
export async function encodeRgbaPng(rgba, width, height, options = {}) {
  const filtered = filterRows(rgba, width, height, 4, options.filterMode || 'auto');
  const idat = await deflateZlib(filtered);
  const ihdr = concatBytes([u32be(width), u32be(height), new Uint8Array([8, 6, 0, 0, 0])]);
  return concatBytes([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** 编码灰阶（color type 0，位深 8）。用于黑白/单通道素材预览。 */
export async function encodeGrayPng(gray, width, height, options = {}) {
  const filtered = filterRows(gray, width, height, 1, options.filterMode || 'auto');
  const idat = await deflateZlib(filtered);
  const ihdr = concatBytes([u32be(width), u32be(height), new Uint8Array([8, 0, 0, 0, 0])]);
  return concatBytes([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* 解码                                                                */
/* ------------------------------------------------------------------ */

function readChunks(bytes) {
  if (!(bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)) {
    throw new Error('不是 PNG 文件');
  }
  let offset = 8;
  const chunks = [];
  while (offset + 8 <= bytes.length) {
    const length = readU32be(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error('PNG 数据被截断');
    chunks.push({ type, data: bytes.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

export async function decodePng(bytes) {
  const chunks = readChunks(bytes);
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idatParts = [];
  for (const c of chunks) {
    if (c.type === 'IHDR') ihdr = c.data;
    else if (c.type === 'PLTE') plte = c.data;
    else if (c.type === 'tRNS') trns = c.data;
    else if (c.type === 'IDAT') idatParts.push(c.data);
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  const width = readU32be(ihdr, 0);
  const height = readU32be(ihdr, 4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const compressed = concatBytes(idatParts);
  const raw = await inflateZlib(compressed);
  return decodeRaw(raw, width, height, bitDepth, colorType, plte, trns);
}
function decodeRaw(raw, width, height, bitDepth, colorType, plte, trns) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 PNG 色彩类型 ${colorType}`);
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error('PNG 像素数据不完整');

  const out = new Uint8ClampedArray(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let offset = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[offset++];
    cur.set(raw.subarray(offset, offset + stride));
    offset += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (filter === 1) v = v + a;
      else if (filter === 2) v = v + b;
      else if (filter === 3) v = v + ((a + b) >> 1);
      else if (filter === 4) v = v + paethPredictor(a, b, c);
      cur[i] = v & 0xff;
    }

    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (colorType === 3) {
        let index;
        if (bitDepth === 8) index = cur[x];
        else {
          const perByte = 8 / bitDepth;
          const byte = cur[Math.floor(x / perByte)];
          const shift = 8 - bitDepth * ((x % perByte) + 1);
          index = (byte >> shift) & ((1 << bitDepth) - 1);
        }
        if (plte) {
          const pi = index * 3;
          out[p] = plte[pi] ?? 0;
          out[p + 1] = plte[pi + 1] ?? 0;
          out[p + 2] = plte[pi + 2] ?? 0;
        }
        out[p + 3] = trns && index < trns.length ? trns[index] : 255;
      } else {
        const readSample = (channelIndex) => {
          if (bitDepth === 8) {
            return cur[x * channels + channelIndex];
          }
          if (bitDepth === 16) {
            return cur[(x * channels + channelIndex) * 2];
          }
          const perByte = 8 / bitDepth;
          const bitPos = x * channels + channelIndex;
          const byte = cur[Math.floor(bitPos / perByte)];
          const shift = 8 - bitDepth * ((bitPos % perByte) + 1);
          const rawValue = (byte >> shift) & ((1 << bitDepth) - 1);
          // 低位深灰阶归一化到 0..255
          return Math.round((rawValue * 255) / ((1 << bitDepth) - 1));
        };
        if (colorType === 0) {
          const g = readSample(0);
          out[p] = g;
          out[p + 1] = g;
          out[p + 2] = g;
          out[p + 3] = 255;
        } else if (colorType === 4) {
          const g = readSample(0);
          out[p] = g;
          out[p + 1] = g;
          out[p + 2] = g;
          out[p + 3] = readSample(1);
        } else if (colorType === 2) {
          out[p] = readSample(0);
          out[p + 1] = readSample(1);
          out[p + 2] = readSample(2);
          out[p + 3] = 255;
        } else {
          out[p] = readSample(0);
          out[p + 1] = readSample(1);
          out[p + 2] = readSample(2);
          out[p + 3] = readSample(3);
        }
      }
    }
    prev.set(cur);
  }
  return { width, height, rgba: out };
}

/** 解析调色板（只读 PLTE，用来展示原图是否已经是索引色）。 */
export function readPngInfo(bytes) {
  try {
    const chunks = readChunks(bytes);
    const ihdr = chunks.find((c) => c.type === 'IHDR')?.data;
    if (!ihdr) return null;
    const plte = chunks.find((c) => c.type === 'PLTE')?.data;
    const trns = chunks.find((c) => c.type === 'tRNS')?.data;
    return {
      width: readU32be(ihdr, 0),
      height: readU32be(ihdr, 4),
      bitDepth: ihdr[8],
      colorType: ihdr[9],
      interlace: ihdr[12],
      paletteSize: plte ? plte.length / 3 : 0,
      hasTransparency: !!trns,
      isIndexed: ihdr[9] === 3,
    };
  } catch {
    return null;
  }
}

export { PNG_SIGNATURE };
