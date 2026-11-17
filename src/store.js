// 内存数据层：组织、账号、按「组织 + 本地客户编号」定位的客户。
// 关键点：客户主键永远是 (orgId, localCustomerNo)，不存在全局唯一的客户编号。

const SEED = {
  orgs: [
    { id: 'org-jia', name: '甲组织' },
    { id: 'org-yi', name: '乙组织' },
  ],
  users: [
    {
      id: 'agent',
      name: '客服小王',
      orgIds: ['org-jia', 'org-yi'],
    },
    {
      id: 'agent-jia',
      name: '客服小甲',
      orgIds: ['org-jia'],
    },
  ],
  customers: [
    {
      orgId: 'org-jia',
      localCustomerNo: 'C01',
      name: '陈一（甲组织）',
      remark: '甲组织初始备注：客户偏好电话回访。',
      version: 1,
      updatedAt: null,
      updatedBy: null,
    },
    {
      orgId: 'org-yi',
      localCustomerNo: 'C01',
      name: '陈一（乙组织）',
      remark: '乙组织初始备注：客户偏好微信沟通。',
      version: 1,
      updatedAt: null,
      updatedBy: null,
    },
    {
      orgId: 'org-jia',
      localCustomerNo: 'C02',
      name: '赵二（甲组织）',
      remark: '',
      version: 1,
      updatedAt: null,
      updatedBy: null,
    },
  ],
};

export const REMARK_MAX_LENGTH = 2000;

function seedState() {
  return structuredClone(SEED);
}

export function createStore() {
  let state = seedState();

  const userById = new Map(state.users.map((u) => [u.id, u]));
  const orgById = new Map(state.orgs.map((o) => [o.id, o]));
  const membership = new Set(state.users.flatMap((u) => u.orgIds.map((orgId) => `${u.id}::${orgId}`)));

  const customerKey = (orgId, localCustomerNo) => `${orgId}::${localCustomerNo}`;
  const customers = new Map(state.customers.map((c) => [customerKey(c.orgId, c.localCustomerNo), c]));

  function getUser(userId) {
    return userById.get(userId) ?? null;
  }

  function getOrg(orgId) {
    return orgById.get(orgId) ?? null;
  }

  function isMember(userId, orgId) {
    return Boolean(getUser(userId) && getOrg(orgId) && membership.has(`${userId}::${orgId}`));
  }

  function listOrgsFor(userId) {
    if (!getUser(userId)) return [];
    return state.orgs
      .filter((org) => membership.has(`${userId}::${org.id}`))
      .map((org) => ({ id: org.id, name: org.name }));
  }

  // 仅供本地演示的账号选择器使用，不是业务接口。
  function listDemoUsers() {
    return state.users.map((user) => ({
      id: user.id,
      name: user.name,
      orgIds: user.orgIds.filter((orgId) => membership.has(`${user.id}::${orgId}`)),
    }));
  }

  function listOrgs() {
    return state.orgs.map((org) => ({ id: org.id, name: org.name }));
  }

  function listCustomers(orgId) {
    return state.customers
      .filter((c) => c.orgId === orgId)
      .map((c) => ({
        localCustomerNo: c.localCustomerNo,
        name: c.name,
        version: c.version,
        updatedAt: c.updatedAt,
      }));
  }

  function getCustomer(orgId, localCustomerNo) {
    const customer = customers.get(customerKey(orgId, localCustomerNo));
    return customer ? structuredClone(customer) : null;
  }

  function updateRemark({ orgId, localCustomerNo, remark, userId }) {
    const key = customerKey(orgId, localCustomerNo);
    const current = customers.get(key);
    if (!current) return null;
    const user = getUser(userId);
    current.remark = remark;
    current.version += 1;
    current.updatedAt = new Date().toISOString();
    current.updatedBy = user ? { id: user.id, name: user.name } : null;
    return structuredClone(current);
  }

  function setMembership(userId, orgId, enabled) {
    if (!getUser(userId) || !getOrg(orgId)) return false;
    const key = `${userId}::${orgId}`;
    if (enabled) membership.add(key);
    else membership.delete(key);
    return true;
  }

  function reset() {
    state = seedState();
    userById.clear();
    for (const user of state.users) userById.set(user.id, user);
    orgById.clear();
    for (const org of state.orgs) orgById.set(org.id, org);
    membership.clear();
    for (const user of state.users) {
      for (const orgId of user.orgIds) membership.add(`${user.id}::${orgId}`);
    }
    customers.clear();
    for (const customer of state.customers) {
      customers.set(customerKey(customer.orgId, customer.localCustomerNo), customer);
    }
  }

  return {
    getUser,
    getOrg,
    isMember,
    listOrgsFor,
    listDemoUsers,
    listOrgs,
    listCustomers,
    getCustomer,
    updateRemark,
    setMembership,
    reset,
  };
}
