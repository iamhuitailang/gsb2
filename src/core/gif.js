/**
 * 极简 GIF89a 编码器。
 *
 * - 全帧调色板：所有帧共用一个全局色表，保证动画颜色稳定。
 * - alpha < 128 视为透明；GIF 只有 1 位透明度（导入/导出限制见 README）。
 * - 每帧使用 disposal=2（还原背景），因此画布上的透明区域在不同帧之间
 *   不会残留上一帧的内容。
 * - 帧延迟单位为 1/100 秒，低于 10ms 或非 10ms 整数倍的时长会被量化。
 */

import { clamp } from './util.js';

const MAX_COLORS = 255; // 预留 1 个透明索引

/** 8 位/通道颜色打包成数字，便于统计。 */
export function packRgb(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

function collectColorCounts(frames) {
  const counts = new Map();
  for (const frame of frames) {
    const { data } = frame;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const key = packRgb(data[i], data[i + 1], data[i + 2]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function averageColor(entries) {
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (const { key, count } of entries) {
    r += ((key >> 16) & 0xff) * count;
    g += ((key >> 8) & 0xff) * count;
    b += (key & 0xff) * count;
    weight += count;
  }
  return packRgb(
    Math.round(r / weight),
    Math.round(g / weight),
    Math.round(b / weight),
  );
}

/** 中位切分量化，返回最多 `limit` 个代表色（数字形式）。 */
export function medianCut(entries, limit) {
  if (entries.length <= limit) return entries.map((e) => e.key);
  let boxes = [entries];
  while (boxes.length < limit) {
    let bestIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.length < 2) continue;
      const ranges = channelRanges(box);
      const score = Math.max(ranges.r, ranges.g, ranges.b) * Math.log2(box.length + 1);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    const box = boxes[bestIndex];
    const ranges = channelRanges(box);
    const channel = ranges.r >= ranges.g && ranges.r >= ranges.b ? 'r' : ranges.g >= ranges.b ? 'g' : 'b';
    const shifted = box
      .map((entry) => ({ entry, value: (entry.key >> { r: 16, g: 8, b: 0 }[channel]) & 0xff }))
      .sort((a, b) => a.value - b.value);
    let acc = 0;
    const half = shifted.reduce((sum, s) => sum + s.entry.count, 0) / 2;
    let split = 1;
    for (let i = 0; i < shifted.length - 1; i += 1) {
      acc += shifted[i].entry.count;
      if (acc >= half) {
        split = i + 1;
        break;
      }
    }
    boxes.splice(bestIndex, 1, shifted.slice(0, split).map((s) => s.entry), shifted.slice(split).map((s) => s.entry));
  }
  return boxes.map(averageColor);
}

function channelRanges(entries) {
  let minR = 255;
  let minG = 255;
  let minB = 255;
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  for (const { key } of entries) {
    const r = (key >> 16) & 0xff;
    const g = (key >> 8) & 0xff;
    const b = key & 0xff;
    if (r < minR) minR = r;
    if (g < minG) minG = g;
    if (b < minB) minB = b;
    if (r > maxR) maxR = r;
    if (g > maxG) maxG = g;
    if (b > maxB) maxB = b;
  }
  return { r: maxR - minR, g: maxG - minG, b: maxB - minB };
}

/**
 * 构建全局色表。返回 { palette: number[]（RGB 打包）, transparentIndex }。
 * 透明索引固定为 0，实际颜色从索引 1 开始。
 */
export function buildPalette(frames) {
  const counts = collectColorCounts(frames);
  const entries = [...counts.entries()].map(([key, count]) => ({ key, count }));
  entries.sort((a, b) => b.count - a.count || a.key - b.key);
  const colors =
    entries.length <= MAX_COLORS
      ? entries.map((e) => e.key)
      : medianCut(entries, MAX_COLORS);
  return { palette: colors, transparentIndex: 0 };
}

function buildColorLookup(palette) {
  const exact = new Map();
  palette.forEach((color, index) => exact.set(color, index + 1));
  // 5bit/通道的近似查找表，用于量化后的大量不同颜色。
  const lut = new Int16Array(32768).fill(-1);
  const lookup = (color) => {
    const cached = exact.get(color);
    if (cached !== undefined) return cached;
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    const lutIndex = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (lut[lutIndex] >= 0) return lut[lutIndex];
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < palette.length; i += 1) {
      const p = palette[i];
      const dr = r - ((p >> 16) & 0xff);
      const dg = g - ((p >> 8) & 0xff);
      const db = b - (p & 0xff);
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    const result = best + 1;
    lut[lutIndex] = result;
    return result;
  };
  return lookup;
}

/**
 * GIF LZW 压缩。返回未分块的字节数组。
 *
 * 采用经过广泛验证的“边输出边提前扩宽码长”方案（与 gif.js / jsgif 的
 * LZWEncoder 相同的码长节奏），保证和浏览器等标准解码器逐位对齐：
 *   - 每输出一个码后，若下一个可用码已超出当前码长上限，则码长 +1，
 *     作用于后续的码；
 *   - 词典写满（4096）时先输出 Clear，再重置词典。
 * 该节奏与解码器“读到该码后补词条、再按 next_code 判断加宽”相互抵消，
 * 是 GIF 生态里最通用的实现。
 */
export function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const maxBits = 12;
  const maxMaxCode = 1 << maxBits;

  let nBits = minCodeSize + 1;
  let maxCode = (1 << nBits) - 1;
  let freeEnt = clearCode + 2;
  let clearFlag = false;
  let dict = new Map();

  const bytes = [];
  let cur = 0;
  let curBits = 0;

  const output = (code) => {
    cur |= code << curBits;
    curBits += nBits;
    while (curBits >= 8) {
      bytes.push(cur & 0xff);
      cur >>>= 8;
      curBits -= 8;
    }
    if (freeEnt > maxCode || clearFlag) {
      if (clearFlag) {
        nBits = minCodeSize + 1;
        maxCode = (1 << nBits) - 1;
        clearFlag = false;
      } else {
        nBits += 1;
        maxCode = nBits === maxBits ? maxMaxCode : (1 << nBits) - 1;
      }
    }
  };

  output(clearCode);

  if (indices.length === 0) {
    output(eoiCode);
    if (curBits > 0) bytes.push(cur & 0xff);
    return bytes;
  }

  let ent = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const c = indices[i];
    const key = ent * 4096 + c;
    const found = dict.get(key);
    if (found !== undefined) {
      ent = found;
      continue;
    }
    output(ent);
    if (freeEnt < maxMaxCode) {
      dict.set(key, freeEnt);
      freeEnt += 1;
    } else {
      clearFlag = true;
      output(clearCode);
      dict = new Map();
      freeEnt = clearCode + 2;
    }
    ent = c;
  }
  output(ent);
  output(eoiCode);
  if (curBits > 0) bytes.push(cur & 0xff);
  return bytes;
}

function pushSubBlocks(out, bytes, blockSize = 255) {
  for (let i = 0; i < bytes.length; i += blockSize) {
    const chunk = bytes.slice(i, i + blockSize);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
}

function u16(value) {
  return [value & 0xff, (value >> 8) & 0xff];
}

/**
 * 编码 GIF。
 * @param {{width:number,height:number,frames:{data:Uint8ClampedArray,duration:number}[],loop?:boolean}} options
 * @returns {Uint8Array}
 */
export function encodeGif({ width, height, frames, loop = true }) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('没有可导出的帧');
  if (width <= 0 || height <= 0) throw new Error('尺寸不合法');

  const { palette, transparentIndex } = buildPalette(frames);
  const totalEntries = palette.length + 1; // + 透明索引
  let tableBits = 1;
  while (1 << tableBits < totalEntries) tableBits += 1;
  tableBits = clamp(tableBits, 2, 8);
  const tableSize = 1 << tableBits;
  const lookup = buildColorLookup(palette);

  const out = [];
  const ascii = (text) => {
    for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i) & 0xff);
  };

  ascii('GIF89a');
  out.push(...u16(width), ...u16(height));
  out.push(0x80 | ((tableBits - 1) << 4) | (tableBits - 1));
  out.push(0, 0); // 背景色索引 / 像素宽高比

  // 全局色表：索引 0 透明，其余为颜色
  out.push(0, 0, 0);
  for (let i = 0; i < tableSize - 1; i += 1) {
    const key = palette[i] ?? 0;
    out.push((key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff);
  }

  if (loop) {
    out.push(0x21, 0xff, 0x0b);
    ascii('NETSCAPE2.0');
    out.push(0x03, 0x01, ...u16(0), 0x00);
  }

  for (const frame of frames) {
    const { data } = frame;
    if (data.length !== width * height * 4) {
      throw new Error('帧像素数据长度与画布尺寸不符');
    }
    const indices = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < indices.length; p += 1, i += 4) {
      indices[p] = data[i + 3] < 128 ? transparentIndex : lookup(packRgb(data[i], data[i + 1], data[i + 2]));
    }
    // GIF 延迟单位 10ms；取整后最小 1，避免 0 被浏览器按 100ms 处理。
    const delay = clamp(Math.round(frame.duration / 10), 1, 65535);

    out.push(0x21, 0xf9, 0x04, (2 << 2) | 0x01, ...u16(delay), transparentIndex, 0x00);

    out.push(0x2c, ...u16(0), ...u16(0), ...u16(width), ...u16(height), 0x00);
    const minCodeSize = Math.max(2, tableBits);
    out.push(minCodeSize);
    pushSubBlocks(out, lzwEncode(indices, minCodeSize));
  }

  out.push(0x3b);
  return Uint8Array.from(out);
}

/** 导出前的时长提示：GIF 以 10ms 为粒度。 */
export function gifTimingReport(frames) {
  return frames.map((frame, index) => {
    const delay = clamp(Math.round(frame.duration / 10), 1, 65535);
    return {
      index,
      requestedMs: frame.duration,
      actualMs: delay * 10,
      clipped: delay * 10 !== frame.duration,
    };
  });
}
