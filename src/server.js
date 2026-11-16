import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store, CONTRACTS_SEED } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4517);
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const CONTRACTS_DIR = path.resolve(
  process.env.CONTRACTS_DIR ?? path.join(ROOT, 'contracts'),
);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const SESSION_TTL_MS = (() => {
  const raw = Number(process.env.SESSION_TTL_MS ?? 15 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000;
})();
// 服务监听在本机时，管理员展示的分享链接默认用本机地址；
// 若通过反向代理对外提供，设置 PUBLIC_BASE_URL 让链接指向外部可达地址。
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
const SESSION_COOKIE = 'contract_session';

const store = await Store.open({ statePath: STATE_PATH, sessionTtlMs: SESSION_TTL_MS });

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ],
  );

const hmac = (value) =>
  crypto
    .createHmac('sha256', store.state.secret)
    .update(String(value))
    .digest('base64url');

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

function adminCookieValue() {
  // 与当前口令绑定：改口令后旧 cookie 自动失效。
  return hmac(`admin:${ADMIN_TOKEN}`);
}

function isAdmin(req) {
  const token = readCookie(req, 'admin') ?? '';
  return safeEqual(token, adminCookieValue());
}

function readCookie(req, name) {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sessionToken(req) {
  return readCookie(req, SESSION_COOKIE);
}

function setCookie(res, name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
  ];
  if (httpOnly) parts.push('HttpOnly');
  if (typeof maxAge === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }
  // 用数组累积 Set-Cookie，避免与 writeHead 传入的头相互覆盖。
  const existing = res.getHeader('Set-Cookie');
  const list = existing
    ? Array.isArray(existing)
      ? [...existing]
      : [existing]
    : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    ...headers,
  });
  res.end(body);
}

function json(res, status, payload) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.writeHead(303, { ...SECURITY_HEADERS, Location: location });
  res.end();
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 管理台只允许本机访问：连接来源必须是回环地址，Host 头也必须是本机名。
 * 这样即使把本地服务临时映射到内网，也无法从其他主机冒用管理台。
 */
function isAdminRequest(req) {
  const remote = (req.socket.remoteAddress ?? '').toLowerCase();
  const fromLoopback =
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1';
  const raw = req.headers.host ?? '';
  const host = raw.startsWith('[')
    ? raw.slice(1, raw.indexOf(']')).toLowerCase()
    : raw.split(':')[0].toLowerCase();
  const hostIsLoopback =
    host === '127.0.0.1' || host === 'localhost' || host === '::1';
  return fromLoopback && hostIsLoopback;
}

/* ------------------------------------------------------------------ */
/* 页面                                                                 */
/* ------------------------------------------------------------------ */

const LAYOUT = (title, body) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; justify-content: center;
    background: #f4f5f7; color: #1c1f23;
    font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
  main { width: 100%; max-width: 720px; padding: 40px 20px 64px; }
  .card {
    background: #fff; border: 1px solid #e3e6ea; border-radius: 12px;
    padding: 28px 28px 24px; box-shadow: 0 1px 2px rgba(16,24,40,.04);
  }
  h1 { font-size: 20px; margin: 0 0 6px; letter-spacing: .2px; }
  h2 { font-size: 16px; margin: 28px 0 10px; }
  .muted { color: #667085; font-size: 13.5px; }
  .kicker { color: #667085; font-size: 12.5px; letter-spacing: .08em; text-transform: uppercase; }
  dl.meta { display: grid; grid-template-columns: 92px 1fr; gap: 6px 14px; margin: 18px 0 0; }
  dl.meta dt { color: #667085; font-size: 13.5px; }
  dl.meta dd { margin: 0; font-size: 14px; }
  .badge {
    display: inline-block; padding: 2px 9px; border-radius: 999px;
    font-size: 12px; font-weight: 600; line-height: 1.7;
  }
  .badge.on { background: #e7f6ec; color: #116b32; }
  .badge.off { background: #f3f4f6; color: #535862; }
  .badge.warn { background: #fff4e5; color: #92400e; }
  .badge.bad { background: #fdecec; color: #b42318; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
  button, .btn {
    font: inherit; font-weight: 600; border-radius: 8px; padding: 10px 18px;
    border: 1px solid transparent; cursor: pointer; text-decoration: none;
    display: inline-flex; align-items: center; gap: 6px;
  }
  button.primary, .btn.primary { background: #1f5fd0; color: #fff; }
  button.primary:hover, .btn.primary:hover { background: #1a51b3; }
  button.ghost, .btn.ghost { background: #fff; border-color: #d0d5dd; color: #344054; }
  button.ghost:hover, .btn.ghost:hover { background: #f9fafb; }
  button.link { background: none; border: none; color: #b42318; padding: 10px 4px; }
  .notice {
    border-radius: 10px; padding: 14px 16px; margin-top: 20px;
    font-size: 14px; border: 1px solid;
  }
  .notice.info { background: #eff6ff; border-color: #bfdbfe; color: #1e3a8a; }
  .notice.warn { background: #fffaeb; border-color: #fde68a; color: #92400e; }
  .notice.bad { background: #fef3f2; border-color: #fecdca; color: #912018; }
  .notice.ok { background: #ecfdf3; border-color: #abefc6; color: #05603a; }
  .doc {
    margin-top: 18px; padding: 22px 24px; border: 1px solid #e3e6ea;
    border-radius: 10px; background: #fcfcfd; white-space: pre-wrap;
    word-break: break-word; font-size: 14px; line-height: 1.9;
    max-height: 60vh; overflow: auto;
    font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  }
  .watermark {
    margin-top: 14px; font-size: 12px; color: #98a2b3; letter-spacing: .04em;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #eef0f2; vertical-align: top; }
  th { color: #667085; font-weight: 600; font-size: 12.5px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  code { background: #f2f4f7; padding: 1px 6px; border-radius: 5px; font-size: 12.5px; word-break: break-all; }
  .linkbox { margin-top: 8px; }
  label { font-size: 14px; }
  .grid-form { display: grid; gap: 14px; margin-top: 16px; }
  .grid-form select, .grid-form input {
    font: inherit; padding: 9px 10px; border: 1px solid #d0d5dd; border-radius: 8px; width: 100%;
  }
  .inline { display: flex; align-items: center; gap: 8px; }
  .inline input { width: auto; }
  @media (prefers-color-scheme: dark) {
    body { background: #101317; color: #e6e8eb; }
    .card, .doc { background: #171b21; border-color: #262b33; }
    .muted, .kicker, th, dl.meta dt { color: #98a2b3; }
    .btn.ghost, button.ghost { background: #171b21; border-color: #333a44; color: #d0d5dd; }
    code { background: #22272f; }
    .doc { background: #14181d; }
  }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

function pageConfirm({ linkId, contract, state, expiresText, allowDownload }) {
  const reasonText = {
    revoked: '该链接已被管理员撤销，无法领取。',
    expired: '该链接已超过有效期，无法领取。',
    unpublished: '该合同已下架，无法领取。',
    claimed: '该链接已被领取。每条链接只允许一个访问者使用。',
    not_found: '链接不存在或格式不正确。',
  };

  if (!state.ok) {
    return {
      status: state.reason === 'not_found' ? 404 : 410,
      body: LAYOUT(
        '链接不可用',
        `<div class="card">
          <div class="kicker">合同访问链接</div>
          <h1>链接不可用</h1>
          <div class="notice bad">${esc(reasonText[state.reason] ?? '链接不可用。')}</div>
          <p class="muted">如需继续查看，请联系法务重新签发链接。</p>
        </div>`,
      ),
    };
  }

  return {
    status: 200,
    body: LAYOUT(
      '确认领取合同',
      `<div class="card">
        <div class="kicker">合同访问链接</div>
        <h1>${esc(contract.title)}</h1>
        <p class="muted">法务已为外部同事签发一个仅可查看本合同的访问链接。</p>
        <dl class="meta">
          <dt>合同编号</dt><dd>${esc(contract.number)}</dd>
          <dt>签署方</dt><dd>${esc(contract.party)}</dd>
          <dt>下载权限</dt><dd>${allowDownload ? '允许下载' : '仅查看，不可下载'}</dd>
          <dt>链接失效</dt><dd>${esc(expiresText)}</dd>
        </dl>
        <div class="notice info">
          本链接只能被领取一次，点击下方按钮后即视为领取。
          仅预览或刷新本页不会消耗领取机会。
        </div>
        <form method="post" action="/l/${encodeURIComponent(linkId)}/claim">
          <div class="actions">
            <button class="primary" type="submit">领取并查看合同</button>
          </div>
        </form>
        <p class="watermark">访问会话为短期临时会话，关闭后需重新由法务签发链接。</p>
      </div>`,
    ),
  };
}

function pageView({ contract, body, allowDownload, expiresAt, watermark }) {
  return LAYOUT(
    contract.title,
    `<div class="card">
      <div class="row">
        <div>
          <div class="kicker">合同阅览（只读）</div>
          <h1>${esc(contract.title)}</h1>
          <p class="muted">${esc(contract.number)} · ${esc(contract.party)}</p>
        </div>
        <span class="badge ${allowDownload ? 'warn' : 'on'}">${
          allowDownload ? '可下载' : '仅查看'
        }</span>
      </div>
      ${
        allowDownload
          ? `<div class="actions"><a class="btn ghost" href="/view/${encodeURIComponent(
              contract.id,
            )}/download">下载合同文件</a></div>`
          : `<div class="notice info">本链接未授权下载，仅可在页面内查看。</div>`
      }
      <div class="doc">${esc(body)}</div>
      <p class="watermark">${esc(watermark)} · 访问会话有效至 ${esc(
        new Date(expiresAt).toLocaleString('zh-CN', { hour12: false }),
      )}</p>
    </div>`,
  );
}

function pageDenied(reason) {
  const text = {
    revoked: '访问已失效：管理员已撤销该链接。',
    expired: '访问已失效：短期访问会话已过期。',
    unpublished: '访问已失效：合同已下架。',
    not_found: '没有有效的访问会话，请使用法务签发的链接重新领取。',
  };
  return LAYOUT(
    '访问已失效',
    `<div class="card">
      <div class="kicker">合同阅览</div>
      <h1>访问已失效</h1>
      <div class="notice bad">${esc(text[reason] ?? text.not_found)}</div>
      <p class="muted">如需再次查看，请联系法务重新签发链接。</p>
    </div>`,
  );
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

const ROUTES = [];
const route = (method, pattern, handler) => ROUTES.push({ method, pattern, handler });

route('GET', '/healthz', async (req, res) => {
  json(res, 200, { ok: true });
});

route('GET', '/', async (req, res) => {
  redirect(res, '/admin');
});

// 管理员登录（本地回环地址可用）
route('GET', '/admin', async (req, res) => {
  if (!isAdminRequest(req)) return send(res, 403, LAYOUT('禁止访问', '<div class="card"><h1>禁止访问</h1><p class="muted">管理台仅允许本机访问。</p></div>'));
  if (!isAdmin(req)) {
    return send(
      res,
      200,
      LAYOUT(
        '管理员登录',
        `<div class="card">
          <div class="kicker">本地合同库</div>
          <h1>管理员登录</h1>
          <p class="muted">请输入部署时设置的管理员口令（环境变量 ADMIN_TOKEN）。</p>
          <form method="post" action="/admin/login">
            <div class="grid-form">
              <label>管理员口令
                <input type="password" name="token" autocomplete="current-password" required>
              </label>
              <div class="actions" style="margin-top:0">
                <button class="primary" type="submit">登录</button>
              </div>
            </div>
          </form>
        </div>`,
      ),
    );
  }
  const snap = await store.snapshot();
  const origin = PUBLIC_BASE_URL || `http://${req.headers.host ?? `${HOST}:${PORT}`}`;
  return send(res, 200, LAYOUT('管理台', renderAdmin(snap, origin)));
});

route('POST', '/admin/login', async (req, res) => {
  if (!isAdminRequest(req)) return json(res, 403, { error: 'forbidden' });
  const body = new URLSearchParams(await readBody(req));
  const token = body.get('token') ?? '';
  if (!safeEqual(token, ADMIN_TOKEN)) {
    return send(
      res,
      401,
      LAYOUT(
        '登录失败',
        `<div class="card"><h1>登录失败</h1><div class="notice bad">管理员口令不正确。</div><div class="actions"><a class="btn ghost" href="/admin">返回</a></div></div>`,
      ),
    );
  }
  setCookie(res, 'admin', adminCookieValue(), { maxAge: 8 * 3600 });
  redirect(res, '/admin');
});

route('POST', '/admin/logout', async (req, res) => {
  setCookie(res, 'admin', '', { maxAge: 0 });
  redirect(res, '/admin');
});

// 管理员签发链接
route('POST', '/admin/links', async (req, res) => {
  if (!isAdmin(req) || !isAdminRequest(req)) return json(res, 403, { error: 'forbidden' });
  const form = new URLSearchParams(await readBody(req));
  const contractId = form.get('contractId') ?? '';
  const ttlMinutes = Number(form.get('ttlMinutes') ?? 60);
  const allowDownload = form.get('allowDownload') === 'on';
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 60 * 24 * 30) {
    return json(res, 400, { error: 'invalid_ttl' });
  }
  const result = await store.createLink({
    contractId,
    ttlMs: Math.round(ttlMinutes * 60 * 1000),
    allowDownload,
  });
  if (!result.ok) {
    return send(
      res,
      400,
      LAYOUT(
        '签发失败',
        `<div class="card"><h1>签发失败</h1><div class="notice bad">${esc(
          result.reason === 'unpublished' ? '该合同已下架，无法签发链接。' : '未找到该合同。',
        )}</div><div class="actions"><a class="btn ghost" href="/admin">返回管理台</a></div></div>`,
      ),
    );
  }
  redirect(res, '/admin');
});

route('POST', '/admin/links/:linkId/revoke', async (req, res) => {
  if (!isAdmin(req) || !isAdminRequest(req)) return json(res, 403, { error: 'forbidden' });
  const { linkId } = req.params;
  await store.revokeLink(linkId);
  redirect(res, '/admin');
});

route('POST', '/admin/contracts/:contractId/publish', async (req, res) => {
  if (!isAdmin(req) || !isAdminRequest(req)) return json(res, 403, { error: 'forbidden' });
  const { contractId } = req.params;
  const form = new URLSearchParams(await readBody(req));
  const published = form.get('published') === '1';
  await store.setPublished(contractId, published);
  redirect(res, '/admin');
});

// 公共确认页：只读，不消耗领取机会；刷新/预览安全。
route('GET', '/l/:linkId', async (req, res) => {
  const { linkId } = req.params;
  const state = await store.inspectLink(linkId);
  // 已领取者刷新确认页时，直接带他去自己的阅览页，而不是提示「已被领取」。
  if (state.reason === 'claimed' && (await sessionMatchesLink(req, linkId))) {
    return redirect(res, '/view');
  }
  const contract = state.contract ?? null;
  const rendered = pageConfirm({
    linkId,
    contract,
    state,
    expiresText: state.link
      ? new Date(state.link.expiresAt).toLocaleString('zh-CN', { hour12: false })
      : '',
    allowDownload: Boolean(state.link?.allowDownload),
  });
  send(res, rendered.status, rendered.body);
});

// 领取：POST 才消耗机会，且只有第一个请求成功。
route('POST', '/l/:linkId/claim', async (req, res) => {
  const { linkId } = req.params;
  const result = await store.claim(linkId);
  if (!result.ok) {
    // 重复提交（如双击）且持有该链接的会话：视为已领取，跳转阅览。
    if (result.reason === 'claimed' && (await sessionMatchesLink(req, linkId))) {
      return redirect(res, '/view');
    }
    const rendered = pageConfirm({
      linkId,
      contract: null,
      state: result,
    });
    return send(res, rendered.status, rendered.body);
  }
  const ttlSeconds = (result.session.expiresAt - Date.now()) / 1000;
  setCookie(res, SESSION_COOKIE, result.token, {
    maxAge: Math.max(1, ttlSeconds),
  });
  redirect(res, '/view');
});

/** 当前请求的会话是否正是该链接领取出来的那一个。 */
async function sessionMatchesLink(req, linkId) {
  const state = await store.inspectSession(sessionToken(req));
  return state.ok && state.session.linkId === linkId;
}

// 合同阅览：只认会话里的 contractId，绝不由 URL 决定看哪份合同。
route('GET', '/view', async (req, res) => {
  const state = await store.inspectSession(sessionToken(req));
  if (!state.ok) {
    if (state.reason === 'not_found') clearSessionCookie(res);
    return send(res, state.reason === 'not_found' ? 401 : 410, pageDenied(state.reason));
  }
  const { contract, session } = state;
  const body = await readContractFile(contract);
  const watermark = `访问会话 ${session.id.slice(0, 10)}`;
  send(
    res,
    200,
    pageView({
      contract,
      body,
      allowDownload: session.allowDownload,
      expiresAt: session.expiresAt,
      watermark,
    }),
  );
});

route('GET', '/view/:contractId/download', async (req, res) => {
  const state = await store.inspectSession(sessionToken(req));
  if (!state.ok) {
    return send(res, state.reason === 'not_found' ? 401 : 410, pageDenied(state.reason));
  }
  const { contract, session } = state;
  // URL 里的 contractId 只是提示：必须与会话绑定的合同完全一致。
  if (req.params.contractId !== contract.id) {
    return send(
      res,
      403,
      LAYOUT(
        '无权访问',
        `<div class="card"><h1>无权访问</h1><div class="notice bad">本次访问会话只对应一份合同，不能打开其他文件。</div></div>`,
      ),
    );
  }
  if (!session.allowDownload) {
    return send(
      res,
      403,
      LAYOUT(
        '不可下载',
        `<div class="card"><h1>不可下载</h1><div class="notice bad">管理员签发链接时未开放下载权限，本次仅可在线查看。</div></div>`,
      ),
    );
  }
  const body = await readContractFile(contract);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(
      `${contract.number}-${contract.title}.txt`,
    )}`,
  });
  res.end(body);
});

function clearSessionCookie(res) {
  setCookie(res, SESSION_COOKIE, '', { maxAge: 0 });
}

async function readContractFile(contract) {
  // 文件名只从内置合同表取，不信任状态文件里的 file 字段，
  // 也绝不拼接 URL 输入。
  const known = CONTRACTS_SEED.find((c) => c.id === contract.id);
  if (!known) throw new Error(`unknown contract: ${contract.id}`);
  return fs.readFile(path.join(CONTRACTS_DIR, path.basename(known.file)), 'utf8');
}

function renderAdmin(snap, origin) {
  const linkRows = snap.links
    .map((link) => {
      const statusBadge = {
        active: '<span class="badge on">待领取</span>',
        claimed: '<span class="badge warn">已领取</span>',
        revoked: '<span class="badge bad">已撤销</span>',
        expired: '<span class="badge off">已过期</span>',
      }[link.status];
      const sessionInfo = link.session
        ? link.session.live
          ? `会话有效至 ${esc(new Date(link.session.expiresAt).toLocaleTimeString('zh-CN', { hour12: false }))}`
          : '会话已失效'
        : '—';
      return `<tr data-link-id="${esc(link.id)}" data-contract-id="${esc(link.contractId)}">
        <td>${esc(link.contract?.title ?? link.contractId)}<br><span class="muted">${esc(link.contract?.number ?? '')}</span></td>
        <td>${link.allowDownload ? '可下载' : '仅查看'}</td>
        <td>${statusBadge}</td>
        <td>${sessionInfo}</td>
        <td>
          <div class="linkbox"><code>${esc(origin)}/l/${esc(link.id)}</code></div>
          ${
            link.status === 'active' || link.status === 'claimed'
              ? `<form method="post" action="/admin/links/${esc(link.id)}/revoke">
                   <button class="link" type="submit">撤销链接</button>
                 </form>`
              : ''
          }
        </td>
      </tr>`;
    })
    .join('');

  const contractOptions = snap.contracts
    .filter((c) => c.published)
    .map((c) => `<option value="${esc(c.id)}">${esc(c.number)} · ${esc(c.title)}</option>`)
    .join('');

  const contractRows = snap.contracts
    .map(
      (c) => `<tr>
        <td>${esc(c.title)}<br><span class="muted">${esc(c.number)}</span></td>
        <td>${esc(c.party)}</td>
        <td>${c.published ? '<span class="badge on">已上架</span>' : '<span class="badge off">已下架</span>'}</td>
        <td>
          <form method="post" action="/admin/contracts/${esc(c.id)}/publish">
            <input type="hidden" name="published" value="${c.published ? '0' : '1'}">
            <button class="ghost" type="submit">${c.published ? '下架' : '上架'}</button>
          </form>
        </td>
      </tr>`,
    )
    .join('');

  return `<div class="card">
      <div class="row">
        <div>
          <div class="kicker">本地合同库</div>
          <h1>管理台</h1>
          <p class="muted">签发一次性链接：先选合同，再设失效时间与下载权限。</p>
        </div>
        <form method="post" action="/admin/logout"><button class="ghost" type="submit">退出</button></form>
      </div>

      <h2>签发新链接</h2>
      <form method="post" action="/admin/links">
        <div class="grid-form">
          <label>合同
            <select name="contractId" required>${contractOptions}</select>
          </label>
          <label>失效时间（分钟）
            <input type="number" name="ttlMinutes" value="60" min="1" max="43200" required>
          </label>
          <label class="inline">
            <input type="checkbox" name="allowDownload"> 允许下载文件
          </label>
          <div class="actions" style="margin-top:0">
            <button class="primary" type="submit">生成链接</button>
          </div>
        </div>
      </form>

      <h2>已签发链接</h2>
      <table>
        <thead><tr><th>合同</th><th>权限</th><th>状态</th><th>访问会话</th><th>链接</th></tr></thead>
        <tbody>${linkRows || '<tr><td colspan="5" class="muted">暂无链接</td></tr>'}</tbody>
      </table>

      <h2>合同库</h2>
      <table>
        <thead><tr><th>合同</th><th>签署方</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${contractRows}</tbody>
      </table>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* 极简路由                                                             */
/* ------------------------------------------------------------------ */

function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const parts = r.pattern.split('/');
    const target = pathname.split('/');
    if (parts.length !== target.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) {
        if (!target[i]) {
          ok = false;
          break;
        }
        try {
          params[parts[i].slice(1)] = decodeURIComponent(target[i]);
        } catch {
          return null;
        }
      } else if (parts[i] !== target[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    // HEAD 复用 GET 路由。Node 对 HEAD 不会发送正文，所以链接预览、
    // IM 抓取、爬虫探测都只是读，不可能消耗领取机会（领取只走 POST）。
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const matched = matchRoute(method, url.pathname);
    if (!matched) {
      return send(
        res,
        404,
        LAYOUT('未找到', '<div class="card"><h1>未找到页面</h1></div>'),
      );
    }
    req.params = matched.params;
    await matched.handler(req, res);
  } catch (err) {
    console.error('[request error]', req.method, req.url, err);
    if (!res.headersSent) {
      send(res, 500, LAYOUT('服务器错误', '<div class="card"><h1>服务器错误</h1></div>'));
    } else {
      res.end();
    }
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`本地合同库已启动: http://${HOST}:${PORT}/admin`);
    console.log(`状态文件: ${STATE_PATH}`);
    if (ADMIN_TOKEN === 'dev-admin-token') {
      console.log('提示: 当前使用默认管理员口令，请用 ADMIN_TOKEN 环境变量覆盖。');
    }
  });
}

export { server };
