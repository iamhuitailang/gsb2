import {
  FIELDS,
  FIELD_BY_KEY,
  ORDER_STATUSES,
  SITE_BY_ID,
} from './data.js';

/**
 * 唯一的字段权限判断入口。
 * 页面、预览、CSV 都必须经过这里，避免三处规则漂移。
 */
export function canViewField(user, field) {
  return !field.permission || user.permissions.includes(field.permission);
}

export function visibleFields(user) {
  return FIELDS.filter((field) => canViewField(user, field));
}

export function visibleFieldKeys(user) {
  return visibleFields(user).map((field) => field.key);
}

/** 订单列表页的列：只含字段目录里标了 page 且当前可见的字段。 */
export function pageFields(user) {
  return visibleFields(user).filter((field) => field.page);
}

export function checkSites(user, value) {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'sites_required',
      message: '请至少选择一个站点。',
    };
  }

  const ids = [...new Set(value)];
  const unknown = ids.filter((id) => !SITE_BY_ID[id]);
  if (unknown.length > 0) {
    return {
      ok: false,
      status: 400,
      code: 'sites_unknown',
      message: '包含不存在的站点。',
      detail: { sites: unknown },
    };
  }

  const denied = ids.filter((id) => !user.sites.includes(id));
  if (denied.length > 0) {
    return {
      ok: false,
      status: 403,
      code: 'sites_forbidden',
      message: '所选站点超出你当前的站点范围，请按当前范围重新选择。',
      detail: { sites: denied.map((id) => ({ id, name: SITE_BY_ID[id].name })) },
    };
  }

  return { ok: true, siteIds: ids };
}

export function checkStatuses(value) {
  if (value == null) return { ok: true, statuses: [] };
  if (!Array.isArray(value)) {
    return { ok: false, status: 400, code: 'statuses_invalid', message: '订单状态筛选格式不正确。' };
  }

  const statuses = [...new Set(value)];
  const unknown = statuses.filter((status) => !ORDER_STATUSES.includes(status));
  if (unknown.length > 0) {
    return {
      ok: false,
      status: 400,
      code: 'statuses_unknown',
      message: '包含未知的订单状态。',
      detail: { statuses: unknown },
    };
  }

  return { ok: true, statuses };
}

export function checkColumns(user, value) {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'columns_required',
      message: '请至少选择一列。',
    };
  }

  const keys = [...new Set(value)];
  const unknown = keys.filter((key) => !FIELD_BY_KEY[key]);
  if (unknown.length > 0) {
    return {
      ok: false,
      status: 400,
      code: 'columns_unknown',
      message: '包含不存在的列。',
      detail: { columns: unknown },
    };
  }

  const denied = keys.filter((key) => !canViewField(user, FIELD_BY_KEY[key]));
  if (denied.length > 0) {
    return {
      ok: false,
      status: 403,
      code: 'columns_forbidden',
      message: '所选列超出你当前的字段权限，请按当前范围重新选择。',
      detail: {
        columns: denied.map((key) => ({
          key,
          label: FIELD_BY_KEY[key].label,
          permission: FIELD_BY_KEY[key].permission,
        })),
      },
    };
  }

  return { ok: true, columns: keys };
}

export function normalizeQuery(user, rawInput) {
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
  const siteInput = input.siteIds == null ? user.sites : input.siteIds;
  const siteCheck = checkSites(user, siteInput);
  if (!siteCheck.ok) return siteCheck;

  const statusCheck = checkStatuses(input.statuses);
  if (!statusCheck.ok) return statusCheck;

  const q = typeof input.q === 'string' ? input.q.trim().slice(0, 50) : '';

  return {
    ok: true,
    query: {
      siteIds: siteCheck.siteIds,
      statuses: statusCheck.statuses,
      q,
    },
  };
}

/** 订单列表页的行投影：只输出该页展示的列。 */
export function projectOrderPage(order, user) {
  const row = {};
  for (const field of pageFields(user)) {
    row[field.key] = field.key === 'site' ? SITE_BY_ID[order.siteId]?.name ?? order.siteId : order[field.key] ?? '';
  }
  return row;
}
