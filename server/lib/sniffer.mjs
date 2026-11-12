/**
 * 基于文件实际字节的类型嗅探。
 * 原则：客户端提供的文件名扩展名与 Content-Type 仅作展示，一律不参与信任决策。
 * 对图片除魔数外还做最小结构解析（尺寸/帧/块），防止“带图片魔数的杂凑文件”蒙混过关。
 */

/**
 * 根据字节内容返回内部类型标识（png/jpeg/gif/webp/bmp/zip），无法识别返回 null。
 * @param {Buffer} head 至少前 32 字节（调用方通常给前 512 字节）
 */
export function sniffType(head) {
  if (!Buffer.isBuffer(head) || head.length < 4) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'jpeg';
  }
  // GIF87a / GIF89a
  if (head.length >= 6 && head.subarray(0, 6).toString('ascii') === 'GIF89a' ||
      head.length >= 6 && head.subarray(0, 6).toString('ascii') === 'GIF87a') {
    return 'gif';
  }
  // BMP: BM
  if (head[0] === 0x42 && head[1] === 0x4d) {
    return 'bmp';
  }
  // RIFF .... WEBP
  if (head.length >= 12 &&
      head.subarray(0, 4).toString('ascii') === 'RIFF' &&
      head.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  // ZIP（含 docx/jar 等 ZIP 容器）: PK\x03\x04 / 空归档 PK\x05\x06 / 分卷 PK\x07\x08
  if (head[0] === 0x50 && head[1] === 0x4b &&
      (head[2] === 0x03 && head[3] === 0x04 ||
       head[2] === 0x05 && head[3] === 0x06 ||
       head[2] === 0x07 && head[0x08] === 0x08)) {
    return 'zip';
  }
  return null;
}

/**
 * 深度结构校验：解析图片容器的基本结构并读取尺寸。
 * 返回 { ok, width, height, reason }。任何结构异常都判失败。
 */
export function verifyImage(type, buf) {
  try {
    switch (type) {
      case 'png': return verifyPng(buf);
      case 'jpeg': return verifyJpeg(buf);
      case 'gif': return verifyGif(buf);
      case 'webp': return verifyWebp(buf);
      case 'bmp': return verifyBmp(buf);
      default: return { ok: false, reason: '不支持的图片类型' };
    }
  } catch (err) {
    return { ok: false, reason: `图片结构解析失败: ${err.message}` };
  }
}

function verifyPng(buf) {
  // IHDR 必须紧跟签名之后：长度(4) + "IHDR" + 宽(4) + 高(4)
  if (buf.length < 24) return { ok: false, reason: 'PNG 内容过短' };
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') {
    return { ok: false, reason: 'PNG 缺少 IHDR 块' };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 30000 || height > 30000) {
    return { ok: false, reason: 'PNG 尺寸非法' };
  }
  // IEND 必须存在（结尾标记）
  if (buf.subarray(buf.length - 8, buf.length - 4).toString('ascii') !== 'IEND') {
    return { ok: false, reason: 'PNG 缺少 IEND 结束块' };
  }
  return { ok: true, width, height };
}

function verifyJpeg(buf) {
  let offset = 2; // 跳过 SOI
  // 遍历标记段，找到 SOFn 读取尺寸
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return { ok: false, reason: 'JPEG 标记结构损坏' };
    let marker = buf[offset + 1];
    // 填充字节 FF
    while (marker === 0xff && offset + 1 < buf.length) {
      offset += 1;
      marker = buf[offset + 1];
    }
    // 不带长度字段的标记
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) return { ok: false, reason: 'JPEG 段长度越界' };
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2 || offset + 2 + segLen > buf.length) {
      return { ok: false, reason: 'JPEG 段长度非法' };
    }
    // SOF0..SOF15 排除 DHT(C4)/DAC(CC) 等
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (width === 0 || height === 0 || width > 30000 || height > 30000) {
        return { ok: false, reason: 'JPEG 尺寸非法' };
      }
      return { ok: true, width, height };
    }
    // SOS 之后是熵编码数据，扫描下一个标记；找不到 SOF 即视为损坏
    if (marker === 0xda) {
      const next = buf.indexOf(0xff, offset + 2 + segLen);
      if (next === -1) return { ok: false, reason: 'JPEG 缺少 SOF 帧标记' };
      offset = next;
      continue;
    }
    offset += 2 + segLen;
  }
  return { ok: false, reason: 'JPEG 未找到有效的帧标记' };
}

function verifyGif(buf) {
  // 签名(6) + 逻辑屏幕宽高(各 2, little-endian)
  if (buf.length < 10) return { ok: false, reason: 'GIF 内容过短' };
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (width === 0 || height === 0) return { ok: false, reason: 'GIF 尺寸非法' };
  // 必须包含 GIF  Trailer (0x3B)
  if (buf[buf.length - 1] !== 0x3b) return { ok: false, reason: 'GIF 缺少结束标记' };
  return { ok: true, width, height };
}

function verifyWebp(buf) {
  const format = buf.subarray(12, 16).toString('ascii');
  if (format === 'VP8 ') {
    // 简单（有损）：在 23..26 处为画面尺寸
    if (buf.length < 30) return { ok: false, reason: 'WebP(VP8) 内容过短' };
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    if (!width || !height) return { ok: false, reason: 'WebP 尺寸非法' };
    return { ok: true, width, height };
  }
  if (format === 'VP8L') {
    // 无损：1 字节签名 0x2F 后为 14 位宽/高（各减 1 存储）
    if (buf.length < 25 || buf[20] !== 0x2f) return { ok: false, reason: 'WebP(VP8L) 头损坏' };
    const b0 = buf.readUInt32LE(21);
    const width = (b0 & 0x3fff) + 1;
    const height = ((b0 >> 14) & 0x3fff) + 1;
    return { ok: true, width, height };
  }
  if (format === 'VP8X') {
    // 扩展格式：24 字节起各 3 字节存储减 1 的宽高
    if (buf.length < 30) return { ok: false, reason: 'WebP(VP8X) 内容过短' };
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    return { ok: true, width, height };
  }
  return { ok: false, reason: 'WebP 块格式未知' };
}

function verifyBmp(buf) {
  if (buf.length < 26) return { ok: false, reason: 'BMP 内容过短' };
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  if (width <= 0 || height <= 0 || width > 30000 || height > 30000) {
    return { ok: false, reason: 'BMP 尺寸非法' };
  }
  return { ok: true, width, height };
}
