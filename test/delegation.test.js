import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.js';

const ORDER_1 = 'ORD-20261117-001';
const ORDER_2 = 'ORD-20261117-002';

/** 极简 HTTP 客户端：自己管理 cookie、不自动跟随重定向。 */
function client(base) {
  const agent = new http.Agent({ keepAlive: false });
  let cookie = '';
  return {
    async request(path, { method = 'GET', form } = {}) {
      const headers = {};
      let body = '';
      if (cookie) headers.cookie = cookie;
      if (form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form).toString();
        headers['content-length'] = Buffer.byteLength(body);
      }
      return new Promise((resolve, reject) => {
        const req = http.request(`${base}${path}`, { method, headers, agent }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const set = res.headers['set-cookie'];
            if (set) {
              const pair = (Array.isArray(set) ? set[0] : set).split(';')[0];
              cookie = pair.endsWith('=') ? '' : pair;
            }
            resolve({
              status: res.statusCode,
              location: res.headers.location,
              text: Buffer.concat(chunks).toString('utf8'),
            });
          });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    },
    async csrf() {
      const r = await this.request('/login');
      const m = r.text.match(/name="csrf" value="([^"]+)"/);
      assert.ok(m, 'csrf token should be rendered');
      return m[1];
    },
  };
}

async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

async function loginAs(base, userId) {
  const c = client(base);
  const csrf = await c.csrf();
  const r = await c.request('/login', { method: 'POST', form: { csrf, userId } });
  assert.equal(r.status, 303);
  return c;
}

async function issueDelegation(base, { agentId, orderId, ttlMinutes = 15 }) {
  const customer = await loginAs(base, 'cust_chen');
  const csrf = await customer.csrf();
  const r = await customer.request('/customer/delegate', {
    method: 'POST',
    form: { csrf, agentId, orderId, ttlMinutes },
  });
  assert.equal(r.status, 303, r.text);
  const loc = decodeURIComponent(r.location);
  const m = loc.match(/DLG-\d{8}-[0-9A-F]{4}/);
  assert.ok(m, `delegation id in redirect: ${loc}`);
  return { customer, delegationId: m[0] };
}

async function enter(base, agentClient, delegationId) {
  const csrf = await agentClient.csrf();
  const r = await agentClient.request('/agent/enter', { method: 'POST', form: { csrf, delegationId } });
  return r;
}

function extractApplicationId(html) {
  const m = html.match(/AS-\d{8}-[0-9A-F]{4}/);
  return m ? m[0] : null;
}

test('客服只能代办被授权的订单，申请的客户身份/客服/授权编号都落库', async () => {
  await withServer(async (base) => {
    const { delegationId } = await issueDelegation(base, { agentId: 'agent_lin', orderId: ORDER_1 });

    const lin = await loginAs(base, 'agent_lin');
    const entered = await enter(base, lin, delegationId);
    assert.equal(entered.status, 303);
    assert.equal(entered.location, '/agent/after-sales/new');

    const formPage = await lin.request('/agent/after-sales/new');
    assert.equal(formPage.status, 200);
    assert.match(formPage.text, new RegExp(delegationId));
    assert.match(formPage.text, /仅限订单 A20261117001/);

    const csrf = await lin.csrf();
    const submitted = await lin.request('/agent/after-sales', {
      method: 'POST',
      form: { csrf, orderId: ORDER_1, reason: '耳机左耳无声，申请换货' },
    });
    assert.equal(submitted.status, 200, submitted.text);
    const appId = extractApplicationId(submitted.text);
    assert.ok(appId);
    assert.match(submitted.text, /陈女士/);
    assert.match(submitted.text, /小林/);
    assert.match(submitted.text, new RegExp(delegationId));

    // 客户页面能看到实际操作人与授权编号
    const custHome = await (await loginAs(base, 'cust_chen')).request('/customer');
    assert.match(custHome.text, new RegExp(appId));
    assert.match(custHome.text, new RegExp(delegationId));
    assert.match(custHome.text, /小林/);

    // 审计里同样可查
    const audit = await (await loginAs(base, 'cust_chen')).request('/customer/audit');
    assert.match(audit.text, /after_sales\.submit/);
    assert.match(audit.text, new RegExp(delegationId));
  });
});

test('第二笔订单不在授权范围，客服不能代办', async () => {
  await withServer(async (base) => {
    const { delegationId } = await issueDelegation(base, { agentId: 'agent_lin', orderId: ORDER_1 });
    const lin = await loginAs(base, 'agent_lin');
    await enter(base, lin, delegationId);

    const csrf = await lin.csrf();
    const r = await lin.request('/agent/after-sales', {
      method: 'POST',
      form: { csrf, orderId: ORDER_2, reason: '台灯闪烁，申请维修' },
    });
    assert.equal(r.status, 403);
    assert.match(r.text, /不在本次授权范围内/);

    // 客户侧的申请列表里没有这条申请
    const custHome = await (await loginAs(base, 'cust_chen')).request('/customer');
    assert.doesNotMatch(custHome.text, /台灯闪烁/);
  });
});

test('授权只发给指定客服，其他客服无法接手或提交', async () => {
  await withServer(async (base) => {
    const { delegationId } = await issueDelegation(base, { agentId: 'agent_lin', orderId: ORDER_1 });

    const zhou = await loginAs(base, 'agent_zhou');
    const tried = await enter(base, zhou, delegationId);
    assert.equal(tried.status, 403);
    assert.match(tried.text, /不是授予当前客服的/);

    // 即使绕过页面直接提交也不行
    const csrf = await zhou.csrf();
    const direct = await zhou.request('/agent/after-sales', {
      method: 'POST',
      form: { csrf, orderId: ORDER_1, reason: '越权提交测试' },
    });
    assert.equal(direct.status, 409); // 没有代办上下文
  });
});

test('客户取消授权后，客服已打开的表单无法提交', async () => {
  await withServer(async (base) => {
    const { customer, delegationId } = await issueDelegation(base, { agentId: 'agent_lin', orderId: ORDER_1 });
    const lin = await loginAs(base, 'agent_lin');
    await enter(base, lin, delegationId);

    const opened = await lin.request('/agent/after-sales/new');
    assert.match(opened.text, /代客户提交售后申请/);
    const csrf = await lin.csrf(); // 表单已打开，手上已有 token

    // 客户此刻取消
    const custCsrf = await customer.csrf();
    const cancelled = await customer.request('/customer/cancel', {
      method: 'POST',
      form: { csrf: custCsrf, delegationId },
    });
    assert.equal(cancelled.status, 303);

    const blocked = await lin.request('/agent/after-sales', {
      method: 'POST',
      form: { csrf, orderId: ORDER_1, reason: '取消后仍尝试提交' },
    });
    assert.equal(blocked.status, 409);
    assert.match(blocked.text, /客户已取消该授权/);

    const after = await (await loginAs(base, 'cust_chen')).request('/customer');
    assert.doesNotMatch(after.text, /取消后仍尝试提交/);

    const audit = await (await loginAs(base, 'cust_chen')).request('/customer/audit');
    assert.match(audit.text, /blocked_cancelled/);
  });
});

test('同一授权重复提交只返回原申请结果', async () => {
  await withServer(async (base) => {
    const { delegationId } = await issueDelegation(base, { agentId: 'agent_lin', orderId: ORDER_1 });
    const lin = await loginAs(base, 'agent_lin');
    await enter(base, lin, delegationId);
    const csrf = await lin.csrf();

    const first = await lin.request('/agent/after-sales', {
      method: 'POST',
      form: { csrf, orderId: ORDER_1, reason: '第一次提交：申请换货' },
    });
    const firstId = extractApplicationId(first.text);

    const second = await lin.request('/agent/after-sales', {
      method: 'POST',
      form: { csrf, orderId: ORDER_1, reason: '第二次提交：内容不同' },
    });
    assert.equal(second.status, 200);
    assert.equal(extractApplicationId(second.text), firstId);
    assert.match(second.text, /原申请结果/);
    assert.doesNotMatch(second.text, /内容不同/);

    const home = await lin.request('/agent');
    const appIds = [...home.text.matchAll(/AS-\d{8}-[0-9A-F]{4}/g)].map((m) => m[0]);
    assert.equal(new Set(appIds).size, 1);
  });
});

test('退出代办后会话只剩客服本人，不残留客户身份；其余页面仍按客服身份工作', async () => {
  await withServer(async (base) => {
    const { delegationId } = await issueDelegation(base, { agentId: 'agent_lin', orderId: ORDER_1 });
    const lin = await loginAs(base, 'agent_lin');
    await enter(base, lin, delegationId);

    const inDelegation = await lin.request('/agent/audit');
    assert.match(inDelegation.text, /代办中/);
    // 代办状态只开放售后流程，审计页仍是客服自己的视角
    assert.match(inDelegation.text, /小林/);

    const csrf = await lin.csrf();
    const exited = await lin.request('/agent/exit', { method: 'POST', form: { csrf } });
    assert.equal(exited.status, 303);

    const after = await lin.request('/agent');
    assert.doesNotMatch(after.text, /代办中/);
    assert.match(after.text, /客服工作台/);
    assert.match(after.text, /小林/);
    // 不能再直接进入代报表单
    const form = await lin.request('/agent/after-sales/new');
    assert.equal(form.status, 303);
    assert.equal(form.location, '/agent');

    // 客户身份仍在客户自己的会话里，且依旧能正常使用
    const custHome = await (await loginAs(base, 'cust_chen')).request('/customer');
    assert.match(custHome.text, /我的订单/);
  });
});

test('客户账号无法进入客服代办的任何页面', async () => {
  await withServer(async (base) => {
    const { delegationId } = await issueDelegation(base, { agentId: 'agent_lin', orderId: ORDER_1 });
    const customer = await loginAs(base, 'cust_chen');

    for (const path of ['/agent', '/agent/after-sales/new', '/agent/audit', `/agent/after-sales/${delegationId}`]) {
      const r = await customer.request(path);
      assert.equal(r.status, 403, `${path} 应拒绝客户访问`);
    }

    const csrf = await customer.csrf();
    const exited = await customer.request('/agent/exit', { method: 'POST', form: { csrf } });
    assert.equal(exited.status, 403);
  });
});

test('客户不能取消已提交的授权', async () => {
  await withServer(async (base) => {
    const { delegationId } = await issueDelegation(base, { agentId: 'agent_lin', orderId: ORDER_1 });
    const lin = await loginAs(base, 'agent_lin');
    await enter(base, lin, delegationId);
    const csrf = await lin.csrf();
    await lin.request('/agent/after-sales', {
      method: 'POST',
      form: { csrf, orderId: ORDER_1, reason: '已提交后不可取消' },
    });

    const customer = await loginAs(base, 'cust_chen');
    const custCsrf = await customer.csrf();
    const r = await customer.request('/customer/cancel', {
      method: 'POST',
      form: { csrf: custCsrf, delegationId },
    });
    assert.equal(r.status, 409);
    assert.match(r.text, /不能取消/);
  });
});
