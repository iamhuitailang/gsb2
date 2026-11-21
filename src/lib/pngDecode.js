/**
 * 最小 PNG 解码器（8 位、非隔行，颜色类型 0/2/4/6，支持调色板 3）。
 * 用于 Node 侧测试与命令行导出；浏览器优先使用 createImageBitmap 以获得更好性能。
 * inflate 由调用方提供（Node 用 zlib.inflateSync，浏览器用 DecompressionStream）。
 */

import { crc32 } from "./crc32.js";

const SIGNATURE = "89504e470d0a1a0a";

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * @param {Uint8Array} bytes
 * @param {(data:Uint8Array)=>Promise<Uint8Array>|Uint8Array} inflate
 * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray}>}
 */
export async function decodePng(bytes, inflate) {
  if (!bytes || bytes.length < 8) throw new Error("PNG 文件太短");
  const sig = Array.from(bytes.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  if (sig !== SIGNATURE) throw new Error("不是 PNG 文件（签名不匹配）");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  let sawIend = false;

  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const length = view.getUint32(0);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error(`PNG 区块 ${type} 数据被截断`);
    const chunkData = bytes.subarray(start, end);
    const expectedCrc = new DataView(bytes.buffer, bytes.byteOffset + end, 4).getUint32(0);
    const actualCrc = crc32(bytes.subarray(offset + 4, end));
    if (expectedCrc !== actualCrc) throw new Error(`PNG 区块 ${type} CRC 校验失败`);

    if (type === "IHDR") {
      const v = new DataView(chunkData.buffer, chunkData.byteOffset, 13);
      width = v.getUint32(0);
      height = v.getUint32(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      interlace = chunkData[12];
      if (bitDepth !== 8) throw new Error(`暂不支持 ${bitDepth} 位色深的 PNG`);
      if (interlace !== 0) throw new Error("暂不支持隔行 PNG，请另存为普通 PNG");
      if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`暂不支持 PNG 颜色类型 ${colorType}`);
    } else if (type === "PLTE") {
      palette = chunkData;
    } else if (type === "tRNS") {
      transparency = chunkData;
    } else if (type === "IDAT") {
      idat.push(chunkData);
    } else if (type === "IEND") {
      sawIend = true;
      offset = end + 4;
      break;
    }
    offset = end + 4;
  }

  if (!width || !height) throw new Error("PNG 缺少 IHDR 或尺寸无效");
  if (!sawIend) throw new Error("PNG 缺少 IEND（文件可能不完整）");
  if (idat.length === 0) throw new Error("PNG 缺少 IDAT 图像数据");

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (colorType === 3 && !palette) throw new Error("调色板 PNG 缺少 PLTE 区块");

  const compressed = concat(idat);
  const raw = await inflate(compressed);
  const bitsPerPixel = channels * 8;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new Error(`PNG 图像数据不完整（需要 ${expected} 字节，解压后 ${raw.length} 字节）`);
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    line.set(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          line[i] = (line[i] + a) & 0xff;
          break;
        case 2:
          line[i] = (line[i] + b) & 0xff;
          break;
        case 3:
          line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          line[i] = (line[i] + paeth(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`PNG 第 ${y} 行使用了未知滤镜 ${filter}`);
      }
    }

    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (colorType === 0) {
        const v = line[x];
        pixels[p] = v;
        pixels[p + 1] = v;
        pixels[p + 2] = v;
        pixels[p + 3] = 255;
      } else if (colorType === 4) {
        const v = line[x * 2];
        pixels[p] = v;
        pixels[p + 1] = v;
        pixels[p + 2] = v;
        pixels[p + 3] = line[x * 2 + 1];
      } else if (colorType === 2) {
        pixels[p] = line[x * 3];
        pixels[p + 1] = line[x * 3 + 1];
        pixels[p + 2] = line[x * 3 + 2];
        pixels[p + 3] = 255;
      } else if (colorType === 6) {
        pixels[p] = line[x * 4];
        pixels[p + 1] = line[x * 4 + 1];
        pixels[p + 2] = line[x * 4 + 2];
        pixels[p + 3] = line[x * 4 + 3];
      } else {
        const idx = line[x];
        if (idx * 3 + 2 >= palette.length) throw new Error(`PNG 调色板索引越界：${idx}`);
        pixels[p] = palette[idx * 3];
        pixels[p + 1] = palette[idx * 3 + 1];
        pixels[p + 2] = palette[idx * 3 + 2];
        pixels[p + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
      }
    }
    prev.set(line);
  }

  return { width, height, data: pixels };
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
