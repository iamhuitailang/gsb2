/**
 * 最小 PNG 编码器（RGBA8888 → PNG，无外部依赖）。
 * deflate 由调用方提供（浏览器用 CompressionStream，Node 用 zlib），
 * 便于同一份代码在浏览器与测试中复用。
 */

import { crc32 } from "./crc32.js";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type, payload) {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(4 + payload.length);
  body.set(typeBytes, 0);
  body.set(payload, 4);
  const crc = crc32(body);
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  out.set(typeBytes, 4);
  out.set(payload, 8);
  view.setUint32(8 + payload.length, crc);
  return out;
}

function adler32(data) {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** 无压缩 zlib 流（deflate stored blocks），用于没有压缩器的环境。 */
export function zlibStored(data) {
  const MAX = 65535;
  const blocks = Math.max(1, Math.ceil(data.length / MAX));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  let p = 0;
  out[p++] = 0x78;
  out[p++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX;
    const len = Math.min(MAX, data.length - start);
    out[p++] = i === blocks - 1 ? 1 : 0;
    out[p++] = len & 0xff;
    out[p++] = (len >>> 8) & 0xff;
    out[p++] = ~len & 0xff;
    out[p++] = (~len >>> 8) & 0xff;
    out.set(data.subarray(start, start + len), p);
    p += len;
  }
  const adler = adler32(data);
  out[p++] = (adler >>> 24) & 0xff;
  out[p++] = (adler >>> 16) & 0xff;
  out[p++] = (adler >>> 8) & 0xff;
  out[p++] = adler & 0xff;
  return out.subarray(0, p);
}

async function defaultDeflate(bytes) {
  if (typeof CompressionStream !== "undefined") {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return zlibStored(bytes);
}

/**
 * 编码 PNG。
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint8Array}} image
 * @param {{deflate?:(bytes:Uint8Array)=>Promise<Uint8Array>|Uint8Array, text?:Record<string,string>}} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function encodePng(image, options = {}) {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("PNG 尺寸无效");
  }
  if (!data || data.length < width * height * 4) throw new Error("PNG 像素数据不完整");

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    raw.set(data.subarray(y * stride, y * stride + stride), rowStart + 1);
  }

  const deflate = options.deflate || defaultDeflate;
  const compressed = await deflate(raw);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [new Uint8Array(SIGNATURE), chunk("IHDR", ihdr)];
  if (options.text) {
    for (const [key, value] of Object.entries(options.text)) {
      if (value == null) continue;
      parts.push(chunk("tEXt", new TextEncoder().encode(`${key}\0${String(value).slice(0, 2000)}`)));
    }
  }
  parts.push(chunk("IDAT", compressed));
  parts.push(chunk("IEND", new Uint8Array(0)));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
