import crypto from 'node:crypto';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function randomToken(prefix = '') {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

export function randomId(prefix = '') {
  return prefix + crypto.randomBytes(12).toString('hex');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// 定长比较，避免根据长度/内容泄露时序信息。
export function safeEqual(a, b) {
  const left = Buffer.from(sha256(a), 'hex');
  const right = Buffer.from(sha256(b), 'hex');
  return crypto.timingSafeEqual(left, right);
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  return safeEqual(hashPassword(password, salt).hash, expectedHash);
}

export function hashSecret(secret, salt) {
  return sha256(`${salt}:${secret}`);
}

export function verifySecret(secret, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  return safeEqual(hashSecret(secret, salt), expectedHash);
}

export function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function isValidPkceVerifier(verifier) {
  return typeof verifier === 'string' && verifier.length >= 43 && verifier.length <= 128 && BASE64URL.test(verifier);
}

export function isValidPkceChallenge(challenge) {
  return typeof challenge === 'string' && /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return parts.join('; ');
}

export function isSubset(candidate, container) {
  return candidate.every((item) => container.includes(item));
}

export function intersection(a, b) {
  return a.filter((item) => b.includes(item));
}

export function unique(list) {
  return [...new Set(list)];
}

export function normalizeScopes(input) {
  // 支持空格分隔字符串或数组，去重并保持稳定顺序
  const raw = Array.isArray(input) ? input : String(input || '').split(/\s+/);
  return unique(raw.map((s) => s.trim()).filter(Boolean)).sort();
}
