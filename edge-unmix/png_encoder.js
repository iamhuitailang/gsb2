/* 浏览器端最小 PNG 编码器：8-bit RGBA、非交错、filter type 0。
   直接从 Uint8ClampedArray 字节编码，绕开 Canvas 的预乘 alpha 存储，
   保证未处理像素（含保护区、全透明像素）逐字节保留。
   使用浏览器内置 CompressionStream('deflate') 做 zlib 压缩，无需第三方库。 */
(function (global) {
  "use strict";

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const typeBytes = new TextEncoder().encode(type);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, data.length);
    const body = new Uint8Array(typeBytes.length + data.length);
    body.set(typeBytes, 0);
    body.set(data, typeBytes.length);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(body));
    const out = new Uint8Array(4 + body.length + 4);
    out.set(len, 0);
    out.set(body, 4);
    out.set(crc, 4 + body.length);
    return out;
  }

  function concat(parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  /**
   * @param {Uint8ClampedArray|Uint8Array} rgba 长度 w*h*4
   * @returns {Promise<Blob>} image/png
   */
  async function encodePng(width, height, rgba) {
    const stride = width * 4;
    // 每行前加一个 filter 字节（0 = None）
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      const srcOff = y * stride;
      const dstOff = y * (stride + 1);
      raw[dstOff] = 0;
      raw.set(rgba.subarray(srcOff, srcOff + stride), dstOff + 1);
    }

    // CompressionStream('deflate') 按规范输出完整 zlib 流（78 9c 头 + adler32），
    // 正是 PNG IDAT 所需格式，无需再手工封装
    const cs = new CompressionStream("deflate");
    const zlib = new Uint8Array(
      await new Response(new Blob([raw]).stream().pipeThrough(cs)).arrayBuffer()
    );

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const png = concat([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib),
      chunk("IEND", new Uint8Array(0)),
    ]);
    return new Blob([png], { type: "image/png" });
  }

  global.PngEncoder = { encodePng };
})(typeof window !== "undefined" ? window : globalThis);
