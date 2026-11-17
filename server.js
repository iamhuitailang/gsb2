import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './lib/session.js';
import { createDomain, DomainError } from './lib/domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const COOKIE = 'gsb_sid';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  send(res, 303, '', { Location: location, ...headers });
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new DomainError('payload_too_large', '请求内容过大', 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

export function createServer({ clock } = {}) {
  const domain = createDomain({ clock });
  const sessions = new SessionStore();

  function currentUser(session) {
    return session?.userId ? domain.user(session.userId) : null;
  }

  function delegationOf(session) {
    if (!session?.delegation || !session.userId) return null;
    const d = domain.getDelegation(session.delegation.id);
    if (!d || d.agentId !== session.userId) {
      session.delegation = null;
      return null;
    }
    return d;
  }

  function checkCsrf(session, form) {
    return session && form.csrf && form.csrf === session.csrf;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      let session = sessions.get(cookies[COOKIE]);
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      // 首次访问时建立会话
      let setCookie = null;
      if (!session) {
        session = sessions.create();
        setCookie = `${COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Lax`;
      }
      const cookieHeaders = setCookie ? { 'Set-Cookie': setCookie } : {};

      if (pathname.startsWith('/assets/')) {
        const name = path.basename(pathname);
        const file = path.join(PUBLIC_DIR, name);
        try {
          const data = await readFile(file);
          res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(data);
        } catch {
          send(res, 404, page('未找到', '<p>资源不存在。</p>'));
        }
        return;
      }

      // ---- 身份切换（演示用，无密码） ----
      if (pathname === '/login' && req.method === 'GET') {
        const users = [...domain.listUsersByRole('customer'), ...domain.listUsersByRole('agent')];
        const list = users.map((u) => `
          <form method="post" action="/login" class="row">
            <input type="hidden" name="csrf" value="${session.csrf}">
            <input type="hidden" name="userId" value="${escapeHtml(u.id)}">
            <div class="who"><strong>${escapeHtml(u.name)}</strong>
              <span class="muted">${u.role === 'customer' ? '客户' : `客服 · ${escapeHtml(u.team ?? '')}`}</span></div>
            <button type="submit">以此身份登录</button>
          </form>`).join('');
        const who = currentUser(session);
        return send(res, 200, page('选择身份', `
          ${who ? `<p class="muted">当前身份：${escapeHtml(who.name)}</p>` : ''}
          <p>这是本地演示后台，直接选择身份即可登录。</p>
          ${list}`, { user: who, csrf: session.csrf }), setCookie ? { 'Set-Cookie': setCookie } : {});
      }

      if (pathname === '/login' && req.method === 'POST') {
        const form = await readForm(req);
        if (!checkCsrf(session, form)) return send(res, 403, page('请求无效', '<p>CSRF 校验失败。</p>'));
        const user = domain.user(form.userId);
        if (!user) return send(res, 400, page('登录失败', '<p>用户不存在。</p>'));
        // 登录换发新会话：旧会话连同代办上下文一起废弃，避免会话固定与身份残留
        const fresh = sessions.rotate(session.id, user.id);
        return redirect(res, user.role === 'customer' ? '/customer' : '/agent', {
          'Set-Cookie': `${COOKIE}=${fresh.id}; Path=/; HttpOnly; SameSite=Lax`,
        });
      }

      if (pathname === '/logout' && req.method === 'POST') {
        const form = await readForm(req);
        if (!checkCsrf(session, form)) return send(res, 403, page('请求无效', '<p>CSRF 校验失败。</p>'));
        // 退出登录连同代办上下文一起销毁，客服会话里不留客户身份
        sessions.destroy(session.id);
        return redirect(res, '/login', {
          'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        });
      }

      const user = currentUser(session);
      if (!user) return redirect(res, '/login', cookieHeaders);

      // 客服代办上下文（客户身份仅存在于 session.delegation，独立于 userId）
      const deleg = user.role === 'agent' ? delegationOf(session) : null;
      const ctx = {
        user,
        delegation: deleg,
        delegationStatus: deleg ? domain.effectiveStatus(deleg) : null,
        csrf: session.csrf,
      };

      if (pathname === '/' ) {
        return redirect(res, user.role === 'customer' ? '/customer' : '/agent', cookieHeaders);
      }

      // 客服路由仅对客服本人开放；客户身份不能进入客服工作台（含代办相关页面）
      if (pathname === '/agent' || pathname.startsWith('/agent/')) {
        if (user.role !== 'agent') {
          return send(res, 403, page('无权访问', '<p>该页面需要客服账号。</p>', ctx), cookieHeaders);
        }
      }

      // ================= 客户页面 =================
      if (user.role === 'customer') {
        if (pathname === '/customer' && req.method === 'GET') {
          return send(res, 200, customerHome(domain, user, session, null, url.searchParams.get('msg')), cookieHeaders);
        }
        if (pathname === '/customer/delegate' && req.method === 'POST') {
          const form = await readForm(req);
          if (!checkCsrf(session, form)) return send(res, 403, page('请求无效', '<p>CSRF 校验失败。</p>'));
          try {
            const d = domain.issueDelegation({
              customerId: user.id,
              agentId: form.agentId,
              orderId: form.orderId,
              ttlMinutes: form.ttlMinutes,
            });
            return redirect(res, `/customer?msg=${encodeURIComponent(`已生成授权 ${d.id}，截止 ${d.expiresAt}`)}`, cookieHeaders);
          } catch (err) {
            if (!(err instanceof DomainError)) throw err;
            return send(res, err.httpStatus, customerHome(domain, user, session, err.message), cookieHeaders);
          }
        }
        if (pathname === '/customer/cancel' && req.method === 'POST') {
          const form = await readForm(req);
          if (!checkCsrf(session, form)) return send(res, 403, page('请求无效', '<p>CSRF 校验失败。</p>'));
          try {
            domain.cancelDelegation({ customerId: user.id, delegationId: form.delegationId });
            return redirect(res, `/customer?msg=${encodeURIComponent('授权已取消，客服手上的表单将无法提交')}`, cookieHeaders);
          } catch (err) {
            if (!(err instanceof DomainError)) throw err;
            return send(res, err.httpStatus, customerHome(domain, user, session, err.message), cookieHeaders);
          }
        }
        if (pathname.startsWith('/customer/orders/') && req.method === 'GET') {
          const orderId = decodeURIComponent(pathname.split('/')[3] ?? '');
          const order = domain.getOrder(orderId);
          if (!order || order.customerId !== user.id) return send(res, 404, page('未找到', '<p>订单不存在。</p>'), cookieHeaders);
          return send(res, 200, customerOrder(domain, user, order, session), cookieHeaders);
        }
        if (pathname === '/customer/audit' && req.method === 'GET') {
          return send(res, 200, auditPage(domain, user, domain.auditForCustomer(user.id), session, '我的订单相关操作记录'), cookieHeaders);
        }
        return send(res, 404, page('未找到', '<p>页面不存在。</p>', ctx), cookieHeaders);
      }

      // ================= 客服页面 =================
      if (pathname === '/agent' && req.method === 'GET') {
        return send(res, 200, agentHome(domain, user, session, ctx, url.searchParams), cookieHeaders);
      }

      if (pathname === '/agent/enter' && req.method === 'POST') {
        const form = await readForm(req);
        if (!checkCsrf(session, form)) return send(res, 403, page('请求无效', '<p>CSRF 校验失败。</p>'));
        try {
          const d = domain.enterDelegation({ agentId: user.id, delegationId: form.delegationId });
          session.delegation = { id: d.id };
          return redirect(res, '/agent/after-sales/new', cookieHeaders);
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
          return send(res, err.httpStatus, agentHome(domain, user, session, ctx, new URLSearchParams({ msg: err.message })), cookieHeaders);
        }
      }

      if (pathname === '/agent/exit' && req.method === 'POST') {
        const form = await readForm(req);
        if (!checkCsrf(session, form)) return send(res, 403, page('请求无效', '<p>CSRF 校验失败。</p>'));
        if (session.delegation) {
          try {
            domain.exitDelegation({ agentId: user.id, delegationId: session.delegation.id });
          } catch (err) {
            if (!(err instanceof DomainError)) throw err;
          }
          // 退出代办：清掉整段代办上下文，客服会话里不残留客户身份
          session.delegation = null;
        }
        return redirect(res, '/agent', cookieHeaders);
      }

      if (pathname === '/agent/after-sales/new' && req.method === 'GET') {
        if (!deleg) return redirect(res, '/agent', cookieHeaders);
        const status = domain.effectiveStatus(deleg);
        if (status === 'submitted') {
          const original = deleg.applicationId ? domain.getApplication(deleg.applicationId) : null;
          if (original) {
            return send(res, 200, applicationResult(domain, user, original, session, {
              notice: '该授权已提交过申请，以下为原申请结果（未重复创建）。',
              replayed: true,
              deleg,
            }), cookieHeaders);
          }
        }
        return send(res, 200, afterSalesForm(domain, user, deleg, session, { status }), cookieHeaders);
      }

      if (pathname === '/agent/after-sales' && req.method === 'POST') {
        if (!deleg) return send(res, 409, page('不在代办状态', '<p>当前会话没有代办授权，请从代办列表进入。</p>'), cookieHeaders);
        const form = await readForm(req);
        if (!checkCsrf(session, form)) return send(res, 403, page('请求无效', '<p>CSRF 校验失败。</p>'), cookieHeaders);
        try {
          // 关键：客户身份（代谁提交）与授权编号都从服务端授权记录读取，
          // 不接受表单里的任何身份字段，避免篡改。
          const { application, replayed } = domain.submitAfterSale({
            agentId: user.id,
            delegationId: deleg.id,
            orderId: form.orderId,
            reason: form.reason,
            solution: form.solution,
            contact: form.contact,
          });
          const notice = replayed
            ? '该授权已提交过申请，以下为原申请结果（未重复创建）。'
            : '售后申请已提交。';
          return send(res, 200, applicationResult(domain, user, application, session, { notice, replayed, deleg }), cookieHeaders);
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
          return send(res, err.httpStatus, afterSalesForm(domain, user, deleg, session, {
            status: domain.effectiveStatus(deleg),
            values: form,
            error: err.message,
          }), cookieHeaders);
        }
      }

      if (pathname.startsWith('/agent/after-sales/') && req.method === 'GET') {
        const id = decodeURIComponent(pathname.split('/')[3] ?? '');
        const app = domain.getApplication(id);
        if (!app) return send(res, 404, page('未找到', '<p>申请不存在。</p>', ctx), cookieHeaders);
        if (app.submittedBy !== user.id) return send(res, 403, page('无权查看', '<p>只能查看自己提交的申请。</p>', ctx), cookieHeaders);
        return send(res, 200, applicationResult(domain, user, app, session, { notice: '申请详情' }), cookieHeaders);
      }

      if (pathname === '/agent/audit' && req.method === 'GET') {
        return send(res, 200, auditPage(domain, user, domain.auditForAgent(user.id), session, '我的操作记录（含代办）', ctx), cookieHeaders);
      }

      return send(res, 404, page('未找到', '<p>页面不存在。</p>', ctx), cookieHeaders);
    } catch (err) {
      if (err instanceof DomainError) {
        return send(res, err.httpStatus, page('操作被拒绝', `<p class="error">${escapeHtml(err.message)}</p>`));
      }
      console.error(err);
      send(res, 500, page('服务器错误', '<p class="error">出现了未预期的问题。</p>'));
    }
  });

  return server;
}

/* ============================ 页面渲染 ============================ */

function banner(ctx) {
  if (!ctx?.user) return '';
  if (ctx.delegation) {
    const d = ctx.delegation;
    return `<div class="banner delegated">
      <div><strong>代办中</strong> ${statPill(ctx.delegationStatus ?? d.status)} — 正在以客户 <strong>${escapeHtml(d.customerName)}</strong> 的身份处理订单
        <strong>${escapeHtml(d.orderNo)}</strong>（仅限售后申请）</div>
      <div class="muted">授权编号 ${escapeHtml(d.id)} · 截止 ${escapeHtml(d.expiresAt)}</div>
      <div class="muted full">代办状态仅开放“售后申请”流程；其他页面仍以客服 ${escapeHtml(ctx.user.name)} 本人身份访问。</div>
      <form method="post" action="/agent/exit"><input type="hidden" name="csrf" value="${ctx.csrf}">
        <button type="submit" class="ghost">退出代办</button></form>
    </div>`;
  }
  return '';
}

function nav(ctx) {
  const u = ctx?.user;
  if (!u) return '';
  const items = u.role === 'customer'
    ? [['/customer', '我的订单'], ['/customer/audit', '操作记录']]
    : [['/agent', '客服工作台'], ['/agent/audit', '操作记录']];
  return `<nav>${items.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}
    <span class="spacer"></span>
    <span class="muted">${escapeHtml(u.name)} · ${u.role === 'customer' ? '客户' : '客服'}</span>
    <form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${ctx.csrf}">
      <button type="submit" class="ghost">退出登录</button></form>
  </nav>`;
}

function page(title, body, ctx = {}) {
  const ctxWithCsrf = { ...ctx, csrf: ctx.csrf };
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 售后代办演示</title>
<link rel="stylesheet" href="/assets/app.css"></head>
<body>
${nav(ctxWithCsrf)}
${banner(ctxWithCsrf)}
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body></html>`;
}

function statPill(status) {
  const map = {
    active: ['可用', 'ok'],
    submitted: ['已提交', 'done'],
    cancelled: ['已取消', 'off'],
    expired: ['已过期', 'off'],
  };
  const [label, cls] = map[status] ?? [status, 'off'];
  return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
}

function customerHome(domain, user, session, error, msg) {
  const agents = domain.listUsersByRole('agent');
  const orders = domain.listOrdersForCustomer(user.id);
  const delegations = domain.listDelegationsForCustomer(user.id);
  const apps = domain.listApplicationsForCustomer(user.id);
  const ctx = { user, csrf: session.csrf };

  const orderRows = orders.map((o) => `
    <tr>
      <td><a href="/customer/orders/${encodeURIComponent(o.id)}">${escapeHtml(o.no)}</a></td>
      <td>${escapeHtml(o.title)}</td>
      <td>¥${o.amount.toFixed(2)}</td>
      <td>${escapeHtml(o.status)}</td>
    </tr>`).join('');

  const dlgRows = delegations.map((d) => {
    const status = domain.effectiveStatus(d);
    const cancelBtn = status === 'active'
      ? `<form method="post" action="/customer/cancel" class="inline">
           <input type="hidden" name="csrf" value="${session.csrf}">
           <input type="hidden" name="delegationId" value="${escapeHtml(d.id)}">
           <button type="submit" class="danger">取消授权</button></form>`
      : '';
    return `<tr>
      <td><code>${escapeHtml(d.id)}</code></td>
      <td>客服 ${escapeHtml(d.agentName)}</td>
      <td>订单 ${escapeHtml(d.orderNo)}</td>
      <td>${escapeHtml(d.scopeText)}</td>
      <td>${escapeHtml(d.createdAt.replace('T', ' ').slice(0, 19))} → ${escapeHtml(d.expiresAt.replace('T', ' ').slice(0, 19))}</td>
      <td>${statPill(status)}</td>
      <td>${cancelBtn}</td>
    </tr>`;
  }).join('');

  const appRows = apps.map((a) => `<tr>
      <td><code>${escapeHtml(a.id)}</code></td>
      <td>订单 ${escapeHtml(a.orderNo)}</td>
      <td>${escapeHtml(a.reason)}</td>
      <td><strong>${escapeHtml(a.submittedByName)}</strong><br><span class="muted">代 ${escapeHtml(a.customerName)} 提交</span></td>
      <td><code>${escapeHtml(a.delegationId)}</code></td>
      <td>${escapeHtml(a.createdAt.replace('T', ' ').slice(0, 19))}</td>
    </tr>`).join('');

  return page('我的订单与授权', `
    ${msg ? `<p class="notice">${escapeHtml(msg)}</p>` : ''}
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <section class="card">
      <h2>我的订单</h2>
      <table><thead><tr><th>订单号</th><th>商品</th><th>金额</th><th>状态</th></tr></thead>
      <tbody>${orderRows}</tbody></table>
    </section>

    <section class="card">
      <h2>发起一次代办授权</h2>
      <p class="muted">授权仅对一笔订单的“${escapeHtml('售后申请（新建）')}”有效。</p>
      <form method="post" action="/customer/delegate" class="grid">
        <input type="hidden" name="csrf" value="${session.csrf}">
        <label>选择订单
          <select name="orderId">${orders.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.no)} · ${escapeHtml(o.title)}</option>`).join('')}</select>
        </label>
        <label>选择客服
          <select name="agentId">${agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}（${escapeHtml(a.team)}）</option>`).join('')}</select>
        </label>
        <label>有效时长（分钟）
          <input type="number" name="ttlMinutes" value="15" min="1" max="1440" required>
        </label>
        <div class="actions"><button type="submit">生成授权</button></div>
      </form>
    </section>

    <section class="card">
      <h2>授权记录</h2>
      ${delegations.length ? `<table><thead><tr><th>授权编号</th><th>客服</th><th>订单</th><th>范围</th><th>有效期</th><th>状态</th><th></th></tr></thead>
      <tbody>${dlgRows}</tbody></table>` : '<p class="muted">尚无授权记录。</p>'}
    </section>

    <section class="card">
      <h2>已提交的售后申请</h2>
      ${apps.length ? `<table><thead><tr><th>申请编号</th><th>订单</th><th>说明</th><th>实际操作人</th><th>授权编号</th><th>提交时间</th></tr></thead>
      <tbody>${appRows}</tbody></table>` : '<p class="muted">尚无售后申请。</p>'}
    </section>
  `, ctx);
}

function customerOrder(domain, user, order, session) {
  const apps = domain.listApplicationsForCustomer(user.id).filter((a) => a.orderId === order.id);
  const dlg = domain.listDelegationsForCustomer(user.id).filter((d) => d.orderId === order.id);
  return page(`订单 ${order.no}`, `
    <section class="card">
      <table>
        <tr><th>订单号</th><td>${escapeHtml(order.no)}</td></tr>
        <tr><th>商品</th><td>${escapeHtml(order.title)}</td></tr>
        <tr><th>金额</th><td>¥${order.amount.toFixed(2)}</td></tr>
        <tr><th>状态</th><td>${escapeHtml(order.status)}</td></tr>
      </table>
    </section>
    <section class="card"><h2>该订单的授权</h2>
      ${dlg.length ? `<table><thead><tr><th>授权编号</th><th>客服</th><th>状态</th><th>截止</th></tr></thead><tbody>
        ${dlg.map((d) => `<tr><td><code>${escapeHtml(d.id)}</code></td><td>${escapeHtml(d.agentName)}</td>
          <td>${statPill(domain.effectiveStatus(d))}</td><td>${escapeHtml(d.expiresAt.replace('T', ' ').slice(0, 19))}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">尚无授权。</p>'}
    </section>
    <section class="card"><h2>该订单的售后申请</h2>
      ${apps.length ? apps.map((a) => `<div class="app-box">
        <div><code>${escapeHtml(a.id)}</code> ${statPill('submitted')}</div>
        <p>${escapeHtml(a.reason)}</p>
        <p class="muted">由客服 <strong>${escapeHtml(a.submittedByName)}</strong> 代客户 ${escapeHtml(a.customerName)} 提交 ·
          授权编号 <code>${escapeHtml(a.delegationId)}</code> · ${escapeHtml(a.createdAt.replace('T', ' ').slice(0, 19))}</p>
      </div>`).join('') : '<p class="muted">尚无售后申请。</p>'}
    </section>`, { user, csrf: session.csrf });
}

function agentHome(domain, user, session, ctx, params) {
  const msg = params.get('msg');
  const delegations = domain.listDelegationsForAgent(user.id);
  const apps = domain.listApplicationsForAgent(user.id);
  const ctxWithCsrf = { ...ctx, csrf: session.csrf };

  const rows = delegations.map((d) => {
    const status = domain.effectiveStatus(d);
    let action = '';
    if (status === 'active') {
      action = `<form method="post" action="/agent/enter" class="inline">
        <input type="hidden" name="csrf" value="${session.csrf}">
        <input type="hidden" name="delegationId" value="${escapeHtml(d.id)}">
        <button type="submit">接手代办</button></form>`;
    } else if (status === 'submitted' && d.applicationId) {
      action = `<a class="button" href="/agent/after-sales/${encodeURIComponent(d.applicationId)}">查看申请</a>`;
    } else {
      action = '<span class="muted">不可用</span>';
    }
    return `<tr>
      <td><code>${escapeHtml(d.id)}</code></td>
      <td>${escapeHtml(d.customerName)}</td>
      <td>订单 ${escapeHtml(d.orderNo)}</td>
      <td>${escapeHtml(d.scopeText)}</td>
      <td>${escapeHtml(d.expiresAt.replace('T', ' ').slice(0, 19))}</td>
      <td>${statPill(status)}</td>
      <td>${action}</td>
    </tr>`;
  }).join('');

  const appRows = apps.map((a) => `<tr>
      <td><a href="/agent/after-sales/${encodeURIComponent(a.id)}"><code>${escapeHtml(a.id)}</code></a></td>
      <td>订单 ${escapeHtml(a.orderNo)}</td>
      <td>${escapeHtml(a.customerName)}</td>
      <td>${escapeHtml(a.reason)}</td>
      <td><code>${escapeHtml(a.delegationId)}</code></td>
    </tr>`).join('');

  return page('客服工作台', `
    ${msg ? `<p class="notice">${escapeHtml(msg)}</p>` : ''}
    <section class="card">
      <h2>发给我的代办授权</h2>
      ${delegations.length ? `<table><thead><tr><th>授权编号</th><th>客户</th><th>订单</th><th>范围</th><th>截止</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>` : '<p class="muted">目前没有客户授权给你。</p>'}
    </section>
    <section class="card">
      <h2>我提交的售后申请</h2>
      ${apps.length ? `<table><thead><tr><th>申请编号</th><th>订单</th><th>客户</th><th>说明</th><th>授权编号</th></tr></thead>
      <tbody>${appRows}</tbody></table>` : '<p class="muted">尚无记录。</p>'}
    </section>
  `, ctxWithCsrf);
}

function afterSalesForm(domain, user, deleg, session, { status, values = {}, error } = {}) {
  const order = domain.getOrder(deleg.orderId);
  const blocked = status !== 'active';
  const blockedText = status === 'cancelled'
    ? '客户已取消授权，本表单无法提交。'
    : status === 'expired'
      ? '授权已过期，本表单无法提交。'
      : status === 'submitted'
        ? '该授权已提交过申请。'
        : '';

  // 防止推进已完成的授权再次提交：submitted 时直接展示原结果由 POST 分支处理，
  // 这里在 GET 时也给出明确提示并禁用按钮。
  const formHtml = blocked ? `
    <p class="error">${escapeHtml(blockedText)}</p>
    <p class="muted">请返回工作台选择其他可用授权，或请客户重新发起授权。</p>
    <a class="button" href="/agent">返回工作台</a>
  ` : `
    <form method="post" action="/agent/after-sales" class="stack">
      <input type="hidden" name="csrf" value="${session.csrf}">
      <input type="hidden" name="orderId" value="${escapeHtml(deleg.orderId)}">
      <label>订单
        <input type="text" value="${escapeHtml(`${deleg.orderNo} · ${order.title}`)}" disabled>
      </label>
      <label>申请类型
        <input type="text" value="${escapeHtml('售后申请（新建）')}" disabled>
      </label>
      <label>申请说明（必填，4–500 字）
        <textarea name="reason" rows="5" maxlength="500" required>${escapeHtml(values.reason ?? '')}</textarea>
      </label>
      <label>期望处理方式
        <input type="text" name="solution" maxlength="200" value="${escapeHtml(values.solution ?? '')}" placeholder="如：换货 / 退货退款 / 维修">
      </label>
      <label>联系方式
        <input type="text" name="contact" maxlength="40" value="${escapeHtml(values.contact ?? '')}">
      </label>
      <p class="muted">提交后将以客户 <strong>${escapeHtml(deleg.customerName)}</strong> 的名义创建申请，
        记录实际操作人 <strong>${escapeHtml(user.name)}</strong> 与授权编号 <code>${escapeHtml(deleg.id)}</code>。</p>
      <div class="actions"><button type="submit">代客户提交售后申请</button></div>
    </form>`;

  return page('代客户提交售后申请', `
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <section class="card scope">
      <h2>本次代办范围</h2>
      <table>
        <tr><th>客户</th><td>${escapeHtml(deleg.customerName)}</td></tr>
        <tr><th>授权编号</th><td><code>${escapeHtml(deleg.id)}</code></td></tr>
        <tr><th>可代办范围</th><td>${escapeHtml(deleg.scopeText)}（仅开放售后流程）</td></tr>
        <tr><th>截止时间</th><td>${escapeHtml(deleg.expiresAt.replace('T', ' ').slice(0, 19))} ${statPill(status)}</td></tr>
      </table>
    </section>
    <section class="card">
      ${formHtml}
    </section>
  `, { user, csrf: session.csrf, delegation: deleg, delegationStatus: status });
}

function applicationResult(domain, user, app, session, { notice, replayed = false, deleg = null, delegationStatus = null }) {
  const ctx = {
    user,
    csrf: session.csrf,
    delegation: deleg,
    delegationStatus: delegationStatus ?? (deleg ? domain.effectiveStatus(deleg) : null),
  };
  return page('售后申请结果', `
    <p class="${replayed ? 'notice' : 'success'}">${escapeHtml(notice)}</p>
    <section class="card">
      <table>
        <tr><th>申请编号</th><td><code>${escapeHtml(app.id)}</code></td></tr>
        <tr><th>订单</th><td>${escapeHtml(app.orderNo)}</td></tr>
        <tr><th>客户身份</th><td>${escapeHtml(app.customerName)}（${escapeHtml(app.customerId)}）</td></tr>
        <tr><th>实际提交客服</th><td>${escapeHtml(app.submittedByName)}（${escapeHtml(app.submittedBy)}）</td></tr>
        <tr><th>授权编号</th><td><code>${escapeHtml(app.delegationId)}</code></td></tr>
        <tr><th>申请说明</th><td>${escapeHtml(app.reason)}</td></tr>
        ${app.solution ? `<tr><th>期望处理</th><td>${escapeHtml(app.solution)}</td></tr>` : ''}
        ${app.contact ? `<tr><th>联系方式</th><td>${escapeHtml(app.contact)}</td></tr>` : ''}
        <tr><th>状态</th><td>${statPill('submitted')}</td></tr>
        <tr><th>提交时间</th><td>${escapeHtml(app.createdAt.replace('T', ' ').slice(0, 19))}</td></tr>
      </table>
      <div class="actions"><a class="button" href="/agent">返回工作台</a></div>
    </section>
  `, ctx);
}

function auditPage(domain, user, entries, session, title, ctx = {}) {
  const rows = entries.map((e) => `<tr>
      <td>${escapeHtml(e.at.replace('T', ' ').slice(0, 19))}</td>
      <td>${escapeHtml(e.action)}</td>
      <td><strong>${escapeHtml(e.actorName)}</strong> <span class="muted">(${escapeHtml(e.actorRole)})</span></td>
      <td>${e.onBehalfOfName ? `${escapeHtml(e.onBehalfOfName)} <span class="muted">(客户)</span>` : '<span class="muted">—</span>'}</td>
      <td>${e.delegationId ? `<code>${escapeHtml(e.delegationId)}</code>` : '<span class="muted">—</span>'}</td>
      <td>${escapeHtml(e.detail)}</td>
    </tr>`).join('');

  return page(title, `
    <section class="card">
      ${entries.length ? `<table><thead><tr><th>时间</th><th>动作</th><th>操作人</th><th>代谁操作</th><th>授权编号</th><th>说明</th></tr></thead>
      <tbody>${rows}</tbody></table>` : '<p class="muted">暂无记录。</p>'}
    </section>
  `, { ...ctx, user, csrf: session.csrf });
}

export { createDomain };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`售后代办演示后台已启动: http://127.0.0.1:${port}/login`);
  });
}
