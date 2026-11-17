import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 32;

/**
 * 演示用的口令校验器。
 *
 * 账号来自配置；真实部署应替换成数据库查询。未知账号也会执行一次哈希，
 * 让“账号不存在”和“密码错误”在耗时上不可区分。
 */
export class PasswordVerifier {
  constructor(users) {
    this.users = new Map();
    this.dummySalt = crypto.randomBytes(16);
    // 预计算一次哑哈希，让“账号不存在”也走同样耗时的比较路径。
    this.dummyHash = hashPassword('dummy-password', this.dummySalt);
    for (const [name, password] of Object.entries(users ?? {})) {
      const salt = crypto.randomBytes(16);
      this.users.set(normalizeName(name), { salt, hash: hashPassword(password, salt) });
    }
  }

  verify(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string') return false;
    const record = this.users.get(normalizeName(username)) ?? {
      salt: this.dummySalt,
      hash: this.dummyHash,
    };
    const candidate = hashPassword(password, record.salt);
    const matches = crypto.timingSafeEqual(candidate, record.hash);
    // 账号不存在时即使哈希巧合相等也返回失败。
    return matches && this.users.has(normalizeName(username));
  }
}

export function normalizeName(name) {
  return String(name).trim().toLowerCase();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: 1024, r: 8, p: 1 });
}
