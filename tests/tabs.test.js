import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, createBrowser, apiCall, sleep } from './helpers.js';
import { createApi, createTabController, customerPath } from '../public/tab-controller.js';

/** 打开一个「标签页」：共享同一个浏览器的 Cookie，但有自己的控制器状态与地址。 */
async function openTab(browser, path, options = {}) {
  const api = createApi({ fetchImpl: browser.fetch });
  const tab = createTabController({ api, fetchImpl: browser.fetch, path, ...options });
  await tab.bootstrap();
  await tab.applyPath(path);
  return tab;
}

async function login(browser, userId = 'agent') {
  const res = await apiCall(browser, '/api/login', { method: 'POST', body: { userId } });
  assert.equal(res.status, 200);
}

async function readCustomer(browser, orgId, no = 'C01') {
  const res = await apiCall(browser, `/api/orgs/${orgId}/customers/${no}`);
  assert.equal(res.status, 200);
  return res.body.customer;
}

test('两个标签各自绑定组织：乙改备注、甲再改，各自保留自己的内容', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const browser = createBrowser(srv.origin);
  await login(browser, 'agent');

  const tabJia = await openTab(browser, customerPath('org-jia', 'C01'));
  const tabYi = await openTab(browser, customerPath('org-yi', 'C01'));

  assert.equal(tabJia.state.load, 'ready');
  assert.equal(tabYi.state.load, 'ready');
  assert.equal(tabJia.state.customer.orgName, '甲组织');
  assert.equal(tabYi.state.customer.orgName, '乙组织');

  // 先在乙改备注
  tabYi.setDraft('乙标签写的备注');
  await tabYi.saveRemark();
  assert.equal(tabYi.state.save, 'saved');

  // 甲的标签完全不受影响：草稿还是甲自己的初始内容
  assert.equal(tabJia.state.customer.orgName, '甲组织');
  assert.equal(tabJia.state.draft, '甲组织初始备注：客户偏好电话回访。');

  // 再回甲保存另一份备注
  tabJia.setDraft('甲标签写的备注');
  await tabJia.saveRemark();
  assert.equal(tabJia.state.save, 'saved');

  const jia = await readCustomer(browser, 'org-jia');
  const yi = await readCustomer(browser, 'org-yi');
  assert.equal(jia.remark, '甲标签写的备注');
  assert.equal(yi.remark, '乙标签写的备注');
  assert.equal(tabJia.state.customer.remark, '甲标签写的备注');
  assert.equal(tabYi.state.customer.remark, '乙标签写的备注');
});

test('刷新甲的旧地址：看不到乙的备注，也改不到乙的记录', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const browser = createBrowser(srv.origin);
  await login(browser, 'agent');

  const oldAddress = customerPath('org-jia', 'C01');

  const tabYi = await openTab(browser, customerPath('org-yi', 'C01'));
  tabYi.setDraft('刷新测试：乙的备注');
  await tabYi.saveRemark();

  // 重新打开甲的旧地址（等价于刷新 / 从收藏进入）
  const tabJia = await openTab(browser, oldAddress);
  assert.equal(tabJia.state.customer.orgName, '甲组织');
  assert.equal(tabJia.state.customer.localCustomerNo, 'C01');
  assert.notEqual(tabJia.state.customer.remark, '刷新测试：乙的备注');
  assert.equal(tabJia.state.draft, await readCustomer(browser, 'org-jia').then((c) => c.remark));

  // 在甲的页面上保存，写入的只能是甲
  tabJia.setDraft('刷新后在甲保存');
  await tabJia.saveRemark();

  const jia = await readCustomer(browser, 'org-jia');
  const yi = await readCustomer(browser, 'org-yi');
  assert.equal(jia.remark, '刷新后在甲保存');
  assert.equal(yi.remark, '刷新测试：乙的备注');
});

test('切换标签的组织不改变另一个标签的上下文', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const browser = createBrowser(srv.origin);
  await login(browser, 'agent');

  const tabJia = await openTab(browser, customerPath('org-jia', 'C01'));
  const tabYi = await openTab(browser, customerPath('org-yi', 'C01'));

  // 在甲标签里切到乙（同一客户编号）
  await tabJia.applyPath(customerPath('org-yi', 'C01'));
  assert.equal(tabJia.state.route.orgId, 'org-yi');
  assert.equal(tabJia.state.customer.orgName, '乙组织');

  // 乙标签保持自己的上下文与地址
  assert.equal(tabYi.state.route.orgId, 'org-yi');
  assert.equal(tabYi.state.customer.orgName, '乙组织');
  assert.equal(tabYi.state.path, customerPath('org-yi', 'C01'));

  // 切回甲也只影响这个标签
  await tabJia.applyPath(customerPath('org-jia', 'C01'));
  assert.equal(tabJia.state.customer.orgName, '甲组织');
  assert.equal(tabYi.state.customer.orgName, '乙组织');
});

test('旧组织的慢响应结果不会覆盖已切到新组织的页面', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const browser = createBrowser(srv.origin);
  await login(browser, 'agent');

  let delay = 250;
  const tab = await openTab(browser, customerPath('org-yi', 'C01'), { delayProvider: () => delay });

  delay = 250;
  // 甲发起慢请求
  const slowJia = tab.applyPath(customerPath('org-jia', 'C01'));
  // 用户马上切到乙（快请求）
  delay = 0;
  const fastYi = tab.applyPath(customerPath('org-yi', 'C01'));
  await fastYi;
  assert.equal(tab.state.customer.orgName, '乙组织');

  await slowJia;
  await sleep(400); // 确保甲的慢响应早已抵达并被处理
  assert.equal(tab.state.route.orgId, 'org-yi');
  assert.equal(tab.state.customer.orgName, '乙组织');
  assert.equal(tab.state.customer.orgId, undefined);
  assert.equal(tab.state.load, 'ready');
  assert.equal(tab.state.path, customerPath('org-yi', 'C01'));
});

test('同一标签内连续快速切换：只渲染最后一次请求的组织', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const browser = createBrowser(srv.origin);
  await login(browser, 'agent');

  let delay = 300;
  const tab = await openTab(browser, customerPath('org-jia', 'C01'), { delayProvider: () => delay });

  const first = tab.applyPath(customerPath('org-yi', 'C01')); // 慢
  delay = 0;
  const second = tab.applyPath(customerPath('org-jia', 'C01')); // 快
  await second;
  await first;
  await sleep(400);

  assert.equal(tab.state.route.orgId, 'org-jia');
  assert.equal(tab.state.customer.orgName, '甲组织');
});

test('失去组织权限：读取被拒绝，写入被拒绝且不落库', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const browser = createBrowser(srv.origin);
  await login(browser, 'agent');

  const tab = await openTab(browser, customerPath('org-jia', 'C01'));
  const original = await readCustomer(browser, 'org-jia');

  await apiCall(browser, '/api/demo/membership', {
    method: 'POST',
    body: { userId: 'agent', orgId: 'org-jia', enabled: false },
  });

  // 已在页面上的旧数据不重载时，直接保存 —— 服务端必须拒绝
  tab.setDraft('权限收回后的写入尝试');
  await tab.saveRemark();
  assert.equal(tab.state.save, 'denied');
  assert.equal(tab.state.saveError.includes('权限'), true);

  // 刷新则直接读不到
  await tab.applyPath(customerPath('org-jia', 'C01'));
  assert.equal(tab.state.load, 'error');
  assert.equal(tab.state.loadError.status, 403);
  assert.equal(tab.state.customer, null);

  // 重新获得权限后，数据没有被那次越权写入改动
  await apiCall(browser, '/api/demo/membership', {
    method: 'POST',
    body: { userId: 'agent', orgId: 'org-jia', enabled: true },
  });
  const after = await readCustomer(browser, 'org-jia');
  assert.equal(after.remark, original.remark);
  assert.equal(after.version, original.version);
});

test('甲标签的失去权限不影响乙标签继续读写', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const browser = createBrowser(srv.origin);
  await login(browser, 'agent');

  const tabJia = await openTab(browser, customerPath('org-jia', 'C01'));
  const tabYi = await openTab(browser, customerPath('org-yi', 'C01'));

  await apiCall(browser, '/api/demo/membership', {
    method: 'POST',
    body: { userId: 'agent', orgId: 'org-jia', enabled: false },
  });

  tabJia.setDraft('越权尝试');
  await tabJia.saveRemark();
  assert.equal(tabJia.state.save, 'denied');

  tabYi.setDraft('乙仍然可写');
  await tabYi.saveRemark();
  assert.equal(tabYi.state.save, 'saved');
  assert.equal((await readCustomer(browser, 'org-yi')).remark, '乙仍然可写');
});

test('后退/前进（popstate）回到旧地址时按地址里的组织重新加载', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const browser = createBrowser(srv.origin);
  await login(browser, 'agent');

  const tab = await openTab(browser, customerPath('org-jia', 'C01'));
  await tab.applyPath(customerPath('org-yi', 'C01'));
  assert.equal(tab.state.customer.orgName, '乙组织');

  // 浏览器后退：应用会拿到旧地址，再按地址恢复组织
  await tab.applyPath(customerPath('org-jia', 'C01'));
  assert.equal(tab.state.route.orgId, 'org-jia');
  assert.equal(tab.state.customer.orgName, '甲组织');
});

test('只属于甲组织的账号打开乙的地址：明确拒绝并保留地址', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const browser = createBrowser(srv.origin);
  await login(browser, 'agent-jia');

  const path = customerPath('org-yi', 'C01');
  const tab = await openTab(browser, path);
  assert.equal(tab.state.load, 'error');
  assert.equal(tab.state.loadError.status, 403);
  assert.equal(tab.state.path, path, '地址保留，便于恢复权限后刷新');
  assert.equal(tab.state.customer, null);
});
