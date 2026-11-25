/**
 * 生成一个带 UV 接缝与内嵌棋盘纹理的 GLB（glTF 2.0 二进制）示例。
 * 纯 Node 实现：JSON chunk + BIN chunk，包含 position / normal / uv / indices、
 * 一个材质和一张内嵌 PNG baseColor 贴图。
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

const FACES = [
  { name: 'px', n: [1, 0, 0], corners: [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]] },
  { name: 'nx', n: [-1, 0, 0], corners: [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5]] },
  { name: 'py', n: [0, 1, 0], corners: [[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]] },
  { name: 'ny', n: [0, -1, 0], corners: [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5]] },
  { name: 'pz', n: [0, 0, 1], corners: [[0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, -0.5, 0.5]] },
  { name: 'nz', n: [0, 0, -1], corners: [[-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, -0.5, -0.5]] },
];
const LAYOUT = {
  pz: [0, 0], nz: [2, 0], px: [1, 0],
  nx: [1, 1], py: [0, 1], ny: [2, 1],
};

const positions = [];
const normals = [];
const uvs = [];
const indices = [];
let vbase = 0;
for (const face of FACES) {
  const [ix, iy] = LAYOUT[face.name];
  const m = 0.002;
  const faceUv = [
    [ix / 3 + m, iy / 2 + m],
    [ix / 3 + m, (iy + 1) / 2 - m],
    [(ix + 1) / 3 - m, (iy + 1) / 2 - m],
    [(ix + 1) / 3 - m, iy / 2 + m],
  ];
  face.corners.forEach((c, i) => {
    positions.push(...c);
    normals.push(...face.n);
    uvs.push(faceUv[i][0], faceUv[i][1]);
  });
  indices.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
  vbase += 4;
}

// ---------- 内嵌棋盘 PNG（与 OBJ 示例同款，256px 以控制 GLB 体积） ----------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function buildCheckerPng(size = 256, cells = 8) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cell = size / cells;
  let row = 0;
  for (let y = 0; y < size; y++) {
    raw[row++] = 0;
    for (let x = 0; x < size; x++) {
      const cx = Math.min(cells - 1, Math.floor(x / cell));
      const cy = Math.min(cells - 1, Math.floor(y / cell));
      const odd = (cx + cy) % 2 === 0;
      let r = odd ? 238 : 120;
      let g = odd ? 238 : 120;
      let b = odd ? 238 : 120;
      if (x % Math.round(cell) === 0 || y % Math.round(cell) === 0) {
        r *= 0.7; g *= 0.7; b *= 0.7;
      }
      raw[row++] = r; raw[row++] = g; raw[row++] = b; raw[row++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const png = buildCheckerPng();

// ---------- 组装 BIN：index | pos | normal | uv | png ----------
const align4 = (b) => (b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]));
/** glTF 规范要求 JSON chunk 用 ASCII 空格 0x20 填充到 4 字节对齐 */
const alignJson = (b) =>
  b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), 0x20)]);
const indexBuf = align4(Buffer.from(new Uint16Array(indices).buffer));
const posBuf = align4(Buffer.from(new Float32Array(positions).buffer));
const normalBuf = align4(Buffer.from(new Float32Array(normals).buffer));
const uvBuf = align4(Buffer.from(new Float32Array(uvs).buffer));
const pngBuf = align4(Buffer.from(png));

let offset = 0;
const bvIndex = { byteOffset: offset, byteLength: indexBuf.length }; offset += indexBuf.length;
const bvPos = { byteOffset: offset, byteLength: posBuf.length }; offset += posBuf.length;
const bvNormal = { byteOffset: offset, byteLength: normalBuf.length }; offset += normalBuf.length;
const bvUv = { byteOffset: offset, byteLength: uvBuf.length }; offset += uvBuf.length;
const bvPng = { byteOffset: offset, byteLength: png.length }; offset += pngBuf.length;
const bin = Buffer.concat([indexBuf, posBuf, normalBuf, uvBuf, pngBuf]);

const gltf = {
  asset: { version: '2.0', generator: 'MeshPaint3D sample generator' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'SeamedCubeGLB', mesh: 0 }],
  meshes: [
    {
      name: 'SeamedCubeGLB',
      primitives: [
        {
          attributes: { POSITION: 1, NORMAL: 2, TEXCOORD_0: 3 },
          indices: 0,
          material: 0,
          mode: 4,
        },
      ],
    },
  ],
  materials: [
    {
      name: 'glb_surface',
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        metallicFactor: 0,
        roughnessFactor: 0.85,
      },
    },
  ],
  textures: [{ sampler: 0, source: 0 }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
  images: [
    {
      name: 'checkerboard',
      mimeType: 'image/png',
      bufferView: 4,
    },
  ],
  bufferViews: [
    { ...bvIndex, buffer: 0, target: 34963 },
    { ...bvPos, buffer: 0, target: 34962 },
    { ...bvNormal, buffer: 0, target: 34962 },
    { ...bvUv, buffer: 0, target: 34962 },
    { ...bvPng, buffer: 0 },
  ],
  accessors: [
    {
      bufferView: 0,
      componentType: 5123,
      count: indices.length,
      type: 'SCALAR',
      max: [Math.max(...indices)],
      min: [0],
    },
    {
      bufferView: 1,
      componentType: 5126,
      count: positions.length / 3,
      type: 'VEC3',
      max: [0.5, 0.5, 0.5],
      min: [-0.5, -0.5, -0.5],
    },
    { bufferView: 2, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
    { bufferView: 3, componentType: 5126, count: uvs.length / 2, type: 'VEC2' },
  ],
  buffers: [{ byteLength: bin.length }], // BIN chunk 已 4 字节对齐填充
};

const jsonBuf = alignJson(Buffer.from(JSON.stringify(gltf), 'utf8'));
const glbHeader = Buffer.alloc(12);
glbHeader.writeUInt32LE(0x46546c67, 0); // "glTF"
glbHeader.writeUInt32LE(2, 4);
glbHeader.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonBuf.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(bin.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4); // "BIN\0"

const glb = Buffer.concat([glbHeader, jsonHeader, jsonBuf, binHeader, bin]);
writeFileSync(resolve(outDir, 'seamed-cube.glb'), glb);
console.log('GLB 示例已生成：', resolve(outDir, 'seamed-cube.glb'), `(${glb.length} bytes)`);
