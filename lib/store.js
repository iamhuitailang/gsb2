// 本地状态存储：
// - data/demo-state.json 持久化管理员配置、模拟身份服务状态、公钥与令牌样例
// - 私钥单独保存在同一 data 文件中，但永远不会通过任何 API 返回给页面
// - 发现缓存/密钥缓存只存在于进程内存，按 providerId 物理隔离，不持久化、不跨提供方复用
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateKeyPair,
  publicJwk,
  privateJwk,
  importPrivateJwk,
  signJwt,
  hashText,
} from './jose.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DEMO_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'demo-state.json');

const AUDIT_LIMIT = 500;

// ---- 内存缓存：每个提供方各自独立的条目，Map 以 providerId 为键，杜绝串用 ----
const discoveryCache = new Map();
const jwksCache = new Map();
// 缓存代数：每次失效/刷新 +1，审计里可据此区分新旧结果
const cacheGeneration = new Map();

function emptyState() {
  return {
    providers: [],
    // 模拟“远端”身份服务：发现文档、密钥集合、离线开关、异常注入
    remote: {},
    // 演示私钥（仅本进程签发样例令牌使用，不对外暴露）
    privateKeys: {},
    samples: [],
    audit: [],
    seq: 0,
  };
}

let state = emptyState();
let saveTimer = null;

export function load() {
  if (fs.existsSync(DATA_FILE)) {
    state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } else {
    state = emptyState();
    persist();
  }
  return state;
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 150);
}

// 进程退出前把去抖中的写入落盘，避免最后一批变更丢失
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearTimeout(saveTimer);
    try { persist(); } catch { /* 忽略退出期写入错误 */ }
    process.exit(0);
  });
}

export function resetAll() {
  state = emptyState();
  discoveryCache.clear();
  jwksCache.clear();
  cacheGeneration.clear();
  persist();
}

function nextId(prefix) {
  state.seq += 1;
  return `${prefix}-${state.seq}`;
}

// ---------- 提供方配置 ----------
export function listProviders() {
  return state.providers.map((p) => ({ ...p }));
}

export function getProvider(providerId) {
  return state.providers.find((p) => p.id === providerId) || null;
}

export function createProvider({ name, expected, allowedAlgs, discoveryTtlSec = 30, jwksTtlSec = 30 }) {
  const id = nextId('idp');
  const now = new Date().toISOString();
  const provider = {
    id,
    name,
    configVersion: 1,
    createdAt: now,
    updatedAt: now,
    expected: {
      issuer: expected.issuer,
      authorizationEndpoint: expected.authorizationEndpoint,
      jwksUri: expected.jwksUri,
    },
    allowedAlgs: [...allowedAlgs],
    discoveryTtlSec,
    jwksTtlSec,
  };
  state.providers.push(provider);
  state.remote[id] = {
    offline: false,
    discovery: {
      issuer: expected.issuer,
      authorization_endpoint: expected.authorizationEndpoint,
      jwks_uri: expected.jwksUri,
    },
    // 演示用 JWKS，附带本地模拟的密钥状态字段
    keys: [],
    duplicateKid: false,
  };
  state.privateKeys[id] = {};
  cacheGeneration.set(id, 1);
  schedulePersist();
  return provider;
}

// 管理员修改配置：版本号 +1，并立即清空该提供方的全部缓存，旧核验结果随之失效
export function updateProvider(providerId, patch) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error('提供方不存在');
  if (patch.name !== undefined) provider.name = patch.name;
  if (patch.allowedAlgs) provider.allowedAlgs = [...patch.allowedAlgs];
  if (patch.discoveryTtlSec) provider.discoveryTtlSec = patch.discoveryTtlSec;
  if (patch.jwksTtlSec) provider.jwksTtlSec = patch.jwksTtlSec;
  if (patch.expected) {
    provider.expected = { ...provider.expected, ...patch.expected };
  }
  provider.configVersion += 1;
  provider.updatedAt = new Date().toISOString();
  invalidateCaches(providerId);
  schedulePersist();
  return provider;
}

export function deleteProvider(providerId) {
  state.providers = state.providers.filter((p) => p.id !== providerId);
  delete state.remote[providerId];
  delete state.privateKeys[providerId];
  discoveryCache.delete(providerId);
  jwksCache.delete(providerId);
  cacheGeneration.delete(providerId);
  schedulePersist();
}

// ---------- 模拟密钥生命周期 ----------
export async function addKey(providerId, alg) {
  const remote = state.remote[providerId];
  if (!remote) throw new Error('提供方不存在');
  const kid = nextId('kid');
  const pair = await generateKeyPair(alg);
  const jwk = await publicJwk(pair.publicKey, kid, alg);
  remote.keys.push({ jwk, status: 'active', addedAt: Date.now() });
  state.privateKeys[providerId][kid] = await privateJwk(pair.privateKey);
  invalidateJwksCache(providerId);
  schedulePersist();
  return publicViewOfKey(remote.keys[remote.keys.length - 1]);
}

export function setKeyStatus(providerId, kid, status) {
  const entry = state.remote[providerId]?.keys.find((k) => k.jwk.kid === kid);
  if (!entry) throw new Error('密钥不存在');
  entry.status = status;
  invalidateJwksCache(providerId);
  schedulePersist();
  return publicViewOfKey(entry);
}

export function listKeys(providerId) {
  return (state.remote[providerId]?.keys || []).map(publicViewOfKey);
}

// 模拟身份服务的当前状态（只含发现文档与开关，不含私钥）
export function getRemoteState(providerId) {
  const remote = state.remote[providerId];
  if (!remote) return null;
  return {
    offline: remote.offline,
    duplicateKid: remote.duplicateKid,
    discovery: JSON.parse(JSON.stringify(remote.discovery)),
  };
}

function publicViewOfKey(entry) {
  return {
    kid: entry.jwk.kid,
    alg: entry.jwk.alg,
    status: entry.status,
    kty: entry.jwk.kty,
    addedAt: new Date(entry.addedAt).toISOString(),
  };
}

// ---------- 模拟身份服务的远端操控（管理员演示按钮） ----------
export function setOffline(providerId, offline) {
  state.remote[providerId].offline = offline;
  schedulePersist();
}

export function mutateRemoteDiscovery(providerId, patch) {
  Object.assign(state.remote[providerId].discovery, patch);
  invalidateDiscoveryCache(providerId);
  schedulePersist();
}

export function setDuplicateKid(providerId, enabled) {
  state.remote[providerId].duplicateKid = enabled;
  invalidateJwksCache(providerId);
  schedulePersist();
}

// 往模拟 JWKS 里注入一个外部未知密钥（用于“未知 kid”场景）
export async function injectForeignKey(providerId, alg) {
  const remote = state.remote[providerId];
  const pair = await generateKeyPair(alg);
  const kid = nextId('foreign-kid');
  remote.keys.push({ jwk: await publicJwk(pair.publicKey, kid, alg), status: 'active', addedAt: Date.now() });
  invalidateJwksCache(providerId);
  schedulePersist();
  return kid;
}

// ---------- 模拟 HTTP 发现 / JWKS 获取（进程内调用，不产生真实网络流量） ----------
async function simulatedFetch(providerId, kind) {
  const remote = state.remote[providerId];
  if (!remote) throw new Error('提供方不存在');
  if (remote.offline) {
    const err = new Error(`模拟身份服务离线，无法获取 ${kind}`);
    err.kind = kind;
    throw err;
  }
  if (kind === 'discovery') return JSON.parse(JSON.stringify(remote.discovery));
  if (kind === 'jwks') {
    let keys = remote.keys.map((k) => ({ ...k.jwk, status: k.status }));
    if (remote.duplicateKid && keys.length > 0) {
      // 复制最后一个密钥的 kid，但公钥不同 —— 模拟远端数据异常
      const pair = await generateKeyPair(keys[keys.length - 1].alg);
      const dup = await publicJwk(pair.publicKey, keys[keys.length - 1].kid, keys[keys.length - 1].alg);
      keys.push({ ...dup, status: 'active' });
    }
    return { keys };
  }
  throw new Error('未知获取类型');
}

// ---------- 缓存原语（按 providerId 隔离） ----------
function bumpGeneration(providerId) {
  cacheGeneration.set(providerId, (cacheGeneration.get(providerId) || 0) + 1);
}

export function getCacheGeneration(providerId) {
  return cacheGeneration.get(providerId) || 0;
}

export function invalidateDiscoveryCache(providerId) {
  discoveryCache.delete(providerId);
  bumpGeneration(providerId);
}

export function invalidateJwksCache(providerId) {
  jwksCache.delete(providerId);
  bumpGeneration(providerId);
}

export function invalidateCaches(providerId) {
  discoveryCache.delete(providerId);
  jwksCache.delete(providerId);
  bumpGeneration(providerId);
}

// 让缓存立即过期（演示 TTL 到期行为，不必真的等 30 秒）
export function expireCachesNow(providerId) {
  for (const cache of [discoveryCache, jwksCache]) {
    const entry = cache.get(providerId);
    if (entry) entry.expiresAt = 0;
  }
  bumpGeneration(providerId);
}

// 只让 JWKS 缓存过期（用于单独演示密钥集合刷新失败）
export function expireJwksOnly(providerId) {
  const entry = jwksCache.get(providerId);
  if (entry) entry.expiresAt = 0;
  bumpGeneration(providerId);
}

// 只让发现缓存过期
export function expireDiscoveryOnly(providerId) {
  const entry = discoveryCache.get(providerId);
  if (entry) entry.expiresAt = 0;
  bumpGeneration(providerId);
}

// 演示用：只篡改内存中的缓存内容/哈希、不重新拉取，核验时应被完整性检查拦下
export function tamperCaches(providerId) {
  const d = discoveryCache.get(providerId);
  if (d) d.payload.issuer = `${d.payload.issuer}-tampered`;
  const j = jwksCache.get(providerId);
  if (j) j.payloadHash = 'tampered-demo';
  bumpGeneration(providerId);
}

function cacheSnapshot(entry) {
  if (!entry) return null;
  return {
    configVersion: entry.configVersion,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
    expired: Date.now() >= entry.expiresAt,
    payloadHash: entry.payloadHash,
  };
}

export function cacheStatus(providerId) {
  return {
    generation: getCacheGeneration(providerId),
    discovery: cacheSnapshot(discoveryCache.get(providerId)),
    jwks: cacheSnapshot(jwksCache.get(providerId)),
  };
}

// 获取发现文档：TTL 内用缓存；过期或强制刷新时重新“请求”，失败不回退旧缓存
export async function fetchDiscovery(providerId, { force = false } = {}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error('提供方不存在');
  const cached = discoveryCache.get(providerId);
  const fresh = cached && Date.now() < cached.expiresAt && cached.configVersion === provider.configVersion;
  if (fresh && !force) {
    return { payload: cached.payload, fromCache: true };
  }
  const payload = await simulatedFetch(providerId, 'discovery');
  const now = Date.now();
  discoveryCache.set(providerId, {
    configVersion: provider.configVersion,
    fetchedAt: now,
    expiresAt: now + provider.discoveryTtlSec * 1000,
    payloadHash: hashText(JSON.stringify(payload)),
    payload,
  });
  bumpGeneration(providerId);
  return { payload, fromCache: false };
}

// 获取密钥集合：同样不跨提供方、不回退过期数据；重复 kid 在此检出并随结果返回
export async function fetchJwks(providerId, { force = false } = {}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error('提供方不存在');
  const cached = jwksCache.get(providerId);
  const fresh = cached && Date.now() < cached.expiresAt && cached.configVersion === provider.configVersion;
  if (fresh && !force) {
    return { ...cached.public, fromCache: true };
  }
  const payload = await simulatedFetch(providerId, 'jwks');
  const seen = new Set();
  let duplicateKid = null;
  for (const key of payload.keys) {
    if (seen.has(key.kid)) {
      duplicateKid = key.kid;
      break;
    }
    seen.add(key.kid);
  }
  const now = Date.now();
  const entry = {
    configVersion: provider.configVersion,
    fetchedAt: now,
    expiresAt: now + provider.jwksTtlSec * 1000,
    payloadHash: hashText(JSON.stringify(payload)),
    public: { keys: payload.keys, duplicateKid },
  };
  jwksCache.set(providerId, entry);
  bumpGeneration(providerId);
  return { ...entry.public, fromCache: false };
}

// ---------- 令牌签发（仅用于生成本地样例） ----------
export async function mintToken(providerId, { kid, alg, payloadOverrides = {}, algHeaderOverride = null, includeKid = true }) {
  const keyEntry = state.remote[providerId]?.keys.find((k) => k.jwk.kid === kid);
  if (!keyEntry) throw new Error('密钥不存在');
  const privJwk = state.privateKeys[providerId][kid];
  if (!privJwk) throw new Error('该密钥没有可用的本地私钥（外部注入密钥不能签发）');
  const provider = getProvider(providerId);
  const headerAlg = algHeaderOverride || alg;
  const payload = {
    iss: provider.expected.issuer,
    sub: 'demo-user',
    aud: 'local-demo-app',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payloadOverrides,
  };
  if (headerAlg === 'none') {
    return signJwt({ alg: 'none', key: null, kid: includeKid ? kid : undefined, payload });
  }
  // 签名始终使用密钥自身算法；algHeaderOverride 只改 header 声明，制造“声明与实际不符”的样例
  const key = await importPrivateJwk(privJwk);
  return signJwt({ alg: keyEntry.jwk.alg, key, kid: includeKid ? kid : undefined, payload, headerAlgOverride: headerAlg });
}

// ---------- 令牌样例 ----------
export function addSample({ providerId, label, description, token }) {
  const sample = { id: nextId('sample'), providerId, label, description, token };
  state.samples.push(sample);
  schedulePersist();
  return { ...sample, token: undefined };
}

export function listSamples() {
  // 列表只返回元数据；完整令牌需显式取单个，页面默认只显示指纹
  return state.samples.map(({ token, ...meta }) => ({
    ...meta,
    tokenFingerprint: hashText(token),
  }));
}

export function getSample(sampleId) {
  return state.samples.find((s) => s.id === sampleId) || null;
}

export function deleteSample(sampleId) {
  state.samples = state.samples.filter((s) => s.id !== sampleId);
  schedulePersist();
}

// ---------- 审计（不落令牌、私钥或完整凭据） ----------
export function appendAudit(entry) {
  const record = {
    id: nextId('audit'),
    ts: new Date().toISOString(),
    ...entry,
  };
  state.audit.unshift(record);
  if (state.audit.length > AUDIT_LIMIT) state.audit.length = AUDIT_LIMIT;
  schedulePersist();
  return record;
}

export function listAudit({ providerId, limit = 100 } = {}) {
  const rows = providerId ? state.audit.filter((a) => a.providerId === providerId) : state.audit;
  return rows.slice(0, limit);
}

export function tokenFingerprint(token) {
  return hashText(token);
}
