import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

// 极简签名 Cookie 会话。本地工具，够用即可；不存任何权限信息，
// 会话里只有 userId，权限每次都回数据库查。

const COOKIE = 'sid';

export function createSessions({ secret, ttlMs = 12 * 3600 * 1000 }) {
  const sessions = new Map();
  // 启动时清理 + 简单节流
  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.expiresAt <= now) sessions.delete(id);
  }, 5 * 60 * 1000).unref();

  function sign(id) {
    return createHmac('sha256', secret).update(id).digest('base64url');
  }

  return {
    cookieName: COOKIE,
    issue(userId) {
      const id = randomUUID();
      sessions.set(id, { userId, expiresAt: Date.now() + ttlMs });
      return `${id}.${sign(id)}`;
    },
    resolve(cookieValue) {
      if (!cookieValue) return null;
      const [id, sig] = String(cookieValue).split('.');
      if (!id || !sig) return null;
      const expected = Buffer.from(sign(id));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      const s = sessions.get(id);
      if (!s || s.expiresAt <= Date.now()) return null;
      return s.userId;
    },
    revoke(cookieValue) {
      const [id, sig] = String(cookieValue ?? '').split('.');
      if (id && sig) sessions.delete(id);
    },
    cookieHeader(token) {
      return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}`;
    },
    clearHeader() {
      return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
    },
  };
}
