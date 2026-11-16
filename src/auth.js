import { randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'gsb2_sid';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  create(userId) {
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, {
      userId,
      csrf: randomBytes(18).toString('base64url'),
      flash: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return token;
  }

  get(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  destroy(token) {
    if (token) this.sessions.delete(token);
  }

  setFlash(session, type, text) {
    if (session) session.flash = { type, text };
  }

  takeFlash(session) {
    if (!session?.flash) return null;
    const flash = session.flash;
    session.flash = null;
    return flash;
  }
}

export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function sessionCookie(token, { secure = false, maxAgeSeconds = SESSION_TTL_MS / 1000 } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie({ secure = false } = {}) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
