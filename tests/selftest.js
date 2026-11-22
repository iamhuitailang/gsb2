/* 纯本地自测：node tests/selftest.js
 * 覆盖：几何互逆变换、盒式模糊边界归一化、alpha 混合、矩形相交，
 * 以及样例 PNG 的结构与关键像素性质（透明区、文字区不透明）。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  clamp, imageToScreen, screenToImage, boxBlur1D, boxBlur2D, blendPixel, rectsIntersect,
} = require('../app.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok -', name);
}

// ---------- 几何/像素纯函数 ----------

test('clamp', () => {
  assert.strictEqual(clamp(5, 0, 10), 5);
  assert.strictEqual(clamp(-1, 0, 10), 0);
  assert.strictEqual(clamp(11, 0, 10), 10);
});

test('imageToScreen / screenToImage 在旋转下互逆（掩码不随视角漂移）', () => {
  const view = { scale: 1.7, rot: Math.PI / 3, cx: 40, cy: -25 };
  const cw = 900, ch = 600, W = 512, H = 512;
  for (const p of [{ x: 0, y: 0 }, { x: 123.4, y: 77.2 }, { x: 511, y: 388 }]) {
    const s = imageToScreen(p, view, cw, ch, W, H);
    const back = screenToImage(s, view, cw, ch, W, H);
    assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9);
  }
  // 图像中心在任何旋转下都映射到屏幕中心（中心支点），这是掩码不漂移的关键
  const v0 = { scale: 1, rot: 0, cx: 0, cy: 0 };
  const v1 = { scale: 1, rot: Math.PI / 2, cx: 0, cy: 0 };
  for (const v of [v0, v1]) {
    const center = imageToScreen({ x: W / 2, y: H / 2 }, v, cw, ch, W, H);
    assert.ok(Math.abs(center.x - cw / 2) < 1e-9 && Math.abs(center.y - ch / 2) < 1e-9);
  }
  // 90° 旋转后同一原图坐标的屏幕位置改变，但逆变换仍还原到同一原图坐标
  const p = { x: 100, y: 50 };
  const a = imageToScreen(p, v0, cw, ch, W, H);
  const b = imageToScreen(p, v1, cw, ch, W, H);
  assert.notDeepStrictEqual({ x: Math.round(a.x), y: Math.round(a.y) },
                            { x: Math.round(b.x), y: Math.round(b.y) });
  const back = screenToImage(b, v1, cw, ch, W, H);
  assert.deepStrictEqual({ x: Math.round(back.x), y: Math.round(back.y) }, { x: 100, y: 50 });
});

test('boxBlur1D 常量数组模糊后不变（边界归一化正确）', () => {
  const inp = new Float32Array([100, 100, 100, 100, 100]);
  const out = new Float32Array(5);
  boxBlur1D(inp, out, 5, 2);
  for (const v of out) assert.ok(Math.abs(v - 100) < 1e-4);
});

test('boxBlur1D 边缘按有效长度平均', () => {
  const inp = new Float32Array([0, 0, 100, 0, 0]);
  const out = new Float32Array(5);
  boxBlur1D(inp, out, 5, 1);
  assert.ok(Math.abs(out[0] - 0) < 1e-4);          // (0+0)/2
  assert.ok(Math.abs(out[2] - 100 / 3) < 1e-4);    // (0+100+0)/3
  assert.ok(Math.abs(out[4] - 0) < 1e-4);
});

test('boxBlur2D r=0 为拷贝，r>0 平滑', () => {
  const inp = new Float32Array(9).fill(0);
  inp[4] = 90;
  const same = boxBlur2D(inp, 3, 3, 0);
  assert.strictEqual(same[4], 90);
  const blur = boxBlur2D(inp, 3, 3, 1);
  assert.ok(blur[4] < 90 && blur[4] > 0);
  assert.ok(blur[0] > 0);  // 能量扩散到角落
});

test('blendPixel 全强度替换，零强度不动', () => {
  const d = [10, 20, 30, 255];
  blendPixel(d, 0, [200, 210, 220, 255], 0, 1);
  assert.deepStrictEqual(d, [200, 210, 220, 255]);
  const d2 = [10, 20, 30, 255];
  blendPixel(d2, 0, [200, 210, 220, 255], 0, 0);
  assert.deepStrictEqual(d2, [10, 20, 30, 255]);
});

test('blendPixel 透明源按 t 衰减目标 alpha（透明边缘修补不产生脏像素）', () => {
  const d = [100, 100, 100, 255];
  blendPixel(d, 0, [0, 0, 0, 0], 0, 0.5);
  assert.strictEqual(d[3], Math.round(255 * 0.5));
  assert.strictEqual(d[0], 100);  // 源无颜色贡献，保持目标色
});

test('rectsIntersect', () => {
  assert.strictEqual(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), true);
  assert.strictEqual(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false);
  assert.strictEqual(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 2, h: 2 }), false);
});

// ---------- 样例 PNG 校验（自带最小解码器，filter 0） ----------

function decodePng(file) {
  const buf = fs.readFileSync(file);
  assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG 签名');
  let off = 8, w = 0, h = 0, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const tag = buf.subarray(off + 4, off + 8).toString('ascii');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (tag === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (tag === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.strictEqual(raw.length, h * (w * 4 + 1), '解压后尺寸匹配（filter 0）');
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    assert.strictEqual(raw[y * (w * 4 + 1)], 0, '仅使用 filter type 0');
    raw.copy(out, y * w * 4, y * (w * 4 + 1) + 1, y * (w * 4 + 1) + 1 + w * 4);
  }
  return { w, h, data: out };
}

const sampleDir = path.join(__dirname, '..', 'public', 'samples');
const f1 = path.join(sampleDir, 'sample1_checker_scratch.png');
const f2 = path.join(sampleDir, 'sample2_transparent_edge.png');

test('样例1：512x512 全不透明，棋盘两色都存在，文字区有深色像素', () => {
  assert.ok(fs.existsSync(f1), '先运行 npm run generate:samples');
  const { w, h, data } = decodePng(f1);
  assert.strictEqual(w, 512); assert.strictEqual(h, 512);
  let opaque = 0, darkText = 0, lightSquare = 0, darkSquare = 0;
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    assert.strictEqual(a, 255);
    opaque++;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (r < 60 && g < 64 && b < 72) darkText++;
    if (r > 180) lightSquare++;
    if (r < 160 && r > 120) darkSquare++;
  }
  assert.strictEqual(opaque, w * h);
  assert.ok(darkText > 40, '应包含文字 SCRATCH 01 的深色像素');
  assert.ok(lightSquare > 1000 && darkSquare > 1000, '棋盘双色格均存在');
});

test('样例2：含透明背景、不透明瓷砖，透明区 alpha=0', () => {
  assert.ok(fs.existsSync(f2), '先运行 npm run generate:samples');
  const { w, h, data } = decodePng(f2);
  assert.strictEqual(w, 512); assert.strictEqual(h, 512);
  let transparent = 0, opaque = 0;
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    if (a === 0) transparent++;
    if (a === 255) opaque++;
  }
  assert.ok(transparent > 50000, '菱形外存在大片透明区');
  assert.ok(opaque > 50000, '菱形瓷砖不透明');
  // 四角必须全透明（透明背景保护测试点）
  for (const idx of [0, w - 1, (h - 1) * w, w * h - 1]) {
    assert.strictEqual(data[idx * 4 + 3], 0);
  }
});

console.log(`\n全部通过：${passed} 项测试`);
