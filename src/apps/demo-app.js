// 演示应用：一个可复用的最小 OAuth2 客户端。
// 两个应用跑同一份逻辑，靠注入各自的 client_id / client_secret / 允许范围区分，
// 从而验证“应用使用自己的凭据访问接口”。
import crypto from 'node:crypto';
import {
  AUTH_ORIGIN,
  DEMO_APPS,
  SCOPES,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
} from '../config.js';
import { escapeHtml, nowSeconds, randomToken } from '../util.js';
import {
  createServer,
  createRouter,
  readForm,
  redirect,
  sendHtml,
  sendJson,
} from '../http.js';

function appLayout({ title, appName, body }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(appName)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f7f8fa; color: #1f2329; }
  header { background: #24504a; color: #fff; padding: 12px 20px; display: flex; align-items: center; gap: 12px; }
  header .brand { font-weight: 600; }
  header .spacer { flex: 1; }
  header a { color: #cfe8e3; text-decoration: none; font-size: 14px; }
  main { max-width: 820px; margin: 26px auto; padding: 0 20px 60px; }
  .card { background: #fff; border: 1px solid #e3e6eb; border-radius: 10px; padding: 20px 22px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0 0 14px; }
  h2 { font-size: 16px; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #eef0f3; }
  th { color: #5b6572; background: #fafbfc; font-weight: 600; }
  .muted { color: #6b7684; font-size: 13px; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: #eef2f7; color: #3c4a5a; }
  .pill.read { background: #e8f3ff; color: #0b5cad; }
  .pill.update { background: #fff2e2; color: #9a5b00; }
  .notice { padding: 10px 14px; border-radius: 8px; margin: 12px 0; font-size: 14px; }
  .notice.err { background: #fdecec; color: #b42318; }
  .notice.ok { background: #e7f6ec; color: #1a7f37; }
  .notice.info { background: #eef4ff; color: #1a4f9c; }
  button, .btn { font: inherit; border-radius: 8px; padding: 8px 15px; border: 1px solid transparent; cursor: pointer; text-decoration: none; display: inline-block; }
  .primary { background: #1a6fd4; color: #fff; }
  .primary:hover { background: #155cb0; }
  .secondary { background: #fff; color: #1f2d3d; border-color: #cfd6df; }
  .secondary:hover { background: #f2f5f9; }
  select { font: inherit; padding: 5px 8px; border: 1px solid #cfd6df; border-radius: 6px; }
  code { background: #f1f3f6; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  .empty { padding: 20px; text-align: center; color: #6b7684; }
</style>
</head>
<body>
<header><span class="brand">${escapeHtml(appName)}</span><span class="spacer"></span><a href="/">首页</a></header>
<main>${body}</main>
</body>
</html>`;
}

function scopePill(scope) {
  const cls = scope === 'tickets:read' ? 'read' : 'update';
  return `<span class="pill ${cls}">${escapeHtml(SCOPES[scope]?.label || scope)}</span>`;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(part.slice(idx + 1).trim()); } catch { out[key] = part.slice(idx + 1).trim(); }
  }
  return out;
}

async function postForm(url, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}

/**
 * @param {object} opts
 * @param {'app-a'|'app-b'} opts.appKey
 * @param {object} opts.credentials  该应用自己的 clientSecret
 * @param {import('../store.js').Store} opts.store  共享状态（本地演示进程内共享）
 * @param {string} [opts.redirectUri] 覆盖注册回调地址（测试用随机端口）
 * @param {string} [opts.authOrigin] 覆盖授权服务地址（测试用随机端口）
 */
export function createDemoApp({ appKey, credentials, store, redirectUri, authOrigin }) {
  const def = DEMO_APPS[appKey];
  const origin = authOrigin || AUTH_ORIGIN;
  const app = {
    clientId: def.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: redirectUri || def.redirectUri,
    allowedScopes: def.allowedScopes,
    name: def.name,
  };
  const router = createRouter();
  // 每个浏览会话一份：access/refresh token + PKCE 临时状态。
  // 放在共享 store 的内存区，便于测试与重启后的一致性；演示够用。
  const sessions = new Map();

  function getSession(req, res) {
    const cookies = parseCookies(req.headers.cookie || '');
    let sid = cookies[`${appKey}_sid`];
    if (!sid || !sessions.has(sid)) {
      sid = randomToken('as_');
      sessions.set(sid, {
        sid,
        tokens: null,
        pending: null,
        flash: null,
        lastResult: null,
      });
      res.setHeader('Set-Cookie', `${appKey}_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return sessions.get(sid);
  }

  function resetTokens(sess, reason) {
    sess.tokens = null;
    sess.lastResult = reason ? { type: 'error', message: reason } : null;
  }

  // 调用授权服务的受保护 API。
  async function api(sess, method, path, body, retried = false) {
    if (!sess.tokens) return { status: 0, json: { error: 'no_token', message: '尚未授权' } };
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${sess.tokens.access_token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    // 令牌失效（撤销/过期）：最多用刷新令牌续期一次，避免无限重试。
    if (res.status === 401 && !retried && sess.tokens.refresh_token && json?.error === 'invalid_token') {
      const refreshed = await tryRefresh(sess);
      if (refreshed) {
        return api(sess, method, path, body, true);
      }
      // 续期失败说明授权已被撤销，清空本地令牌。
      resetTokens(sess, '授权已失效，请重新授权');
      return { status: 401, json: { error: 'grant_revoked', message: '授权已失效' } };
    }
    return { status: res.status, json };
  }

  async function tryRefresh(sess) {
    const result = await postForm(`${origin}/oauth/token`, {
      grant_type: 'refresh_token',
      refresh_token: sess.tokens.refresh_token,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    });
    if (result.status === 200 && result.json?.access_token) {
      sess.tokens = result.json;
      return true;
    }
    return false;
  }

  router.get('/', async (req, res) => {
    const sess = getSession(req, res);
    const hadTokens = Boolean(sess.tokens);
    // 先按当前令牌取数据；若令牌已失效，api() 会尝试续期或清空会话。
    const me = hadTokens ? await api(sess, 'GET', '/api/me') : null;
    const scopes = me?.status === 200 ? me.json.scopes : [];
    const list = sess.tokens ? await api(sess, 'GET', '/api/tickets') : null;
    // 在 API 调用之后再读取提示，确保“授权已失效”这类信息本次就能显示。
    const flash = sess.lastResult;
    sess.lastResult = null;

    let body;
    if (!sess.tokens) {
      body = `
      <div class="card">
        <h1>${escapeHtml(app.name)}</h1>
        <p>本应用需要你授权后，才能读取你有权限的工单。</p>
        <div class="notice info">本应用会申请：${app.allowedScopes.map(scopePill).join(' ')}。授权后只能访问这些范围，且始终受你本人可见的工单限制。</div>
        <div class="actions"><a class="btn primary" href="/login">使用工单系统账号授权</a></div>
        ${flash ? `<div class="notice ${flash.type === 'error' ? 'err' : 'ok'}">${escapeHtml(flash.message)}</div>` : ''}
      </div>`;
    } else {
      const canRead = scopes.includes('tickets:read');
      const canUpdate = scopes.includes('tickets:update');
      let table;
      if (list.status === 200 && canRead) {
        table = list.json.tickets.length
          ? `<table><thead><tr><th style="width:110px">编号</th><th>标题</th></tr></thead><tbody>${
              list.json.tickets.map((t) => `<tr><td><code>${escapeHtml(t.id)}</code></td><td>${escapeHtml(t.title)}</td></tr>`).join('')
            }</tbody></table>`
          : '<div class="empty">没有你可访问的工单标题。</div>';
      } else if (list.status === 403) {
        table = '<div class="notice info">本应用未获得只读范围，无法列出标题。</div>';
      } else if (list.status === 401) {
        table = '<div class="notice err">授权已失效，请重新授权。</div>';
      } else {
        table = '<div class="empty">暂无数据。</div>';
      }

      body = `
      <div class="card">
        <h1>${escapeHtml(app.name)}</h1>
        <p class="muted">当前身份：${escapeHtml(me?.json?.user?.displayName || '-')}；本应用生效范围：${scopes.map(scopePill).join(' ') || '<span class="muted">无</span>'}</p>
        ${flash ? `<div class="notice ${flash.type === 'error' ? 'err' : 'ok'}">${escapeHtml(flash.message)}</div>` : ''}
        <h2>可访问的工单标题</h2>
        ${table}
      </div>
      ${canUpdate ? updateCard(sess) : `
      <div class="card">
        <h2>更新工单状态</h2>
        <p class="muted">本应用当前只有只读范围，不能更新工单。</p>
        ${app.allowedScopes.includes('tickets:update') ? `<div class="actions"><a class="btn secondary" href="/upgrade">申请更新权限</a></div>` : ''}
      </div>`}
      <div class="card">
        <h2>连接信息</h2>
        <p class="muted">应用凭据：<code>${escapeHtml(app.clientId)}</code>（client_secret 保存在服务端，不进入浏览器）。</p>
        <div class="actions">
          <form method="post" action="/disconnect" style="margin:0"><button class="secondary" type="submit">断开本地会话</button></form>
        </div>
        <p class="muted" style="margin-top:8px">断开只清除本应用本地的令牌副本；如需让已发出的令牌彻底失效，请到工单系统的「已授权应用」页撤销授权。</p>
      </div>`;
    }
    sendHtml(res, 200, appLayout({ title: '首页', appName: app.name, body }));
  });

  function updateCard(_sess) {
    const opts = TICKET_STATUSES.map((s) => `<option value="${s}">${escapeHtml(TICKET_STATUS_LABELS[s])}（${s}）</option>`).join('');
    return `
    <div class="card">
      <h2>更新工单状态</h2>
      <form method="post" action="/update" class="actions" style="align-items:flex-end">
        <label class="muted">工单编号<br><input name="ticketId" placeholder="T-1001" required style="padding:7px;border:1px solid #cfd6df;border-radius:6px"></label>
        <label class="muted">目标状态<br><select name="status">${opts}</select></label>
        <button class="primary" type="submit">提交更新</button>
      </form>
      <p class="muted">只能更新你有权限访问的工单；应用凭据范围不含更新时会被拒绝。</p>
    </div>`;
  }

  // 发起授权：生成 state + PKCE，跳转到授权服务。
  router.get('/login', async (req, res) => {
    const sess = getSession(req, res);
    const verifier = randomToken();
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = randomToken();
    sess.pending = { verifier, state, createdAt: nowSeconds() };
    const url = new URL(`${origin}/oauth/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', app.clientId);
    url.searchParams.set('redirect_uri', app.redirectUri);
    url.searchParams.set('scope', app.allowedScopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    redirect(res, url.toString());
  });

  // 升级：申请本应用允许的完整范围。授权服务会把新增范围并入已有授权，
  // 并因出现“新增范围”而重新展示确认页；这样升级后应用同时保留只读与更新能力。
  router.get('/upgrade', async (req, res) => {
    const sess = getSession(req, res);
    if (!sess.tokens) return redirect(res, '/');
    const verifier = randomToken();
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = randomToken();
    sess.pending = { verifier, state, createdAt: nowSeconds() };
    const url = new URL(`${origin}/oauth/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', app.clientId);
    url.searchParams.set('redirect_uri', app.redirectUri);
    url.searchParams.set('scope', app.allowedScopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    redirect(res, url.toString());
  });

  router.get('/callback', async (req, res) => {
    const sess = getSession(req, res);
    const params = new URL(req.url, 'http://placeholder').searchParams;
    const pending = sess.pending;
    sess.pending = null;

    if (params.get('error')) {
      sess.lastResult = { type: 'error', message: `授权未完成：${params.get('error_description') || params.get('error')}` };
      return redirect(res, '/');
    }
    const code = params.get('code');
    const state = params.get('state');
    if (!pending || !code || state !== pending.state) {
      sess.lastResult = { type: 'error', message: '授权回调校验失败（state 不匹配），请重试' };
      return redirect(res, '/');
    }

    const result = await postForm(`${origin}/oauth/token`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: app.redirectUri,
      code_verifier: pending.verifier,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    });
    if (result.status !== 200 || !result.json?.access_token) {
      sess.lastResult = { type: 'error', message: `换取令牌失败：${result.json?.error_description || result.json?.error || result.status}` };
      return redirect(res, '/');
    }
    sess.tokens = result.json;
    sess.lastResult = { type: 'ok', message: `授权成功，生效范围：${result.json.scope || '-'}` };
    redirect(res, '/');
  });

  router.post('/update', async (req, res) => {
    const sess = getSession(req, res);
    const form = await readForm(req);
    const ticketId = String(form.ticketId || '').trim();
    const status = String(form.status || '');
    if (!ticketId) {
      sess.lastResult = { type: 'error', message: '请填写工单编号' };
      return redirect(res, '/');
    }
    const result = await api(sess, 'POST', `/api/tickets/${encodeURIComponent(ticketId)}/status`, { status });
    if (result.status === 200) {
      sess.lastResult = { type: 'ok', message: `已更新 ${result.json.id} 的状态为 ${TICKET_STATUS_LABELS[result.json.status] || result.json.status}` };
    } else if (result.status === 403) {
      sess.lastResult = { type: 'error', message: '被拒绝：应用凭据没有更新范围（403 insufficient_scope）' };
    } else if (result.status === 404) {
      sess.lastResult = { type: 'error', message: '被拒绝：工单不存在或当前用户无权访问（404）' };
    } else if (result.status === 401) {
      sess.lastResult = { type: 'error', message: '授权已失效，请重新授权' };
    } else {
      sess.lastResult = { type: 'error', message: `更新失败：${result.json?.error_description || result.json?.error || result.status}` };
    }
    redirect(res, '/');
  });

  router.post('/disconnect', async (req, res) => {
    const sess = getSession(req, res);
    // 主动归还令牌；即便服务端忽略，本地也已清空。
    if (sess.tokens?.refresh_token) {
      await postForm(`${origin}/oauth/revoke`, {
        token: sess.tokens.access_token,
        client_id: app.clientId,
        client_secret: app.clientSecret,
      }).catch(() => {});
    }
    resetTokens(sess);
    sess.lastResult = { type: 'ok', message: '已断开本地会话' };
    redirect(res, '/');
  });

  router.get('/status.json', async (req, res) => {
    const sess = getSession(req, res);
    sendJson(res, 200, {
      app: app.clientId,
      authorized: Boolean(sess.tokens),
      scope: sess.tokens?.scope || null,
    });
  });

  const handler = async (req, res) => {
    const { pathname } = new URL(req.url, 'http://placeholder');
    const match = router.match(req.method, pathname);
    if (match) {
      req.routeParams = match.params;
      return match.handler(req, res);
    }
    sendHtml(res, 404, appLayout({ title: '未找到', appName: app.name, body: '<div class="card">页面不存在</div>' }));
  };

  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      console.error(`[${appKey}]`, err);
      sendHtml(res, 500, appLayout({ title: '出错', appName: app.name, body: `<div class="card"><h1>出错了</h1><p>${escapeHtml(err.message)}</p></div>` }));
    }
  };
}

export function createDemoAppServer(opts) {
  return createServer(createDemoApp(opts));
}
