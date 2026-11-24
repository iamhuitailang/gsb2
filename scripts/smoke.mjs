// 校验：所有浏览器模块做语法解析；不依赖 DOM 的模块再实际 import 一次。
// 用法：node scripts/smoke.mjs

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const browserOnly = ['main.js', 'chart.js', 'map2d.js', 'render3d.js'];

for (const file of browserOnly) {
  execFileSync(process.execPath, ['--check', `js/${file}`], { stdio: 'inherit' });
  console.log(`syntax ok: ${file}`);
}

for (const file of ['util.js', 'config.js', 'model.js', 'solver.js']) {
  const mod = await import(`../js/${file}`);
  console.log(`import ok: ${file} (${Object.keys(mod).length} exports)`);
}

const source = await readFile('js/render3d.js', 'utf8');
if (!source.includes('export function drawScene')) throw new Error('drawScene missing');
console.log('render3d exports drawScene');
