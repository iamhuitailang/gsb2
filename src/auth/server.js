// 授权服务：登录、授权确认、令牌签发/刷新/撤销、设置页、受保护 API。
import {
  ALL_SCOPES,
  AUTH_ORIGIN,
  PENDING_REQUEST_TTL,
  APP_A_PORT,
  APP_B_PORT,
} from '../config.js';
import {
  OAuthError,
  applyGrant,
  authenticateAccessToken,
  authenticateClient,
  consumeCode,
  findClient,
  findGrant,
  grantById,
  hasScope,
  issueCode,
  issueTokens,
  listGrants,
  refreshTokens,
  revokeGrant,
  validateRedirectUri,
  validateRequestedScopes,
} from '../auth/grants.js';
import {
  clearSessionCookie,
  createSession,
  csrfTokenFor,
  currentSession,
  destroySession,
  sessionCookie,
  verifyCsrf,
} from '../auth/session.js';
import {
  nowSeconds,
  normalizeScopes,
  randomId,
  sha256,
  verifyPassword,
} from '../util.js';
import {
  canAccessTicket,
  isValidStatus,
  toReadView,
  toStatusView,
  visibleTickets,
} from '../domain/tickets.js';
import {
  createRouter,
  layout,
  query,
  readBody,
  readForm,
  readFormAll,
  redirect,
  sendHtml,
  sendJson,
} from '../http.js';
import {
  consentPage,
  docsPage,
  errorPage,
  homePage,
  loginPage,
  settingsPage,
} from '../ui/pages.js';

const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW = 5 * 60;

function html(res, status, body) {
  sendHtml(res, status, body);
}

function requireSession(req, state, res) {
  const ctx = currentSession(req, state);
  if (!ctx) {
    redirect(res, `/login?next=${encodeURIComponent(req.url)}`);
    return null;
  }
  return ctx;
}

function flashFrom(params) {
  const msg = params.get('msg');
  if (!msg) return null;
  return { type: params.get('type') === 'error' ? 'error' : 'ok', message: msg };
}

// 认证/授权错误重定向到 redirect_uri 时带上 error，应用才能处理。
function redirectWithError(res, redirectUri, state, error, description) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  redirect(res, url.toString());
}

function safeNext(next) {
  const value = String(next || '/');
  // 只允许站内相对路径，阻断开放重定向。
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value;
}

function badRequestPage(res, status, title, message) {
  return html(res, status, layout({ title, body: errorPage({ title, message, status }) }));
}

export function createAuthApp(store) {
  const router = createRouter();
  const appAUrl = process.env.GSB_APP_A_URL || `http://127.0.0.1:${APP_A_PORT}/`;
  const appBUrl = process.env.GSB_APP_B_URL || `http://127.0.0.1:${APP_B_PORT}/`;

  // ---- 页面 ----
  router.get('/', async (req, res) => {
    const ctx = currentSession(req, store.state);
    if (!ctx) return redirect(res, '/login');
    const tickets = visibleTickets(store.state, ctx.user);
    html(res, 200, layout({
      title: '工单系统',
      user: ctx.user,
      csrf: csrfTokenFor(req, res),
      body: homePage({ user: ctx.user, tickets, appAUrl, appBUrl }),
    }));
  });

  router.get('/login', async (req, res) => {
    const params = query(req);
    const ctx = currentSession(req, store.state);
    if (ctx) return redirect(res, safeNext(params.get('next')));
    const csrf = csrfTokenFor(req, res);
    html(res, 200, layout({
      title: '登录',
      body: loginPage({ csrf, next: safeNext(params.get('next')) }),
    }));
  });

  router.post('/login', async (req, res) => {
    const form = await readForm(req);
    const next = safeNext(form.next);
    if (!verifyCsrf(req, form.csrf)) {
      return html(res, 400, layout({ title: '登录', body: loginPage({ csrf: csrfTokenFor(req, res), next, error: '表单已过期，请重试' }) }));
    }
    const username = String(form.username || '').trim();
    const password = String(form.password || '');
    const now = nowSeconds();
    const user = store.state.users.find((u) => u.username === username && u.active !== false);

    if (user && user.lockedUntil && user.lockedUntil > now) {
      return html(res, 429, layout({ title: '登录', body: loginPage({ csrf: csrfTokenFor(req, res), next, error: '尝试次数过多，请稍后再试' }) }));
    }

    if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      if (user) {
        await store.transaction((s) => {
          const u = s.users.find((x) => x.username === username);
          const windowStart = now - LOGIN_WINDOW;
          u.loginFails = (u.loginFails || []).filter((t) => t > windowStart);
          u.loginFails.push(now);
          if (u.loginFails.length >= LOGIN_MAX_FAILS) u.lockedUntil = now + LOGIN_WINDOW;
        });
      }
      return html(res, 401, layout({ title: '登录', body: loginPage({ csrf: csrfTokenFor(req, res), next, error: '用户名或密码不正确' }) }));
    }

    const session = await store.transaction((s) => {
      const u = s.users.find((x) => x.username === username);
      u.loginFails = [];
      delete u.lockedUntil;
      return createSession(s, username);
    });
    res.setHeader('Set-Cookie', sessionCookie(session.sessionId));
    store.audit({ event: 'user.login', actor: username });
    redirect(res, next);
  });

  router.post('/logout', async (req, res) => {
    const form = await readForm(req);
    if (!verifyCsrf(req, form.csrf)) return badRequestPage(res, 400, '请求无效', 'CSRF 校验失败');
    const ctx = currentSession(req, store.state);
    if (ctx) await store.transaction((s) => destroySession(s, ctx.session.sessionId));
    res.setHeader('Set-Cookie', clearSessionCookie());
    redirect(res, '/login');
  });

  router.get('/settings', async (req, res) => {
    const ctx = requireSession(req, store.state, res);
    if (!ctx) return;
    const params = query(req);
    const grants = listGrants(store.state, ctx.user.username);
    html(res, 200, layout({
      title: '已授权应用',
      user: ctx.user,
      csrf: csrfTokenFor(req, res),
      body: settingsPage({ user: ctx.user, grants, csrf: csrfTokenFor(req, res), flash: flashFrom(params) }),
    }));
  });

  router.post('/settings/grants/:grantId/revoke', async (req, res) => {
    const ctx = requireSession(req, store.state, res);
    if (!ctx) return;
    const form = await readForm(req);
    if (!verifyCsrf(req, form.csrf)) {
      return redirect(res, '/settings?type=error&msg=' + encodeURIComponent('表单已过期，请重试'));
    }
    const grantId = req.routeParams.grantId;
    const result = await store.transaction((s) => {
      const grant = grantById(s, grantId);
      // 只能撤销自己的授权。
      if (!grant || grant.userId !== ctx.user.username) return { ok: false };
      const info = revokeGrant(s, grantId);
      return { ok: true, info, clientId: grant.clientId };
    });
    if (!result.ok) {
      return redirect(res, '/settings?type=error&msg=' + encodeURIComponent('授权不存在或无权操作'));
    }
    store.audit({ event: 'grant.revoked', actor: ctx.user.username, grantId, clientId: result.clientId, ...result.info });
    redirect(res, '/settings?msg=' + encodeURIComponent(`已撤销对 ${result.clientId} 的授权，其访问令牌和续期能力已一并失效`));
  });

  router.get('/docs', async (req, res) => {
    const ctx = currentSession(req, store.state);
    html(res, 200, layout({ title: '接口说明', user: ctx?.user || null, csrf: ctx ? csrfTokenFor(req, res) : null, body: docsPage() }));
  });

  // ---- OAuth2 授权端点 ----
  router.get('/oauth/authorize', async (req, res) => {
    const params = query(req);
    const p = Object.fromEntries(params.entries());
    const state = p.state;

    // 先校验 redirect_uri 可信；不可信时不重定向，直接在授权服务上报错。
    const client = findClient(store.state, p.client_id);
    if (!client) return badRequestPage(res, 400, '授权失败', '未知的应用');
    let redirectUri;
    try {
      redirectUri = validateRedirectUri(client, p.redirect_uri);
    } catch {
      return badRequestPage(res, 400, '授权失败', 'redirect_uri 与注册值不一致，已中止');
    }

    const ctx = currentSession(req, store.state);
    if (!ctx) {
      const next = `/oauth/authorize?${params.toString()}`;
      return redirect(res, `/login?next=${encodeURIComponent(next)}`);
    }

    if (p.response_type !== 'code') {
      return redirectWithError(res, redirectUri, state, 'unsupported_response_type', '仅支持授权码模式');
    }
    let requested;
    try {
      requested = validateRequestedScopes(client, normalizeScopes(p.scope));
    } catch (err) {
      return redirectWithError(res, redirectUri, state, err.code || 'invalid_scope', err.message);
    }
    if (!p.code_challenge) {
      return redirectWithError(res, redirectUri, state, 'invalid_request', '缺少 PKCE code_challenge');
    }

    const existing = findGrant(store.state, ctx.user.username, client.clientId);
    const existingScopes = existing ? existing.scopes : [];

    // 统一走确认页：首次授权、权限升级、以及重复授权都由用户当面确认。
    // 升级（新增范围）无法通过“静默沿用旧同意”完成，必须经过本页。
    const csrf = csrfTokenFor(req, res);
    html(res, 200, layout({
      title: '授权确认',
      user: ctx.user,
      csrf,
      body: consentPage({ client, requestedScopes: requested, existingScopes, csrf, params: p }),
    }));
  });

  router.post('/oauth/authorize', async (req, res) => {
    const { all, first: p } = await readFormAll(req);
    const client = findClient(store.state, p.client_id);
    if (!client) return badRequestPage(res, 400, '授权失败', '未知的应用');
    let redirectUri;
    try {
      redirectUri = validateRedirectUri(client, p.redirect_uri);
    } catch {
      return badRequestPage(res, 400, '授权失败', 'redirect_uri 与注册值不一致，已中止');
    }
    const ctx = currentSession(req, store.state);
    if (!ctx) {
      const next = `/oauth/authorize?` + new URLSearchParams(p).toString();
      return redirect(res, `/login?next=${encodeURIComponent(next)}`);
    }
    if (!verifyCsrf(req, p.csrf)) {
      return redirectWithError(res, redirectUri, p.state, 'invalid_request', 'CSRF 校验失败，请重试');
    }
    if (p.response_type !== 'code') {
      return redirectWithError(res, redirectUri, p.state, 'unsupported_response_type', '仅支持授权码模式');
    }

    let requested;
    try {
      requested = validateRequestedScopes(client, normalizeScopes(p.scope));
    } catch (err) {
      return redirectWithError(res, redirectUri, p.state, err.code || 'invalid_scope', err.message);
    }

    if (p.decision !== 'approve') {
      store.audit({ event: 'authorize.denied', actor: ctx.user.username, clientId: client.clientId });
      return redirectWithError(res, redirectUri, p.state, 'access_denied', '用户拒绝了授权');
    }

    // 用户在确认页可取消勾选部分范围；最终只能授予“申请集合”的子集。
    const checked = normalizeScopes(all.approved_scope || []);
    const approved = checked.filter((s) => requested.includes(s));
    if (approved.length === 0) {
      return redirectWithError(res, redirectUri, p.state, 'access_denied', '未选择任何范围');
    }
    if (!p.code_challenge) {
      return redirectWithError(res, redirectUri, p.state, 'invalid_request', '缺少 PKCE code_challenge');
    }

    const outcome = await store.transaction((s) => {
      const { grant, upgraded, added } = applyGrant(s, {
        userId: ctx.user.username,
        clientId: client.clientId,
        scopes: approved,
      });
      const code = issueCode(s, {
        clientId: client.clientId,
        redirectUri,
        userId: ctx.user.username,
        grantId: grant.grantId,
        scopes: approved,
        codeChallenge: p.code_challenge,
        codeChallengeMethod: p.code_challenge_method,
      });
      return { grant, upgraded, added, code };
    });

    store.audit({
      event: 'authorize.approved',
      actor: ctx.user.username,
      clientId: client.clientId,
      grantId: outcome.grant.grantId,
      upgraded: outcome.upgraded,
      added: outcome.added,
      scopes: outcome.grant.scopes,
    });

    const url = new URL(redirectUri);
    url.searchParams.set('code', outcome.code);
    if (p.state) url.searchParams.set('state', p.state);
    redirect(res, url.toString());
  });

  // ---- 令牌端点（应用凭据鉴权） ----
  router.post('/oauth/token', async (req, res) => {
    const form = await readForm(req);
    authenticateClient(store.state, form.client_id, form.client_secret);
    const grantType = form.grant_type;

    if (grantType === 'authorization_code') {
      if (!form.code) throw new OAuthError('invalid_request', '缺少 code');
      const result = await store.transaction((s) => {
        const client = authenticateClient(s, form.client_id, form.client_secret);
        const { record, grant } = consumeCode(s, {
          code: form.code,
          clientId: client.clientId,
          redirectUri: form.redirect_uri,
          codeVerifier: form.code_verifier,
        });
        const tokens = issueTokens(s, {
          grant,
          clientId: client.clientId,
          userId: record.userId,
          scopes: record.scopes,
        });
        return { tokens, clientId: client.clientId, grantId: grant.grantId, scopes: record.scopes };
      });
      store.audit({ event: 'token.issued', clientId: result.clientId, grantId: result.grantId, scopes: result.scopes });
      return sendJson(res, 200, result.tokens);
    }

    if (grantType === 'refresh_token') {
      if (!form.refresh_token) throw new OAuthError('invalid_request', '缺少 refresh_token');
      const result = await store.transaction((s) => {
        const client = authenticateClient(s, form.client_id, form.client_secret);
        const tokens = refreshTokens(s, { rawRefreshToken: form.refresh_token, clientId: client.clientId });
        return { tokens, clientId: client.clientId };
      });
      store.audit({ event: 'token.refreshed', clientId: result.clientId, scopes: result.tokens.scope });
      return sendJson(res, 200, result.tokens);
    }

    throw new OAuthError('unsupported_grant_type', '不支持的 grant_type');
  });

  router.post('/oauth/revoke', async (req, res) => {
    const form = await readForm(req);
    const client = authenticateClient(store.state, form.client_id, form.client_secret);
    const raw = form.token;
    if (raw) {
      const hash = sha256(raw);
      await store.transaction((s) => {
        s.accessTokens = s.accessTokens.filter((t) => !(t.tokenHash === hash && t.clientId === client.clientId));
        s.refreshTokens = s.refreshTokens.filter((t) => !(t.tokenHash === hash && t.clientId === client.clientId));
      });
      store.audit({ event: 'token.revoked', clientId: client.clientId });
    }
    // RFC 7009：撤销成功也返回 200。
    sendJson(res, 200, { ok: true });
  });

  // ---- 受保护 API：Bearer 令牌；权限 = 令牌范围 ∩ 当前用户可见范围 ----
  async function bearer(req) {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) throw new OAuthError('invalid_token', '缺少 Bearer 访问令牌', 401);
    return match[1];
  }

  router.get('/api/me', async (req, res) => {
    const raw = await bearer(req);
    const { user, token, grant, scopes } = authenticateAccessToken(store.state, raw);
    const client = findClient(store.state, token.clientId);
    sendJson(res, 200, {
      user: { username: user.username, displayName: user.displayName, teams: user.teams },
      client: { clientId: client.clientId, name: client.name },
      scopes,
      grantScopes: grant.scopes,
    });
  });

  router.get('/api/tickets', async (req, res) => {
    const raw = await bearer(req);
    const { user, token, scopes } = authenticateAccessToken(store.state, raw);
    if (!hasScope(scopes, 'tickets:read')) {
      throw new OAuthError('insufficient_scope', '缺少 tickets:read 范围', 403);
    }
    // 可见范围实时计算：用户团队/发起人关系变化会立即反映，不受令牌历史影响。
    const tickets = visibleTickets(store.state, user).map(toReadView);
    sendJson(res, 200, {
      tickets,
      scope: scopes.join(' '),
      clientId: token.clientId,
    });
  });

  router.post('/api/tickets/:id/status', async (req, res) => {
    const raw = await bearer(req);
    const { user, scopes } = authenticateAccessToken(store.state, raw);
    if (!hasScope(scopes, 'tickets:update')) {
      throw new OAuthError('insufficient_scope', '缺少 tickets:update 范围', 403);
    }
    const ticketId = req.routeParams.id;
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      throw new OAuthError('invalid_request', '请求体必须是 JSON');
    }
    const status = String(body?.status || '');
    if (!isValidStatus(status)) throw new OAuthError('invalid_request', 'status 取值不合法');

    const result = await store.transaction((s) => {
      // 在事务里重新鉴权，避免并发撤销后仍写入。
      const fresh = authenticateAccessToken(s, raw);
      const ticket = s.tickets.find((t) => t.id === ticketId);
      // 工单不存在或当前用户无权访问，统一 404，避免泄露存在性。
      if (!ticket || !canAccessTicket(fresh.user, ticket)) {
        throw new OAuthError('not_found', '工单不存在或无权访问', 404);
      }
      ticket.status = status;
      return { ticket, clientId: fresh.token.clientId };
    });
    store.audit({ event: 'ticket.status_updated', actor: user.username, clientId: result.clientId, ticketId, status, scopes });
    sendJson(res, 200, toStatusView(result.ticket));
  });

  // ---- 全局兜底：API 走 JSON，页面走 HTML ----
  const handler = async (req, res) => {
    const { pathname } = new URL(req.url, 'http://placeholder');
    const match = router.match(req.method, pathname);
    if (match) {
      req.routeParams = match.params;
      return match.handler(req, res);
    }
    const allowed = router.allowedMethods(pathname);
    if (allowed.length) {
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: allowed.join(', ') });
      }
      return html(res, 405, layout({ title: '不支持的方法', body: errorPage({ title: '不支持的方法', message: '请检查请求方法', status: 'method_not_allowed' }) }));
    }
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found', message: '接口不存在' });
    html(res, 404, layout({ title: '未找到', body: errorPage({ title: '未找到', message: '页面不存在', status: 'not_found' }) }));
  };

  // 把 OAuthError 等已知错误映射成 JSON（API）/HTML（页面）。
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      const status = err.statusCode || 500;
      if (err instanceof OAuthError) {
        const wantsHtml = String(req.headers.accept || '').includes('text/html') && req.method === 'GET' && !req.url.startsWith('/api/');
        if (wantsHtml) {
          return html(res, status, layout({ title: '出错', body: errorPage({ title: '请求失败', message: err.message, status: err.code }) }));
        }
        return sendJson(res, status, { error: err.code, error_description: err.message });
      }
      if (status === 500) console.error('[auth] unhandled', err);
      sendJson(res, status, { error: 'server_error', error_description: status === 500 ? '服务器内部错误' : err.message });
    }
  };
}
