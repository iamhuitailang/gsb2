// 本地演示后台服务：零依赖，node src/server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

// token -> { userId, actingAuthId }  代办只是会话上的一个受控标记
const sessions = new Map();

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(store.httpError(413, '请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(store.httpError(400, 'JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}
function getSession(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  return token ? sessions.get(token) || null : null;
}
// 结算当前会话的代办状态：
// - 授权失效（取消/过期）：带 blockedReason，服务端拒绝其代办动作
// - 授权已消费（已成功提交）：不带 blockedReason，保留会话以便重复点击回放原申请
function resolveActing(session) {
  if (!session?.actingAuthId) return null;
  const auth = store.getAuth(session.actingAuthId);
  if (!auth) return null;
  if (auth.status === 'active' || auth.status === 'consumed') return auth;
  return { ...auth, blockedReason: store.statusText(auth.status) };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // ---------- 静态资源 ----------
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end('Not Found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }

    const session = getSession(req);
    const me = session ? store.getUser(session.userId) : null;
    const acting = resolveActing(session);
    const requireLogin = () => {
      if (!me) throw store.httpError(401, '未登录或会话已失效');
      return me;
    };
    const requireRole = (role) => {
      const u = requireLogin();
      if (u.role !== role) throw store.httpError(403, '当前身份无权访问该功能');
      return u;
    };
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

    // ---------- 登录 / 退出 ----------
    if (p === '/api/login' && req.method === 'POST') {
      const user = store.getUser(body.userId);
      if (!user) throw store.httpError(400, '用户不存在');
      const token = crypto.randomBytes(16).toString('hex');
      sessions.set(token, { userId: user.id, actingAuthId: null });
      store.addAudit({ actorId: user.id, action: 'login', detail: { via: '本地演示登录' } });
      return send(res, 200, { token, user });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : null;
      if (session) {
        // 退出代办/登出时，客户身份不得残留在客服会话里
        store.addAudit({
          actorId: session.userId,
          action: 'logout',
          detail: { hadActing: Boolean(session.actingAuthId) }
        });
      }
      if (token) sessions.delete(token);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/me' && req.method === 'GET') {
      requireLogin();
      return send(res, 200, { user: me, acting });
    }

    // ---------- 订单 ----------
    if (p === '/api/orders' && req.method === 'GET') {
      requireLogin();
      const orders =
        me.role === 'customer'
          ? store.listOrders(me.id)
          : store.listOrders().map((o) => ({ ...o, customer: store.getUser(o.customerId) }));
      return send(res, 200, { orders });
    }

    if (p.startsWith('/api/orders/') && req.method === 'GET') {
      requireLogin();
      const id = p.split('/').pop();
      const order = store.getOrder(id);
      if (!order) throw store.httpError(404, '订单不存在');
      if (me.role === 'customer' && order.customerId !== me.id) {
        throw store.httpError(403, '只能查看自己的订单');
      }
      return send(res, 200, {
        order: { ...order, customer: store.getUser(order.customerId) },
        auth:
          me.role === 'customer'
            ? store.listAuths({ customerId: me.id, orderId: id })[0] || null
            : null,
        aftersales: store.listAftersales({ orderId: id })
      });
    }

    // ---------- 客户：发起 / 取消授权 ----------
    if (p === '/api/authorizations' && req.method === 'POST') {
      const customer = requireRole('customer');
      const created = store.createAuth({
        customerId: customer.id,
        agentId: body.agentId,
        orderId: body.orderId,
        ttlMinutes: Number(body.ttlMinutes) || 10,
        scope: ['aftersale:submit'] // 仅用于某笔订单的代办授权：范围固定为该订单的售后提交
      });
      store.addAudit({
        actorId: customer.id,
        action: 'auth.create',
        detail: {
          authId: created.id,
          orderId: created.orderId,
          agentId: created.agentId,
          scope: created.scope,
          expiresAt: new Date(created.expiresAt).toISOString()
        }
      });
      return send(res, 201, { auth: created });
    }

    if (p === '/api/authorizations' && req.method === 'GET') {
      requireLogin();
      const filter =
        me.role === 'customer' ? { customerId: me.id } : me.role === 'agent' ? { agentId: me.id } : {};
      return send(res, 200, { auths: store.listAuths(filter) });
    }

    if (p.startsWith('/api/authorizations/') && p.endsWith('/cancel') && req.method === 'POST') {
      const customer = requireRole('customer');
      const authId = p.split('/')[3];
      const auth = store.getAuth(authId);
      if (!auth) throw store.httpError(404, '授权不存在');
      if (auth.customerId !== customer.id) throw store.httpError(403, '只能取消自己发起的授权');
      const canceled = store.cancelAuth(authId, customer.id);
      store.addAudit({
        actorId: customer.id,
        action: 'auth.cancel',
        detail: { authId, orderId: canceled.orderId, agentId: canceled.agentId }
      });
      return send(res, 200, { auth: canceled });
    }

    // ---------- 客服：接手 / 退出代办 ----------
    if (p === '/api/acting/enter' && req.method === 'POST') {
      const agent = requireRole('agent');
      if (session.actingAuthId) throw store.httpError(409, '当前已在代办中，请先退出');
      const auth = store.takeUpAuth(body.authId, agent.id);
      session.actingAuthId = auth.id;
      store.addAudit({
        actorId: agent.id,
        action: 'acting.enter',
        detail: { authId: auth.id, customerId: auth.customerId, orderId: auth.orderId }
      });
      return send(res, 200, { auth, acting: store.getAuth(auth.id) });
    }

    if (p === '/api/acting/exit' && req.method === 'POST') {
      requireRole('agent');
      const prev = session.actingAuthId;
      if (!prev) return send(res, 200, { ok: true });
      session.actingAuthId = null; // 清除客户身份标记
      store.addAudit({
        actorId: me.id,
        action: 'acting.exit',
        detail: { authId: prev }
      });
      return send(res, 200, { ok: true });
    }

    // ---------- 售后：客服代办提交（幂等） ----------
    if (p === '/api/aftersales' && req.method === 'POST') {
      const agent = requireRole('agent');
      if (!session.actingAuthId) {
        throw store.httpError(403, '不在代办状态，不能以客户身份提交售后');
      }
      // 幂等前置：该授权已提交成功，再点一次只返回原申请结果
      const existing = store.findAftersaleByAuth(session.actingAuthId);
      if (existing) {
        store.addAudit({
          actorId: agent.id,
          action: 'aftersale.submit',
          detail: {
            aftersaleId: existing.id,
            authId: existing.authId,
            customerId: existing.customerId,
            orderId: existing.orderId,
            duplicated: true
          }
        });
        return send(res, 200, { aftersale: existing, duplicated: true });
      }
      const live = store.getAuth(session.actingAuthId);
      if (!live || live.status !== 'active') {
        // 客户取消 / 过期：手上已打开的表单不能提交
        session.actingAuthId = null;
        throw store.httpError(
          409,
          `授权${live ? store.statusText(live.status) : '不存在'}，表单已锁定，不能提交`
        );
      }
      const result = store.submitAftersale({
        authId: session.actingAuthId,
        agentId: agent.id,
        type: body.type,
        reason: body.reason,
        amount: body.amount
      });
      store.addAudit({
        actorId: agent.id,
        action: 'aftersale.submit',
        detail: {
          aftersaleId: result.aftersale.id,
          authId: result.aftersale.authId,
          customerId: result.aftersale.customerId,
          orderId: result.aftersale.orderId,
          duplicated: false
        }
      });
      // 不自动退出：保留在代办页展示原申请结果，由客服显式退出，退出即清除客户身份
      return send(res, 201, result);
    }

    if (p === '/api/aftersales' && req.method === 'GET') {
      requireLogin();
      const filter =
        me.role === 'customer'
          ? { customerId: me.id }
          : me.role === 'agent'
            ? { agentId: me.id }
            : {};
      return send(res, 200, { aftersales: store.listAftersales(filter) });
    }

    // ---------- 客服自己的常规页面（代办状态下仍以客服本人身份工作） ----------
    if (p === '/api/my-tickets' && req.method === 'GET') {
      const agent = requireRole('agent');
      // 刻意只按客服本人 id 查询，与代办身份隔离
      return send(res, 200, {
        tickets: [
          { id: 'T-9001', owner: agent.name, title: '物流咨询工单', state: '处理中' },
          { id: 'T-9002', owner: agent.name, title: '发票补开工单', state: '待回访' }
        ],
        note: '这些页面始终以客服本人身份工作，与代办授权无关'
      });
    }
    if (p === '/api/knowledge' && req.method === 'GET') {
      requireRole('agent');
      return send(res, 200, {
        articles: [
          { id: 'KB-1', title: '售后政策与时效说明' },
          { id: 'KB-2', title: '退款审核操作手册' }
        ]
      });
    }

    // ---------- 审计 ----------
    if (p === '/api/audits' && req.method === 'GET') {
      requireRole('auditor');
      return send(res, 200, { audits: store.listAudits() });
    }

    send(res, 404, { error: '接口不存在' });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    send(res, status, { error: err.message || '服务器错误' });
  }
});

server.listen(PORT, () => {
  console.log(`演示后台已启动: http://localhost:${PORT}`);
});
