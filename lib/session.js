import { randomBytes } from 'node:crypto';

/**
 * 服务端会话。会话本身只保存客服/客户的登录身份（userId），
 * 代办上下文单独挂在 session.delegation 上，退出代办时整段删除，
 * 绝不把客户身份写进 userId。
 */
export class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  create() {
    const session = {
      id: randomBytes(24).toString('hex'),
      csrf: randomBytes(18).toString('hex'),
      userId: null,
      delegation: null,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(sid) {
    return sid ? this.sessions.get(sid) ?? null : null;
  }

  /**
   * 登录时换发新的会话 ID（防会话固定）。旧会话里的代办上下文一并丢弃，
   * 新会话只带登录身份，绝无任何客户身份残留。
   */
  rotate(oldSid, userId) {
    if (oldSid) this.sessions.delete(oldSid);
    const session = this.create();
    session.userId = userId;
    return session;
  }

  destroy(sid) {
    if (sid) this.sessions.delete(sid);
  }
}
