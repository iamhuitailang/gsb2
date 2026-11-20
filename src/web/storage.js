// 浏览器端本地存储：所有策略数据仅保存在 localStorage，不写入任何远端服务。
// 数据模型：{ id, name, description, mode, text, createdAt, updatedAt }

const STORAGE_KEY = 'csp-workbench.policies.v1';

function safeStorage() {
  try {
    const probe = '__csp_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch (err) {
    return null;
  }
}

export function loadPolicies() {
  const store = safeStorage();
  if (!store) return { ok: false, policies: [], error: '浏览器禁用了 localStorage，无法在本地保存数据' };
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return { ok: true, policies: [] };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: true, policies: [] };
    return { ok: true, policies: parsed };
  } catch (err) {
    return { ok: false, policies: [], error: `本地数据读取失败：${err.message}` };
  }
}

export function savePolicies(policies) {
  const store = safeStorage();
  if (!store) return { ok: false, error: '浏览器禁用了 localStorage，无法保存' };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(policies));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message}` };
  }
}

export function upsertPolicy(policies, policy) {
  const now = new Date().toISOString();
  const idx = policies.findIndex((p) => p.id === policy.id);
  if (idx === -1) {
    const record = { ...policy, createdAt: now, updatedAt: now };
    return { policies: [...policies, record], record };
  }
  const record = { ...policies[idx], ...policy, updatedAt: now };
  const next = [...policies];
  next[idx] = record;
  return { policies: next, record };
}

export function removePolicy(policies, id) {
  return policies.filter((p) => p.id !== id);
}

export function newId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
