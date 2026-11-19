/**
 * 无依赖 PNG 编码器（8 位灰度 / RGBA）。
 * 使用 zlib 的 stored（不压缩）deflate 块，能被所有标准解码器读取；
 * 浏览器和 Node 共用同一份代码，便于测试和示例生成。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
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

export function adler32(bytes) {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  const chunk = 5552;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(i + chunk, bytes.length);
    for (; i < end; i += 1) {
      a += bytes[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function writeUint32(target, offset, value) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** zlib 容器 + stored deflate 块。 */
export function zlibStore(raw) {
  const MAX_BLOCK = 65535;
  const blocks = Math.max(1, Math.ceil(raw.length / MAX_BLOCK));
  const output = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  output[0] = 0x78;
  output[1] = 0x01;
  let offset = 2;
  for (let i = 0; i < blocks; i += 1) {
    const start = i * MAX_BLOCK;
    const length = Math.min(MAX_BLOCK, raw.length - start);
    output[offset] = i === blocks - 1 ? 1 : 0;
    output[offset + 1] = length & 0xff;
    output[offset + 2] = (length >>> 8) & 0xff;
    output[offset + 3] = ~length & 0xff;
    output[offset + 4] = (~length >>> 8) & 0xff;
    output.set(raw.subarray(start, start + length), offset + 5);
    offset += 5 + length;
  }
  writeUint32(output, offset, adler32(raw));
  return output;
}

function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  writeUint32(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  writeUint32(out, 8 + data.length, crc32(crcInput));
  return out;
}

/**
 * 编码 PNG。
 * @param {{width:number,height:number}} size
 * @param {Uint8Array|Uint8ClampedArray} pixels 灰度时长度 w*h，RGBA 时长度 w*h*4
 * @param {{colorType?: 0|6, deflate?: (bytes: Uint8Array) => Uint8Array}} options
 *   colorType 0=灰度, 6=RGBA；deflate 可传入真正的压缩器（如 Node 的 zlib），
 *   浏览器内默认使用 stored 块（不压缩，但格式合法）。
 */
export function encodePng({ width, height }, pixels, { colorType = 0, deflate = zlibStore } = {}) {
  const raw = pngScanlines({ width, height }, pixels, colorType);
  return buildPng({ width, height }, colorType, deflate(raw));
}

/**
 * 浏览器友好的异步版本：优先用 CompressionStream('deflate') 压缩，
 * 生成的文件与常规 PNG 完全一致且体积更小；环境不支持时退回 stored 块。
 */
export async function encodePngAsync(size, pixels, colorType = 0) {
  const raw = pngScanlines(size, pixels, colorType);
  const deflated = await deflateWithCompressionStream(raw);
  return buildPng(size, colorType, deflated);
}

export async function deflateWithCompressionStream(raw) {
  if (typeof CompressionStream === 'undefined') return zlibStore(raw);
  try {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return zlibStore(raw);
  }
}

function pngScanlines({ width, height }, pixels, colorType) {
  const channels = colorType === 6 ? 4 : 1;
  const expected = width * height * channels;
  if (pixels.length !== expected) {
    throw new Error(`像素长度 ${pixels.length} 与 ${width}×${height}×${channels} 不符`);
  }
  const stride = width * channels + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    raw.set(pixels.subarray(y * width * channels, (y + 1) * width * channels), y * stride + 1);
  }
  return raw;
}

function buildPng({ width, height }, colorType, idat) {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, width);
  writeUint32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
