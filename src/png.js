'use strict';
// 极简 PNG 编码器(仅依赖 node:zlib),用于生成样例报告里的本地图片。
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Buffer,长度 width*height*4 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function setPixel(rgba, width, x, y, [r, g, b, a]) {
  const i = (y * width + x) * 4;
  rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
}

/** 生成一张柱状图样式的本地图片,模拟供应商报告里的统计图。 */
function barChartPng() {
  const width = 360, height = 220;
  const rgba = Buffer.alloc(width * height * 4);
  const WHITE = [255, 255, 255, 255], GRID = [220, 224, 230, 255],
        AXIS = [90, 96, 104, 255], BAR = [49, 112, 214, 255];
  for (let i = 0; i < width * height; i++) setPixel(rgba, width, i % width, Math.floor(i / width), WHITE);
  // 网格线
  for (const gy of [40, 90, 140, 190]) {
    for (let x = 30; x < width - 10; x++) setPixel(rgba, width, x, gy, GRID);
  }
  // 坐标轴
  for (let y = 20; y <= 190; y++) setPixel(rgba, width, 30, y, AXIS);
  for (let x = 30; x < width - 10; x++) setPixel(rgba, width, x, 190, AXIS);
  // 柱子
  const bars = [60, 110, 85, 140, 120];
  bars.forEach((h, i) => {
    const x0 = 50 + i * 60;
    for (let x = x0; x < x0 + 36; x++) {
      for (let y = 190 - h; y < 190; y++) setPixel(rgba, width, x, y, BAR);
    }
  });
  return encodePng(width, height, rgba);
}

module.exports = { encodePng, barChartPng };
