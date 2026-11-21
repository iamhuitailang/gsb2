#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSamples } from './generate-samples.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const manifest = join(repoRoot, 'public', 'samples', 'manifest.json');

try {
  await access(manifest);
} catch {
  console.log('示例素材缺失，正在生成…');
  await generateSamples();
}
