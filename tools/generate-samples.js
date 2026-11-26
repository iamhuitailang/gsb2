/**
 * tools/generate-samples.js — 零依赖生成示例素材（PNG 编码器手写，无第三方包）
 * 输出到 public/samples/（已在 .gitignore，可用本命令恢复）：
 *   bg-white.png / bg-demo.png / bg-checker.png
 *   icon-circle.png / icon-diamond.png / icon-square.png / icon-triangle.png
 * 图标为带软边的透明 PNG，用于验证“半透明边缘 / 全透明区”分类。
 */
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // 每行前置 filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeBuf(W, H) { return Buffer.alloc(W * H * 4, 0); }
function setPx(buf, W, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const i = (y * W + x) * 4;
  // source-over 叠加，保证边缘是真正的半透明像素
  const sa = a / 255, da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}

function solid(W, H, [r, g, b]) {
  const buf = makeBuf(W, H);
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255;
  }
  return buf;
}
function demoBg(W, H) {
  const buf = makeBuf(W, H);
  const half = Math.round(W / 2);
  // 与 js/assets.js 的演示底保持一致：浅黄绿→橄榄绿→砖红(与红圆ΔE≈3)→土黄→深蓝
  const stops = [
    [0.0, [232, 242, 192]],
    [0.32, [127, 154, 74]],
    [0.52, [209, 79, 71]],
    [0.72, [181, 138, 62]],
    [1.0, [46, 53, 80]],
  ];
  function sample(t) {
    for (let s = 0; s < stops.length - 1; s++) {
      const [t0, c0] = stops[s], [t1, c1] = stops[s + 1];
      if (t <= t1) {
        const u = (t - t0) / (t1 - t0);
        return c0.map((v, k) => Math.round(v + (c1[k] - v) * u));
      }
    }
    return stops[stops.length - 1][1];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let rgb;
      if (x < half) rgb = [255, 255, 255];
      else {
        const t = ((x - half) / (W - half) + y / H) / 2;
        rgb = sample(t);
      }
      setPx(buf, W, x, y, rgb[0], rgb[1], rgb[2], 255);
    }
  }
  return buf;
}
function checker(W, H, cell) {
  const buf = makeBuf(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? [201, 201, 201] : [242, 242, 242];
    setPx(buf, W, x, y, c[0], c[1], c[2], 255);
  }
  return buf;
}

function shapeMask(shape, x, y, S) {
  const cx = S / 2, r = S * 0.42;
  switch (shape) {
    case 'circle': return Math.hypot(x - cx, y - cx) <= r;
    case 'square': return Math.abs(x - cx) <= r && Math.abs(y - cx) <= r;
    case 'diamond': return Math.abs(x - cx) + Math.abs(y - cx) <= r * 1.25;
    case 'triangle':
      return y >= cx - r && y <= cx + r &&
        Math.abs(x - cx) <= (y - (cx - r)) * 0.9;
    default: return false;
  }
}
function icon(shape, [r, g, b], S) {
  const SS = 4;
  const big = makeBuf(S * SS, S * SS);
  for (let y = 0; y < S * SS; y++) for (let x = 0; x < S * SS; x++) {
    if (shapeMask(shape, x, y, S * SS)) {
      const k = 0.72 + 0.5 * (1 - y / (S * SS)); // 同色明暗造型
      setPx(big, S * SS, x, y,
        Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k), 255);
    }
  }
  // 降采样：alpha 自然落在 0-255 之间，形成软边
  const out = makeBuf(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let ar = 0, ag = 0, ab = 0, aa = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const i = ((y * SS + sy) * S * SS + (x * SS + sx)) * 4;
      const a = big[i + 3];
      ar += big[i] * a; ag += big[i + 1] * a; ab += big[i + 2] * a; aa += a;
    }
    if (aa > 0) {
      const i = (y * S + x) * 4;
      out[i] = Math.round(ar / aa); out[i + 1] = Math.round(ag / aa);
      out[i + 2] = Math.round(ab / aa); out[i + 3] = Math.round(aa / (SS * SS));
    }
  }
  return out;
}

const outDir = path.join(__dirname, '..', 'public', 'samples');
fs.mkdirSync(outDir, { recursive: true });
function write(name, W, H, buf) {
  fs.writeFileSync(path.join(outDir, name), encodePNG(W, H, buf));
  console.log('✓', path.join('public/samples', name));
}

write('bg-white.png', 640, 400, solid(640, 400, [255, 255, 255]));
write('bg-demo.png', 640, 400, demoBg(640, 400));
write('bg-checker.png', 640, 400, checker(640, 400, 24));
write('icon-circle.png', 96, 96, icon('circle', [224, 68, 62], 96));
write('icon-diamond.png', 96, 96, icon('diamond', [63, 157, 77], 96));
write('icon-square.png', 96, 96, icon('square', [58, 111, 224], 96));
write('icon-triangle.png', 96, 96, icon('triangle', [232, 137, 42], 96));
console.log('示例素材已生成，可在页面“导入”中选择 public/samples 下的文件。');
