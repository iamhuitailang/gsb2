import { spawn } from 'node:child_process';

/** 依次运行各测试文件，任一失败则整体失败。 */
const files = ['test/sanitize.test.mjs', 'test/unit.test.mjs', 'test/e2e.mjs'];
const extra = process.argv.slice(2);

let failed = false;
for (const file of files) {
  const child = spawn(process.execPath, ['--test', file, ...extra], { stdio: 'inherit' });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (code !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
