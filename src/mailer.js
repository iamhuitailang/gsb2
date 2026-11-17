// 项目自带的“收件箱”：不连接真实 SMTP，邮件直接写到本地数据，
// 在 /inbox 页面查看。演示链接随邮件一并展示，方便本地点击。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MAIL_FILE = path.join(DATA_DIR, 'mailbox.json');

let mailbox = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(MAIL_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MAIL_FILE, JSON.stringify(mailbox, null, 2));
}

/**
 * 发送一封密码重置邮件。
 * @param {string} to 收件邮箱
 * @param {string} resetUrl 含明文令牌的完整重置链接（仅存在于“邮件”中）
 */
export function sendPasswordResetMail(to, resetUrl) {
  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    to,
    subject: '重置你的密码',
    body: '我们收到了重置你账号密码的申请。请点击下面的链接设置新密码，链接仅在有效期内可用，且只能使用一次。',
    resetUrl,
    sentAt: new Date().toISOString(),
  };
  mailbox.unshift(message);
  persist();
  return message;
}

export function listMails() {
  return [...mailbox];
}
