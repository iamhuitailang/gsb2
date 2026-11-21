/**
 * 生成示例素材：渐变、细线、透明边缘、像素风角色。
 * 图像定义在 src/samples.js 里，浏览器与 Node 共用同一份。
 *
 *   npm run generate:samples
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeRgbaPng } from '../src/png.js';
import { SAMPLE_DEFINITIONS, sampleManifest } from '../src/samples.js';

const outDir = fileURLToPath(new URL('../samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });

for (const def of SAMPLE_DEFINITIONS) {
  const image = def.build();
  const bytes = await encodeRgbaPng(image.rgba, image.width, image.height);
  writeFileSync(join(outDir, def.file), bytes);
  console.log(`写出 ${def.file}（${image.width}×${image.height}，${bytes.length} 字节）`);
}

writeFileSync(join(outDir, 'samples.json'), JSON.stringify(sampleManifest(), null, 2) + '\n');
console.log('写出 samples.json');
