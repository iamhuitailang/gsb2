import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopedReader } from '../public/request-gate.js';

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 可以手动决定「谁先返回」的假 fetch。 */
function deferredFetch() {
  const pending = [];
  const fetchImpl = (url) =>
    new Promise((resolve) => {
      pending.push({ url, resolve });
    });
  return {
    fetchImpl,
    pending,
    resolveUrl(url, body, status = 200) {
      const entry = pending.find((p) => p.url === url);
      if (!entry) throw new Error(`没有在途请求：${url}`);
      entry.resolve(jsonResponse(body, status));
    },
  };
}

test('request-gate：旧请求的慢结果被标记为 stale，不交给页面', async () => {
  const fake = deferredFetch();
  const reader = createScopedReader({
    buildUrl: ({ orgId }) => `/api/orgs/${orgId}/customers/C01`,
    fetchImpl: fake.fetchImpl,
  });

  const jia = reader.load({ orgId: 'org-jia' });
  const yi = reader.load({ orgId: 'org-yi' });

  // 乙先返回
  fake.resolveUrl('/api/orgs/org-yi/customers/C01', {
    org: { id: 'org-yi', name: '乙组织' },
    customer: { localCustomerNo: 'C01', remark: '乙的备注' },
  });
  assert.equal((await yi).outcome, 'ok');

  // 甲的慢结果后到 —— 必须是 stale，页面不能拿它去渲染
  fake.resolveUrl('/api/orgs/org-jia/customers/C01', {
    org: { id: 'org-jia', name: '甲组织' },
    customer: { localCustomerNo: 'C01', remark: '甲的备注' },
  });
  const jiaResult = await jia;
  assert.equal(jiaResult.outcome, 'stale');
  assert.equal(jiaResult.body, undefined);
});

test('request-gate：响应里的组织与请求的组织不一致时判为 mismatch', async () => {
  const fake = deferredFetch();
  const reader = createScopedReader({
    buildUrl: ({ orgId }) => `/api/orgs/${orgId}/customers/C01`,
    fetchImpl: fake.fetchImpl,
  });

  const pending = reader.load({ orgId: 'org-jia' });
  // 服务端/代理错配：请求甲，却回来乙的数据
  fake.resolveUrl('/api/orgs/org-jia/customers/C01', {
    org: { id: 'org-yi', name: '乙组织' },
    customer: { localCustomerNo: 'C01', remark: '乙的备注' },
  });
  const result = await pending;
  assert.equal(result.outcome, 'mismatch');
});

test('request-gate：reset 之后所有在途结果都作废', async () => {
  const fake = deferredFetch();
  const reader = createScopedReader({
    buildUrl: ({ orgId }) => `/api/orgs/${orgId}/customers/C01`,
    fetchImpl: fake.fetchImpl,
  });
  const pending = reader.load({ orgId: 'org-jia' });
  reader.reset();
  fake.resolveUrl('/api/orgs/org-jia/customers/C01', {
    org: { id: 'org-jia', name: '甲组织' },
    customer: { localCustomerNo: 'C01', remark: '甲的备注' },
  });
  assert.equal((await pending).outcome, 'stale');
});

test('request-gate：HTTP 错误保留状态码与错误体', async () => {
  const fake = deferredFetch();
  const reader = createScopedReader({
    buildUrl: ({ orgId }) => `/api/orgs/${orgId}/customers/C01`,
    fetchImpl: fake.fetchImpl,
  });
  const pending = reader.load({ orgId: 'org-jia' });
  fake.resolveUrl(
    '/api/orgs/org-jia/customers/C01',
    { error: { code: 'ORG_FORBIDDEN', message: '没有权限' } },
    403,
  );
  const result = await pending;
  assert.equal(result.outcome, 'error');
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'ORG_FORBIDDEN');
});
