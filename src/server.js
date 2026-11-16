import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Store, INVITE_STATUS, INVITE_STATUS_LABELS, ROLE_LABELS } from './store.js';
import {
  SessionStore,
  SESSION_COOKIE,
  clearSessionCookie,
  parseCookies,
  sessionCookie,
} from './auth.js';
import { adminPage, errorPage, inboxPage, invitePage, loginPage } from './views.js';

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        // Drain the rest so the socket stays usable for the 413 response.
        req.resume();
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function parseForm(raw) {
  const params = new URLSearchParams(raw);
  const result = Object.create(null);
  for (const [key, value] of params) result[key] = value;
  return result;
}

function safeEqual(a, b) {
  // An absent token on either side never matches, so a request that omits
  // both the field and the session cannot trivially pass.
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

/**
 * Build the request handler. Exported separately from `createApp` so tests can
 * drive it without binding a port.
 */
export function createHandler({ store, sessions, secureCookies = false }) {
  const statusLabels = INVITE_STATUS_LABELS;

  function context(req) {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[SESSION_COOKIE] ?? null;
    const session = sessions.get(sid);
    const user = session ? store.publicUser(session.userId) : null;
    return {
      sid,
      session,
      user,
      csrf: session?.csrf ?? '',
      unread: user ? store.countUnreadForEmail(user.email) : 0,
      flash: session ? sessions.takeFlash(session) : null,
      cookieHeader: secureCookies,
    };
  }

  function ensureCsrfCookieless(ctx, res) {
    // Anonymous visitors need a CSRF token for the login form. Always mint a
    // fresh server-side session: never adopt a client-supplied cookie value.
    if (ctx.session) return ctx;
    const token = sessions.create(null);
    const session = sessions.get(token);
    res.setHeader('Set-Cookie', sessionCookie(token, { secure: secureCookies, maxAgeSeconds: 3600 }));
    return { ...ctx, sid: token, session, csrf: session.csrf };
  }

  return async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      send(res, 400, errorPage({ status: 400, title: '请求无效', message: '无法解析请求地址。' }));
      return;
    }
    const path = url.pathname;

    try {
      if (req.method === 'GET' && (path === '/' || path === '/login')) {
        const ctx = context(req);
        if (path === '/' && ctx.user) {
          redirect(res, ctx.user.role === 'admin' ? '/admin' : '/inbox');
          return;
        }
        // `/login` stays reachable while signed in so a user can switch to the
        // account that actually owns the invited mailbox.
        const withCsrf = ensureCsrfCookieless(ctx, res);
        send(
          res,
          200,
          loginPage({
            csrf: withCsrf.csrf,
            next: url.searchParams.get('next') ?? '',
            currentUser: ctx.user,
          }),
        );
        return;
      }

      if (req.method === 'POST' && path === '/login') {
        const raw = await readBody(req);
        const form = parseForm(raw);
        const ctx = context(req);
        // The CSRF token on the login form belongs to the cookie issued with
        // the GET, so require both a session and a matching token.
        if (!ctx.session || !safeEqual(form.csrf, ctx.csrf)) {
          const withCsrf = ensureCsrfCookieless(ctx, res);
          send(
            res,
            403,
            loginPage({ csrf: withCsrf.csrf, error: '会话已过期，请重新登录。' }),
          );
          return;
        }
        const user = store.authenticate(form.email, form.password);
        if (!user) {
          send(
            res,
            401,
            loginPage({ csrf: ctx.csrf, error: '邮箱或密码不正确。', currentUser: ctx.user }),
          );
          return;
        }
        // Rotate the session on login to avoid fixation.
        sessions.destroy(ctx.sid);
        const token = sessions.create(user.id);
        const next = safeNext(form.next, user);
        redirect(res, next, {
          'Set-Cookie': sessionCookie(token, { secure: secureCookies }),
        });
        return;
      }

      if (req.method === 'POST' && path === '/logout') {
        const ctx = context(req);
        const raw = await readBody(req);
        const form = parseForm(raw);
        if (!ctx.session || !safeEqual(form.csrf, ctx.csrf)) {
          send(res, 403, errorPage({ user: ctx.user, csrf: ctx.csrf, title: '请求被拒绝', message: 'CSRF 校验失败。' }));
          return;
        }
        sessions.destroy(ctx.sid);
        redirect(res, '/login', { 'Set-Cookie': clearSessionCookie({ secure: secureCookies }) });
        return;
      }

      if (req.method === 'GET' && path === '/inbox') {
        const ctx = context(req);
        if (!ctx.user) {
          redirect(res, '/login?next=%2Finbox');
          return;
        }
        const messages = store.listMessagesForEmail(ctx.user.email);
        // Viewing the inbox marks messages read.
        const unreadBefore = store.countUnreadForEmail(ctx.user.email);
        if (unreadBefore > 0) store.markMessagesReadForEmail(ctx.user.email);
        const teamsById = Object.fromEntries(store.listTeams().map((team) => [team.id, team.name]));
        send(
          res,
          200,
          inboxPage({
            user: ctx.user,
            csrf: ctx.csrf,
            messages,
            teamsById,
            statusLabels,
            unread: 0,
            flash: ctx.flash,
          }),
        );
        return;
      }

      if (req.method === 'GET' && path === '/admin') {
        const ctx = context(req);
        if (!ctx.user) {
          redirect(res, '/login?next=%2Fadmin');
          return;
        }
        if (ctx.user.role !== 'admin') {
          send(res, 403, errorPage({ user: ctx.user, csrf: ctx.csrf, title: '无权访问', message: '只有管理员可以进入控制台。' }));
          return;
        }
        const teams = store.listTeams();
        const membersByTeam = Object.fromEntries(
          teams.map((team) => [team.id, store.listMembershipsForTeam(team.id)]),
        );
        send(
          res,
          200,
          adminPage({
            user: ctx.user,
            csrf: ctx.csrf,
            teams,
            invites: store.listInvites(),
            membersByTeam,
            knownEmails: store.listUsers().map((u) => u.email),
            statusLabels,
            unread: ctx.unread,
            flash: ctx.flash,
          }),
        );
        return;
      }

      if (req.method === 'POST' && path === '/admin/invites') {
        const ctx = context(req);
        if (!ctx.user || ctx.user.role !== 'admin') {
          send(res, 403, errorPage({ user: ctx.user, csrf: ctx.csrf, title: '无权访问', message: '只有管理员可以发送邀请。' }));
          return;
        }
        const form = parseForm(await readBody(req));
        if (!safeEqual(form.csrf, ctx.csrf)) {
          send(res, 403, errorPage({ user: ctx.user, csrf: ctx.csrf, title: '请求被拒绝', message: 'CSRF 校验失败。' }));
          return;
        }
        const result = store.createInvite({
          email: form.email,
          teamId: form.teamId,
          role: form.role,
          actorUserId: ctx.user.id,
        });
        if (!result.ok) {
          const text =
            result.reason === 'invalid_email'
              ? '邮箱格式不正确。'
              : result.reason === 'invalid_team'
                ? '团队不存在。'
                : '角色不合法。';
          sessions.setFlash(ctx.session, 'error', text);
          redirect(res, '/admin');
          return;
        }
        const teamName = store.getTeam(result.invite.teamId)?.name ?? '';
        const extra = result.superseded.length ? '，旧邀请已自动失效。' : '。';
        sessions.setFlash(
          ctx.session,
          'success',
          `已向 ${result.invite.email} 发送「${teamName}」${ROLE_LABELS[result.invite.role]}邀请${extra}`,
        );
        redirect(res, '/admin');
        return;
      }

      const revokeMatch = path.match(/^\/admin\/invites\/([^/]+)\/revoke$/);
      if (req.method === 'POST' && revokeMatch) {
        const ctx = context(req);
        if (!ctx.user || ctx.user.role !== 'admin') {
          send(res, 403, errorPage({ user: ctx.user, csrf: ctx.csrf, title: '无权访问', message: '只有管理员可以撤销邀请。' }));
          return;
        }
        const form = parseForm(await readBody(req));
        if (!safeEqual(form.csrf, ctx.csrf)) {
          send(res, 403, errorPage({ user: ctx.user, csrf: ctx.csrf, title: '请求被拒绝', message: 'CSRF 校验失败。' }));
          return;
        }
        const result = store.revokeInvite({ inviteId: revokeMatch[1], actorUserId: ctx.user.id });
        if (result.ok) {
          sessions.setFlash(ctx.session, 'success', '邀请已撤销。');
        } else if (result.reason === 'not_found') {
          sessions.setFlash(ctx.session, 'error', '邀请不存在。');
        } else {
          sessions.setFlash(ctx.session, 'error', '该邀请已不是待接受状态，撤销未生效。');
        }
        redirect(res, '/admin');
        return;
      }

      if (req.method === 'POST' && path === '/admin/members/role') {
        const ctx = context(req);
        if (!ctx.user || ctx.user.role !== 'admin') {
          send(res, 403, errorPage({ user: ctx.user, csrf: ctx.csrf, title: '无权访问', message: '只有管理员可以调整角色。' }));
          return;
        }
        const form = parseForm(await readBody(req));
        if (!safeEqual(form.csrf, ctx.csrf)) {
          send(res, 403, errorPage({ user: ctx.user, csrf: ctx.csrf, title: '请求被拒绝', message: 'CSRF 校验失败。' }));
          return;
        }
        const result = store.setMemberRole({
          teamId: form.teamId,
          userId: form.userId,
          role: form.role,
        });
        sessions.setFlash(
          ctx.session,
          result.ok ? 'success' : 'error',
          result.ok
            ? '成员角色已更新。'
            : result.reason === 'not_a_member'
              ? '该用户不是团队成员。'
              : '角色不合法。',
        );
        redirect(res, '/admin');
        return;
      }

      const acceptMatch = path.match(/^\/invite\/([^/]+)\/accept$/);
      if (req.method === 'POST' && acceptMatch) {
        const ctx = context(req);
        const token = acceptMatch[1];
        const form = parseForm(await readBody(req));
        if (!ctx.session || !safeEqual(form.csrf, ctx.csrf)) {
          send(res, 403, errorPage({ user: ctx.user, csrf: ctx.csrf, title: '请求被拒绝', message: '会话已过期，请重新登录。' }));
          return;
        }
        if (!ctx.user) {
          redirect(res, `/login?next=${encodeURIComponent(`/invite/${token}`)}`);
          return;
        }
        const result = store.acceptInvite({ token, userId: ctx.user.id });
        if (result.ok) {
          const note = result.alreadyMember
            ? `你原本已是成员，本次未重复生成成员关系${result.roleApplied ? '，角色已按最新邀请更新' : '，角色保持不变'}。`
            : '已加入团队。';
          sessions.setFlash(ctx.session, 'success', `已接受「${result.teamName}」邀请。${note}`);
          redirect(res, '/inbox');
          return;
        }
        const messages = {
          not_found: '邀请链接无效。',
          not_pending: '该邀请已失效、已撤销或已被接受。',
          not_authenticated: '请先登录。',
          email_unverified: '你的账号邮箱尚未验证，无法接受邀请。',
          email_mismatch: '当前账号邮箱与受邀邮箱不一致，无法接受。',
        };
        sessions.setFlash(ctx.session, 'error', messages[result.reason] ?? '无法接受该邀请。');
        // Dead links have no page of their own, so send the user to the inbox
        // where the current invite (if any) lives.
        const dead =
          result.reason === 'not_pending' &&
          (result.status === INVITE_STATUS.SUPERSEDED ||
            result.status === INVITE_STATUS.REVOKED);
        redirect(res, dead ? '/inbox' : `/invite/${encodeURIComponent(token)}`);
        return;
      }

      const inviteMatch = path.match(/^\/invite\/([^/]+)$/);
      if (req.method === 'GET' && inviteMatch) {
        const ctx = context(req);
        const token = inviteMatch[1];
        const invite = store.findInviteByToken(token);
        if (!invite) {
          send(
            res,
            404,
            errorPage({
              user: ctx.user,
              csrf: ctx.csrf,
              title: '邀请链接不可用',
              message: '该链接无效或已被新的邀请替代，请到本地收件箱查看最新邀请。',
            }),
          );
          return;
        }
        const teamName = store.getTeam(invite.teamId)?.name ?? '未知团队';

        // A superseded link is no longer a valid invite: the link itself must
        // not open, so the user is sent to their inbox for the current one.
        if (invite.status === INVITE_STATUS.SUPERSEDED) {
          send(
            res,
            404,
            errorPage({
              user: ctx.user,
              csrf: ctx.csrf,
              title: '邀请链接已失效',
              message: '该邀请已被同一团队的新邀请替代，请到本地收件箱打开最新邀请。',
            }),
          );
          return;
        }
        if (invite.status === INVITE_STATUS.REVOKED) {
          send(
            res,
            410,
            errorPage({
              user: ctx.user,
              csrf: ctx.csrf,
              title: '邀请已撤销',
              message: '该邀请已被管理员撤销，无法再接受。',
            }),
          );
          return;
        }

        const canAccept =
          Boolean(ctx.user) &&
          invite.email === ctx.user.email &&
          ctx.user.emailVerified;
        let blockReason = null;
        if (ctx.user && invite.status === INVITE_STATUS.PENDING) {
          if (invite.email !== ctx.user.email) blockReason = 'email_mismatch';
          else if (!ctx.user.emailVerified) blockReason = 'email_unverified';
        }
        let notice = null;
        if (invite.status === INVITE_STATUS.ACCEPTED) notice = '该邀请已被接受。';
        const alreadyMember =
          Boolean(ctx.user) && Boolean(store.findMembership(invite.teamId, ctx.user.id));
        send(
          res,
          200,
          invitePage({
            user: ctx.user,
            csrf: ctx.csrf,
            invite: {
              email: invite.email,
              role: invite.role,
              status: invite.status,
            },
            token,
            teamName,
            statusLabels,
            toLogin: `/login?next=${encodeURIComponent(`/invite/${token}`)}`,
            notice,
            canAccept,
            alreadyMember,
            blockReason,
            unread: ctx.unread,
            flash: ctx.flash,
          }),
        );
        return;
      }

      send(
        res,
        404,
        errorPage({ user: null, title: '页面不存在', message: '你访问的地址不存在。' }),
      );
    } catch (error) {
      const status = error.statusCode ?? 500;
      if (status >= 500) console.error('[gsb2] request failed:', error);
      send(
        res,
        status,
        errorPage({
          status,
          title: status === 413 ? '请求过大' : '服务器错误',
          message: status === 413 ? '提交的内容超出限制。' : '处理请求时出现错误，请稍后重试。',
        }),
      );
    }
  };
}

function safeNext(next, user) {
  // Only allow a plain same-origin absolute path: reject protocol-relative
  // URLs, backslashes, and control characters that could break the Location
  // header or be reinterpreted by browsers.
  const fallback = user.role === 'admin' ? '/admin' : '/inbox';
  if (typeof next !== 'string' || next.length > 512) return fallback;
  if (!next.startsWith('/') || next.startsWith('//')) return fallback;
  // base64url tokens use '-', '_', and '~', so they must be allowed too.
  if (!/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%?]*$/.test(next)) return fallback;
  return next;
}

export function createApp({ dataFile = null, seed = true, secureCookies = false } = {}) {
  const store = new Store({ filePath: dataFile, seed });
  const sessions = new SessionStore();
  const handler = createHandler({ store, sessions, secureCookies });
  return { store, sessions, handler };
}

export function startServer({ port = 3000, dataFile = null, host = '127.0.0.1' } = {}) {
  const app = createApp({ dataFile });
  const server = createServer(app.handler);
  server.listen(port, host, () => {
    const { port: actual } = server.address();
    console.log(`GSB2 项目组入驻页面已启动: http://${host}:${actual}`);
    console.log('管理员账号: admin@gsb2.local / admin123');
  });
  return { ...app, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const dataFile = process.env.DATA_FILE ?? new URL('../data/store.json', import.meta.url).pathname;
  startServer({ port, dataFile });
}
