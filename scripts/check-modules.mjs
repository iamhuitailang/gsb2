/** 语法检查：对 src / scripts / test 中的每个 JS 文件运行 node --check（不执行模块）。 */
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dirs = [
  fileURLToPath(new URL('../src/', import.meta.url)),
  fileURLToPath(new URL('../scripts/', import.meta.url)),
  fileURLToPath(new URL('../test/', import.meta.url)),
];

let failures = 0;
let checked = 0;
for (const dir of dirs) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  } catch {
    continue;
  }
  for (const file of files) {
    const path = join(dir, file);
    checked++;
    try {
      // 跳过自身，避免无意义地检查检查器。
      if (file === 'check-modules.mjs') continue;
      execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    } catch (err) {
      failures++;
      console.error(`FAIL ${file}`);
      console.error(String(err.stderr || err.message));
    }
  }
}
console.log(`语法检查：${checked} 个文件，${failures} 个失败`);
process.exit(failures ? 1 : 0);
