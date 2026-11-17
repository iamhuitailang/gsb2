// 本地值班后台 HTTP 服务：零依赖，仅使用 Node 内置模块
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store, newToken, hashToken, SESSION_TTL_MS, PENDING_TTL_MS } from './store.js';
import * as pages from './pages.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');

const COOKIE = {
  SESSION: 'dl_session',
  PENDING: 'dl_pending',
  DEVICE: 'dl_device',
};
const DEVICE_TTL_SECONDS = 90 * 24 * 60 * 60; // 设备信任保留 90 天

const store = new Store(DATA_DIR);

// ---------- HTTP 小工具 ----------

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Set-Cookie 是多值头：必须累积到数组，setHeader 直接赋值会覆盖之前的 cookie
function setCookie(res, name, value, maxAgeSeconds) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds > 0) attrs.push(`Max-Age=${maxAgeSeconds}`);
  const existing = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : [existing]), attrs.join('; ')]);
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseForm(req) {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

// 识别请求身份：正式会话 / 待确认浏览器 / 匿名
function classify(req) {
  const cookies = parseCookies(req);
  if (cookies[COOKIE.SESSION]) {
    const session = store.getSession(cookies[COOKIE.SESSION]);
    if (session) return { kind: 'session', session, cookies };
  }
  if (cookies[COOKIE.PENDING]) {
    // pending cookie 是浏览器侧密钥，配合记录里的哈希校验
    const pending = Object.values(store.data.pendings).find(
      (p) => p.browserKeyHash === hashToken(cookies[COOKIE.PENDING]) && !p.confirmed && p.expiresAt > Date.now()
    );
    if (pending) return { kind: 'pending', pending, cookies };
  }
  return { kind: 'anon', cookies };
}

// 待确认浏览器允许访问的白名单：等待页、状态轮询、收件箱、确认链接、取消登录
const PENDING_ALLOWED = new Set(['/waiting', '/wait/status', '/inbox', '/confirm', '/logout']);

// ---------- 路由处理 ----------

async function handle(req, res) {
  store.pruneExpired();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const auth = classify(req);

  // 待确认浏览器沙箱：白名单之外一律 403，值班数据不可访问
  if (auth.kind === 'pending' && !PENDING_ALLOWED.has(path)) {
    return sendJson(res, 403, { error: '设备尚未确认，只能访问等待页面', waiting: '/waiting' });
  }

  // ---- 登录页 / 登录提交 ----
  if (path === '/login' && req.method === 'GET') {
    if (auth.kind === 'session') return redirect(res, '/');
    return sendHtml(res, 200, pages.loginPage());
  }

  if (path === '/login' && req.method === 'POST') {
    const form = await parseForm(req);
    const username = (form.username || '').trim();
    const password = form.password || '';
    const remember = form.remember === '1';
    const deviceName = (form.deviceName || '').trim();

    if (!store.verifyLogin(username, password)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pages.loginPage('账号或密码错误，请重试。'));
    }

    // 密码正确：先看这台浏览器是否已是可信设备
    const deviceToken = auth.cookies[COOKIE.DEVICE];
    const device = deviceToken ? store.findDeviceByToken(deviceToken) : null;
    if (device && device.username === username) {
      // 已记住设备：走普通流程，直接生成正式会话
      const { sid } = store.createSession({ username, deviceId: device.id });
      store.touchDevice(device.id);
      setCookie(res, COOKIE.SESSION, sid, SESSION_TTL_MS / 1000);
      if (auth.kind === 'pending') clearCookie(res, COOKIE.PENDING);
      return redirect(res, '/');
    }

    // 未记住的浏览器：创建待确认登录，浏览器侧密钥只放进 pending cookie
    const browserKey = newToken(32);
    const { id: confirmToken } = store.createPending({
      username,
      browserKey,
      remember,
      name: deviceName,
    });

    const link = `http://${req.headers.host}/confirm?token=${confirmToken}`;
    store.addMessage({
      to: username,
      subject: '【值班后台】新设备登录确认',
      html: `有人使用正确密码登录值班后台，但该浏览器尚未被信任。<br>
请在 <b>15 分钟</b>内、在<b>发起登录的同一浏览器</b>中点击以下链接完成确认：
<div class="link"><a href="${link}">${link}</a></div>
<p class="muted">如非本人操作，请忽略此邮件，该登录不会获得任何数据访问权限。</p>`,
      text: link,
    });

    setCookie(res, COOKIE.PENDING, browserKey, PENDING_TTL_MS / 1000);
    return redirect(res, '/waiting');
  }

  // ---- 设备确认链接：绑定「本次登录」+「发起它的浏览器」 ----
  if (path === '/confirm' && req.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const pending = store.getPending(token);
    if (!pending) {
      return sendHtml(res, 403, pages.confirmErrorPage('确认链接无效、已使用或已过期。每次登录的链接只能使用一次。'));
    }
    const browserKey = auth.cookies[COOKIE.PENDING];
    if (!browserKey || hashToken(browserKey) !== pending.browserKeyHash) {
      // 典型场景：把乙浏览器的链接复制到甲浏览器打开 —— 甲没有乙的 pending cookie
      return sendHtml(
        res,
        403,
        pages.confirmErrorPage('该链接不属于当前浏览器。确认链接仅对发起本次登录的浏览器有效，不能在其他浏览器中代开。')
      );
    }

    store.markPendingConfirmed(token);

    let deviceId = null;
    if (pending.remember) {
      const deviceToken = newToken(32);
      const device = store.createDevice({ username: pending.username, name: pending.name, deviceToken });
      deviceId = device.id;
      setCookie(res, COOKIE.DEVICE, deviceToken, DEVICE_TTL_SECONDS);
    }

    // 确认通过后才生成正式会话
    const { sid } = store.createSession({ username: pending.username, deviceId });
    setCookie(res, COOKIE.SESSION, sid, SESSION_TTL_MS / 1000);
    clearCookie(res, COOKIE.PENDING);
    return redirect(res, '/');
  }

  // ---- 等待页与状态轮询 ----
  if (path === '/waiting' && req.method === 'GET') {
    if (auth.kind === 'session') return redirect(res, '/');
    if (auth.kind === 'pending') return sendHtml(res, 200, pages.waitingPage());
    return redirect(res, '/login');
  }

  if (path === '/wait/status' && req.method === 'GET') {
    if (auth.kind === 'session') return sendJson(res, 200, { status: 'confirmed' });
    if (auth.kind === 'pending') return sendJson(res, 200, { status: 'pending' });
    return sendJson(res, 403, { status: 'invalid' });
  }

  // ---- 内置收件箱：匿名和待确认浏览器可读（链接本身受浏览器密钥保护） ----
  if (path === '/inbox' && req.method === 'GET') {
    return sendHtml(res, 200, pages.inboxPage(store.listMessages(), auth.kind === 'session'));
  }

  // ---- 退出 / 取消等待：正式会话和待确认浏览器都可用 ----
  if (path === '/logout' && req.method === 'POST') {
    if (auth.kind === 'pending') {
      // 待确认浏览器主动取消：废弃等待态，返回登录
      clearCookie(res, COOKIE.PENDING);
      return redirect(res, '/login');
    }
    store.destroySession(auth.cookies[COOKIE.SESSION]);
    clearCookie(res, COOKIE.SESSION);
    clearCookie(res, COOKIE.PENDING);
    return redirect(res, '/login');
  }

  // ---- 以下接口仅正式会话可用 ----
  if (auth.kind !== 'session') {
    if (path === '/api/roster') return sendJson(res, 403, { error: '未授权' });
    if (path === '/login') return sendHtml(res, 405, pages.loginPage());
    return redirect(res, '/login');
  }

  store.touchSession(auth.cookies[COOKIE.SESSION]);

  if (path === '/' && req.method === 'GET') {
    const device = auth.session.deviceId ? store.getDevice(auth.session.deviceId) : null;
    return sendHtml(res, 200, pages.rosterPage(store.getRoster(), auth.session.username, device?.name));
  }

  if (path === '/api/roster' && req.method === 'GET') {
    return sendJson(res, 200, { user: auth.session.username, roster: store.getRoster() });
  }

  if (path === '/security' && req.method === 'GET') {
    const flash = url.searchParams.get('revoked') === '1' ? '已取消对该设备的信任，它下次登录需重新确认。' : '';
    return sendHtml(res, 200, pages.securityPage(store.listDevices(auth.session.username), auth.session.username, flash));
  }

  const revokeMatch = path.match(/^\/devices\/([A-Za-z0-9_-]+)\/revoke$/);
  if (revokeMatch && req.method === 'POST') {
    store.revokeDevice(revokeMatch[1], auth.session.username);
    // 只删除设备记录：当前会话保留，其他已记住的浏览器也不受影响
    return redirect(res, '/security?revoked=1');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
  });
});

server.listen(PORT, () => {
  console.log(`值班后台已启动: http://localhost:${PORT}`);
  console.log(`演示账号: admin / duty-2026（数据目录: ${DATA_DIR}）`);
});

export { server };
