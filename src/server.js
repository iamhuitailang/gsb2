import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from './config.js';
import { DemoClock } from './clock.js';
import { StateStore } from './state-store.js';
import { AdminLog } from './admin-log.js';
import { PasswordVerifier, normalizeName } from './passwords.js';
import { LoginLimiter } from './rate-limiter.js';
import { Mutex } from './mutex.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// 演示来源用短标识；普通登录的来源形如 ip:127.0.0.1，只用于状态查询。
const DEMO_SOURCE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const SOURCE_QUERY_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 256;

/** 对外统一的失败响应：限流和密码错误在客户端看来完全一样。 */
const GENERIC_LOGIN_FAILURE = Object.freeze({
  error: 'login_failed',
  message: '账号或密码不正确。请确认后重试。',
});

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createApp(overrides = {}) {
  const config = resolveConfig(overrides);
  const store = new StateStore(config.stateFile);
  const state = store.load();
  const clock = new DemoClock(state.clockOffsetMs ?? 0);
  const log = new AdminLog(config.adminLogFile);
  const verifier = new PasswordVerifier(config.users ?? {});
  const limiter = new LoginLimiter({ state, store, clock, log, config, verifier });
  const mutex = new Mutex();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      // 出错时请求体可能还没读完（例如鉴权先失败），先排空再响应，
      // 否则 keep-alive 连接上残留的字节会干扰下一个请求。
      req.resume();
      sendError(res, error);
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /' || route === 'GET /index.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    }
    if (route === 'GET /app.js') {
      return sendFile(res, path.join(PUBLIC_DIR, 'app.js'), 'text/javascript; charset=utf-8');
    }
    if (route === 'GET /styles.css') {
      return sendFile(res, path.join(PUBLIC_DIR, 'styles.css'), 'text/css; charset=utf-8');
    }

    if (route === 'POST /api/login') {
      assertSameOrigin(req);
      // 普通登录接口：来源只由连接本身决定，任何自报来源的尝试一律拒绝。
      const body = await readJson(req);
      if (body && Object.prototype.hasOwnProperty.call(body, 'source')) {
        throw new HttpError(400, 'source_not_allowed', '普通登录接口不接受自定义来源');
      }
      if (url.searchParams.has('source')) {
        throw new HttpError(400, 'source_not_allowed', '普通登录接口不接受自定义来源');
      }
      return handleLogin(res, body, deriveSource(req), { demo: false });
    }

    if (route === 'POST /api/demo/login') {
      requireDemo(req);
      assertSameOrigin(req);
      const body = await readJson(req);
      const source = validateSource(body?.source, DEMO_SOURCE_PATTERN);
      return handleLogin(res, body, source, { demo: true });
    }

    if (route === 'GET /api/demo/status') {
      requireDemo(req);
      const account = String(url.searchParams.get('account') ?? '').trim();
      const source = validateSource(url.searchParams.get('source'), SOURCE_QUERY_PATTERN);
      const now = clock.now();
      return sendJson(res, 200, {
        now,
        clockOffsetMs: clock.offsetMs,
        ...limiter.describe(account, source, now),
      });
    }

    if (route === 'POST /api/demo/clock') {
      requireDemo(req);
      const body = await readJson(req);
      const minutes = Number(body?.advanceMinutes);
      if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 24 * 60) {
        throw new HttpError(400, 'invalid_clock_step', 'advanceMinutes 必须是 1 到 1440 的整数');
      }
      await mutex.run(async () => {
        clock.advance(minutes * 60 * 1000);
        limiter.persistClock();
        log.write({ event: 'clock_advanced', minutes, actor: 'demo-page' });
      });
      return sendJson(res, 200, { now: clock.now(), clockOffsetMs: clock.offsetMs });
    }

    if (route === 'POST /api/demo/clock/reset') {
      requireDemo(req);
      await readJson(req); // 排空请求体，保证连接可复用
      await mutex.run(async () => {
        clock.reset();
        limiter.persistClock();
        log.write({ event: 'clock_reset', actor: 'demo-page' });
      });
      return sendJson(res, 200, { now: clock.now(), clockOffsetMs: clock.offsetMs });
    }

    if (route === 'GET /api/demo/log') {
      requireDemo(req);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return sendJson(res, 200, {
        entries: log.recent(Number.isFinite(limit) ? limit : 50),
      });
    }

    if (route === 'POST /api/demo/reset') {
      requireDemo(req);
      await readJson(req);
      await mutex.run(async () => {
        limiter.clearAll();
        log.write({ event: 'state_cleared', actor: 'demo-page' });
      });
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'GET /api/health') {
      return sendJson(res, 200, { ok: true });
    }

    throw new HttpError(404, 'not_found', '接口不存在');
  }

  async function handleLogin(res, body, source, { demo }) {
    const username = body?.username;
    const password = body?.password;
    if (typeof username !== 'string' || username.trim() === '' ||
        username.length > MAX_USERNAME_LENGTH ||
        typeof password !== 'string' || password === '' ||
        password.length > MAX_PASSWORD_LENGTH) {
      throw new HttpError(400, 'invalid_request', '请填写账号和密码');
    }

    // 串行化整个“判定 + 计数”过程，避免并发请求一起越过上限。
    const outcome = await mutex.run(async () =>
      limiter.attempt({ username, password, source, viaDemo: demo }),
    );

    if (outcome.ok) {
      return sendJson(res, 200, { ok: true, account: normalizeName(username) });
    }
    // 无论是密码错误还是被限流，对外响应完全一致。
    return sendJson(res, 401, GENERIC_LOGIN_FAILURE);
  }

  function requireDemo(req) {
    if (!config.demoEnabled) {
      throw new HttpError(404, 'not_found', '演示入口未启用');
    }
    if (!isLoopback(req.socket.remoteAddress)) {
      throw new HttpError(403, 'forbidden', '演示入口仅限本机访问');
    }
  }

  return { server, config, limiter, clock, log, state, store };
}

function deriveSource(req) {
  // 来源只由连接信息推导，客户端无法通过表单或请求头指定。
  const address = String(req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  return `ip:${address}`;
}

function validateSource(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new HttpError(400, 'invalid_source', '来源标识格式不合法');
  }
  return value;
}

function isLoopback(address) {
  if (!address) return false;
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address === '::ffff:127.0.0.1';
}

/**
 * CSRF 防护：带 Origin 的跨站 POST 直接拒绝。
 * 同站页面和命令行工具（无 Origin）不受影响。
 */
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'forbidden', '来源不合法');
  }
  if (host !== req.headers.host) {
    throw new HttpError(403, 'forbidden', '跨站请求已被拒绝');
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'payload_too_large', '请求体过大');
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是合法 JSON');
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch {
    throw new HttpError(404, 'not_found', '文件不存在');
  }
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const known = error instanceof HttpError;
  if (!known) {
    console.error('[server]', error);
  }
  sendJson(res, known ? error.status : 500, {
    error: known ? error.code : 'internal_error',
    message: known ? error.message : '服务器内部错误',
  });
}
