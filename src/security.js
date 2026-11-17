import { hashToken, PENDING_TTL_MS } from './store.js';
import { parseCookies } from './http.js';

// 把一次请求解析成三种身份之一：
//   { mode: 'session', ... } 已确认的正式会话
//   { mode: 'pending', ... } 密码正确、等待设备确认（只能访问等待页）
//   { mode: 'anonymous' }
export function resolveAuth(store, req) {
  const cookies = parseCookies(req);
  const now = Date.now();
  const sToken = cookies.sid;
  if (sToken) {
    const rec = store.state.sessions.find(
      (s) => s.tokenHash === hashToken(sToken) && s.expiresAt > now
    );
    if (rec) {
      const user = store.getUser(rec.userId);
      const device = user && user.devices.find((d) => d.id === rec.deviceId);
      if (user && device) {
        rec.lastSeenAt = now;
        device.lastActiveAt = now;
        store.save();
        return { mode: 'session', user, device, session: rec };
      }
    }
  }

  const psToken = cookies.psid;
  if (psToken) {
    const rec = store.state.pendingLogins.find(
      (p) => p.psTokenHash === hashToken(psToken) && p.status === 'waiting'
    );
    if (rec && rec.expiresAt <= now) {
      rec.status = 'expired';
      store.save();
    } else if (rec) {
      const user = store.getUser(rec.userId);
      const device = user && user.devices.find((d) => d.id === rec.deviceId);
      // psid 必须与浏览器 did 对得上，否则视为无效
      if (user && device && cookies.did === device.id) {
        device.lastActiveAt = now;
        store.save();
        return { mode: 'pending', user, device, pending: rec };
      }
    }
  }

  return { mode: 'anonymous' };
}

// 确认链接的有效期与待确认登录一致（10 分钟）
export function pendingIsFresh(rec, now = Date.now()) {
  return rec.status === 'waiting' && rec.expiresAt > now;
}

export { PENDING_TTL_MS };
