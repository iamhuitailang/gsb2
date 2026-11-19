#!/usr/bin/env node
/**
 * 生成示例资源说明。
 *
 * 本项目所有粒子贴图都由 Canvas 程序化生成（见 src/render/textures.ts），
 * 这里额外生成两份可直接载入的示例工程文件，便于在不启动页面的情况下
 * 检查/演示工程格式，也方便游戏侧做数据比对。
 *
 * 运行：npm run generate:samples
 * 产物：public/samples/spark.particle.json、smoke.particle.json
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPresetProject } from '../src/core/presets.ts';
import { serializeProject } from '../src/core/serialization.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'samples');

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const id of ['spark', 'smoke']) {
    const project = createPresetProject(id);
    const text = serializeProject(project);
    const file = join(outDir, `${id}.particle.json`);
    await writeFile(file, text, 'utf8');
    console.log(`已生成 ${file}（${project.emitters.length} 个发射器）`);
  }
}

main().catch((error) => {
  console.error('生成示例失败：', error);
  process.exitCode = 1;
});
