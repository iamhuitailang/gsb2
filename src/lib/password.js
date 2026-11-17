'use strict';

// 本地演示用密码哈希：scrypt + 每用户随机盐。仅用于演示，不接外部系统。
const { scryptSync, randomBytes, timingSafeEqual } = require('node:crypto');

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const digest = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPassword(password, stored) {
  const [salt, digest] = String(stored).split(':');
  if (!salt || !digest) return false;
  const actual = scryptSync(String(password), salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };
