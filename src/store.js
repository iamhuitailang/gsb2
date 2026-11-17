// 数据层：内存数据 + data.json 落盘（演示用，无外部依赖）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'data.json');

// ---------- 初始化种子数据 ----------
function seed() {
  const now = Date.now();
  return {
    seq: 0,
    users: [
      { id: 'u_cust', name: '客户·王丽', role: 'customer' },
      { id: 'u_agent', name: '客服·李敏', role: 'agent' },
      { id: 'u_agent2', name: '客服·周强', role: 'agent' },
      { id: 'u_auditor', name: '审计员·赵审核', role: 'auditor' }
    ],
    orders: [
      {
        id: 'o_1001',
        orderNo: 'SO-20261117-0001',
        customerId: 'u_cust',
        title: '无线降噪耳机 Pro',
        amount: 899,
        createdAt: now - 3 * 86400_000,
        status: '已签收'
      },
      {
        id: 'o_1002',
        orderNo: 'SO-20261118-0002',
        customerId: 'u_cust',
        title: '智能手环 2 代',
        amount: 329,
        createdAt: now - 1 * 86400_000,
        status: '待收货'
      }
    ],
    // 授权：一次授权 = 一个授权编号，绑定客户/客服/单笔订单/范围/截止时间
    authorizations: [],
    // 售后申请：同时保存客户身份、实际提交的客服、使用的授权编号
    aftersales: [],
    // 审计日志：所有敏感动作留痕
    audits: []
  };
}

let db;
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  db = seed();
  persist();
}

function persist() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function nextId(prefix) {
  db.seq += 1;
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate()
  ).padStart(2, '0')}`;
  return `${prefix}${ymd}${String(db.seq).padStart(4, '0')}`;
}

// ---------- 用户 / 订单 ----------
export function listUsers() {
  return db.users;
}
export function getUser(id) {
  return db.users.find((u) => u.id === id) || null;
}
export function listOrders(customerId) {
  const rows = customerId
    ? db.orders.filter((o) => o.customerId === customerId)
    : db.orders;
  return rows.map((o) => ({ ...o, customer: getUser(o.customerId) }));
}
export function getOrder(id) {
  return db.orders.find((o) => o.id === id) || null;
}

// ---------- 授权状态惰性结算（过期 / 已消费） ----------
function settle(auth, now = Date.now()) {
  if (auth.status === 'active' && now >= auth.expiresAt) {
    auth.status = 'expired';
    persist();
  }
  return auth;
}
function viewAuth(auth) {
  return {
    ...auth,
    customer: getUser(auth.customerId),
    agent: getUser(auth.agentId),
    order: getOrder(auth.orderId)
  };
}

export function findActiveAuthForOrder(orderId, customerId) {
  const now = Date.now();
  return (
    db.authorizations
      .filter((a) => a.orderId === orderId && a.customerId === customerId)
      .map((a) => settle(a, now))
      .find((a) => a.status === 'active') || null
  );
}

export function createAuth({ customerId, agentId, orderId, ttlMinutes, scope }) {
  const customer = getUser(customerId);
  const agent = getUser(agentId);
  const order = getOrder(orderId);
  if (!customer || customer.role !== 'customer') throw httpError(400, '客户身份不存在');
  if (!agent || agent.role !== 'agent') throw httpError(400, '被授权客服不存在');
  if (!order || order.customerId !== customerId) throw httpError(400, '该订单不属于当前客户');
  if (findActiveAuthForOrder(orderId, customerId)) {
    throw httpError(409, '该订单已有一份生效中的授权，请先取消后再发起');
  }
  const now = Date.now();
  const auth = {
    id: nextId('AUTH'),
    customerId,
    agentId,
    orderId,
    scope: scope || ['aftersale:submit'],
    ttlMinutes,
    status: 'active', // active | canceled | expired | consumed
    createdAt: now,
    expiresAt: now + Math.round(ttlMinutes * 60_000),
    canceledAt: null,
    consumedAt: null
  };
  db.authorizations.push(auth);
  persist();
  return viewAuth(auth);
}

export function getAuth(id) {
  const auth = db.authorizations.find((a) => a.id === id);
  return auth ? viewAuth(settle(auth)) : null;
}

export function listAuths(filter = {}) {
  const now = Date.now();
  return db.authorizations
    .filter((a) => (!filter.customerId || a.customerId === filter.customerId))
    .filter((a) => (!filter.agentId || a.agentId === filter.agentId))
    .filter((a) => !filter.orderId || a.orderId === filter.orderId)
    .map((a) => viewAuth(settle(a, now)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function cancelAuth(id, operatorId) {
  const auth = db.authorizations.find((a) => a.id === id);
  if (!auth) throw httpError(404, '授权不存在');
  settle(auth);
  if (auth.status !== 'active') {
    throw httpError(409, `授权当前状态为 ${statusText(auth.status)}，无法取消`);
  }
  auth.status = 'canceled';
  auth.canceledAt = Date.now();
  persist();
  return viewAuth(auth);
}

// 客服凭授权编号接手：校验归属、范围、状态、截止时间
export function takeUpAuth(authNo, agentId) {
  const auth = db.authorizations.find((a) => a.id === authNo);
  if (!auth) throw httpError(404, '授权编号不存在');
  settle(auth);
  if (auth.agentId !== agentId) throw httpError(403, '该授权不是发给你的，无法接手');
  if (auth.status !== 'active') {
    throw httpError(409, `授权${statusText(auth.status)}，无法接手`);
  }
  return viewAuth(auth);
}

// ---------- 售后申请（含幂等：一个授权只能成功提交一次） ----------
export function findAftersaleByAuth(authId) {
  const row = db.aftersales.find((r) => r.authId === authId);
  return row ? viewAftersale(row) : null;
}

export function submitAftersale({ authId, agentId, type, reason, amount }) {
  const auth = db.authorizations.find((a) => a.id === authId);
  if (!auth) throw httpError(404, '授权不存在');
  settle(auth);

  // 幂等：已提交成功，再点一次只返回原申请
  const existing = findAftersaleByAuth(authId);
  if (existing) return { aftersale: existing, duplicated: true };

  if (auth.agentId !== agentId) throw httpError(403, '无权使用该授权');
  if (auth.status === 'canceled') throw httpError(409, '客户已取消授权，表单不能提交');
  if (auth.status === 'expired') throw httpError(409, '授权已过截止时间，表单不能提交');
  if (auth.status === 'consumed') throw httpError(409, '授权已被使用');
  if (!auth.scope.includes('aftersale:submit')) {
    throw httpError(403, '授权范围不包含售后提交');
  }

  const now = Date.now();
  const row = {
    id: nextId('AS'),
    orderId: auth.orderId,
    authId: auth.id,
    customerId: auth.customerId, // 客户身份
    agentId, // 实际提交的客服
    type,
    reason,
    amount: amount ?? null,
    status: '已受理',
    createdAt: now
  };
  db.aftersales.push(row);
  auth.status = 'consumed';
  auth.consumedAt = now;
  persist();
  return { aftersale: viewAftersale(row), duplicated: false };
}

function viewAftersale(row) {
  return {
    ...row,
    customer: getUser(row.customerId),
    agent: getUser(row.agentId),
    order: getOrder(row.orderId),
    auth: getAuth(row.authId)
  };
}

export function listAftersales(filter = {}) {
  return db.aftersales
    .filter((r) => !filter.customerId || r.customerId === filter.customerId)
    .filter((r) => !filter.agentId || r.agentId === filter.agentId)
    .filter((r) => !filter.orderId || r.orderId === filter.orderId)
    .map(viewAftersale)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getAftersale(id) {
  const row = db.aftersales.find((r) => r.id === id);
  return row ? viewAftersale(row) : null;
}

// ---------- 审计 ----------
export function addAudit({ actorId, action, detail }) {
  const row = {
    id: nextId('LOG'),
    actorId,
    actor: actorId ? getUser(actorId) : null,
    action,
    detail,
    at: Date.now()
  };
  db.audits.push(row);
  persist();
  return row;
}

export function listAudits() {
  return [...db.audits].sort((a, b) => b.at - a.at);
}

// ---------- 工具 ----------
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
export function statusText(s) {
  return (
    { active: '生效中', canceled: '已被客户取消', expired: '已过期', consumed: '已使用' }[s] || s
  );
}
