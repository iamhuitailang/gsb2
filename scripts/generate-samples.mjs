/**
 * 生成本地示例素材（纯 Node，无第三方依赖）：
 *  - public/samples/seamed-cube.obj + .mtl：每面独立 UV 岛（接缝贯穿所有棱），单材质
 *  - public/samples/multi-material.obj + .mtl：六个面六个材质槽
 *  - public/samples/checkerboard.png：程序生成的棋盘纹理
 *
 * 运行：npm run generate:samples
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'samples');
mkdirSync(outDir, { recursive: true });

// 立方体六面，角点顺序与 UV(左下, 左上, 右上, 右下) 对应
const FACES = [
  { name: 'px', corners: [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]] },
  { name: 'nx', corners: [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5]] },
  { name: 'py', corners: [[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]] },
  { name: 'ny', corners: [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5]] },
  { name: 'pz', corners: [[0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, -0.5, 0.5]] },
  { name: 'nz', corners: [[-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, -0.5, -0.5]] },
];

// 每面 UV 岛在 0..1 画布中的位置（3 列 2 行），带 2‰ 内缩避免岛间串色
const LAYOUT = {
  pz: [0, 0], nz: [2, 0], px: [1, 0],
  nx: [1, 1], py: [0, 1], ny: [2, 1],
};

function faceUv(faceName) {
  const [ix, iy] = LAYOUT[faceName];
  const m = 0.002;
  const u0 = ix / 3 + m;
  const u1 = (ix + 1) / 3 - m;
  const v0 = iy / 2 + m;
  const v1 = (iy + 1) / 2 - m;
  return [[u0, v0], [u0, v1], [u1, v1], [u1, v0]];
}

/**
 * 生成 OBJ。perMaterial=true 时每面写入 usemtl，配合多材质 mtl。
 */
function buildObj(perMaterial) {
  const lines = [
    '# MeshPaint 3D 示例：带 UV 接缝的立方体（每面独立 UV 岛，棱边即接缝）',
    'mtllib seamed-cube.mtl',
    'o SeamedCube',
  ];
  let vBase = 0;
  let vtBase = 0;
  for (const face of FACES) {
    if (perMaterial) lines.push(`usemtl mat_${face.name}`);
    else lines.push('usemtl cube_surface');
    for (const c of face.corners) lines.push(`v ${c[0]} ${c[1]} ${c[2]}`);
    for (const uv of faceUv(face.name)) lines.push(`vt ${uv[0]} ${uv[1]}`);
    // 两个三角面 (1,2,3) (1,3,4)，位置与 UV 索引并行
    lines.push(
      `f ${vBase + 1}/${vtBase + 1} ${vBase + 2}/${vtBase + 2} ${vBase + 3}/${vtBase + 3}`,
    );
    lines.push(
      `f ${vBase + 1}/${vtBase + 1} ${vBase + 3}/${vtBase + 3} ${vBase + 4}/${vtBase + 4}`,
    );
    vBase += 4;
    vtBase += 4;
  }
  return lines.join('\n') + '\n';
}

const SINGLE_MTL = `# 单材质，引用程序棋盘纹理
newmtl cube_surface
Ka 0.2 0.2 0.2
Kd 0.85 0.85 0.85
Ks 0.0 0.0 0.0
d 1.0
map_Kd checkerboard.png
`;

const MULTI_MTL_HEADER = `# 多材质：立方体六面各占一个材质槽\n`;
function buildMultiMtl() {
  const colors = {
    px: [0.85, 0.3, 0.3],
    nx: [0.3, 0.55, 0.85],
    py: [0.95, 0.8, 0.35],
    ny: [0.45, 0.8, 0.45],
    pz: [0.75, 0.5, 0.9],
    nz: [0.4, 0.8, 0.85],
  };
  let out = MULTI_MTL_HEADER;
  for (const face of FACES) {
    const [r, g, b] = colors[face.name];
    out += `newmtl mat_${face.name}\nKa 0.2 0.2 0.2\nKd ${r} ${g} ${b}\nKs 0 0 0\nd 1.0\nmap_Kd checkerboard.png\n\n`;
  }
  return out;
}

// ---------- 程序化棋盘 PNG（纯 Node 编码） ----------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function buildCheckerPng(size = 512, cells = 8) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cell = size / cells;
  let row = 0;
  for (let y = 0; y < size; y++) {
    raw[row++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const cx = Math.min(cells - 1, Math.floor(x / cell));
      const cy = Math.min(cells - 1, Math.floor(y / cell));
      const odd = (cx + cy) % 2 === 0;
      let r = odd ? 238 : 120;
      let g = odd ? 238 : 120;
      let b = odd ? 238 : 120;
      // 格线
      if (x % Math.round(cell) === 0 || y % Math.round(cell) === 0) {
        r *= 0.7; g *= 0.7; b *= 0.7;
      }
      raw[row++] = r; raw[row++] = g; raw[row++] = b; raw[row++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(resolve(outDir, 'seamed-cube.obj'), buildObj(false));
writeFileSync(resolve(outDir, 'seamed-cube.mtl'), SINGLE_MTL);
writeFileSync(resolve(outDir, 'multi-material.obj'), buildObj(true));
writeFileSync(resolve(outDir, 'multi-material.mtl'), buildMultiMtl());
writeFileSync(resolve(outDir, 'checkerboard.png'), buildCheckerPng(512, 8));

console.log('示例素材已生成到', outDir);
