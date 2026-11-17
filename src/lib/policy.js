'use strict';

// 字段级权限策略：服务端白名单，前端表单只是体验，不能作为安全边界。

// 客户本人在账户中心可改的资料字段
const CUSTOMER_FIELDS = ['displayName', 'address', 'deliveryNote'];

// 主管可维护的字段（客户字段 + 只给主管的受保护字段）
const SUPERVISOR_FIELDS = [
  'displayName',
  'address',
  'deliveryNote',
  'creditLevel',
  'storeId',
  'disabled',
];

// 受保护字段：信用等级、所属门店、停用状态，只给主管操作
const PROTECTED_FIELDS = ['creditLevel', 'storeId', 'disabled'];

// 白名单字段到数据库列的显式映射，杜绝按提交 key 拼 SQL
const FIELD_TO_COLUMN = {
  displayName: 'display_name',
  address: 'address',
  deliveryNote: 'delivery_note',
  creditLevel: 'credit_level',
  storeId: 'store_id',
  disabled: 'disabled',
};

const CREDIT_LEVELS = ['A', 'B', 'C', 'D'];

function allowedFieldsFor(role) {
  return role === 'supervisor' ? SUPERVISOR_FIELDS : CUSTOMER_FIELDS;
}

// 单字段校验：合法返回 null，不合法返回错误消息
function validateField(field, value) {
  switch (field) {
    case 'displayName':
      if (typeof value !== 'string' || !value.trim()) return '显示名不能为空';
      if (value.length > 50) return '显示名最长 50 字';
      return null;
    case 'address':
      if (typeof value !== 'string' || !value.trim()) return '地址不能为空';
      if (value.length > 200) return '地址最长 200 字';
      return null;
    case 'deliveryNote':
      if (typeof value !== 'string') return '签收备注必须是文本';
      if (value.length > 200) return '签收备注最长 200 字';
      return null;
    case 'creditLevel':
      if (!CREDIT_LEVELS.includes(value)) return `信用等级必须是 ${CREDIT_LEVELS.join('/')} 之一`;
      return null;
    case 'storeId':
      if (!Number.isInteger(value) || value <= 0) return '所属门店不合法';
      return null;
    case 'disabled':
      if (typeof value !== 'boolean') return '停用状态必须是布尔值';
      return null;
    default:
      return '未知字段';
  }
}

function normalize(field, value) {
  if (field === 'displayName' || field === 'address' || field === 'deliveryNote') {
    return String(value).trim();
  }
  return value;
}

module.exports = {
  CUSTOMER_FIELDS,
  SUPERVISOR_FIELDS,
  PROTECTED_FIELDS,
  FIELD_TO_COLUMN,
  CREDIT_LEVELS,
  allowedFieldsFor,
  validateField,
  normalize,
};
