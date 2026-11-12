import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 全部默认值均指向本机，不包含任何外部地址
export const config = {
  port: Number(process.env.PORT) || 3210,
  host: process.env.HOST || '127.0.0.1',
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(__dirname, '../data'),
  dbFile: process.env.DB_FILE || null, // 为空时在 dataDir 下生成，见下方
  screenshotDir: process.env.SCREENSHOT_DIR || null,
  // RPA 浏览器：默认有头，便于观察录入过程；CI/冒烟测试用 HEADLESS=1
  headless: process.env.HEADLESS === '1',
  // 每条录入之间的人工节奏（毫秒），方便观察进度
  stepDelay: Number(process.env.STEP_DELAY) || 350,
  // 找不到 Playwright 自带 chromium 时，回退到系统 Chrome（macOS 默认安装路径）
  fallbackChromePath:
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};

config.dbFile ||= path.join(config.dataDir, 'rpa.db');
config.screenshotDir ||= path.join(config.dataDir, 'screenshots');

export function mockBaseUrl() {
  return `http://${config.host}:${config.port}/mock`;
}
