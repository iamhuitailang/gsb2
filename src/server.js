// 零依赖 HTTP 服务：账号 / 会话 / 密码恢复接口 + 静态页面。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashPassword,
  verifyPassword,
  dummyVerify,
  randomToken,
  sha256,
} from './security.js';
import {
  RESET_PURPOSE,
  getUserByEmail,
  getUserById,
  createUser,
  updateUserPassword,
  updateUserProfile,
  addSession,
  getSession,
  deleteSessionsByUser,
  addResetToken,
  findUsableResetToken,
  markResetTokenUsed,
  invalidateUnusedResetTokens,
} from './store.js';
import { sendPasswordResetMail, listMails } from './mailer.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
// 重置链接有效期（毫秒），测试时可用环境变量缩短
const RESET_TTL_MS = Number(process.env.RESET_TTL_MS || 30 * 60 * 1000);
const SESSION_COOKIE = 'sid';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
}

/**
 * 从请求的会话 cookie 解析当前用户。
 * 资料页等受保护资源每次都由服务端重新判断，不信任前端状态。
 */
function authenticate(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = getSession(sha256(token));
  if (!session) return null;
  return getUserById(session.userId);
}

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  bio: u.bio,
  createdAt: u.createdAt,
});

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    // ---------- 认证 ----------
    if (pathname === '/api/register' && method === 'POST') {
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendJson(res, 400, { error: '请输入合法的邮箱地址' });
      }
      if (password.length < 8) {
        return sendJson(res, 400, { error: '密码至少需要 8 位' });
      }
      if (getUserByEmail(email)) {
        return sendJson(res, 409, { error: '该邮箱已注册' });
      }
      const user = createUser({ email, password, name });
      const token = randomToken();
      addSession({ idHash: sha256(token), userId: user.id });
      setSessionCookie(res, token);
      return sendJson(res, 201, { user: publicUser(user) });
    }

    if (pathname === '/api/login' && method === 'POST') {
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = getUserByEmail(email);
      // 用户不存在也跑一次同等强度的哈希，避免时序差异
      const ok = user ? verifyPassword(password, user.passwordHash) : (dummyVerify(), false);
      if (!user || !ok) {
        return sendJson(res, 401, { error: '邮箱或密码不正确' });
      }
      const token = randomToken();
      addSession({ idHash: sha256(token), userId: user.id });
      setSessionCookie(res, token);
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (pathname === '/api/logout' && method === 'POST') {
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    // ---------- 当前用户 / 资料（服务端校验会话） ----------
    if (pathname === '/api/me' && method === 'GET') {
      const user = authenticate(req);
      if (!user) return sendJson(res, 401, { error: '未登录或会话已失效' });
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (pathname === '/api/profile' && method === 'POST') {
      const user = authenticate(req);
      // 改密码后旧会话已被删除：另一个浏览器拿着旧 cookie 保存资料会被拒绝
      if (!user) return sendJson(res, 401, { error: '未登录或会话已失效，请重新登录' });
      const body = await readJsonBody(req);
      const updated = updateUserProfile(user.id, { name: body.name, bio: body.bio });
      return sendJson(res, 200, { user: publicUser(updated) });
    }

    // ---------- 忘记密码：统一回复，不泄露邮箱是否注册 ----------
    if (pathname === '/api/password/forgot' && method === 'POST') {
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendJson(res, 400, {
          message: '请输入合法的邮箱地址',
        });
      }

      const user = getUserByEmail(email);
      if (user) {
        const token = randomToken();
        addResetToken({
          tokenHash: sha256(token),
          purpose: RESET_PURPOSE,
          userId: user.id,
          expiresAt: Date.now() + RESET_TTL_MS,
        });
        const resetUrl = `${url.origin}/reset.html?token=${encodeURIComponent(token)}`;
        sendPasswordResetMail(user.email, resetUrl);
      } else {
        // 未注册邮箱：跑一次相同强度的哈希，抹平两条路径的耗时差异
        dummyVerify();
      }

      // 日志只记申请时刻与统一结果，不含邮箱
      logger.resetRequest();

      // 无论账号是否存在，响应文案与状态码完全一致
      return sendJson(res, 200, {
        message:
          '如果该邮箱已注册，重置链接已发送到邮箱，请前往内置收件箱查看。链接有效期内仅可使用一次。',
      });
    }

    // 打开重置链接时校验状态（同样不区分失效原因）
    if (pathname === '/api/password/reset' && method === 'GET') {
      const token = url.searchParams.get('token') || '';
      const record = findUsableResetToken(sha256(token), RESET_PURPOSE);
      return sendJson(res, 200, { valid: Boolean(record) });
    }

    // ---------- 使用重置链接设置新密码（一次重置只成功一次） ----------
    if (pathname === '/api/password/reset' && method === 'POST') {
      const body = await readJsonBody(req);
      const token = String(body.token || '');
      const newPassword = String(body.password || '');

      if (newPassword.length < 8) {
        return sendJson(res, 400, { error: '新密码至少需要 8 位' });
      }

      // 所有校验先做完，再修改任何状态
      const record = findUsableResetToken(sha256(token), RESET_PURPOSE);
      if (!record) {
        logger.resetComplete('invalid');
        return sendJson(res, 400, {
          error: '重置链接无效、已过期或已经使用过，请重新申请。',
        });
      }
      const user = getUserById(record.userId);
      if (!user) {
        logger.resetComplete('invalid');
        return sendJson(res, 400, {
          error: '重置链接无效、已过期或已经使用过，请重新申请。',
        });
      }

      // 以下写操作全部同步执行，单线程内不会被另一个请求穿插，
      // 因此同一条链接不可能成功两次。
      markResetTokenUsed(record.tokenHash);
      invalidateUnusedResetTokens(user.id); // 其余未使用的链接全部失效
      updateUserPassword(user.id, hashPassword(newPassword));
      deleteSessionsByUser(user.id); // 之前登录的所有会话立即失效

      logger.resetComplete('success');
      return sendJson(res, 200, {
        message: '密码已更新，请使用新密码重新登录。',
      });
    }

    // ---------- 内置收件箱 ----------
    if (pathname === '/api/mails' && method === 'GET') {
      return sendJson(res, 200, { mails: listMails() });
    }

    // ---------- 静态页面 ----------
    if (method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    return sendJson(res, 404, { error: 'Not Found' });
  } catch (err) {
    sendJson(res, 400, { error: '请求处理失败，请检查输入后重试' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请用 PORT=其它端口 npm start 启动。`);
  } else {
    console.error('服务启动失败：', err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
  console.log(`演示账号: demo@example.com / password123`);
  console.log(`内置收件箱: http://localhost:${PORT}/inbox.html`);
});
