/**
 * 本地测试入口：等价于 node --test，但显式指定文件，
 * 兼容不同 Node 版本对目录扫描的差异。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'tests/project.test.js',
  'tests/state.test.js',
  'tests/export.test.js',
  'tests/player.test.js',
];
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: '' },
});
process.exit(result.status ?? 1);
