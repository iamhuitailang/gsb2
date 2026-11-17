import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPositiveInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

function readBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no'].includes(String(value).toLowerCase());
}

/**
 * 配置合并：显式传入的 overrides 优先于环境变量，环境变量优先于内置默认值。
 * 只有这样测试才能完全绕开宿主机的环境变量。
 */
export function resolveConfig(overrides = {}) {
  const fromEnv = (key, read) => (key in overrides ? overrides[key] : read());

  const config = {
    host: fromEnv('host', () => process.env.HOST || '127.0.0.1'),
    port: fromEnv('port', () => readPositiveInt(process.env.PORT, 3210, 'PORT')),
    stateFile: fromEnv('stateFile', () => process.env.STATE_FILE || path.join(ROOT, 'data', 'state.json')),
    adminLogFile: fromEnv(
      'adminLogFile',
      () => process.env.ADMIN_LOG_FILE || path.join(ROOT, 'data', 'admin.log'),
    ),
    accountLimit: fromEnv(
      'accountLimit',
      () => readPositiveInt(process.env.ACCOUNT_LIMIT, 3, 'ACCOUNT_LIMIT'),
    ),
    accountWindowMs: fromEnv(
      'accountWindowMs',
      () => readPositiveInt(process.env.ACCOUNT_WINDOW_MS, 15 * 60 * 1000, 'ACCOUNT_WINDOW_MS'),
    ),
    sourceLimit: fromEnv(
      'sourceLimit',
      () => readPositiveInt(process.env.SOURCE_LIMIT, 5, 'SOURCE_LIMIT'),
    ),
    sourceWindowMs: fromEnv(
      'sourceWindowMs',
      () => readPositiveInt(process.env.SOURCE_WINDOW_MS, 15 * 60 * 1000, 'SOURCE_WINDOW_MS'),
    ),
    demoEnabled: fromEnv('demoEnabled', () => readBool(process.env.DEMO_MODE, true) &&
      process.env.NODE_ENV !== 'production'),
    // 演示账号。生产环境应替换为用户库中的口令哈希。
    users: fromEnv('users', () => ({
      jia: 'jia-demo-2026',
      yi: 'yi-demo-2026',
      bing: 'bing-demo-2026',
    })),
  };

  for (const key of ['accountLimit', 'sourceLimit', 'accountWindowMs', 'sourceWindowMs']) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) {
      throw new Error(`${key} 必须是正整数`);
    }
  }
  if (!Number.isInteger(config.port) || config.port < 0) {
    throw new Error('port 必须是非负整数');
  }
  return config;
}
