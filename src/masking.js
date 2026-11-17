// 脱敏与序列化层：所有对外返回工单数据的接口（列表、搜索、详情、导出）
// 必须经过这里，保证完整号码只有在「当前会话用户持有该工单该字段的有效授权」
// 时才会出现。接口本身不接受任何控制脱敏的参数，换入口无法绕过。

import {
  SENSITIVE_FIELDS,
  hasActiveGrant,
  findActiveGrant,
  addAuditLog,
} from './store.js';

const SENSITIVE_KEYS = new Set(SENSITIVE_FIELDS.map((f) => f.key));

// 手机号掩码：保留前 3 位与后 4 位。
export function maskPhone(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, '$1****$2');
}

/**
 * 按当前用户的授权序列化单张工单。
 * @param {object} ticket 原始工单（含完整号码）
 * @param {object} viewer 当前会话用户
 * @param {object} [opts]
 * @param {boolean} [opts.auditView=true] 明文放行时写一条查看审计
 * @returns {object} 可安全返回给前端的工单对象
 */
export function serializeTicket(ticket, viewer, { auditView = true } = {}) {
  const out = { ...ticket };
  out._permissions = {};

  for (const key of SENSITIVE_KEYS) {
    const granted = viewer && hasActiveGrant(viewer.id, ticket.id, key);
    if (granted) {
      // 明文仅在此时保留；附带授权信息，前端可展示剩余有效期。
      const grant = findActiveGrant(viewer.id, ticket.id, key);
      out._permissions[key] = {
        unmasked: true,
        grantId: grant.id,
        expiresAt: grant.expiresAt,
      };
      if (auditView) {
        // 审计只记元数据，不记号码。
        addAuditLog({
          action: 'sensitive.view',
          actorId: viewer.id,
          actorName: viewer.name,
          ticketId: ticket.id,
          field: key,
          grantId: grant.id,
        });
      }
    } else {
      out[key] = maskPhone(ticket[key]);
      out._permissions[key] = { unmasked: false };
    }
  }
  return out;
}

export function serializeTickets(tickets, viewer, opts) {
  return tickets.map((t) => serializeTicket(t, viewer, opts));
}
