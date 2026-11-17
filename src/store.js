// 内存数据层：用户、工单、授权申请、审计日志。
// 演示用途，重启后数据回到种子状态。生产环境应替换为持久化存储，
// 但「授权粒度 = 用户 × 工单 × 字段」以及脱敏在序列化层完成的约束不变。

export const GRANT_TTL_SECONDS = Number(process.env.GRANT_TTL_SECONDS ?? 600); // 默认 10 分钟

export const users = [
  { id: 'u_jia', name: '客服甲', role: 'agent' },
  { id: 'u_yi', name: '客服乙', role: 'agent' },
  { id: 'u_lead', name: '主管', role: 'supervisor' },
];

// 敏感字段定义：只有这里登记的字段才可能被临时授权查看明文。
export const SENSITIVE_FIELDS = [
  { key: 'phone', label: '联系电话' },
  { key: 'backupPhone', label: '备用电话' },
];

// 工单中的完整联系方式只保存在服务端，任何接口都不会无条件返回。
export const tickets = [
  {
    id: 'WO-1001',
    customer: '张伟',
    status: '物流异常',
    address: '上海市浦东新区世纪大道 100 号',
    phone: '13812345678',
    backupPhone: '13987654321',
    createdAt: '2026-11-15 09:12',
    note: '快递显示已签收但客户未收到，需要电话核实派送情况。',
  },
  {
    id: 'WO-1002',
    customer: '李娜',
    status: '配送中',
    address: '北京市海淀区中关村大街 20 号',
    phone: '13655556666',
    backupPhone: '13711112222',
    createdAt: '2026-11-16 14:30',
    note: '客户要求改约派送时间。',
  },
];

// 授权申请 / 授权记录，同一条记录在批准后即作为生效授权使用。
// 状态：pending（待审批）/ approved（已批准，可能仍在有效期内）/
//       revoked（已撤销）/ expired（已过期）/ rejected（已驳回）
export const grantRequests = [];

// 审计日志：只记录「谁、对哪张工单的哪个字段、做了什么」，
// 严禁写入电话号码本身（含自由文本中的号码，写入前必须掩码）。
export const auditLogs = [];

let grantSeq = 0;

export function createGrantRequest({ userId, ticketId, field, reason }) {
  // 同一用户对同一工单同一字段，已有待审批申请时直接返回原申请，避免重复单。
  const existing = grantRequests.find(
    (g) =>
      g.userId === userId &&
      g.ticketId === ticketId &&
      g.field === field &&
      g.status === 'pending'
  );
  if (existing) return existing;

  const now = Date.now();
  const record = {
    id: `GR-${String(++grantSeq).padStart(4, '0')}`,
    userId,
    ticketId,
    field,
    reason,
    status: 'pending',
    createdAt: now,
    decidedAt: null,
    decidedBy: null,
    expiresAt: null,
    revokedAt: null,
  };
  grantRequests.unshift(record);
  return record;
}

export function decideGrant(id, supervisorId, approve) {
  const record = grantRequests.find((g) => g.id === id);
  if (!record || record.status !== 'pending') return null;
  record.status = approve ? 'approved' : 'rejected';
  record.decidedAt = Date.now();
  record.decidedBy = supervisorId;
  if (approve) {
    record.expiresAt = Date.now() + GRANT_TTL_SECONDS * 1000;
  }
  return record;
}

export function revokeGrant(id, supervisorId) {
  const record = grantRequests.find((g) => g.id === id);
  if (!record || record.status !== 'approved') return null;
  record.status = 'revoked';
  record.revokedAt = Date.now();
  record.revokedBy = supervisorId;
  return record;
}

// 判断某用户当前对某工单某字段是否持有有效授权。
// 惰性过期：到期未撤销的授权在此判定为 expired。
export function hasActiveGrant(userId, ticketId, field) {
  const record = grantRequests.find(
    (g) =>
      g.userId === userId &&
      g.ticketId === ticketId &&
      g.field === field &&
      g.status === 'approved'
  );
  if (!record) return false;
  if (record.expiresAt <= Date.now()) {
    record.status = 'expired';
    return false;
  }
  return true;
}

export function findActiveGrant(userId, ticketId, field) {
  if (!hasActiveGrant(userId, ticketId, field)) return null;
  return grantRequests.find(
    (g) =>
      g.userId === userId &&
      g.ticketId === ticketId &&
      g.field === field
  );
}

// 自由文本入库/入日志前的号码掩码，防止号码经申请理由等字段进入审计日志。
export function scrubPhoneNumbers(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, '$1****$2');
}

export function addAuditLog(entry) {
  const log = {
    at: new Date().toISOString(),
    ...entry,
  };
  // 双保险：任何字符串字段里的手机号模式在落日志前一律掩码。
  for (const key of Object.keys(log)) {
    if (typeof log[key] === 'string') log[key] = scrubPhoneNumbers(log[key]);
  }
  auditLogs.unshift(log);
  return log;
}

export function resetStore() {
  grantRequests.length = 0;
  auditLogs.length = 0;
  grantSeq = 0;
}
