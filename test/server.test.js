import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { getUser, store } from '../src/store.js';

const { handler } = createApp();

let baseUrl;
let server;

// 所有用例共享同一个内存 store，按顺序执行，每个用例前把种子数据恢复原样。
const SEED = new Map(
  [...store.customers.entries()].map(([key, value]) => [key, { ...value }]),
);
beforeEach(() => {
  store.customers.clear();
  for (const [key, value] of SEED) store.customers.set(key, { ...value });
  getUser('u-agent').organizationIds = ['org-jia', 'org-yi'];
});

before(async () => {
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(
  () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
);

/** 极简客户端：每个实例模拟一个独立的浏览器标签（独立 cookie 罐）。 */
function client() {
  let cookie = '';
  async function request(method, path, body) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  return {
    get: (path) => request('GET', path),
    put: (path, body) => request('PUT', path, body),
    login: (userId) => request('POST', '/api/session', { userId }),
    get cookie() {
      return cookie;
    },
  };
}

test('未登录时读写接口都返回 401', async () => {
  const c = client();
  const read = await c.get('/api/orgs/jia/customers/C01');
  assert.equal(read.status, 401);
  const write = await c.put('/api/orgs/jia/customers/C01/note', { note: 'x' });
  assert.equal(write.status, 401);
});

test('没有组织权限的账号读写都被 403 拒绝', async () => {
  const c = client();
  await c.login('u-outsider');
  assert.equal((await c.get('/api/orgs/jia/customers/C01')).status, 403);
  assert.equal((await c.put('/api/orgs/jia/customers/C01/note', { note: 'x' })).status, 403);
});

test('组织不存在时返回 404，不泄露客户数据', async () => {
  const c = client();
  await c.login('u-agent');
  const res = await c.get('/api/orgs/nope/customers/C01');
  assert.equal(res.status, 404);
  assert.equal(res.data.error.code, 'ORGANIZATION_NOT_FOUND');
});

test('同一编号 C01 在甲乙各取各的记录', async () => {
  const c = client();
  await c.login('u-agent');

  const jia = await c.get('/api/orgs/jia/customers/C01');
  const yi = await c.get('/api/orgs/yi/customers/C01');
  assert.equal(jia.status, 200);
  assert.equal(yi.status, 200);
  assert.equal(jia.data.customer.organizationId, 'org-jia');
  assert.equal(yi.data.customer.organizationId, 'org-yi');
  assert.notEqual(jia.data.customer.name, yi.data.customer.name);
});

test('验收流程：乙先改，甲再改，两边互不影响', async () => {
  const jiaTab = client();
  const yiTab = client();
  await jiaTab.login('u-agent');
  await yiTab.login('u-agent');

  await yiTab.put('/api/orgs/yi/customers/C01/note', { note: '乙侧备注：发票已开' });
  const jiaSave = await jiaTab.put('/api/orgs/jia/customers/C01/note', { note: '甲侧备注：续费已确认' });
  assert.equal(jiaSave.status, 200);

  const jiaAfter = await jiaTab.get('/api/orgs/jia/customers/C01');
  const yiAfter = await yiTab.get('/api/orgs/yi/customers/C01');
  assert.equal(jiaAfter.data.customer.note, '甲侧备注：续费已确认');
  assert.equal(yiAfter.data.customer.note, '乙侧备注：发票已开');

  // 刷新甲标签的原地址，仍然只能看到甲的内容。
  const jiaReloaded = await jiaTab.get('/api/orgs/jia/customers/C01');
  assert.equal(jiaReloaded.data.customer.note, '甲侧备注：续费已确认');
  assert.ok(!jiaReloaded.data.customer.note.includes('乙侧'));
});

test('列表接口只返回该组织的客户', async () => {
  const c = client();
  await c.login('u-agent');
  const jia = await c.get('/api/orgs/jia/customers');
  const yi = await c.get('/api/orgs/yi/customers');
  assert.ok(jia.data.customers.every((x) => x.organizationId === 'org-jia'));
  assert.ok(yi.data.customers.every((x) => x.organizationId === 'org-yi'));
});

test('失去权限后，即使仍带旧地址也拒绝读写', async () => {
  const c = client();
  await c.login('u-agent');
  assert.equal((await c.get('/api/orgs/jia/customers/C01')).status, 200);

  // 同一会话改成无权限账号（模拟管理员收回权限后再访问旧地址）。
  await c.login('u-outsider');
  assert.equal((await c.get('/api/orgs/jia/customers/C01')).status, 403);
  assert.equal((await c.put('/api/orgs/jia/customers/C01/note', { note: '越权' })).status, 403);
});

test('慢查询在等待期间权限被收回时，不把结果交出去', async () => {
  const agent = getUser('u-agent');
  const original = [...agent.organizationIds];
  const c = client();
  await c.login('u-agent');

  const pending = c.get('/api/orgs/jia/customers/C01?delay=400');
  // 请求已在服务端 sleep，此时收回组织权限。
  await new Promise((resolve) => setTimeout(resolve, 100));
  agent.organizationIds = agent.organizationIds.filter((id) => id !== 'org-jia');
  try {
    const res = await pending;
    assert.equal(res.status, 403);
  } finally {
    agent.organizationIds = original;
  }
});

test('请求体里声明了与地址不同的组织时拒绝写入', async () => {
  const c = client();
  await c.login('u-agent');
  const before = (await c.get('/api/orgs/yi/customers/C01')).data.customer.note;
  const res = await c.put('/api/orgs/yi/customers/C01/note', {
    note: '用甲的名义写乙',
    organizationId: 'org-jia',
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'ORGANIZATION_MISMATCH');
  const after = (await c.get('/api/orgs/yi/customers/C01')).data.customer.note;
  assert.equal(after, before);
});

test('不带组织、只用编号的路径不会被解释成客户资源', async () => {
  const c = client();
  await c.login('u-agent');
  const res = await c.get('/api/customers/C01');
  assert.equal(res.status, 404);
});

test('旧地址 /o/:org/... 刷新时返回客户页外壳，组织信息仍在地址里', async () => {
  const res = await fetch(`${baseUrl}/o/jia/customers/C01`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.match(html, /\/app\.js/);
});

test('静态资源不会被目录穿越读到', async () => {
  const res = await fetch(`${baseUrl}/o/..%2f..%2fpackage.json`);
  // 要么回落到应用页，要么 4xx；绝不能返回仓库里的 package.json。
  const text = await res.text();
  assert.ok(!text.includes('"name": "gsb2-org-bound-desk"'));
});
