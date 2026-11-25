/**
 * PNG 编码往返测试：
 * Node 没有 DOM/Canvas，这里复刻 image.js 的编码算法（zlib deflate + 同款 chunk 结构），
 * 用 Python 标准库解码，验证输出的是合法 PNG 且像素与输入一致。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const core = require("../public/js/core.js");

function chunk(tag, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  Buffer.from(tag).copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(core.crc32(Uint8Array.from(out.subarray(4, 8 + data.length))), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const deflated = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk(Buffer.from("IHDR"), ihdr),
    chunk(Buffer.from("IDAT"), deflated),
    chunk(Buffer.from("IEND"), Buffer.alloc(0)),
  ]);
}

test("PNG 编码往返：Python 解码后像素与输入一致", () => {
  const w = 7;
  const h = 5;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 37) % 256;
    rgba[i * 4 + 1] = (i * 73 + 20) % 256;
    rgba[i * 4 + 2] = (i * 11 + 128) % 256;
    rgba[i * 4 + 3] = 255;
  }
  const png = encodePNG(w, h, rgba);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtpack-png-"));
  const pngPath = path.join(dir, "roundtrip.png");
  fs.writeFileSync(pngPath, png);

  const decodeScript = `
import struct, zlib, sys, json
data = open(sys.argv[1], "rb").read()
assert data[:8] == b"\\x89PNG\\r\\n\\x1a\\n"
pos = 8; idat = b""; w=h=0
while pos < len(data):
    ln = struct.unpack(">I", data[pos:pos+4])[0]
    tag = data[pos+4:pos+8]
    body = data[pos+8:pos+8+ln]
    if tag == b"IHDR":
        w, h = struct.unpack(">II", body[:8])
        assert body[8] == 8 and body[9] == 6
    elif tag == b"IDAT":
        idat += body
    pos += 12 + ln
raw = zlib.decompress(idat)
stride = w * 4 + 1
pixels = []
for y in range(h):
    row = raw[y*stride:(y+1)*stride]
    assert row[0] == 0
    pixels.extend(row[1:])
print(json.dumps({"w": w, "h": h, "pixels": pixels}))
`;
  const out = JSON.parse(execFileSync("python3", ["-I", "-c", decodeScript, pngPath], { encoding: "utf8" }));
  assert.equal(out.w, w);
  assert.equal(out.h, h);
  assert.deepEqual(Buffer.from(out.pixels), rgba);
});
