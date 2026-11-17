import zlib from 'node:zlib';

/** 一个最小 PNG 编码器，用来生成样例报告里的本地图片（不依赖外部文件）。 */
export function encodePng(width, height, pixel) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pixel(x, y);
      const offset = 1 + x * 4;
      row[offset] = r;
      row[offset + 1] = g;
      row[offset + 2] = b;
      row[offset + 3] = a;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([length, typeAndData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 样例图表：浅色背景 + 几条柱状块，便于肉眼确认图片确实渲染了。 */
export function sampleChartPng() {
  const width = 160;
  const height = 96;
  const bars = [
    { x: 16, w: 24, h: 40, color: [84, 174, 255] },
    { x: 56, w: 24, h: 64, color: [26, 127, 55] },
    { x: 96, w: 24, h: 30, color: [191, 135, 0] },
    { x: 136, w: 12, h: 76, color: [207, 34, 46] },
  ];
  return encodePng(width, height, (x, y) => {
    const baseline = height - 12;
    for (const bar of bars) {
      if (x >= bar.x && x < bar.x + bar.w && y >= baseline - bar.h && y < baseline) {
        return [...bar.color, 255];
      }
    }
    if (y === baseline || y === baseline + 1) return [140, 149, 159, 255];
    return [246, 248, 250, 255];
  });
}
