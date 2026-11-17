// 演示用的内存数据层。所有资源都以 organizationId 为一级键，
// 客户编号只在组织内部唯一（甲乙都会有 C01）。

export const ORGANIZATIONS = [
  { id: 'org-jia', name: '甲公司', slug: 'jia' },
  { id: 'org-yi', name: '乙公司', slug: 'yi' },
];

// 同一个客服账号同时属于甲乙两个组织。
export const USERS = [
  {
    id: 'u-agent',
    name: '客服小李',
    organizationIds: ['org-jia', 'org-yi'],
  },
  {
    id: 'u-outsider',
    name: '已离职客服',
    organizationIds: [], // 用来演示“失去权限”
  },
];

const seedCustomers = [
  {
    organizationId: 'org-jia',
    code: 'C01',
    name: '王女士',
    phone: '138****0001',
    note: '甲公司的客户记录：咨询过企业版续费。',
  },
  {
    organizationId: 'org-yi',
    code: 'C01',
    name: '王先生',
    phone: '139****0002',
    note: '乙公司的客户记录：上周申请过发票。',
  },
];

export const store = {
  organizations: new Map(ORGANIZATIONS.map((org) => [org.id, org])),
  users: new Map(USERS.map((user) => [user.id, user])),
  customers: new Map(
    seedCustomers.map((customer) => [`${customer.organizationId}::${customer.code}`, customer]),
  ),
  // 我特意把“所有客户”也按组织分开存，避免任何按 code 的全表查找。
  setCustomer(organizationId, code, patch) {
    const key = `${organizationId}::${code}`;
    const current = this.customers.get(key);
    if (!current) return null;
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.customers.set(key, updated);
    return updated;
  },
  getCustomer(organizationId, code) {
    return this.customers.get(`${organizationId}::${code}`) || null;
  },
  listCustomers(organizationId) {
    return [...this.customers.values()].filter((c) => c.organizationId === organizationId);
  },
};

export function getOrganization(id) {
  return store.organizations.get(id) || null;
}

export function getUser(id) {
  return store.users.get(id) || null;
}

export function canAccessOrganization(user, organizationId) {
  return Boolean(user && organizationId && user.organizationIds.includes(organizationId));
}

export function listOrganizationsForUser(user) {
  return user
    ? user.organizationIds.map((id) => store.organizations.get(id)).filter(Boolean)
    : [];
}
