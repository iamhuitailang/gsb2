#!/usr/bin/env node
// 生成内置样例到 public/samples/：
// - sample-model.obj   多对象 / 多组 / 多材质，并故意包含缺失材质、无效面、越界索引、不支持指令
// - sample-material.mtl 四个材质，其中一个声明的贴图文件故意不生成
// - checkerboard.png   实际存在的棋盘格贴图（纯 Node + zlib 手写 PNG，无第三方依赖）
//
// 运行：npm run generate:samples

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'samples');
mkdirSync(outDir, { recursive: true });

// ---------- PNG 编码器（RGBA，8bit，单 IDAT） ----------
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 64x64 橙白棋盘格
const pngSize = 64;
const cell = 16;
const pixels = Buffer.alloc(pngSize * pngSize * 4);
for (let y = 0; y < pngSize; y++) {
  for (let x = 0; x < pngSize; x++) {
    const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
    const i = (y * pngSize + x) * 4;
    pixels[i] = dark ? 230 : 245;
    pixels[i + 1] = dark ? 126 : 232;
    pixels[i + 2] = dark ? 34 : 218;
    pixels[i + 3] = 255;
  }
}
writeFileSync(join(outDir, 'checkerboard.png'), encodePng(pngSize, pngSize, pixels));

// ---------- MTL ----------
const mtl = `# 示例材质库（由 scripts/generate-samples.mjs 生成）
newmtl RedPlastic
Ka 0.15 0.15 0.15
Kd 0.82 0.18 0.16
Ks 0.25 0.25 0.25
Ns 24
d 1.0

newmtl BlueMetal
Ka 0.1 0.12 0.18
Kd 0.12 0.32 0.78
Ks 0.75 0.75 0.8
Ns 96

newmtl CheckerMat
Ka 0.2 0.2 0.2
Kd 0.9 0.9 0.9
Ks 0.1 0.1 0.1
Ns 16
map_Kd checkerboard.png

newmtl MissingTextureMat
Ka 0.1 0.1 0.1
Kd 0.2 0.65 0.35
Ks 0.2 0.2 0.2
Ns 20
map_Kd does-not-exist.png

newmtl TransparentGlass
Ka 0.2 0.25 0.3
Kd 0.55 0.75 0.9
Ks 0.9 0.9 0.95
Ns 120
d 0.45
`;
writeFileSync(join(outDir, 'sample-material.mtl'), mtl);

// ---------- OBJ ----------
// 顶点手工编号，行号见行尾注释，README 与测试用例都引用这些位置
const obj = `# 示例 OBJ：覆盖正常几何、多对象多组、材质切换与各类读取异常
# 由 scripts/generate-samples.mjs 生成
mtllib sample-material.mtl

# ===== 对象 1：立方体 CubeA（8 顶点 / 6 四边形面），两组两材质 =====
o CubeA
v -1.6 -1.0 -1.6
v -0.6 -1.0 -1.6
v -0.6  0.0 -1.6
v -1.6  0.0 -1.6
v -1.6 -1.0 -0.6
v -0.6 -1.0 -0.6
v -0.6  0.0 -0.6
v -1.6  0.0 -0.6
vt 0.0 0.0
vt 1.0 0.0
vt 1.0 1.0
vt 0.0 1.0
vn 0.0 0.0 -1.0
vn 0.0 0.0 1.0
vn -1.0 0.0 0.0
vn 1.0 0.0 0.0
vn 0.0 -1.0 0.0
vn 0.0 1.0 0.0
g Bottom
usemtl RedPlastic
f 1/1/5 2/2/5 6/3/5 5/4/5
f 1/1/3 4/2/3 8/3/3 5/4/3
f 2/1/4 6/2/4 7/3/4 3/4/4
g Top
usemtl BlueMetal
f 4/1/6 3/2/6 7/3/6 8/4/6
f 1/1/1 2/2/1 3/3/1 4/4/1
f 5/1/2 8/2/2 7/3/2 6/4/2

# ===== 对象 2：重名立方体，验证结构树按稳定 ID 区分而不是按名字 =====
o CubeA
v 0.4 -1.0 0.4
v 1.4 -1.0 0.4
v 1.4 0.0 0.4
v 0.4 0.0 0.4
v 0.4 -1.0 1.4
v 1.4 -1.0 1.4
v 1.4 0.0 1.4
v 0.4 0.0 1.4
g Textured
usemtl CheckerMat
f 9/1 10/2 11/3 12/4
f 9/1 13/2 17/3 12/4
f 10/1 14/2 18/3 11/4
f 12/1 11/2 19/3 16/4
f 13/1 14/2 18/3 17/4
f 13/1 9/2 10/3 14/4
g WithMissingMap
usemtl MissingTextureMat
f 13/1 17/2 18/3 14/4

# ===== 对象 3：金字塔 Pyramid，含玻璃材质与一组故意制造的异常面 =====
# 前两个立方体共 16 个顶点，本对象顶点编号为 17..21
o Pyramid
v 2.2 -1.0 -1.6
v 3.2 -1.0 -1.6
v 3.2 -1.0 -0.6
v 2.2 -1.0 -0.6
v 2.7 -0.1 -1.1
g Sides
usemtl TransparentGlass
f 17 18 21
f 18 19 21
f 19 20 21
f 20 17 21
g Base
usemtl RedPlastic
f 17 20 19 18
# 补一个合法顶点（编号 22），与下方错误面里的越界索引 999 形成对照
v 3.4 -1.0 -0.1

# ===== 以下为故意制造的读取异常，警告面板应逐条列出位置 =====
# 非法顶点会被解析器跳过、不占用编号，因此不影响上面正常几何的索引
g ErrorCases
usemtl NotDefinedAnywhere
f 17 18 19
f 18 0 19
f 9 10 999
f 17 18
f x y z
curv 0.0 1.0 17 18 19
v not-a-number 0 0
f 17 -1 -2
`;
writeFileSync(join(outDir, 'sample-model.obj'), obj);

console.log(`样例已生成到 ${outDir}`);
console.log('  - sample-model.obj');
console.log('  - sample-material.mtl');
console.log('  - checkerboard.png（missing texture 材质引用的 does-not-exist.png 故意不生成）');
