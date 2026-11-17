// 应用日志：密码恢复相关事件只记录“时刻 + 结果”，
// 不记录邮箱、令牌、用户 ID 等任何可用于推断账号是否存在的信息。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

function write(event, result) {
  const entry = {
    time: new Date().toISOString(),
    event,
    result,
  };
  const line = JSON.stringify(entry);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `${line}\n`);
  console.log(line);
}

export const logger = {
  // 忘记密码申请：无论邮箱是否注册，结果统一记 accepted
  resetRequest() {
    write('password_reset_request', 'accepted');
  },
  // 重置落地结果：success（密码已更新）或 invalid（链接无效/过期/用过）
  resetComplete(result) {
    write('password_reset_complete', result);
  },
};
