'use strict';

const db = require('../db/init');
const audit = require('../lib/audit');
const {
  FIELD_TO_COLUMN,
  allowedFieldsFor,
  validateField,
  normalize,
} = require('../lib/policy');

class ServiceError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

function rowToCustomer(row) {
  return {
    id: row.id,
    storeId: row.store_id,
    displayName: row.display_name,
    address: row.address,
    deliveryNote: row.delivery_note,
    creditLevel: row.credit_level,
    disabled: Boolean(row.disabled),
  };
}

// 两个角色共用同一条详情查询：归属校验和更新前核对都从这里取记录
function getCustomerById(customerId) {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!row) throw new ServiceError(404, 'NOT_FOUND', '客户不存在');
  return rowToCustomer(row);
}

function listCustomers() {
  return db
    .prepare('SELECT * FROM customers ORDER BY id')
    .all()
    .map(rowToCustomer);
}

// 资料更新的唯一入口。
// 关键安全点：
// 1. 不按提交内容整包写库，只取角色白名单内的字段；
// 2. 普通请求只要夹带任何无权限字段（含受保护字段），整次保存拒绝，原资料不变；
// 3. 主管必须通过客户门店归属核对（与详情同源）；
// 4. 字段先校验、在事务内整体提交，任何一步失败都不落库。
function updateCustomer(actor, targetId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ServiceError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
  }

  const submitted = Object.keys(body);
  if (submitted.length === 0) {
    throw new ServiceError(400, 'EMPTY_UPDATE', '没有可更新的字段');
  }

  // 先取详情记录：归属核对和后续字段对比都基于同一份快照
  const before = getCustomerById(targetId);

  if (actor.role === 'supervisor') {
    if (actor.storeId !== before.storeId) {
      audit.log({
        actorId: actor.id,
        actorName: actor.displayName,
        actorRole: actor.role,
        customerId: targetId,
        action: 'customer_update',
        result: 'denied',
        detail: `门店归属不匹配：主管属门店 ${actor.storeId}，客户属门店 ${before.storeId}`,
      });
      throw new ServiceError(403, 'STORE_MISMATCH', '该客户不属于你负责的门店，不能修改');
    }
  } else if (actor.customerId !== targetId) {
    throw new ServiceError(403, 'FORBIDDEN', '只能维护本人资料');
  }

  const allowed = allowedFieldsFor(actor.role);

  // 夹带任何白名单外的字段：整次拒绝，原资料保持不变
  const rejected = submitted.filter((field) => !allowed.includes(field));
  if (rejected.length > 0) {
    audit.log({
      actorId: actor.id,
      actorName: actor.displayName,
      actorRole: actor.role,
      customerId: targetId,
      action: 'customer_update',
      result: 'denied',
      detail: `包含无权限字段：${rejected.join('、')}`,
    });
    throw new ServiceError(403, 'FIELD_FORBIDDEN', '以下字段你无权修改，整次保存未执行', {
      rejectedFields: rejected,
    });
  }

  // 全量校验：任一字段不合法都拒绝，不做部分更新
  const changes = [];
  for (const field of submitted) {
    const normalized = normalize(field, body[field]);
    const message = validateField(field, normalized);
    if (message) {
      throw new ServiceError(400, 'VALIDATION_FAILED', message, { field });
    }
    changes.push({ field, value: normalized });
  }

  // 主管调整门店时，目标门店必须存在
  if (Object.hasOwn(body, 'storeId')) {
    const store = db.prepare('SELECT id FROM stores WHERE id = ?').get(body.storeId);
    if (!store) {
      throw new ServiceError(400, 'VALIDATION_FAILED', '目标门店不存在', { field: 'storeId' });
    }
  }

  const effective = changes
    .filter(({ field, value }) => before[field] !== value)
    .map(({ field, value }) => ({
      field,
      column: FIELD_TO_COLUMN[field],
      value: field === 'disabled' ? Number(value) : value,
      oldValue: before[field],
      newValue: value,
    }));

  if (effective.length === 0) {
    return { customer: before, changed: false, changes: [] };
  }

  db.exec('BEGIN');
  try {
    for (const change of effective) {
      db.prepare(`UPDATE customers SET ${change.column} = ? WHERE id = ?`).run(
        change.value,
        targetId,
      );
    }
    const after = getCustomerById(targetId);
    for (const change of effective) {
      // 地址原值/新值在 audit.log 内部掩码，审计表不落地址原文
      audit.log({
        actorId: actor.id,
        actorName: actor.displayName,
        actorRole: actor.role,
        customerId: targetId,
        action: 'customer_update',
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        result: 'success',
      });
    }
    db.exec('COMMIT');
    return {
      customer: after,
      changed: true,
      changes: effective.map(({ field, oldValue, newValue }) => ({ field, oldValue, newValue })),
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function listAuditLogs() {
  return db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').all();
}

module.exports = {
  ServiceError,
  getCustomerById,
  listCustomers,
  updateCustomer,
  listAuditLogs,
};
