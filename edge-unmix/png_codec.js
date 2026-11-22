"use strict";
/* 最小 PNG 解码器：仅支持 8-bit RGBA（color type 6）、非交错，覆盖全部 5 种行过滤。
   双环境：Node 下 module.exports（含 readPng 文件读取），浏览器下挂 window.PngCodec。
   浏览器用它从文件字节直接解码出 straight-alpha RGBA，绕开 Canvas 预乘存储，
   保证原始像素逐字节可用。无第三方依赖。 */

function u32be(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function ascii(b, o, e) {
  let s = "";
  for (let i = o; i < e; i++) s += String.fromCharCode(b[i]);
  return s;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// 解析块结构，返回尺寸与拼好的 IDAT 字节
function parseChunks(b) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new Error("不是 PNG 文件");
  let pos = 8,
    width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0,
    interlace = 0;
  const idatParts = [];
  while (pos + 8 <= b.length) {
    const len = u32be(b, pos);
    const type = ascii(b, pos + 4, pos + 8);
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = u32be(body, 0);
      height = u32be(body, 4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "IDAT") {
      idatParts.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (interlace !== 0) throw new Error("不支持交错 PNG");
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error("仅支持 8-bit RGBA PNG（bitDepth=" + bitDepth + " colorType=" + colorType + "）");
  }
  const idat = new Uint8Array(idatParts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of idatParts) {
    idat.set(p, off);
    off += p.length;
  }
  return { width, height, idat };
}

// 对解压后的扫描线做反向滤波
function unfilter(width, height, raw) {
  const stride = width * 4;
  const out = new Uint8ClampedArray(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    const rowBase = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[lineStart + x];
      const a = x >= 4 ? raw[lineStart + x - 4] : 0;
      const b = y ? out[rowBase - stride + x] : 0;
      const c = y && x >= 4 ? out[rowBase - stride + x - 4] : 0;
      let v;
      switch (f) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: v = cur + paeth(a, b, c); break;
        default: throw new Error("不支持的行过滤类型 " + f);
      }
      out[rowBase + x] = v & 255;
    }
  }
  return out;
}

// 同步解码（Node：zlib 同步可用）
function decodeWithSyncInflate(b, inflateSync) {
  const { width, height, idat } = parseChunks(b);
  const raw = inflateSync(idat);
  return { width, height, data: unfilter(width, height, new Uint8Array(raw)) };
}

const api = { parseChunks, unfilter };

if (typeof module !== "undefined" && module.exports) {
  const fs = require("fs");
  const zlib = require("zlib");
  module.exports = {
    decodePng: (b) => decodeWithSyncInflate(new Uint8Array(b), (d) => zlib.inflateSync(d)),
    readPng(file) {
      return decodeWithSyncInflate(new Uint8Array(fs.readFileSync(file)), (d) =>
        zlib.inflateSync(d)
      );
    },
  };
} else {
  // 浏览器：DecompressionStream 是异步的
  api.decodePngAsync = async function (uint8) {
    const { width, height, idat } = parseChunks(uint8);
    const ds = new DecompressionStream("deflate");
    const raw = new Uint8Array(
      await new Response(new Blob([idat]).stream().pipeThrough(ds)).arrayBuffer()
    );
    return { width, height, data: unfilter(width, height, raw) };
  };
  globalThis.PngCodec = api;
}
