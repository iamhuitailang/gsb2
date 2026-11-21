/**
 * TGA 解码器：支持未压缩 / RLE 的 24/32 位真彩色、8 位灰度，以及 16 位真彩色（5-5-5-1）。
 * 浏览器没有内置 TGA 支持，而游戏贴图里很常见，因此自带一个最小实现。
 * 返回 { width, height, data: Uint8ClampedArray }（RGBA8888，未预乘）。
 *
 * 调色板（type 1/9）与 16 位真彩色为尽力支持，复杂变体可能不被识别。
 */

export function isTga(bytes, fileName = "") {
  if (/\.tga$/i.test(fileName)) return true;
  if (!bytes || bytes.length < 18) return false;
  // 通过合理的头字段组合判断
  const colorMapType = bytes[1];
  const imageType = bytes[2];
  const bpp = bytes[16];
  return (
    (colorMapType === 0 || colorMapType === 1) &&
    [0, 1, 2, 3, 9, 10, 11].includes(imageType) &&
    [8, 15, 16, 24, 32].includes(bpp)
  );
}

export function decodeTga(bytes) {
  if (!bytes || bytes.length < 18) throw new Error("TGA 文件太短，缺少文件头");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = bytes[0];
  const colorMapType = bytes[1];
  const imageType = bytes[2];
  const colorMapOrigin = view.getUint16(3, true);
  const colorMapLength = view.getUint16(5, true);
  const colorMapDepth = bytes[7];
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const bpp = bytes[16];
  const descriptor = bytes[17];
  const topOrigin = (descriptor & 0x20) !== 0;
  const rightOrigin = (descriptor & 0x10) !== 0;

  if (!width || !height) throw new Error(`TGA 尺寸无效：${width}×${height}`);
  if (width * height > 64 * 1024 * 1024) throw new Error(`TGA 过大：${width}×${height}`);

  const bytesPerPixel = Math.ceil(bpp / 8);
  let offset = 18 + idLength;

  if (colorMapType === 1) {
    offset += colorMapLength * Math.ceil(colorMapDepth / 8);
  }

  const isRle = imageType === 9 || imageType === 10 || imageType === 11;
  const baseType = isRle ? imageType - 8 : imageType;
  if (baseType !== 2 && baseType !== 3 && baseType !== 1) {
    throw new Error(`暂不支持该 TGA 图像类型 ${imageType}（支持 1/2/3/9/10/11）`);
  }
  if (baseType === 2 && bpp !== 24 && bpp !== 32 && bpp !== 16 && bpp !== 15) {
    throw new Error(`暂不支持 ${bpp} 位真彩色 TGA`);
  }
  if (baseType === 1 && colorMapDepth !== 24 && colorMapDepth !== 32) {
    throw new Error(`暂不支持 ${colorMapDepth} 位调色板 TGA`);
  }

  const pixelCount = width * height;
  const pixels = new Uint8ClampedArray(pixelCount * 4);

  // 读取原始像素字节
  const raw = new Uint8Array(pixelCount * bytesPerPixel);
  if (isRle) {
    let p = 0;
    let written = 0;
    while (written < pixelCount) {
      if (offset >= bytes.length) throw new Error("TGA 数据意外结束（RLE 段不完整）");
      const header = bytes[offset++];
      const count = (header & 0x7f) + 1;
      if (written + count > pixelCount) {
        throw new Error("TGA RLE 数据超出图像尺寸，文件可能已损坏");
      }
      if (header & 0x80) {
        if (offset + bytesPerPixel > bytes.length) throw new Error("TGA 数据意外结束（RLE 像素不完整）");
        for (let i = 0; i < count; i++) {
          raw.set(bytes.subarray(offset, offset + bytesPerPixel), p);
          p += bytesPerPixel;
        }
        offset += bytesPerPixel;
      } else {
        const span = count * bytesPerPixel;
        if (offset + span > bytes.length) throw new Error("TGA 数据意外结束（RLE 原始段不完整）");
        raw.set(bytes.subarray(offset, offset + span), p);
        p += span;
        offset += span;
      }
      written += count;
    }
  } else {
    const span = pixelCount * bytesPerPixel;
    if (offset + span > bytes.length) {
      throw new Error(`TGA 像素数据不完整（需要 ${span} 字节，剩余 ${bytes.length - offset} 字节）`);
    }
    raw.set(bytes.subarray(offset, offset + span));
  }

  // 调色板
  let palette = null;
  if (baseType === 1) {
    const entryBytes = Math.ceil(colorMapDepth / 8);
    palette = new Uint8ClampedArray(colorMapLength * 4);
    let p = 18 + idLength;
    for (let i = 0; i < colorMapLength; i++) {
      const b0 = bytes[p++];
      const b1 = bytes[p++];
      const b2 = bytes[p++];
      const a = entryBytes === 4 ? bytes[p++] : 255;
      palette[i * 4] = b2;
      palette[i * 4 + 1] = b1;
      palette[i * 4 + 2] = b0;
      palette[i * 4 + 3] = a;
    }
  }

  for (let i = 0; i < pixelCount; i++) {
    const s = i * bytesPerPixel;
    const d = i * 4;
    if (baseType === 1) {
      const index = bytesPerPixel === 2 ? raw[s] | (raw[s + 1] << 8) : raw[s];
      const idx = Math.max(0, index - colorMapOrigin);
      if (idx >= colorMapLength) throw new Error(`TGA 调色板索引越界：${index}`);
      pixels[d] = palette[idx * 4];
      pixels[d + 1] = palette[idx * 4 + 1];
      pixels[d + 2] = palette[idx * 4 + 2];
      pixels[d + 3] = palette[idx * 4 + 3];
      continue;
    }
    if (baseType === 3) {
      const g = raw[s];
      const a = bytesPerPixel === 2 ? raw[s + 1] : 255;
      pixels[d] = g;
      pixels[d + 1] = g;
      pixels[d + 2] = g;
      pixels[d + 3] = a;
      continue;
    }
    if (bpp === 24) {
      pixels[d] = raw[s + 2];
      pixels[d + 1] = raw[s + 1];
      pixels[d + 2] = raw[s];
      pixels[d + 3] = 255;
    } else if (bpp === 32) {
      pixels[d] = raw[s + 2];
      pixels[d + 1] = raw[s + 1];
      pixels[d + 2] = raw[s];
      pixels[d + 3] = raw[s + 3];
    } else {
      // 16-bit: 5-5-5-1，部分工具把最高位当 alpha，这里统一按不透明处理
      const v = raw[s] | (raw[s + 1] << 8);
      const r5 = (v >> 10) & 0x1f;
      const g5 = (v >> 5) & 0x1f;
      const b5 = v & 0x1f;
      pixels[d] = Math.round((r5 / 31) * 255);
      pixels[d + 1] = Math.round((g5 / 31) * 255);
      pixels[d + 2] = Math.round((b5 / 31) * 255);
      pixels[d + 3] = 255;
    }
  }

  // 处理原点方向
  if (!topOrigin || rightOrigin) {
    const flipped = new Uint8ClampedArray(pixels.length);
    for (let y = 0; y < height; y++) {
      const srcY = topOrigin ? y : height - 1 - y;
      for (let x = 0; x < width; x++) {
        const srcX = rightOrigin ? width - 1 - x : x;
        const s = (srcY * width + srcX) * 4;
        const d = (y * width + x) * 4;
        flipped[d] = pixels[s];
        flipped[d + 1] = pixels[s + 1];
        flipped[d + 2] = pixels[s + 2];
        flipped[d + 3] = pixels[s + 3];
      }
    }
    return { width, height, data: flipped };
  }

  return { width, height, data: pixels };
}
