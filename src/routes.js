import {
  html, redirect, json, parseBody, sameOrigin, cookie, clearCookie,
} from './http.js';
import { randomToken, hashToken } from './store.js';
import { resolveAuth } from './security.js';
import { DUTY_SCHEDULE } from './duty-data.js';
import {
  page, loginView, waitingView, confirmErrorView, confirmPromptView,
  inboxView, dashboardView, dutyView, securityView, errorView, esc,
} from './views.js';

const DID_MAX_AGE = 365 * 24 * 60 * 60;

export function createRouter(store) {
  async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;
    const auth = resolveAuth(store, req);

    try {
      // ---- 公开页面 ----
      if (method === 'GET' && path === '/health') return json(res, 200, { ok: true });

      if (method === 'GET' && path === '/login') {
        if (auth.mode === 'session') return redirect(res, '/');
        if (auth.mode === 'pending') return redirect(res, '/login/waiting');
        return html(res, 200, loginView());
      }

      if (method === 'POST' && path === '/login') {
        if (!sameOrigin(req)) return json(res, 403, { error: '跨站请求被拒绝' });
        return handleLogin(req, res, auth);
      }

      if (method === 'GET' && path === '/login/waiting') {
        if (auth.mode === 'session') return redirect(res, '/');
        if (auth.mode !== 'pending') return redirect(res, '/login');
        return html(res, 200, waitingView(auth));
      }

      if (method === 'GET' && path === '/login/confirm') {
        return handleConfirmGet(req, res, url, auth);
      }
      if (method === 'POST' && path === '/login/confirm') {
        if (!sameOrigin(req)) return json(res, 403, { error: '跨站请求被拒绝' });
        return handleConfirmPost(req, res, url, auth);
      }

      if (method === 'GET' && path === '/api/login-status') {
        if (auth.mode === 'session') return json(res, 200, { mode: 'session' });
        if (auth.mode === 'pending') {
          return json(res, 200, { mode: 'pending', expiresAt: auth.pending.expiresAt });
        }
        return json(res, 200, { mode: 'anonymous' });
      }

      // ---- 模拟收件箱：匿名/等待/正式登录都可读（模拟本地邮箱），写操作需同源 ----
      if (method === 'GET' && path === '/inbox') {
        return html(res, 200, inboxView(auth, getVisibleMessages(auth)));
      }
      if (method === 'GET' && path === '/api/inbox') {
        return json(res, 200, { messages: getVisibleMessages(auth) });
      }
      if (method === 'POST' && path === '/inbox/read') {
        if (!sameOrigin(req)) return json(res, 403, { error: '跨站请求被拒绝' });
        if (auth.mode === 'anonymous') return html(res, 401, errorView(auth, 401, '请先登录'));
        const body = await parseBody(req);
        store.markMessageRead(String(body.id || ''), auth.user.id);
        store.save();
        if (String(body.ajax || '') === '1') return json(res, 200, { ok: true });
        return redirect(res, '/inbox');
      }

      // ---- 正式会话才能访问的区域 ----
      if (method === 'GET' && path === '/') {
        if (auth.mode === 'pending') return redirect(res, '/login/waiting');
        if (auth.mode === 'anonymous') return redirect(res, '/login');
        return html(res, 200, dashboardView(auth));
      }

      if (method === 'GET' && path === '/duty') {
        if (auth.mode !== 'session') return html(res, 403, errorView(auth, 403, '设备确认通过前不能查看值班数据'));
        return html(res, 200, dutyView(auth, DUTY_SCHEDULE));
      }

      if (method === 'GET' && path === '/api/duty') {
        if (auth.mode !== 'session') {
          return json(res, 403, { error: '设备确认通过前不能查询值班数据' });
        }
        return json(res, 200, DUTY_SCHEDULE);
      }

      if (method === 'GET' && path === '/security') {
        if (auth.mode !== 'session') return html(res, 403, errorView(auth, 403, '请先完成登录与设备确认'));
        return html(res, 200, securityView(auth, auth.user.devices));
      }

      if (method === 'POST' && path === '/security/revoke') {
        if (!sameOrigin(req)) return json(res, 403, { error: '跨站请求被拒绝' });
        if (auth.mode !== 'session') return json(res, 403, { error: '无权限' });
        const body = await parseBody(req);
        const target = auth.user.devices.find((d) => d.id === String(body.deviceId || ''));
        if (!target) return json(res, 404, { error: '设备不存在' });
        target.trusted = false;
        target.trustedAt = null;
        store.save();
        return respondAction(req, res, '/security', { ok: true, deviceId: target.id });
      }

      if (method === 'POST' && path === '/security/rename') {
        if (!sameOrigin(req)) return json(res, 403, { error: '跨站请求被拒绝' });
        if (auth.mode !== 'session') return json(res, 403, { error: '无权限' });
        const body = await parseBody(req);
        const target = auth.user.devices.find((d) => d.id === String(body.deviceId || ''));
        if (!target) return json(res, 404, { error: '设备不存在' });
        const name = String(body.name || '').trim();
        if (!name) return json(res, 400, { error: '名称不能为空' });
        target.name = name.slice(0, 40);
        store.save();
        return respondAction(req, res, '/security', { ok: true });
      }

      if (method === 'POST' && path === '/logout') {
        if (auth.mode === 'session') {
          store.state.sessions = store.state.sessions.filter((s) => s.tokenHash !== auth.session.tokenHash);
        }
        if (auth.mode === 'pending') {
          auth.pending.status = 'superseded';
        }
        store.save();
        res.writeHead(302, {
          Location: '/login',
          'Set-Cookie': [clearCookie('sid'), clearCookie('psid')],
        });
        return res.end();
      }

      return html(res, 404, errorView(auth, 404, '页面不存在'));
    } catch (err) {
      const status = err.status || 500;
      const message = status === 500 ? '服务器内部错误' : err.message;
      if (status === 500) console.error(err);
      const acceptsJson = (req.headers.accept || '').includes('application/json') || path.startsWith('/api/');
      if (acceptsJson) return json(res, status, { error: message });
      return html(res, status, errorView(auth, status, message));
    }
  }

  // 收件箱里匿名访客看不到任何人的邮件；已登录（含等待中）只看到自己的
  function getVisibleMessages(auth) {
    if (auth.mode === 'anonymous') return [];
    return store.messagesForUser(auth.user.id);
  }

  async function handleLogin(req, res, auth) {
    const body = await parseBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const remember = body.remember === '1' || body.remember === 'true' || body.remember === true;
    const deviceName = String(body.deviceName || '').trim() || '未命名设备';

    const user = store.findUserByName(username);
    if (!user || !store.verifyPassword(user, password)) {
      return html(res, 401, loginView('账号或密码错误'));
    }

    // did 标识“这台浏览器”；首次访问没有就签发一个长期 cookie
    const cookies = (req.headers.cookie || '');
    let did = /(?:^|;\s*)did=([^;]+)/.exec(cookies)?.[1];
    did = did ? decodeURIComponent(did) : null;
    let device = did && store.findDevice(user, did);
    if (!device) {
      did = randomToken(16);
      device = store.registerDevice(user, { id: did, name: deviceName });
    } else if (deviceName !== '未命名设备') {
      device.name = deviceName; // 用户重新填了名称就更新
    }

    // 已信任设备：直接建立正式会话，走普通流程
    if (device.trusted) {
      const { raw } = store.createSession(user, device);
      store.save();
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': [
          cookie('sid', raw, { maxAge: 12 * 60 * 60 }),
          cookie('did', did, { maxAge: DID_MAX_AGE }),
          clearCookie('psid'),
        ],
      });
      return res.end();
    }

    // 未信任设备：只建立“等待确认”的临时会话，不生成正式 sid
    const pending = store.createPendingLogin({ user, device, remember });
    store.addMessage(user, pending);
    store.save();
    res.writeHead(302, {
      Location: '/login/waiting',
      'Set-Cookie': [
        cookie('psid', pending.psRaw, { maxAge: 600 }),
        cookie('did', did, { maxAge: DID_MAX_AGE }),
        clearCookie('sid'),
      ],
    });
    return res.end();
  }

  // 确认前的三重校验：token 有效 + 属于当前等待中的登录 + 与本浏览器 did/psid 绑定
  function loadPendingForConfirm(auth, token) {
    const byToken = store.state.pendingLogins.find((p) => p.confirmTokenHash === hashToken(token));
    if (!byToken) return { error: '确认链接不存在或已被使用' };
    if (byToken.status !== 'waiting') {
      return { error: '该确认链接对应的登录已失效（已被使用或被新的登录取代）' };
    }
    if (byToken.expiresAt <= Date.now()) {
      byToken.status = 'expired';
      store.save();
      return { error: '确认链接已过期，请重新登录' };
    }
    if (auth.mode !== 'pending' || auth.pending.id !== byToken.id) {
      return { error: '该链接属于另一次登录或另一台浏览器，不能在当前浏览器确认' };
    }
    return { rec: byToken };
  }

  async function handleConfirmGet(req, res, url, auth) {
    const token = url.searchParams.get('token') || '';
    const result = loadPendingForConfirm(auth, token);
    if (result.error) return html(res, 400, confirmErrorView(auth, result.error));
    return html(res, 200, confirmPromptView(auth, token));
  }

  async function handleConfirmPost(req, res, url, auth) {
    const token = url.searchParams.get('token') || '';
    const result = loadPendingForConfirm(auth, token);
    if (result.error) return html(res, 400, confirmErrorView(auth, result.error));

    const rec = result.rec;
    const { user, device } = auth;
    if (rec.remember) {
      device.trusted = true;
      device.trustedAt = Date.now();
    }
    rec.status = 'confirmed';
    rec.confirmedAt = Date.now();
    const { raw } = store.createSession(user, device);
    store.save();

    res.writeHead(303, {
      Location: '/',
      'Set-Cookie': [
        cookie('sid', raw, { maxAge: 12 * 60 * 60 }),
        clearCookie('psid'),
        cookie('did', device.id, { maxAge: DID_MAX_AGE }),
      ],
    });
    return res.end();
  }

  function respondAction(req, res, fallback, payload) {
    const accept = req.headers.accept || '';
    if (accept.includes('application/json')) return json(res, 200, payload);
    return redirect(res, fallback);
  }

  return handler;
}
