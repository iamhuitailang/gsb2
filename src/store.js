// 本地 JSON 文件持久化：账号、会话、待确认登录、可信设备、内置收件箱
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 待确认登录 / 会话的有效期
export const PENDING_TTL_MS = 15 * 60 * 1000; // 确认链接 15 分钟内有效
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 正式会话 7 天

// 演示用的值班数据
const DEFAULT_ROSTER = [
  { date: '2026-11-16', day: '周一', primary: '张倩', backup: '李雷', phone: '138-0000-0001' },
  { date: '2026-11-17', day: '周二', primary: '王芳', backup: '韩梅梅', phone: '138-0000-0002' },
  { date: '2026-11-18', day: '周三', primary: '李雷', backup: '张倩', phone: '138-0000-0003' },
  { date: '2026-11-19', day: '周四', primary: '韩梅梅', backup: '王芳', phone: '138-0000-0004' },
  { date: '2026-11-20', day: '周五', primary: '张倩', backup: '李雷', phone: '138-0000-0005' },
];

// 令牌只以 SHA-256 哈希形式落盘，原始值仅存在浏览器 cookie 或邮件链接里
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(password, salt, 32).toString('hex');
  return { salt, derived };
}

function verifyPassword(password, record) {
  const derived = scryptSync(password, record.salt, 32);
  const stored = Buffer.from(record.derived, 'hex');
  return derived.length === stored.length && timingSafeEqual(derived, stored);
}

export function newToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'db.json');
    this.data = {
      user: null,
      sessions: {},   // sidHash -> { id, username, deviceId, createdAt, lastAt, expiresAt }
      pendings: {},   // pendingTokenHash -> { id, username, browserKeyHash, remember, createdAt, expiresAt, confirmed }
      devices: {},    // deviceId -> { id, username, name, deviceTokenHash, createdAt, lastAt }
      messages: [],   // 内置收件箱
      roster: DEFAULT_ROSTER,
    };
    mkdirSync(dataDir, { recursive: true });
    this.#load();
  }

  #load() {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...this.data, ...parsed };
    } catch {
      // 首次运行：初始化演示账号 admin / duty-2026
      const { salt, derived } = hashPassword('duty-2026');
      this.data.user = { username: 'admin', salt, derived };
      this.save();
    }
  }

  // 先写临时文件再重命名，避免写到一半进程退出导致数据损坏
  save() {
    const tmp = join(this.dataDir, `.db.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  verifyLogin(username, password) {
    const user = this.data.user;
    if (!user || username !== user.username) return false;
    return verifyPassword(password, user);
  }

  // ---- 可信设备 ----

  findDeviceByToken(deviceToken) {
    const tokenHash = hashToken(deviceToken);
    return Object.values(this.data.devices).find((d) => d.deviceTokenHash === tokenHash) || null;
  }

  getDevice(id) {
    return this.data.devices[id] || null;
  }

  listDevices(username) {
    return Object.values(this.data.devices)
      .filter((d) => d.username === username)
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  createDevice({ username, name, deviceToken }) {
    const id = newToken(12);
    const now = Date.now();
    this.data.devices[id] = {
      id,
      username,
      name: name || `设备 ${id.slice(0, 6)}`,
      deviceTokenHash: hashToken(deviceToken),
      createdAt: now,
      lastAt: now,
    };
    this.save();
    return this.data.devices[id];
  }

  touchDevice(id) {
    const device = this.data.devices[id];
    if (device) {
      device.lastAt = Date.now();
      this.save();
    }
  }

  revokeDevice(id, username) {
    const device = this.data.devices[id];
    if (!device || device.username !== username) return false;
    delete this.data.devices[id];
    this.save();
    return true;
  }

  // ---- 待确认登录（密码正确、设备未记住） ----

  createPending({ username, browserKey, remember, name }) {
    const id = newToken(12);
    const now = Date.now();
    const record = {
      id,
      username,
      name: name || '',
      browserKeyHash: hashToken(browserKey),
      remember,
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
      confirmed: false,
    };
    this.data.pendings[hashToken(id)] = record;
    this.save();
    return { id, record };
  }

  getPending(token) {
    const record = this.data.pendings[hashToken(token)];
    if (!record) return null;
    if (record.confirmed || record.expiresAt < Date.now()) return null;
    return record;
  }

  markPendingConfirmed(token) {
    const key = hashToken(token);
    const record = this.data.pendings[key];
    if (record) {
      record.confirmed = true; // 一次性：确认后再次点击链接无效
      delete this.data.pendings[key];
      this.save();
    }
  }

  pruneExpired() {
    const now = Date.now();
    let changed = false;
    for (const [key, p] of Object.entries(this.data.pendings)) {
      if (p.expiresAt < now) {
        delete this.data.pendings[key];
        changed = true;
      }
    }
    for (const [key, s] of Object.entries(this.data.sessions)) {
      if (s.expiresAt < now) {
        delete this.data.sessions[key];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // ---- 正式会话（确认通过后才生成） ----

  createSession({ username, deviceId }) {
    const sid = newToken(32);
    const now = Date.now();
    const record = {
      id: newToken(12),
      username,
      deviceId: deviceId || null,
      createdAt: now,
      lastAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.data.sessions[hashToken(sid)] = record;
    this.save();
    return { sid, record };
  }

  getSession(sid) {
    const record = this.data.sessions[hashToken(sid)];
    if (!record || record.expiresAt < Date.now()) return null;
    return record;
  }

  touchSession(sid) {
    const record = this.getSession(sid);
    if (record) {
      record.lastAt = Date.now();
      this.save();
    }
  }

  destroySession(sid) {
    delete this.data.sessions[hashToken(sid)];
    this.save();
  }

  // ---- 内置收件箱 ----

  addMessage({ to, subject, html, text }) {
    const msg = {
      id: newToken(8),
      to,
      subject,
      html,
      text,
      createdAt: Date.now(),
    };
    this.data.messages.unshift(msg);
    this.save();
    return msg;
  }

  listMessages() {
    return this.data.messages;
  }

  // ---- 值班数据 ----

  getRoster() {
    return this.data.roster;
  }
}
