#!/usr/bin/env node
/**
 * Generate the bundled sample images into public/samples/.
 * Deterministic output: re-running produces identical files.
 *
 * Importable (`generateSamples`) so the dev server and the test suite can
 * ensure the assets exist without shelling out.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePng } from './lib/raster.mjs';
import {
  SCENES,
  renderSceneVersion,
  sceneAlignment,
  sceneCornerPoints,
} from './lib/scenes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const outRoot = join(repoRoot, 'public', 'samples');

export async function generateSamples({ quiet = false } = {}) {
  const manifest = {
    name: 'Verso 示例素材',
    generatedAt: '2026-03-20T09:00:00.000Z',
    note: '示例图片均由脚本本地生成，可用于演示尺寸差异、局部改动与角点配准。',
    scenes: [],
  };

  for (const scene of SCENES) {
    const dir = join(outRoot, scene.id);
    await mkdir(dir, { recursive: true });
    const a = renderSceneVersion(scene, 'a');
    const b = renderSceneVersion(scene, 'b');
    await writeFile(join(dir, 'a.png'), encodePng(a));
    await writeFile(join(dir, 'b.png'), encodePng(b));

    manifest.scenes.push({
      id: scene.id,
      title: scene.title,
      description: scene.description,
      changes: scene.changes,
      design: scene.design,
      recommendedAlignment: sceneAlignment(scene),
      cornerPoints: sceneCornerPoints(scene),
      a: {
        file: `samples/${scene.id}/a.png`,
        name: `${scene.title} · A`,
        version: scene.a.version,
        width: scene.a.width,
        height: scene.a.height,
      },
      b: {
        file: `samples/${scene.id}/b.png`,
        name: `${scene.title} · B`,
        version: scene.b.version,
        width: scene.b.width,
        height: scene.b.height,
      },
    });
    if (!quiet) {
      console.log(`✓ ${scene.id}: A ${a.width}×${a.height}, B ${b.width}×${b.height}`);
    }
  }

  await writeFile(
    join(outRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (!quiet) console.log(`示例素材已写入 ${outRoot}`);
  return { manifest, outRoot };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  generateSamples().catch((error) => {
    console.error('生成示例素材失败：', error);
    process.exitCode = 1;
  });
}
