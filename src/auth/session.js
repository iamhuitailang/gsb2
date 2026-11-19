// 浏览器会话：登录态、CSRF 双提交、创建/销毁。
import { SESSION_TTL } from '../config.js';
import { nowSeconds, parseCookies, randomToken } from '../util.js';

export const SESSION_COOKIE = 'gsb_session';
export const CSRF_COOKIE = 'gsb_csrf';

export function ensureCsrfCookie(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies[CSRF_COOKIE]) return cookies[CSRF_COOKIE];
  const token = randomToken();
  res.setHeader('Set-Cookie', [
    `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax`,
  ]);
  return token;
}

// 同一请求内多次调用必须返回同一 token：否则页面里多个表单会拿到不同值，
// 而 Set-Cookie 只保留最后一次，导致其中某些表单提交时 CSRF 校验必然失败。
export function csrfTokenFor(req, res) {
  if (req._csrfToken) return req._csrfToken;
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[CSRF_COOKIE] || ensureCsrfCookie(req, res);
  req._csrfToken = token;
  return token;
}

export function verifyCsrf(req, submitted) {
  const cookies = parseCookies(req.headers.cookie || '');
  const expected = cookies[CSRF_COOKIE];
  return Boolean(expected && submitted && expected === submitted);
}

export function currentSession(req, state) {
  const cookies = parseCookies(req.headers.cookie || '');
  const id = cookies[SESSION_COOKIE];
  if (!id) return null;
  const now = nowSeconds();
  // 会话 id 明文存 hash 可以更严格；本地演示直接匹配随机 id。
  const session = state.sessions.find((s) => s.sessionId === id && s.expiresAt > now);
  if (!session) return null;
  const user = state.users.find((u) => u.username === session.username && u.active !== false);
  if (!user) return null;
  return { session, user };
}

export function createSession(state, username) {
  const now = nowSeconds();
  const session = {
    sessionId: randomToken('ss_'),
    username,
    createdAt: now,
    expiresAt: now + SESSION_TTL,
  };
  state.sessions.push(session);
  return session;
}

export function destroySession(state, sessionId) {
  state.sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
}

export function sessionCookie(sessionId) {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
