/**
 * API 钥匙领域逻辑：签发、轮换、停用与状态判定。
 *
 * 安全约定：
 * - 钥匙明文只在签发/轮换的响应中出现一次，落盘只存 SHA-256 哈希和展示前缀；
 * - 钥匙的可执行动作与仓库范围在签发时即被服务账号权限"夹住"，
 *   之后每次请求鉴权还会再次对照服务账号当前权限，两层都不能突破。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ACTIONS, ALL_ACTIONS } from './store.js';
import { err } from './errors.js';

const KEY_PREFIX = 'gsb2_';
/** 展示前缀长度（含固定前缀），之后用 … 遮蔽 */
const PREFIX_VISIBLE = 12;
/** 轮换默认重叠时长：1 小时（演示时钟可快进） */
export const DEFAULT_OVERLAP_MS = 60 * 60 * 1000;

export function hashSecret(secret) {
  return createHash('sha256').update(secret).digest('hex');
}

export function secretPreview(secret) {
  return `${secret.slice(0, PREFIX_VISIBLE)}…`;
}

/** 生成一把新钥匙明文，形如 gsb2_live_xxxxxxxx... */
export function generateSecret() {
  return `${KEY_PREFIX}live_${randomBytes(24).toString('base64url')}`;
}

function ensureArray(value) {
  if (!Array.isArray(value)) throw err.badRequest('scope 必须是数组');
  return value;
}

/**
 * 签发钥匙。
 * @param {import('./store.js').Store} store
 * @param {import('./clock.js').DemoClock} clock
 */
export function issueKey(store, clock, params) {
  const account = store.findAccount(params.serviceAccountId);
  if (!account) throw err.notFound('服务账号不存在');
  if (!account.enabled) throw err.conflict('服务账号已停用，不能签发钥匙');

  const warehouses = ensureArray(params.warehouses);
  const actions = ensureArray(params.actions);
  if (warehouses.length === 0 || actions.length === 0) {
    throw err.badRequest('至少选择一个仓库和一个可执行动作');
  }

  // 第一层边界：签发时就不允许超出服务账号权限
  const deniedWarehouse = warehouses.find((w) => !account.allowedWarehouses.includes(w));
  if (deniedWarehouse) {
    throw err.forbidden(`服务账号无权访问仓库 ${deniedWarehouse}`);
  }
  const deniedAction = actions.find((a) => !ALL_ACTIONS.includes(a));
  if (deniedAction) throw err.badRequest(`未知动作 ${deniedAction}`);
  const deniedByAccount = actions.find((a) => !account.allowedActions.includes(a));
  if (deniedByAccount) {
    throw err.forbidden(`服务账号无权执行动作 ${deniedByAccount}`);
  }

  const now = clock.now();
  const secret = generateSecret();
  const record = {
    id: `key_${randomUUID()}`,
    serviceAccountId: account.id,
    prefix: secretPreview(secret),
    hash: hashSecret(secret),
    warehouses: [...warehouses],
    actions: [...actions],
    status: 'active',
    createdAt: new Date(now).toISOString(),
    expiresAt: null,
    rotatedById: null,
    rotatedFromId: null,
    revokedAt: null,
  };
  store.keys.push(record);
  store.persist();

  // 明文仅此一次随响应返回
  return { key: serializeKey(record, clock, account), secret };
}

/**
 * 轮换钥匙：复制原钥匙范围生成新钥匙，旧钥匙进入重叠期并获得截止时刻。
 * 同一服务账号因此在重叠期内同时存在两把可用钥匙。
 */
export function rotateKey(store, clock, keyId, overlapMs = DEFAULT_OVERLAP_MS) {
  const oldKey = store.findKey(keyId);
  if (!oldKey) throw err.notFound('钥匙不存在');

  const status = keyStatus(oldKey, clock);
  if (status !== 'active') {
    throw err.conflict(`只有生效中的钥匙可以轮换，当前状态为 ${status}`);
  }
  const account = store.findAccount(oldKey.serviceAccountId);
  if (!account || !account.enabled) {
    throw err.conflict('服务账号已停用，不能轮换钥匙');
  }

  const now = clock.now();
  const secret = generateSecret();
  const newKey = {
    id: `key_${randomUUID()}`,
    serviceAccountId: account.id,
    prefix: secretPreview(secret),
    hash: hashSecret(secret),
    warehouses: [...oldKey.warehouses],
    actions: [...oldKey.actions],
    status: 'active',
    createdAt: new Date(now).toISOString(),
    expiresAt: null,
    rotatedById: null,
    rotatedFromId: oldKey.id,
    revokedAt: null,
  };
  oldKey.status = 'overlapping';
  oldKey.expiresAt = new Date(now + overlapMs).toISOString();
  oldKey.rotatedById = newKey.id;
  store.keys.push(newKey);
  store.persist();

  return {
    key: serializeKey(newKey, clock, account),
    secret,
    oldKey: serializeKey(oldKey, clock, account),
  };
}

/** 手动吊销单把钥匙 */
export function revokeKey(store, clock, keyId) {
  const key = store.findKey(keyId);
  if (!key) throw err.notFound('钥匙不存在');
  if (keyStatus(key, clock) === 'revoked') throw err.conflict('钥匙已被吊销');
  key.status = 'revoked';
  key.revokedAt = new Date(clock.now()).toISOString();
  key.expiresAt = key.expiresAt || new Date(clock.now()).toISOString();
  store.persist();
  return serializeKey(key, clock, store.findAccount(key.serviceAccountId));
}

/**
 * 钥匙的实时状态。落盘的 status 是"意图状态"，到期判断以演示时钟为准：
 * - 重叠期旧钥匙到了截止时刻 -> expired
 * - 其余情况沿用落盘状态（active / overlapping / revoked）
 */
export function keyStatus(key, clock) {
  if (key.status === 'revoked') return 'revoked';
  if (key.expiresAt && clock.now() >= Date.parse(key.expiresAt)) return 'expired';
  return key.status;
}

/** 钥匙当前是否可用于鉴权 */
export function isUsable(key, clock) {
  const s = keyStatus(key, clock);
  return s === 'active' || s === 'overlapping';
}

/**
 * 惰性 + 定时清扫：把已到截止时刻的重叠钥匙标记为 expired 落盘，
 * 让管理页在没有请求流量时也能看到状态翻转。
 */
export function sweepExpirations(store, clock) {
  let changed = false;
  for (const key of store.keys) {
    if (key.status === 'overlapping' && clock.now() >= Date.parse(key.expiresAt)) {
      key.status = 'expired';
      changed = true;
    }
  }
  if (changed) store.persist();
  return changed;
}

export const STATUS_LABELS = Object.freeze({
  active: '生效中',
  overlapping: '重叠期（待到期）',
  expired: '已到期',
  revoked: '已吊销',
});

export function serializeKey(key, clock, account = null) {
  const status = keyStatus(key, clock);
  return {
    id: key.id,
    serviceAccountId: key.serviceAccountId,
    serviceAccountName: account ? account.name : key.serviceAccountId,
    prefix: key.prefix,
    warehouses: key.warehouses,
    actions: key.actions,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    rotatedFromId: key.rotatedFromId,
    rotatedById: key.rotatedById,
    revokedAt: key.revokedAt,
  };
}

export function serializeAccount(account, store, clock) {
  const keys = store.keys.filter((k) => k.serviceAccountId === account.id);
  const effective = keys.filter((k) => isUsable(k, clock)).length;
  return {
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    allowedWarehouses: account.allowedWarehouses,
    allowedActions: account.allowedActions,
    createdAt: account.createdAt,
    keyCount: keys.length,
    effectiveKeyCount: effective,
  };
}

export { ACTIONS };
