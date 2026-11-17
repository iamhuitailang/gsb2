'use strict';

const crypto = require('node:crypto');
const db = require('../db/init');
const { verifyPassword } = require('../lib/password');
const { ServiceError } = require('./customerService');

// 进程内存会话：演示足够；重启后需要重新登录
const sessions = new Map();

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, createdAt: Date.now() });
  return token;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function login(username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? ''));
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new ServiceError(401, 'BAD_CREDENTIALS', '用户名或密码错误');
  }
  const user = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    customerId: row.customer_id,
    storeId: row.store_id,
  };
  const token = createSession(user);
  return { token, user };
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function getCurrentUser(req) {
  const token = parseCookies(req.headers.cookie).session;
  const session = token && sessions.get(token);
  if (!session) return null;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId);
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    customerId: row.customer_id,
    storeId: row.store_id,
  };
}

function requireUser(req) {
  const user = getCurrentUser(req);
  if (!user) throw new ServiceError(401, 'UNAUTHORIZED', '请先登录');
  return user;
}

function requireRole(user, role) {
  if (user.role !== role) {
    throw new ServiceError(403, 'FORBIDDEN', '当前角色无权访问该功能');
  }
}

module.exports = {
  login,
  logout: destroySession,
  parseCookies,
  getCurrentUser,
  requireUser,
  requireRole,
};
