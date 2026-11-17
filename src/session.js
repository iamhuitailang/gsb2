import { randomToken } from './util.js';

const COOKIE_NAME = 'gsb_session';

/**
 * 业务页的会话只认发给业务源的 cookie。
 * 报告站点是另一个源，浏览器的同源策略 + cookie 的 host 绑定使报告页拿不到它；
 * 业务侧再对 /api/* 做 Sec-Fetch-Site / Origin 校验，作为第二道防线。
 */
export class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.account = {
      userId: 'u_1024',
      displayName: '林晓',
      role: '采购专员',
      department: '华东采购中心',
      // 故意放一个只应在业务页可见的内部标识，便于验证隔离。
      internalRef: 'biz-internal-7f3a',
    };
    this.crossSiteAttempts = [];
  }

  parseCookie(header = '') {
    for (const part of header.split(';')) {
      const [rawName, ...rest] = part.trim().split('=');
      if (rawName === COOKIE_NAME) return rest.join('=');
    }
    return null;
  }

  /** 取当前会话；不存在则新建。返回 { session, created }。 */
  ensure(req) {
    const token = this.parseCookie(req.headers.cookie);
    if (token) {
      const session = this.sessions.get(token);
      if (session) {
        session.lastSeenAt = new Date().toISOString();
        session.requests += 1;
        return { session, created: false };
      }
    }
    const newToken = randomToken();
    const now = new Date().toISOString();
    const session = {
      token: newToken,
      publicId: `sess_${newToken.slice(0, 8)}`,
      account: this.account,
      createdAt: now,
      lastSeenAt: now,
      requests: 1,
      actions: [],
    };
    this.sessions.set(newToken, session);
    return { session, created: true };
  }

  cookieHeader(token) {
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax`;
  }

  recordCrossSite(entry) {
    this.crossSiteAttempts.push(entry);
    if (this.crossSiteAttempts.length > 50) this.crossSiteAttempts.shift();
  }

  publicView(session) {
    return {
      id: session.publicId,
      account: {
        displayName: session.account.displayName,
        role: session.account.role,
        department: session.account.department,
      },
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      requests: session.requests,
      actionCount: session.actions.length,
      lastAction: session.actions.at(-1) ?? null,
    };
  }
}
