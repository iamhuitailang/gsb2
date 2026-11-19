/**
 * 测试用 GIF 解析 / LZW 解码器，用来独立验证编码器输出。
 * 只覆盖本项目会用到的 GIF89a 子集。
 */

export function parseGif(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => {
    const v = bytes[p] | (bytes[p + 1] << 8);
    p += 2;
    return v;
  };
  const signature = String.fromCharCode(...bytes.slice(0, 6));
  p = 6;
  const width = u16();
  const height = u16();
  const packed = u8();
  const backgroundIndex = u8();
  p += 1; // aspect
  let globalColorTable = null;
  if (packed & 0x80) {
    const size = 2 << (packed & 0x07);
    globalColorTable = [];
    for (let i = 0; i < size; i += 1) {
      globalColorTable.push([u8(), u8(), u8()]);
    }
  }

  const frames = [];
  let pendingGce = null;
  let loopCount = null;
  for (;;) {
    if (p >= bytes.length) throw new Error('GIF 数据意外结束');
    const marker = u8();
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        const size = u8();
        if (size !== 4) throw new Error('GCE 长度异常');
        const gcePacked = u8();
        const delay = u16();
        const transparentIndex = u8();
        p += 1; // terminator
        pendingGce = {
          disposal: (gcePacked >> 2) & 0x07,
          transparency: Boolean(gcePacked & 0x01),
          delay,
          transparentIndex,
        };
      } else if (label === 0xff) {
        const size = u8();
        const app = String.fromCharCode(...bytes.slice(p, p + size));
        p += size;
        const subBlocks = readSubBlocks(bytes, () => p, (next) => (p = next));
        if (app === 'NETSCAPE2.0') {
          loopCount = subBlocks[0]?.[1] | (subBlocks[0]?.[2] << 8);
        }
      } else {
        skipSubBlocks(bytes, () => p, (next) => (p = next));
      }
      continue;
    }
    if (marker === 0x2c) {
      const left = u16();
      const top = u16();
      const fw = u16();
      const fh = u16();
      const imagePacked = u8();
      let localTable = null;
      if (imagePacked & 0x80) {
        const size = 2 << (imagePacked & 0x07);
        localTable = [];
        for (let i = 0; i < size; i += 1) localTable.push([u8(), u8(), u8()]);
      }
      const minCodeSize = u8();
      const blocks = readSubBlocks(bytes, () => p, (next) => (p = next));
      const lzw = concat(blocks);
      const indices = lzwDecode(lzw, minCodeSize, fw * fh);
      frames.push({
        left,
        top,
        width: fw,
        height: fh,
        minCodeSize,
        indices,
        gce: pendingGce,
        colorTable: localTable ?? globalColorTable,
      });
      pendingGce = null;
      continue;
    }
    throw new Error(`未知 GIF 块 0x${marker.toString(16)}`);
  }
  return {
    signature,
    width,
    height,
    packed,
    backgroundIndex,
    globalColorTable,
    loopCount,
    frames,
  };
}

function skipSubBlocks(bytes, getP, setP) {
  let p = getP();
  while (bytes[p] !== 0) {
    p += 1 + bytes[p];
  }
  setP(p + 1);
}

function readSubBlocks(bytes, getP, setP) {
  let p = getP();
  const blocks = [];
  while (bytes[p] !== 0) {
    const size = bytes[p];
    p += 1;
    blocks.push(bytes.slice(p, p + size));
    p += size;
  }
  setP(p + 1);
  return blocks;
}

function concat(blocks) {
  const total = blocks.reduce((sum, b) => sum + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

export function lzwDecode(data, minCodeSize, expectedLength = null) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out = [];
  let dict = [];
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let bitPos = 0;
  let prev = null;

  const reset = () => {
    dict = [];
    for (let i = 0; i < clearCode; i += 1) dict[i] = [i];
    dict[clearCode] = null;
    dict[eoiCode] = null;
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
    prev = null;
  };

  reset();

  const totalBits = data.length * 8;
  for (;;) {
    if (bitPos + codeSize > totalBits) break;
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      const byteIndex = bitPos >> 3;
      const bitIndex = bitPos & 7;
      code |= ((data[byteIndex] >> bitIndex) & 1) << bit;
      bitPos += 1;
    }
    if (code === clearCode) {
      reset();
      continue;
    }
    if (code === eoiCode) break;
    let entry;
    if (code < nextCode && dict[code]) {
      entry = dict[code];
    } else if (code === nextCode && prev) {
      entry = [...prev, prev[0]];
    } else {
      throw new Error(`LZW 非法编码 ${code}（next=${nextCode}, size=${codeSize}）`);
    }
    for (const v of entry) out.push(v);
    if (prev) {
      if (nextCode < 4096) {
        dict[nextCode] = [...prev, entry[0]];
        nextCode += 1;
        if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
      }
    }
    prev = entry;
    if (expectedLength != null && out.length > expectedLength) {
      throw new Error('LZW 解码长度超出预期');
    }
  }
  if (expectedLength != null && out.length !== expectedLength) {
    throw new Error(`LZW 解码长度 ${out.length}，预期 ${expectedLength}`);
  }
  return out;
}

/** 把解码后的索引帧还原成 RGBA。 */
export function gifFrameToRgba(frame) {
  const { width, height, indices, gce, colorTable } = frame;
  const out = new Uint8ClampedArray(width * height * 4);
  const transparent = gce?.transparency ? gce.transparentIndex : -1;
  for (let i = 0; i < indices.length; i += 1) {
    const idx = indices[i];
    if (idx === transparent) continue;
    const color = colorTable?.[idx] ?? [0, 0, 0];
    out[i * 4] = color[0];
    out[i * 4 + 1] = color[1];
    out[i * 4 + 2] = color[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}
