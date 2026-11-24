// 生成两张示例法线纹理的 PPM 快照到 public/samples/，方便不打开浏览器时检查原始字节。
// 运行：npm run generate:samples （Node 24 原生 strip-types，无需额外依赖）
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTexture } from '../src/core/textures.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'samples');
mkdirSync(outDir, { recursive: true });

function writePPM(filename: string, rgba: Uint8ClampedArray, size: number): void {
  const header = Buffer.from(`P6\n${size} ${size}\n255\n`, 'ascii');
  const body = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    body[i * 3] = rgba[i * 4];
    body[i * 3 + 1] = rgba[i * 4 + 1];
    body[i * 3 + 2] = rgba[i * 4 + 2];
  }
  writeFileSync(resolve(outDir, filename), Buffer.concat([header, body]));
  console.log('written', filename);
}

const size = 128;
const flat = generateTexture('flat', size);
const dir = generateTexture('directional', size);
writePPM('normal-flat-opengl.ppm', flat.rgba, size);
writePPM('normal-directional-opengl.ppm', dir.rgba, size);

// DirectX 约定快照：仅翻绿，用于对照两种约定的字节差异
const dx = new Uint8ClampedArray(dir.rgba);
for (let i = 0; i < size * size; i++) {
  dx[i * 4 + 1] = 255 - dx[i * 4 + 1];
}
writePPM('normal-directional-directx-greenflip.ppm', dx, size);
console.log('samples ->', outDir);
