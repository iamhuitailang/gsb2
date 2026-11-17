import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceSummary, defaultDeviceName, detectKind, kindLabel } from './lib/device.mjs';
import { Store } from './lib/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE ?? path.join(__dirname, 'data', 'db.json');
const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? '127.0.0.1';
const COOKIE_NAME = 'gsb2_sid';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  const message = error instanceof HttpError ? error.message : '服务器内部错误';
  if (!(error instanceof HttpError)) console.error('[server]', error);
  sendJson(res, status, { error: { code, message, ...error.extra } });
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    let value = part.slice(index + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // 保留原始值，交给令牌查找去判定无效。
    }
    cookies[key] = value;
  }
  return cookies;
}

function sessionCookie(token, maxAgeSeconds) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', '请求内容过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', '请求内容不是合法的 JSON');
  }
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers.host;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'bad_origin', '请求来源不合法');
  }
  if (originHost !== host) throw new HttpError(403, 'bad_origin', '请求来源不合法');
}

function requireString(value, field, { max = 200, min = 1 } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_field', `缺少字段：${field}`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new HttpError(400, 'invalid_field', `字段 ${field} 长度不合法`);
  }
  return trimmed;
}

// 已结束的会话在重新登录后仍会留在列表里，因此限制每人保留的已结束条目数量。
const MAX_ENDED_SESSIONS_PER_USER = 20;

function pruneEndedSessions(store, userId) {
  const ended = store
    .sessionsForUser(userId)
    .filter((session) => session.revokedAt)
    .sort((a, b) => Date.parse(b.revokedAt) - Date.parse(a.revokedAt));
  if (ended.length <= MAX_ENDED_SESSIONS_PER_USER) return;
  const stale = new Set(ended.slice(MAX_ENDED_SESSIONS_PER_USER));
  store.data.sessions = store.data.sessions.filter((session) => !stale.has(session));
  store.queueSave();
}

function parseAuth(req, store) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const session = store.findSessionByToken(token);
  if (!session) throw new HttpError(401, 'unauthenticated', '请先登录');
  return session;
}

function sessionView(session, currentSessionId) {
  return {
    id: session.id,
    shortId: session.id.replace(/^s_/, '').slice(0, 6),
    deviceName: session.deviceName,
    deviceSummary: deviceSummary(session),
    kind: session.kind,
    kindLabel: kindLabel(session.kind),
    ip: session.ip,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    isCurrent: session.id === currentSessionId,
    revokedAt: session.revokedAt,
    revokedReason: session.revokedReason,
    revokedByDeviceName: session.revokedByDeviceName,
    status: session.revokedAt ? 'ended' : 'online',
  };
}

function byRecentActivity(a, b) {
  const aTime = Date.parse(a.revokedAt ?? a.lastSeenAt);
  const bTime = Date.parse(b.revokedAt ?? b.lastSeenAt);
  return bTime - aTime;
}

function draftView(draft) {
  return {
    id: draft.id,
    title: draft.title,
    content: draft.content,
    version: draft.version,
    updatedAt: draft.updatedAt,
  };
}

const ROUTES = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    })}$`,
  );
  ROUTES.push({ method, regex, keys, handler });
}

// ---- auth ----

route('POST', '/api/login', async (req, res, ctx) => {
  requireSameOrigin(req);
  const body = await readJsonBody(req);
  const username = requireString(body.username, 'username', { max: 64 });
  const password = typeof body.password === 'string' ? body.password : '';
  const user = ctx.store.verifyCredentials(username, password);
  if (!user) throw new HttpError(401, 'bad_credentials', '账号或密码不正确');

  // 同一个浏览器再次登录时，它上一次的会话随之结束，避免同一设备留下两条在线记录。
  const previous = ctx.store.findSessionByToken(
    parseCookies(req.headers.cookie)[COOKIE_NAME],
  );
  if (previous && previous.userId === user.id && !previous.revokedAt) {
    ctx.store.revokeSession(previous, 'replaced_by_new_login');
  }

  const userAgent = String(req.headers['user-agent'] ?? '');
  const requestedName =
    typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName : '';
  const deviceName = requestedName || defaultDeviceName(userAgent);
  const deviceNameSource = requestedName ? 'user' : 'auto';
  const kind = body.kind ?? detectKind(userAgent);
  const { token, session } = ctx.store.createSession({
    userId: user.id,
    deviceName,
    deviceNameSource,
    kind,
    userAgent,
    ip: req.socket.remoteAddress ?? '',
  });
  pruneEndedSessions(ctx.store, user.id);
  sendJson(res, 200, { user: publicUser(user) }, {
    'Set-Cookie': sessionCookie(token, 60 * 60 * 24 * 30),
  });
});

route('POST', '/api/logout', async (req, res, ctx) => {
  requireSameOrigin(req);
  const session = parseAuth(req, ctx.store);
  ctx.store.revokeSession(session, 'self_signout');
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
});

// ---- session ----

route('GET', '/api/me', async (req, res, ctx) => {
  const session = parseAuth(req, ctx.store);
  if (session.revokedAt) throw sessionRevokedError(session);
  const user = ctx.store.getUserById(session.userId);
  if (!user) throw new HttpError(401, 'unauthenticated', '账号不存在');
  ctx.store.markActivity(session);
  sendJson(res, 200, { user: publicUser(user), currentSessionId: session.id });
});

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName };
}

function sessionRevokedError(session) {
  const when = session.revokedAt;
  return new HttpError(401, 'session_revoked', '这台设备上的登录已结束', {
    revokedAt: when,
    revokedReason: session.revokedReason,
    revokedByDeviceName: session.revokedByDeviceName,
  });
}

// Authenticated endpoints must reject revoked sessions even though the cookie
// is still present in the browser: the server-side record is the source of truth.
function requireActiveSession(req, store) {
  const session = parseAuth(req, store);
  if (session.revokedAt) throw sessionRevokedError(session);
  store.markActivity(session);
  return session;
}

route('GET', '/api/security/sessions', async (req, res, ctx) => {
  const current = requireActiveSession(req, ctx.store);
  const deviceMap = new Map();

  for (const session of ctx.store.sessionsForUser(current.userId)) {
    // 同一台设备重新登录后，新会话和已结束的旧会话应归在一起。
    const key = ctx.store.deviceKeyFor(session);
    let entry = deviceMap.get(key);
    if (!entry) {
      entry = { deviceName: session.deviceName, online: [], ended: [], latest: session };
      deviceMap.set(key, entry);
    }
    // 设备摘要取最近一次会话的信息，避免用旧会话的 UA 描述这台设备。
    if (Date.parse(session.createdAt) > Date.parse(entry.latest.createdAt)) {
      entry.latest = session;
    }
    if (session.revokedAt) entry.ended.push(session);
    else entry.online.push(session);
  }

  const devices = [...deviceMap.values()].map((entry) => {
    const online = [...entry.online].sort(byRecentActivity);
    const ended = [...entry.ended].sort(byRecentActivity);
    const currentSession = online.find((item) => item.id === current.id) ?? null;
    return {
      deviceName: entry.latest.deviceName,
      deviceSummary: deviceSummary(entry.latest),
      kindLabel: kindLabel(entry.latest.kind),
      isCurrentDevice: Boolean(currentSession),
      currentSessionId: currentSession?.id ?? null,
      activeSessions: online.map((item) => sessionView(item, current.id)),
      endedSessions: ended.slice(0, 8).map((item) => sessionView(item, current.id)),
      endedSessionTotal: ended.length,
    };
  });

  devices.sort((a, b) => {
    if (a.isCurrentDevice !== b.isCurrentDevice) return a.isCurrentDevice ? -1 : 1;
    const aLatest = Math.max(
      0,
      ...a.activeSessions.map((item) => Date.parse(item.lastSeenAt)),
      ...a.endedSessions.map((item) => Date.parse(item.revokedAt)),
    );
    const bLatest = Math.max(
      0,
      ...b.activeSessions.map((item) => Date.parse(item.lastSeenAt)),
      ...b.endedSessions.map((item) => Date.parse(item.revokedAt)),
    );
    return bLatest - aLatest;
  });

  sendJson(res, 200, {
    devices,
    activeDeviceCount: devices.filter((item) => item.activeSessions.length > 0).length,
    endedSessionCount: devices.reduce((sum, item) => sum + item.endedSessionTotal, 0),
    checkedAt: new Date().toISOString(),
  });
});

route('POST', '/api/security/sessions/:id/revoke', async (req, res, ctx) => {
  requireSameOrigin(req);
  const current = requireActiveSession(req, ctx.store);
  const target = ctx.store.findSessionById(ctx.params.id);
  if (!target || target.userId !== current.userId) {
    throw new HttpError(404, 'session_not_found', '找不到该会话');
  }
  if (target.id === current.id) {
    throw new HttpError(400, 'cannot_revoke_current', '不能在这里退出当前设备，请使用「退出登录」');
  }
  if (target.revokedAt) {
    sendJson(res, 200, { ok: true, alreadyEnded: true });
    return;
  }
  ctx.store.revokeSession(target, 'revoked_by_device', { bySession: current });
  sendJson(res, 200, { ok: true, revoked: sessionView(target, current.id) });
});

route('POST', '/api/security/sessions/revoke-others', async (req, res, ctx) => {
  requireSameOrigin(req);
  const current = requireActiveSession(req, ctx.store);
  const count = ctx.store.revokeOtherSessions(current.userId, current.id, current);
  sendJson(res, 200, { ok: true, revokedCount: count });
});

// ---- drafts ----

route('GET', '/api/drafts', async (req, res, ctx) => {
  const session = requireActiveSession(req, ctx.store);
  sendJson(res, 200, { drafts: ctx.store.listDrafts(session.userId).map(draftView) });
});

route('GET', '/api/drafts/:id', async (req, res, ctx) => {
  const session = requireActiveSession(req, ctx.store);
  const draft = ctx.store.getDraft(session.userId, ctx.params.id);
  if (!draft) throw new HttpError(404, 'draft_not_found', '找不到这份草稿');
  sendJson(res, 200, { draft: draftView(draft) });
});

route('PUT', '/api/drafts/:id', async (req, res, ctx) => {
  requireSameOrigin(req);
  const session = requireActiveSession(req, ctx.store);
  const draft = ctx.store.getDraft(session.userId, ctx.params.id);
  if (!draft) throw new HttpError(404, 'draft_not_found', '找不到这份草稿');

  const body = await readJsonBody(req);
  if (typeof body.content !== 'string') {
    throw new HttpError(400, 'invalid_field', '缺少字段：content');
  }
  if (body.content.length > 200_000) {
    throw new HttpError(413, 'payload_too_large', '草稿内容过长');
  }
  if (Number.isInteger(body.baseVersion) && body.baseVersion !== draft.version) {
    throw new HttpError(409, 'version_conflict', '服务端上的草稿已被更新，请先合并最新内容', {
      currentVersion: draft.version,
      currentContent: draft.content,
      currentUpdatedAt: draft.updatedAt,
    });
  }

  const updated = ctx.store.updateDraft(session.userId, draft.id, body.content);
  sendJson(res, 200, { draft: draftView(updated) });
});

// ---- static ----

const STATIC_ALIASES = new Map([
  ['/', 'index.html'],
  ['/editor', 'editor.html'],
  ['/security', 'security.html'],
]);

async function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/api/')) return false;
  const alias = STATIC_ALIASES.get(pathname);
  const relative = alias ?? pathname.replace(/^\/+/, '');
  if (!relative || relative.includes('\0')) return false;

  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) return false;

  let info;
  try {
    info = await stat(resolved);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const type = MIME_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(resolved).pipe(res);
  return true;
}

// ---- server ----

export async function createApp({ dataFile = DATA_FILE } = {}) {
  const store = await Store.open(dataFile);

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendJson(res, 400, { error: { code: 'bad_request', message: '请求地址不合法' } });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await serveStatic(req, res, pathname)) return;
    }

    for (const entry of ROUTES) {
      if (entry.method !== req.method) continue;
      const match = entry.regex.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(entry.keys.map((key, index) => [key, match[index + 1]]));
      try {
        await entry.handler(req, res, { store, params });
      } catch (error) {
        // 出错时请求体可能还没被读取，排空它，避免 keep-alive 连接卡住。
        req.resume();
        if (!res.headersSent) sendError(res, error);
        else res.end();
      }
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: { code: 'not_found', message: '接口不存在' } });
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: '页面不存在' } });
  });

  // 数据落盘由调用方（启动脚本或测试的清理钩子）通过 store.close() 负责，
  // 不挂在 server 的 close 事件上，避免两处同时写入同一个数据文件。
  return { server, store };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server, store } = await createApp();
  server.listen(PORT, HOST, () => {
    const users = store.data.users.map((user) => user.username).join('、');
    console.log('');
    console.log('  账号安全演示已启动');
    console.log(`  地址： http://${HOST}:${PORT}/`);
    console.log(`  账号： ${users}　密码： demo1234`);
    console.log(`  数据： ${DATA_FILE}`);
    console.log('');
    console.log('  提示：用两个不同的浏览器（或一个普通窗口 + 一个无痕窗口）分别登录。');
    console.log('');
  });

  const shutdown = async () => {
    server.close();
    // 浏览器/测试客户端可能保持 keep-alive 连接，强制断开以免退出卡住。
    server.closeAllConnections?.();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
