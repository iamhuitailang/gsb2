// 密码哈希、随机令牌、哈希存储等基础安全能力，全部基于 node:crypto，无外部依赖。
import crypto from 'node:crypto';

/**
 * 生成密码存储串：scrypt + 每用户独立盐
 * 格式：scrypt$<salt>$<hash>
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/** 常量时间校验密码，避免通过比较耗时猜测哈希内容 */
export function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHash] = parts;
  const keyBuf = crypto.scryptSync(String(password), salt, 64);
  const hashBuf = Buffer.from(expectedHash, 'hex');
  return keyBuf.length === hashBuf.length && crypto.timingSafeEqual(keyBuf, hashBuf);
}

/**
 * 邮箱不存在等分支也跑一次相同强度的 scrypt，
 * 让“注册 / 未注册”两条路径的响应耗时基本一致，防止时序枚举。
 */
export function dummyVerify() {
  crypto.scryptSync('dummy-password', 'fixed-dummy-salt', 64);
}

/** 生成随机令牌（会话 ID、重置令牌） */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 令牌只以 SHA-256 摘要形式落盘，明文只出现在邮件链接里 */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
