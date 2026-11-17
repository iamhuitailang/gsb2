// JSON 文件存储。所有写操作同步完成后立即落盘，
// 配合单线程事件循环，保证“使用重置链接改密码”这类关键流程具有原子性。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

export const RESET_PURPOSE = 'password_reset';

const initialData = () => ({
  users: [],
  sessions: [], // { idHash, userId, createdAt }，id 只存哈希
  resetTokens: [], // { tokenHash, purpose, userId, expiresAt, usedAt, invalidatedAt, createdAt }
  nextId: 1,
});

let state = initialData();

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    state = { ...initialData(), ...JSON.parse(raw) };
  } catch {
    state = initialData();
    // 首次启动写入演示账号
    const demo = {
      id: state.nextId++,
      email: 'demo@example.com',
      passwordHash: hashPassword('password123'),
      name: '演示用户',
      bio: '这是一个演示账号，可以直接修改资料。',
      createdAt: new Date().toISOString(),
    };
    state.users.push(demo);
    persist();
  }
}

load();

// ---------- 用户 ----------
export function getUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return state.users.find((u) => u.email === normalized) || null;
}

export function getUserById(id) {
  return state.users.find((u) => u.id === id) || null;
}

export function createUser({ email, password, name }) {
  const user = {
    id: state.nextId++,
    email: String(email).trim().toLowerCase(),
    passwordHash: hashPassword(password),
    name: String(name || '').trim() || '未命名用户',
    bio: '',
    createdAt: new Date().toISOString(),
  };
  state.users.push(user);
  persist();
  return user;
}

export function updateUserPassword(userId, newPasswordHash) {
  const user = getUserById(userId);
  if (!user) return null;
  user.passwordHash = newPasswordHash;
  persist();
  return user;
}

export function updateUserProfile(userId, { name, bio }) {
  const user = getUserById(userId);
  if (!user) return null;
  user.name = String(name || '').trim() || user.name;
  user.bio = String(bio ?? '').slice(0, 500);
  persist();
  return user;
}

// ---------- 会话 ----------
export function addSession({ idHash, userId }) {
  state.sessions.push({
    idHash,
    userId,
    createdAt: new Date().toISOString(),
  });
  persist();
}

export function getSession(idHash) {
  return state.sessions.find((s) => s.idHash === idHash) || null;
}

/** 让某个用户的所有登录会话立即失效（改密码后调用） */
export function deleteSessionsByUser(userId) {
  state.sessions = state.sessions.filter((s) => s.userId !== userId);
  persist();
}

// ---------- 密码重置令牌 ----------
export function addResetToken({ tokenHash, purpose, userId, expiresAt }) {
  state.resetTokens.push({
    tokenHash,
    purpose,
    userId,
    expiresAt,
    usedAt: null,
    invalidatedAt: null,
    createdAt: new Date().toISOString(),
  });
  persist();
}

/**
 * 取出“仍然有效”的重置令牌记录：用途匹配、未使用、未失效、未过期。
 * 过期或已经用过 / 已失效的链接都会返回 null，前端只能看到统一的失败页。
 */
export function findUsableResetToken(tokenHash, purpose) {
  const record = state.resetTokens.find(
    (t) => t.tokenHash === tokenHash && t.purpose === purpose
  );
  if (!record) return null;
  if (record.usedAt || record.invalidatedAt) return null;
  if (Date.now() > record.expiresAt) return null;
  return record;
}

export function markResetTokenUsed(tokenHash) {
  const record = state.resetTokens.find((t) => t.tokenHash === tokenHash);
  if (record) {
    record.usedAt = new Date().toISOString();
    persist();
  }
}

/** 成功改密码后，让该用户所有“还没用过”的重置链接一并失效 */
export function invalidateUnusedResetTokens(userId) {
  for (const token of state.resetTokens) {
    if (token.userId === userId && !token.usedAt && !token.invalidatedAt) {
      token.invalidatedAt = new Date().toISOString();
    }
  }
  persist();
}

// 供测试检查存储内容（例如确认落盘的只有令牌哈希）
export function getStateSnapshot() {
  return JSON.parse(JSON.stringify(state));
}
