// @ts-check
// Zero-dependency build using Node's built-in TypeScript type stripping.
// Emits one ES module per source file into dist/ and copies static assets.
// Requires Node >= 22.13 (Node 24 recommended).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const outDir = path.join(root, 'dist');

async function collect(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await collect(p, out);
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  if (typeof nodeModule.stripTypeScriptTypes !== 'function') {
    console.error('Node lacks module.stripTypeScriptTypes. Please use Node >= 22.13 (24.x recommended).');
    process.exitCode = 1;
    return;
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const files = (await collect(srcDir)).sort();
  let bytes = 0;
  for (const file of files) {
    const rel = path.relative(srcDir, file).replace(/\.ts$/, '.js');
    const source = await fs.readFile(file, 'utf8');
    const js = nodeModule.stripTypeScriptTypes(source, { mode: 'strip' });
    const dest = path.join(outDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, js, 'utf8');
    bytes += js.length;
  }

  for (const file of ['index.html', 'styles.css']) {
    await fs.copyFile(path.join(root, file), path.join(outDir, file));
  }

  console.log(
    `built ${files.length} modules (${(bytes / 1024).toFixed(1)} kB) into dist/ in ${Date.now() - t0}ms`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
