import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PENDING_TTL_MS = 10 * 60 * 1000; // 待确认登录 10 分钟有效
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 正式会话 12 小时

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

// 所有会话/确认令牌在磁盘上只存哈希，原始值只存在 cookie 或确认链接里
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 64).toString('hex');
}

function emptyState() {
  return { users: [], pendingLogins: [], sessions: [], messages: [], seq: 1 };
}

export class Store {
  constructor(file, state) {
    this.file = file;
    this.state = state;
    this._timer = null;
  }

  static async load(file) {
    let state;
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      state = emptyState();
    }
    return new Store(file, state);
  }

  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  // 防抖落盘；进程退出时再 flush 一次
  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch(() => {});
    }, 200);
  }

  nextId(prefix) {
    return `${prefix}_${this.state.seq++}`;
  }

  // ---- 用户 ----

  findUserByName(name) {
    return this.state.users.find((u) => u.username === name);
  }

  getUser(id) {
    return this.state.users.find((u) => u.id === id);
  }

  createUser(username, password) {
    const salt = randomBytes(16).toString('hex');
    const user = {
      id: this.nextId('u'),
      username,
      passwordSalt: salt,
      passwordHash: hashPassword(password, salt),
      devices: [],
    };
    this.state.users.push(user);
    return user;
  }

  verifyPassword(user, password) {
    const a = Buffer.from(hashPassword(password, user.passwordSalt), 'hex');
    const b = Buffer.from(user.passwordHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---- 设备（浏览器）----

  findDevice(user, deviceId) {
    return user.devices.find((d) => d.id === deviceId);
  }

  registerDevice(user, { id, name }) {
    const now = Date.now();
    const device = {
      id,
      name,
      trusted: false,
      trustedAt: null,
      createdAt: now,
      lastActiveAt: now,
    };
    user.devices.push(device);
    return device;
  }

  // ---- 待确认登录 ----

  createPendingLogin({ user, device, remember }) {
    // 同一浏览器此前若有等待中的登录，立即作废——链接只对应发起它的那次登录
    for (const p of this.state.pendingLogins) {
      if (p.userId === user.id && p.deviceId === device.id && p.status === 'waiting') {
        p.status = 'superseded';
      }
    }
    const psRaw = randomToken();
    const confirmRaw = randomToken();
    const now = Date.now();
    const rec = {
      id: this.nextId('pl'),
      userId: user.id,
      deviceId: device.id,
      remember: Boolean(remember),
      psTokenHash: hashToken(psRaw),
      confirmTokenHash: hashToken(confirmRaw),
      status: 'waiting', // waiting -> confirmed / superseded / expired
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
      confirmedAt: null,
    };
    this.state.pendingLogins.push(rec);
    return { rec, psRaw, confirmRaw };
  }

  // ---- 正式会话 ----

  createSession(user, device) {
    const raw = randomToken();
    const now = Date.now();
    const rec = {
      tokenHash: hashToken(raw),
      userId: user.id,
      deviceId: device.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.state.sessions.push(rec);
    return { raw, rec };
  }

  // ---- 模拟收件箱（站内消息即“邮件”，里面带原始确认链接）----

  addMessage(user, pending) {
    const msg = {
      id: this.nextId('m'),
      userId: user.id,
      pendingLoginId: pending.rec.id,
      subject: `设备确认：${user.username} 账号的新登录`,
      link: `/login/confirm?token=${pending.confirmRaw}`,
      read: false,
      createdAt: Date.now(),
    };
    this.state.messages.push(msg);
    return msg;
  }

  messagesForUser(userId) {
    return this.state.messages
      .filter((m) => m.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  markMessageRead(id, userId) {
    const msg = this.state.messages.find((m) => m.id === id && m.userId === userId);
    if (msg) msg.read = true;
    return Boolean(msg);
  }
}
