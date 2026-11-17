'use strict';

const db = require('../db/init');

// 审计不记录地址原文：address 的任何值在写入审计表前一律掩码
function maskValue(field, value) {
  if (field === 'address') return '[地址已隐藏]';
  if (value === null || value === undefined) return null;
  return String(value);
}

const insert = db.prepare(`
  INSERT INTO audit_logs
    (actor_id, actor_name, actor_role, customer_id, action, field,
     old_value, new_value, result, detail)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function log(entry) {
  insert.run(
    entry.actorId ?? null,
    entry.actorName,
    entry.actorRole,
    entry.customerId ?? null,
    entry.action,
    entry.field ?? null,
    Object.hasOwn(entry, 'oldValue') ? maskValue(entry.field, entry.oldValue) : null,
    Object.hasOwn(entry, 'newValue') ? maskValue(entry.field, entry.newValue) : null,
    entry.result,
    entry.detail ?? null,
  );
}

module.exports = { log, maskValue };
