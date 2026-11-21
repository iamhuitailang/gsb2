/**
 * 零依赖测试运行器：跑 tests/*.test.js，汇总通过/失败并设置退出码。
 * 用法：node scripts/check.mjs
 */
import { run } from 'node:test';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const dir = resolve(fileURLToPath(new URL('../tests', import.meta.url)));
const files = (await readdir(dir))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => resolve(dir, name));

let passed = 0;
let failed = 0;
const failures = [];
const startedAt = Date.now();

const stream = run({ files, concurrency: 1 });

for await (const event of stream) {
  if (event.type === 'test:pass') {
    if (event.data.skip || event.data.todo) continue;
    passed += 1;
    process.stdout.write(`  ✓ ${event.data.name}\n`);
  } else if (event.type === 'test:fail') {
    failed += 1;
    failures.push(event.data);
    process.stdout.write(`  ✗ ${event.data.name}\n`);
  }
}

for (const data of failures) {
  const error = data.details?.error;
  process.stdout.write(`\n✗ ${data.name}\n`);
  if (error) {
    const message = typeof error === 'string' ? error : error.stack || error.message || String(error);
    process.stdout.write(`${message}\n`);
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(2);
process.stdout.write(`\n${passed} 通过，${failed} 失败（${seconds}s）\n`);
if (failed > 0) process.exitCode = 1;
