import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const results = [];
function run(label, args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180000 });
  results.push({ label, status: result.status, stdout: result.stdout, stderr: result.stderr });
}

const cwd = process.cwd();
const wavPath = path.join(cwd, 'public', 'samples', 'demo-interview.wav');
if (!fs.existsSync(wavPath)) {
  run('generate-samples', ['scripts/generate-samples.mjs'], cwd);
}
const testFiles = fs
  .readdirSync('tests')
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => `tests/${name}`);
run('tests', ['--test', ...testFiles], cwd);

for (const item of results) {
  console.log(`\n===== ${item.label} (exit ${item.status}) =====`);
  if (item.stdout) console.log(item.stdout.trim());
  if (item.stderr) console.error(item.stderr.trim());
}
const failed = results.some((item) => item.status !== 0);
if (failed) {
  console.error('\n验证失败：请查看上面的用例输出。');
} else {
  console.log('\n验证通过：示例生成与全部核心逻辑测试均正常。');
}
process.exit(failed ? 1 : 0);
