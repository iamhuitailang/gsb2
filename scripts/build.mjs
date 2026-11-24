#!/usr/bin/env node
/**
 * 无依赖构建：用 Node 内置的 TypeScript 类型擦除把 src/ 转成浏览器可运行的 ES 模块。
 * 只做类型擦除 + 把 import 的 .ts 后缀改写为 .js，不引入打包器。
 */
import { stripTypeScriptTypes } from 'node:module';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const publicDir = join(root, 'public');
const outDir = join(root, 'dist');

/** 递归列出目录下的 .ts 文件。 */
async function listTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listTsFiles(full)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

function rewriteSpecifiers(code) {
  return code.replace(/(\bfrom\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3').replace(
    /(\bimport\s*\(\s*['"])(\.[^'"]+)\.ts(['"]\s*\))/g,
    '$1$2.js$3',
  );
}

async function build() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const files = await listTsFiles(srcDir);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    let js;
    try {
      js = stripTypeScriptTypes(source, { mode: 'strip' });
    } catch (error) {
      throw new Error(`类型擦除失败 ${relative(root, file)}: ${error instanceof Error ? error.message : error}`);
    }
    const output = rewriteSpecifiers(js);
    const rel = relative(srcDir, file).replace(/\.ts$/, '.js');
    const target = join(outDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output);
  }

  await cp(publicDir, outDir, { recursive: true });

  const index = await readFile(join(outDir, 'index.html'), 'utf8');
  if (!index.includes('./app/main.js')) {
    throw new Error('index.html 必须引用 ./app/main.js');
  }
  const leftovers = [];
  for (const file of files) {
    const rel = relative(srcDir, file).replace(/\.ts$/, '.js');
    const code = await readFile(join(outDir, rel), 'utf8');
    if (/from\s+['"]\.[^'"]+\.ts['"]/.test(code)) leftovers.push(rel);
  }
  if (leftovers.length) throw new Error(`仍有未改写的 .ts 导入: ${leftovers.join(', ')}`);

  console.log(`构建完成: ${files.length} 个模块 -> ${relative(root, outDir)}/`);
  console.log(`运行: npm run dev  或  用静态服务器打开 ${relative(root, outDir)}/index.html`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
