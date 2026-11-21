import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, inflateSync } from "node:zlib";

import {
  buildOutput,
  describeFit,
  extractScalar,
  fitGeometry,
  previewDimensions,
  renderNormalSphere,
  resampleScalar,
  samplePixel,
  transformValue,
} from "../src/lib/imaging.js";
import { decodePng } from "../src/lib/pngDecode.js";
import { encodePng } from "../src/lib/png.js";
import { decodeTga } from "../src/lib/tga.js";
import { createZip } from "../src/lib/zip.js";
import { crc32 } from "../src/lib/crc32.js";

function solid(w, h, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { width: w, height: h, data };
}

function striped(w, h, axis = "x") {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = axis === "x" ? Math.round((x / (w - 1)) * 255) : Math.round((y / (h - 1)) * 255);
      const p = (y * w + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/* ----------------------------- 取色 ----------------------------- */

test("samplePixel 支持全部取色方式", () => {
  const data = new Uint8ClampedArray([10, 20, 100, 128]);
  assert.equal(samplePixel(data, 0, "red"), 10 / 255);
  assert.equal(samplePixel(data, 0, "green"), 20 / 255);
  assert.equal(samplePixel(data, 0, "blue"), 100 / 255);
  assert.equal(samplePixel(data, 0, "alpha"), 128 / 255);
  assert.ok(Math.abs(samplePixel(data, 0, "average") - 130 / 3 / 255) < 1e-6);
  assert.equal(samplePixel(data, 0, "max"), 100 / 255);
  assert.equal(samplePixel(data, 0, "min"), 10 / 255);
  const lum = (0.2126 * 10 + 0.7152 * 20 + 0.0722 * 100) / 255;
  assert.ok(Math.abs(samplePixel(data, 0, "luminance") - lum) < 1e-6);
});

test("extractScalar 拒绝不完整数据", () => {
  assert.throws(
    () => extractScalar({ width: 4, height: 4, data: new Uint8ClampedArray(16) }),
    /像素数据不完整/,
  );
});

/* ----------------------------- 尺寸策略 ----------------------------- */

test("fitGeometry: 等比留边（横图放进方形）", () => {
  const g = fitGeometry(200, 100, 100, 100, "pad");
  assert.equal(g.dw, 100);
  assert.equal(g.dh, 50);
  assert.equal(g.dx, 0);
  assert.equal(g.dy, 25);
  assert.match(describeFit(200, 100, 100, 100, "pad"), /上下留边 50px/);
});

test("fitGeometry: 裁切会裁掉超出的部分且居中", () => {
  const g = fitGeometry(200, 100, 100, 100, "crop");
  assert.equal(g.sx, 50);
  assert.equal(g.sy, 0);
  assert.equal(g.sw, 100);
  assert.equal(g.sh, 100);
});

test("fitGeometry: 拉伸直接填满，描述中提示变形", () => {
  const g = fitGeometry(200, 100, 100, 100, "scale");
  assert.equal(g.dw, 100);
  assert.equal(g.dh, 100);
  assert.match(describeFit(200, 100, 100, 100, "scale"), /变形/);
});

test("resampleScalar: pad 模式留边填充常量", () => {
  const src = new Float32Array(200 * 100).fill(1);
  const out = resampleScalar(src, 200, 100, 100, 100, "pad", 0);
  assert.equal(out[0], 0, "左上角留边应为填充值");
  assert.equal(out[50 * 100 + 50], 1, "中心应为源数据");
});

test("resampleScalar: crop 模式覆盖整张目标图", () => {
  const src = new Float32Array(200 * 100).fill(0.7);
  const out = resampleScalar(src, 200, 100, 100, 100, "crop", 0);
  for (const v of out) assert.ok(Math.abs(v - 0.7) < 1e-5);
});

test("同尺寸复用快速路径，保持像素值", () => {
  const src = new Float32Array([0.1, 0.4, 0.9, 0.5]);
  const out = resampleScalar(src, 2, 2, 2, 2, "pad", 0);
  assert.deepEqual([...out], [...src]);
});

test("previewDimensions 保持宽高比且不超过上限", () => {
  const p = previewDimensions(2048, 1024, 512);
  assert.equal(p.width, 512);
  assert.equal(p.height, 256);
  const small = previewDimensions(64, 32, 512);
  assert.equal(small.width, 64, "小图不放大");
});

/* ----------------------------- 变换 ----------------------------- */

test("transformValue: 反相 / 强度 / 法线居中缩放", () => {
  assert.equal(transformValue(0.2, { invert: true }), 0.8);
  assert.equal(transformValue(0.5, { strength: 2 }), 1);
  assert.equal(transformValue(0.25, { strength: 2 }), 0.5);
  assert.equal(transformValue(0.75, { normal: true, strength: 0 }), 0.5);
  assert.equal(transformValue(0.75, { normal: true, strength: 2 }), 1);
});

/* ----------------------------- 打包 ----------------------------- */

const channelsFor = (role, sample = "luminance") => ({
  r: { source: role ? { kind: "role", role } : { kind: "constant" }, sample, constant: 10 },
  g: { source: role ? { kind: "role", role } : { kind: "constant" }, sample, constant: 20 },
  b: { source: role ? { kind: "role", role } : { kind: "constant" }, sample, constant: 30 },
  a: { source: { kind: "constant" }, sample: "luminance", constant: 40 },
});

test("buildOutput: 把颜色图按 R/G/B 写入对应通道", () => {
  const image = solid(2, 2, [11, 22, 33]);
  const out = buildOutput({
    width: 2,
    height: 2,
    fitMode: "pad",
    includeAlpha: false,
    channels: {
      r: { source: { kind: "role", role: "albedo" }, sample: "red" },
      g: { source: { kind: "role", role: "albedo" }, sample: "green" },
      b: { source: { kind: "role", role: "albedo" }, sample: "blue" },
      a: { source: { kind: "constant" }, constant: 0 },
    },
    resolveImage: () => image,
  });
  assert.equal(out.data[0], 11);
  assert.equal(out.data[1], 22);
  assert.equal(out.data[2], 33);
  assert.equal(out.data[3], 255, "未启用 Alpha 时固定不透明");
  assert.equal(out.channels[3].usedConstant, true);
});

test("buildOutput: 缺少来源时用常量补齐并给出警告", () => {
  const out = buildOutput({
    width: 2,
    height: 1,
    fitMode: "pad",
    includeAlpha: false,
    channels: channelsFor("roughness"),
    resolveImage: () => null,
  });
  assert.equal(out.data[0], 10);
  assert.equal(out.data[1], 20);
  assert.equal(out.data[2], 30);
  assert.equal(out.channels[0].usedConstant, true);
  assert.equal(out.channels[0].missingSource, true);
  assert.ok(out.warnings.some((w) => /缺少「粗糙度」/.test(w)));
});

test("buildOutput: 解码失败的来源回退常量并记录原因", () => {
  const out = buildOutput({
    width: 1,
    height: 1,
    fitMode: "pad",
    channels: channelsFor("normal"),
    includeAlpha: false,
    resolveImage: () => ({ error: "TGA 数据不完整" }),
  });
  assert.equal(out.channels[0].usedConstant, true);
  assert.match(out.channels[0].sourceError, /数据不完整/);
  assert.ok(out.warnings.some((w) => /解码失败/.test(w)));
});

test("buildOutput: DirectX 约定只会翻转法线的绿通道", () => {
  const image = striped(2, 1, "x");
  // 让三通道取到的值都不同：用灰度条纹 + 不同取色方式
  const makeChannels = () => ({
    r: { source: { kind: "role", role: "normal" }, sample: "red" },
    g: { source: { kind: "role", role: "normal" }, sample: "green" },
    b: { source: { kind: "role", role: "normal" }, sample: "blue" },
    a: { source: { kind: "constant" }, constant: 255 },
  });
  const gl = buildOutput({
    width: 2,
    height: 1,
    includeAlpha: false,
    convention: "opengl",
    channels: makeChannels(),
    resolveImage: () => image,
  });
  const dx = buildOutput({
    width: 2,
    height: 1,
    includeAlpha: false,
    convention: "directx",
    channels: makeChannels(),
    resolveImage: () => image,
  });
  assert.equal(gl.data[0], dx.data[0], "R 不变");
  assert.equal(gl.data[2], dx.data[2], "B 不变");
  assert.equal(dx.data[1], 255 - gl.data[1], "G 被翻转");
});

test("buildOutput: 尺寸不一致时按上限警告并记录原始尺寸", () => {
  const image = solid(64, 32, [200, 100, 50]);
  const out = buildOutput({
    width: 64,
    height: 64,
    fitMode: "pad",
    includeAlpha: false,
    channels: {
      r: { source: { kind: "role", role: "albedo" }, sample: "red", constant: 10 },
      g: { source: { kind: "role", role: "albedo" }, sample: "green", constant: 20 },
      b: { source: { kind: "role", role: "albedo" }, sample: "blue", constant: 30 },
      a: { source: { kind: "constant" }, constant: 255 },
    },
    resolveImage: () => image,
  });
  assert.equal(out.channels[0].sourceWidth, 64);
  assert.equal(out.channels[0].sourceHeight, 32);
  assert.ok(out.warnings.some((w) => /尺寸 64×32 与目标 64×64 不一致/.test(w)));
  // 上下留边应为各通道常量
  assert.equal(out.data[0], 10);
  assert.equal(out.data[1], 20);
  assert.equal(out.data[2], 30);
  const centerRow = 32 * 64;
  assert.equal(out.data[centerRow * 4], 200);
  assert.equal(out.data[centerRow * 4 + 1], 100);
  assert.equal(out.data[centerRow * 4 + 2], 50);
});

test("buildOutput: 预览模式（warnOnSizeMismatch=false）不误报尺寸不一致", () => {
  const image = solid(64, 32, [200, 100, 50]);
  const out = buildOutput({
    width: 32,
    height: 32,
    fitMode: "pad",
    includeAlpha: false,
    warnOnSizeMismatch: false,
    channels: channelsFor("albedo"),
    resolveImage: () => image,
  });
  assert.equal(out.warnings.length, 0);
});

test("buildOutput: 尺寸无警告时提示尺寸一致", () => {
  const image = solid(8, 8, [1, 2, 3]);
  const out = buildOutput({
    width: 8,
    height: 8,
    includeAlpha: false,
    channels: channelsFor("albedo"),
    resolveImage: () => image,
  });
  assert.equal(out.warnings.length, 0);
});

test("buildOutput: 非法尺寸直接报错", () => {
  assert.throws(() => buildOutput({ width: 0, height: 4 }), /尺寸无效/);
  assert.throws(() => buildOutput({ width: 4.5, height: 4 }), /尺寸无效/);
});

test("renderNormalSphere 生成不文字母的半球像素", () => {
  const normal = striped(32, 32, "x");
  const pixels = renderNormalSphere({ data: normal.data, width: 32, height: 32, convention: "opengl", size: 64 });
  assert.equal(pixels.length, 64 * 64 * 4);
  assert.equal(pixels[0 * 4 + 3], 0, "角落透明");
  const center = (32 * 64 + 32) * 4;
  assert.equal(pixels[center + 3], 255, "中心不透明");
});

/* ----------------------------- PNG 编解码 ----------------------------- */

test("PNG 编码后可被自带解码器还原", async () => {
  const image = solid(13, 7, [12, 34, 56, 78]);
  const png = await encodePng(image, { deflate: (b) => deflateSync(b) });
  const decoded = await decodePng(png, (b) => inflateSync(b));
  assert.equal(decoded.width, 13);
  assert.equal(decoded.height, 7);
  assert.equal(decoded.data[0], 12);
  assert.equal(decoded.data[1], 34);
  assert.equal(decoded.data[2], 56);
  assert.equal(decoded.data[3], 78);
});

test("PNG 解码器识别 CRC 损坏", async () => {
  const png = await encodePng(solid(2, 2, [1, 2, 3, 4]), { deflate: (b) => deflateSync(b) });
  const broken = Uint8Array.from(png);
  broken[40] = broken[40] ^ 0xff;
  await assert.rejects(() => decodePng(broken, (b) => inflateSync(b)), /CRC/);
});

test("PNG 解码器识别被截断的文件", async () => {
  const png = await encodePng(solid(8, 8, [1, 2, 3, 4]), { deflate: (b) => deflateSync(b) });
  const truncated = png.subarray(0, png.length - 30);
  await assert.rejects(() => decodePng(truncated, (b) => inflateSync(b)));
});

/* ----------------------------- TGA ----------------------------- */

function makeTga(w, h, bpp = 24, imageType = 2, pixels = null) {
  const header = new Uint8Array(18);
  header[2] = imageType;
  header[12] = w & 0xff;
  header[13] = (w >> 8) & 0xff;
  header[14] = h & 0xff;
  header[15] = (h >> 8) & 0xff;
  header[16] = bpp;
  header[17] = 0x20;
  const data = pixels || new Uint8Array(w * h * (bpp / 8));
  const out = new Uint8Array(18 + data.length);
  out.set(header, 0);
  out.set(data, 18);
  return out;
}

test("TGA: 解码 24 位未压缩", () => {
  const w = 2;
  const h = 1;
  const pixels = new Uint8Array([
    10, 20, 30, // BGR -> rgb(30,20,10)
    40, 50, 60,
  ]);
  const decoded = decodeTga(makeTga(w, h, 24, 2, pixels));
  assert.equal(decoded.width, 2);
  assert.deepEqual([...decoded.data.subarray(0, 4)], [30, 20, 10, 255]);
  assert.deepEqual([...decoded.data.subarray(4, 8)], [60, 50, 40, 255]);
});

test("TGA: 解码 8 位灰度", () => {
  const decoded = decodeTga(makeTga(2, 2, 8, 3, new Uint8Array([0, 128, 255, 200])));
  assert.deepEqual([...decoded.data.subarray(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...decoded.data.subarray(4, 8)], [128, 128, 128, 255]);
});

test("TGA: 解码 RLE 段（重复 + 原始）", () => {
  // 0x82：同一像素重复 3 次；0x01：后面跟 2 个原始像素
  const payload = new Uint8Array([
    0x82, 1, 2, 3,
    0x01, 4, 5, 6, 7, 8, 9,
  ]);
  const bytes = makeTga(5, 1, 24, 10, payload);
  const decoded = decodeTga(bytes);
  assert.equal(decoded.data.length, 5 * 4);
  // 前 3 个像素都来自 RLE 段（BGR 1,2,3 -> RGB 3,2,1）
  for (let i = 0; i < 3; i++) {
    assert.deepEqual([...decoded.data.subarray(i * 4, i * 4 + 4)], [3, 2, 1, 255]);
  }
  assert.deepEqual([...decoded.data.subarray(12, 16)], [6, 5, 4, 255]);
  assert.deepEqual([...decoded.data.subarray(16, 20)], [9, 8, 7, 255]);
});

test("TGA: 数据不完整时给出明确错误", () => {
  const bytes = makeTga(4, 4, 24, 2, new Uint8Array(10));
  assert.throws(() => decodeTga(bytes), /像素数据不完整/);
});

/* ----------------------------- ZIP ----------------------------- */

test("ZIP 结构完整性（本地头 + 中央目录 + EOCD）", () => {
  const zip = createZip([{ name: "a.txt", data: new TextEncoder().encode("hello") }]);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.ok(zip.includes(0x61)); // 'a'
});

test("crc32 对已知输入稳定", () => {
  const bytes = new TextEncoder().encode("123456789");
  assert.equal(crc32(bytes), 0xcbf43926);
});
