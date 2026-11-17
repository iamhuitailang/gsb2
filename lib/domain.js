import { randomBytes } from 'node:crypto';

const SCOPE_AFTER_SALES = 'after_sales.create';

export const SCOPE_LABEL = '售后申请（新建）';

export class DomainError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function makeCode(prefix, ms, existing) {
  const d = new Date(ms);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  for (let i = 0; i < 20; i += 1) {
    const code = `${prefix}-${stamp}-${randomBytes(2).toString('hex').toUpperCase()}`;
    if (!existing.has(code)) return code;
  }
  throw new DomainError('code_exhausted', '编号生成失败，请重试', 500);
}

function normalizeTtl(ttlMinutes) {
  const n = Number(ttlMinutes);
  if (!Number.isFinite(n)) return 15;
  return Math.min(Math.max(Math.round(n), 1), 24 * 60);
}

export function createDomain({ clock = () => Date.now() } = {}) {
  const users = new Map();
  const orders = new Map();
  const delegations = new Map();
  const applications = new Map();
  const audit = [];
  let auditSeq = 0;

  function addUser(user) {
    users.set(user.id, { ...user });
  }

  function addOrder(order) {
    orders.set(order.id, { ...order });
  }

  addUser({ id: 'cust_chen', name: '陈女士', role: 'customer', phone: '138****2043' });
  addUser({ id: 'agent_lin', name: '小林', role: 'agent', team: '售后一组' });
  addUser({ id: 'agent_zhou', name: '周舟', role: 'agent', team: '售后二组' });

  addOrder({
    id: 'ORD-20261117-001',
    no: 'A20261117001',
    customerId: 'cust_chen',
    title: '静音无线耳机（黑色）',
    amount: 399,
    status: '已签收',
  });
  addOrder({
    id: 'ORD-20261117-002',
    no: 'A20261117002',
    customerId: 'cust_chen',
    title: '护眼桌面台灯（暖白）',
    amount: 259,
    status: '运输中',
  });

  function record({ actorId, actorRole, actorName, onBehalfOfId = null, onBehalfOfName = null, delegationId = null, action, detail = '', orderId = null, applicationId = null }) {
    auditSeq += 1;
    const entry = {
      id: `AUD-${String(auditSeq).padStart(4, '0')}`,
      at: new Date(clock()).toISOString(),
      actorId,
      actorRole,
      actorName,
      onBehalfOfId,
      onBehalfOfName,
      delegationId,
      action,
      detail,
      orderId,
      applicationId,
    };
    audit.push(entry);
    return entry;
  }

  function user(id) {
    return users.get(id) ?? null;
  }

  function requireUser(id, role, message) {
    const u = users.get(id);
    if (!u || (role && u.role !== role)) {
      throw new DomainError('forbidden', message ?? '无权执行该操作', 403);
    }
    return u;
  }

  function getOrder(orderId) {
    return orders.get(orderId) ?? null;
  }

  function listOrdersForCustomer(customerId) {
    return [...orders.values()].filter((o) => o.customerId === customerId);
  }

  function getDelegation(delegationId) {
    return delegations.get(delegationId) ?? null;
  }

  function effectiveStatus(d) {
    if (!d) return 'missing';
    if (d.status === 'active' && clock() >= d.expiresAtMs) return 'expired';
    return d.status;
  }

  function scopeText(d) {
    const order = orders.get(d.orderId);
    return `仅限订单 ${order.no}（${order.title}）的${SCOPE_LABEL}`;
  }

  function listDelegationsForCustomer(customerId) {
    return [...delegations.values()]
      .filter((d) => d.customerId === customerId)
      .sort((a, b) => b.createdMs - a.createdMs);
  }

  function listDelegationsForAgent(agentId) {
    return [...delegations.values()]
      .filter((d) => d.agentId === agentId)
      .sort((a, b) => b.createdMs - a.createdMs);
  }

  function issueDelegation({ customerId, agentId, orderId, ttlMinutes }) {
    const customer = requireUser(customerId, 'customer', '请使用客户账号发起授权');
    const agent = requireUser(agentId, 'agent', '请选择有效的客服账号');
    const order = orders.get(orderId);
    if (!order || order.customerId !== customerId) {
      throw new DomainError('order_not_found', '订单不存在或不属于当前客户', 404);
    }
    const now = clock();
    const ttl = normalizeTtl(ttlMinutes);
    const d = {
      id: makeCode('DLG', now, delegations),
      customerId,
      customerName: customer.name,
      agentId,
      agentName: agent.name,
      orderId,
      orderNo: order.no,
      scope: [SCOPE_AFTER_SALES],
      scopeText: `仅限订单 ${order.no}（${order.title}）的${SCOPE_LABEL}`,
      status: 'active',
      createdAt: new Date(now).toISOString(),
      createdMs: now,
      expiresAt: new Date(now + ttl * 60_000).toISOString(),
      expiresAtMs: now + ttl * 60_000,
      ttlMinutes: ttl,
      cancelledAt: null,
      submittedAt: null,
      applicationId: null,
    };
    delegations.set(d.id, d);
    record({
      actorId: customer.id,
      actorRole: 'customer',
      actorName: customer.name,
      delegationId: d.id,
      action: 'delegation.issue',
      detail: `授权客服 ${agent.name} 代办订单 ${order.no} 的售后申请，截止 ${d.expiresAt}`,
      orderId,
    });
    return d;
  }

  function cancelDelegation({ customerId, delegationId }) {
    const customer = requireUser(customerId, 'customer', '只有客户本人可以取消授权');
    const d = delegations.get(delegationId);
    if (!d) throw new DomainError('delegation_not_found', '授权不存在', 404);
    if (d.customerId !== customer.id) {
      throw new DomainError('forbidden', '无权取消他人的授权', 403);
    }
    if (d.status === 'submitted') {
      throw new DomainError('already_submitted', '该授权已提交过申请，不能取消', 409);
    }
    if (d.status === 'cancelled') return d;
    d.status = 'cancelled';
    d.cancelledAt = new Date(clock()).toISOString();
    record({
      actorId: customer.id,
      actorRole: 'customer',
      actorName: customer.name,
      delegationId: d.id,
      action: 'delegation.cancel',
      detail: `客户取消了对客服 ${d.agentName} 的授权`,
      orderId: d.orderId,
    });
    return d;
  }

  function assertAgentOwnsDelegation(agentId, d) {
    if (d.agentId !== agentId) {
      record({
        actorId: agentId,
        actorRole: 'agent',
        actorName: users.get(agentId)?.name ?? agentId,
        delegationId: d.id,
        action: 'delegation.denied',
        detail: '该授权并未授予当前客服',
        orderId: d.orderId,
      });
      throw new DomainError('not_your_delegation', '该授权不是授予当前客服的', 403);
    }
  }

  function enterDelegation({ agentId, delegationId }) {
    const agent = requireUser(agentId, 'agent');
    const d = delegations.get(delegationId);
    if (!d) throw new DomainError('delegation_not_found', '授权不存在', 404);
    assertAgentOwnsDelegation(agent.id, d);
    const status = effectiveStatus(d);
    if (status === 'cancelled') {
      throw new DomainError('authorization_cancelled', '客户已取消该授权，无法接手代办', 409);
    }
    if (status === 'expired') {
      throw new DomainError('authorization_expired', '该授权已过期，无法接手代办', 409);
    }
    record({
      actorId: agent.id,
      actorRole: 'agent',
      actorName: agent.name,
      onBehalfOfId: d.customerId,
      onBehalfOfName: d.customerName,
      delegationId: d.id,
      action: 'delegation.enter',
      detail: '客服接手代办，进入代办上下文',
      orderId: d.orderId,
    });
    return d;
  }

  function exitDelegation({ agentId, delegationId }) {
    const agent = requireUser(agentId, 'agent');
    const d = delegations.get(delegationId);
    if (!d) throw new DomainError('delegation_not_found', '授权不存在', 404);
    assertAgentOwnsDelegation(agent.id, d);
    record({
      actorId: agent.id,
      actorRole: 'agent',
      actorName: agent.name,
      onBehalfOfId: d.customerId,
      onBehalfOfName: d.customerName,
      delegationId: d.id,
      action: 'delegation.exit',
      detail: '客服退出代办，会话恢复为客服本人',
      orderId: d.orderId,
    });
  }

  function deny(agent, d, action, detail) {
    record({
      actorId: agent.id,
      actorRole: 'agent',
      actorName: agent.name,
      onBehalfOfId: d.customerId,
      onBehalfOfName: d.customerName,
      delegationId: d.id,
      action,
      detail,
      orderId: d.orderId,
    });
  }

  function submitAfterSale({ agentId, delegationId, orderId, reason, solution = '', contact = '' }) {
    const agent = requireUser(agentId, 'agent');
    const d = delegations.get(delegationId);
    if (!d) throw new DomainError('delegation_not_found', '授权不存在或已失效', 404);
    assertAgentOwnsDelegation(agent.id, d);

    const status = effectiveStatus(d);

    if (status === 'cancelled') {
      deny(agent, d, 'after_sales.blocked_cancelled', '客户已取消授权，本次提交被拒绝');
      throw new DomainError('authorization_cancelled', '客户已取消该授权，表单不能提交', 409);
    }
    if (status === 'expired') {
      deny(agent, d, 'after_sales.blocked_expired', '授权已过期，本次提交被拒绝');
      throw new DomainError('authorization_expired', '该授权已过期，表单不能提交', 409);
    }

    // 范围校验先于幂等判断：拿别的订单号来提交，永远按越权处理，不会被“原结果”掩盖。
    if (orderId !== d.orderId) {
      deny(agent, d, 'after_sales.blocked_out_of_scope', `尝试为授权范围外的订单 ${orderId} 提交申请，已拒绝`);
      throw new DomainError('out_of_scope', '该订单不在本次授权范围内，不能代办', 403);
    }

    // 幂等：该授权已成功提交过，无论再点多少次，都只返回原申请结果。
    if (status === 'submitted') {
      const application = applications.get(d.applicationId);
      if (!application) throw new DomainError('application_missing', '原申请记录不存在', 500);
      record({
        actorId: agent.id,
        actorRole: 'agent',
        actorName: agent.name,
        onBehalfOfId: d.customerId,
        onBehalfOfName: d.customerName,
        delegationId: d.id,
        action: 'after_sales.replay',
        detail: '授权已提交，重复操作仅返回原申请结果',
        orderId: d.orderId,
        applicationId: application.id,
      });
      return { application, replayed: true };
    }

    const cleanReason = String(reason ?? '').trim();
    if (cleanReason.length < 4) {
      throw new DomainError('invalid_reason', '请填写至少 4 个字的申请说明', 422);
    }
    if (cleanReason.length > 500) {
      throw new DomainError('invalid_reason', '申请说明不能超过 500 字', 422);
    }

    const now = clock();
    const app = {
      id: makeCode('AS', now, applications),
      orderId: d.orderId,
      orderNo: d.orderNo,
      customerId: d.customerId,
      customerName: d.customerName,
      submittedBy: agent.id,
      submittedByName: agent.name,
      delegationId: d.id,
      scope: SCOPE_LABEL,
      reason: cleanReason,
      solution: String(solution ?? '').trim().slice(0, 200),
      contact: String(contact ?? '').trim().slice(0, 40),
      status: '已提交',
      createdAt: new Date(now).toISOString(),
    };
    applications.set(app.id, app);
    d.status = 'submitted';
    d.submittedAt = app.createdAt;
    d.applicationId = app.id;

    record({
      actorId: agent.id,
      actorRole: 'agent',
      actorName: agent.name,
      onBehalfOfId: d.customerId,
      onBehalfOfName: d.customerName,
      delegationId: d.id,
      action: 'after_sales.submit',
      detail: `客服代客户提交售后申请 ${app.id}`,
      orderId: d.orderId,
      applicationId: app.id,
    });
    return { application: app, replayed: false };
  }

  function getApplication(id) {
    return applications.get(id) ?? null;
  }

  function listApplicationsForCustomer(customerId) {
    return [...applications.values()]
      .filter((a) => a.customerId === customerId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  function listApplicationsForAgent(agentId) {
    return [...applications.values()].filter((a) => a.submittedBy === agentId);
  }

  function queryAudit({ actorId, onBehalfOfId } = {}) {
    return audit
      .filter((e) => {
        if (actorId && e.actorId !== actorId) return false;
        if (onBehalfOfId && e.onBehalfOfId !== onBehalfOfId) return false;
        return true;
      })
      .slice()
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  /** 审计是追加写入的，id 递增；按 id 倒序才是可靠的“最新在前”。 */
  function newestFirst(entries) {
    return entries.slice().sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  function auditForCustomer(customerId) {
    return newestFirst(audit.filter((e) => e.actorId === customerId || e.onBehalfOfId === customerId));
  }

  function auditForAgent(agentId) {
    return newestFirst(audit.filter((e) => e.actorId === agentId));
  }

  return {
    // reads
    user,
    listUsersByRole: (role) => [...users.values()].filter((u) => u.role === role),
    getOrder,
    listOrdersForCustomer,
    getDelegation,
    effectiveStatus,
    listDelegationsForCustomer,
    listDelegationsForAgent,
    scopeText,
    getApplication,
    listApplicationsForCustomer,
    listApplicationsForAgent,
    queryAudit,
    auditForCustomer,
    auditForAgent,
    // writes
    issueDelegation,
    cancelDelegation,
    enterDelegation,
    exitDelegation,
    submitAfterSale,
  };
}
