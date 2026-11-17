import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/server.js';

const PASSWORD = { jia: 'jia-pass', yi: 'yi-pass', bing: 'bing-pass' };
const MINUTE = 60 * 1000;

let tmpDir;
let app;
let base;
let instanceCount = 0;

function newApp(overrides = {}) {
  // 每个实例使用独立的状态文件，避免测试之间相互影响；
  // 需要模拟重启时显式传入同一组路径。
  instanceCount += 1;
  const dir = path.join(tmpDir, `instance-${instanceCount}`);
  fs.mkdirSync(dir, { recursive: true });
  return createApp({
    host: '127.0.0.1',
    port: 0,
    stateFile: path.join(dir, 'state.json'),
    adminLogFile: path.join(dir, 'admin.log'),
    accountLimit: 3,
    accountWindowMs: 15 * MINUTE,
    sourceLimit: 5,
    sourceWindowMs: 15 * MINUTE,
    demoEnabled: true,
    users: PASSWORD,
    ...overrides,
  });
}

function persistentPaths() {
  instanceCount += 1;
  const dir = path.join(tmpDir, `persistent-${instanceCount}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    stateFile: path.join(dir, 'state.json'),
    adminLogFile: path.join(dir, 'admin.log'),
  };
}

async function listen(instance) {
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const { port } = instance.server.address();
  return `http://127.0.0.1:${port}`;
}

async function start(overrides) {
  // 每个用例都新建实例；上一个实例若还在监听先关掉，避免句柄泄漏。
  if (app) await stop().catch(() => {});
  app = newApp(overrides);
  base = await listen(app);
  return app;
}

async function stop() {
  if (!app) return;
  const closing = new Promise((resolve) => app.server.close(() => resolve()));
  // fetch 默认使用 keep-alive，直接 close 会等待空闲连接；这里主动断开。
  app.server.closeAllConnections?.();
  await closing;
  app = null;
}

async function post(pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

async function get(pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function fail(username, source, times = 1) {
  const results = [];
  for (let i = 0; i < times; i += 1) {
    results.push(await post('/api/demo/login', {
      username,
      password: 'wrong-password',
      source,
    }));
  }
  return results;
}

async function login(username, source, password = PASSWORD[username]) {
  return post('/api/demo/login', { username, password, source });
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-guard-'));
});

after(async () => {
  await stop().catch(() => {});
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('账号累计失败到上限后，换新来源仍被拦截', async () => {
  await start();
  // 演示样例：两个来源累计让甲失败 3 次。
  await fail('jia', 'demo-a', 2);
  await fail('jia', 'demo-b', 1);

  const blocked = await login('jia', 'demo-c');
  assert.equal(blocked.status, 401);

  const status = await get('/api/demo/status?account=jia&source=demo-c');
  assert.equal(status.body.accountWindow.blocked, true);
  assert.equal(status.body.sourceWindow.blocked, false);

  // 新来源本身没有失败计数，说明拦截来自账号层。
  assert.equal(status.body.sourceWindow.used, 0);
  assert.ok(status.body.accountWindow.retryAt > status.body.now - 1);
});

test('账号失败到上限后，其他账号在未满来源仍可登录', async () => {
  await start();
  await fail('jia', 'demo-a', 2);
  await fail('jia', 'demo-b', 1);
  assert.equal((await login('yi', 'demo-c')).status, 200);
});

test('相同来源换不同账号，累计到来源上限后全部被拦截', async () => {
  await start();
  // 5 次失败分散在 3 个账号上，来源层仍然会被占满。
  await fail('jia', 'demo-a', 2);
  await fail('yi', 'demo-a', 2);
  await fail('bing', 'demo-a', 1);

  const blocked = await login('bing', 'demo-a', 'bing-pass');
  assert.equal(blocked.status, 401);

  const status = await get('/api/demo/status?account=bing&source=demo-a');
  assert.equal(status.body.sourceWindow.blocked, true);
  assert.ok(status.body.sourceWindow.used >= 5);

  // 另一个来源不受影响，说明限制按来源分别计算。
  const other = await get('/api/demo/status?account=bing&source=demo-b');
  assert.equal(other.body.sourceWindow.blocked, false);
});

test('成功登录清空本账号计数，但不清除来源计数', async () => {
  await start();
  await fail('yi', 'demo-a', 2); // 来源 2 次，乙账号 2 次
  await fail('jia', 'demo-a', 1); // 来源 3 次，甲账号 1 次

  assert.equal((await login('yi', 'demo-a')).status, 200);

  const afterSuccess = await get('/api/demo/status?account=yi&source=demo-a');
  assert.equal(afterSuccess.body.accountWindow.used, 0);
  assert.equal(afterSuccess.body.sourceWindow.used, 3);

  // 甲自己的计数也还在，成功登录没有替别人清理。
  const jia = await get('/api/demo/status?account=jia&source=demo-a');
  assert.equal(jia.body.accountWindow.used, 1);
});

test('失败与限流对外响应完全一致', async () => {
  await start();
  const failed = await post('/api/demo/login', {
    username: 'jia',
    password: 'nope',
    source: 'demo-a',
  });
  await fail('jia', 'demo-a', 2);
  const limited = await login('jia', 'demo-b');

  assert.deepEqual(failed.body, limited.body);
  assert.equal(failed.status, limited.status);
});

test('管理员日志标出生效的限制层', async () => {
  await start();
  await fail('jia', 'demo-a', 2);
  await fail('jia', 'demo-b', 1);
  await login('jia', 'demo-c');

  const { body } = await get('/api/demo/log?limit=50');
  const blocked = body.entries.filter((entry) => entry.event === 'login_blocked');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].layer, 'account');

  // 来源层生效时日志标记为 source。5 次失败分散到三个账号，
  // 避免单个账号先撞到 3 次的账号上限（被账号层拦下的请求不再计入来源）。
  await fail('yi', 'demo-d', 2);
  await fail('bing', 'demo-d', 2);
  await fail('guest', 'demo-d', 1);
  assert.equal((await login('yi', 'demo-d')).status, 401);
  const second = await get('/api/demo/log?limit=50');
  const sourceBlock = second.body.entries.find(
    (entry) => entry.event === 'login_blocked' && entry.layer === 'source',
  );
  assert.ok(sourceBlock, '应记录来源层限制');
  assert.equal(sourceBlock.source, 'demo-d');

  // 落盘日志同样可审计。
  const lines = fs.readFileSync(app.config.adminLogFile, 'utf8').trim().split('\n');
  const parsed = lines.map((line) => JSON.parse(line));
  assert.ok(parsed.some((entry) => entry.event === 'login_blocked' && entry.layer === 'account'));
});

test('同时到达的失败请求不会越过账号上限', async () => {
  await start();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      post('/api/demo/login', {
        username: 'jia',
        password: `wrong-${index}`,
        source: `burst-${index}`,
      }),
    ),
  );
  assert.ok(results.every((result) => result.status === 401));

  const status = await get('/api/demo/status?account=jia&source=burst-x');
  // 3 次上限之后，其余并发请求都应在计数写入前被拦下。
  assert.equal(status.body.accountWindow.used, 3);

  // 正确密码同样会被拦截，证明锁确实生效而不是仅靠概率。
  assert.equal((await login('jia', 'burst-y')).status, 401);
});

test('同时到达的不同账号请求不会越过来源上限', async () => {
  await start();
  // 每次用不同账号，确保先撞到的是来源上限而不是某个账号的 3 次上限。
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      post('/api/demo/login', {
        username: `user-${index}`,
        password: `wrong-${index}`,
        source: 'shared-source',
      }),
    ),
  );

  const status = await get('/api/demo/status?account=user-0&source=shared-source');
  assert.equal(status.body.sourceWindow.used, 5);
});

test('普通登录接口拒绝客户端自报来源，并按连接来源计数', async () => {
  await start();
  const spoofed = await post('/api/login', {
    username: 'jia',
    password: 'wrong',
    source: 'spoofed-source',
  });
  assert.equal(spoofed.status, 400);
  assert.equal(spoofed.body.error, 'source_not_allowed');

  const normal = await post('/api/login', { username: 'jia', password: 'wrong' });
  assert.equal(normal.status, 401);

  const status = await get('/api/demo/status?account=jia&source=ip%3A127.0.0.1');
  assert.equal(status.body.sourceWindow.used, 1);
});

test('演示时钟推进过窗口后，正确密码可以重新登录', async () => {
  // 用 10 分钟窗口，按整分钟推进，避免依赖亚分钟级的剩余时间。
  await start({ accountWindowMs: 10 * MINUTE });
  await fail('jia', 'demo-a', 2);
  await fail('jia', 'demo-b', 1);
  assert.equal((await login('jia', 'demo-c')).status, 401);

  const beforeAdvance = await get('/api/demo/status?account=jia&source=demo-c');
  assert.equal(beforeAdvance.body.accountWindow.blocked, true);
  assert.ok(beforeAdvance.body.accountWindow.retryAt > beforeAdvance.body.now);

  // 窗口内推进 5 分钟，仍然被限制。
  await post('/api/demo/clock', { advanceMinutes: 5 });
  assert.equal((await login('jia', 'demo-c')).status, 401);

  // 再推进 6 分钟，累计超过 10 分钟窗口，正确密码可以登录。
  await post('/api/demo/clock', { advanceMinutes: 6 });
  assert.equal((await login('jia', 'demo-c')).status, 200);
});

test('服务重启后限流仍按原截止时间生效', async () => {
  const paths = persistentPaths();
  await start({ ...paths, accountWindowMs: 10 * MINUTE });
  await fail('jia', 'demo-a', 2);
  await fail('jia', 'demo-b', 1);
  const before = await get('/api/demo/status?account=jia&source=demo-c');
  assert.equal(before.body.accountWindow.blocked, true);
  const retryAt = before.body.accountWindow.retryAt;
  await stop();

  await start({ ...paths, accountWindowMs: 10 * MINUTE });
  const after = await get('/api/demo/status?account=jia&source=demo-c');
  assert.equal(after.body.accountWindow.blocked, true);
  assert.equal(after.body.accountWindow.retryAt, retryAt);
  assert.equal((await login('jia', 'demo-c')).status, 401);

  // 重启后演示时钟仍然可用，推过窗口后按原截止时间解除限制。
  await post('/api/demo/clock', { advanceMinutes: 11 });
  assert.equal((await login('jia', 'demo-c')).status, 200);
});

test('来源上限按来源分别计算，不影响其他来源', async () => {
  await start();
  // 5 次失败分散到三个账号，让来源层而不是账号层先满。
  await fail('yi', 'demo-a', 2);
  await fail('bing', 'demo-a', 2);
  await fail('jia', 'demo-a', 1);

  assert.equal((await login('yi', 'demo-a')).status, 401);
  assert.equal((await login('yi', 'demo-b')).status, 200);
});

test('两套窗口按各自的截止时间解除，互不推迟', async () => {
  await start({ accountWindowMs: 10 * MINUTE, sourceWindowMs: 30 * MINUTE });
  // 甲账号 3 次、来源共 5 次：两层同时触发，截止时间不同。
  await fail('jia', 'demo-a', 2);
  await fail('yi', 'demo-a', 2);
  await fail('jia', 'demo-a', 1);

  const initial = await get('/api/demo/status?account=jia&source=demo-a');
  assert.equal(initial.body.accountWindow.blocked, true);
  assert.equal(initial.body.sourceWindow.blocked, true);
  assert.ok(initial.body.sourceWindow.retryAt > initial.body.accountWindow.retryAt);

  // 越过账号窗口但仍在来源窗口内：账号层解除，来源层继续拦截。
  await post('/api/demo/clock', { advanceMinutes: 12 });
  const afterAccount = await get('/api/demo/status?account=jia&source=demo-a');
  assert.equal(afterAccount.body.accountWindow.blocked, false);
  assert.equal(afterAccount.body.sourceWindow.blocked, true);
  assert.deepEqual(afterAccount.body.blockedBy, ['source']);
  assert.equal(afterAccount.body.nextRetryAt, afterAccount.body.sourceWindow.retryAt);
  assert.equal((await login('jia', 'demo-a')).status, 401);

  // 日志应记录这一轮生效的是来源层（演示请求日志排在后面，需按事件筛选）。
  const { body } = await get('/api/demo/log?limit=10');
  const lastBlock = body.entries.find((entry) => entry.event === 'login_blocked');
  assert.equal(lastBlock.layer, 'source');
  assert.equal(lastBlock.source, 'demo-a');

  // 再过 20 分钟，来源窗口也过期，正确密码可以登录。
  await post('/api/demo/clock', { advanceMinutes: 20 });
  assert.equal((await login('jia', 'demo-a')).status, 200);
});

test('账号层与来源层同时生效时，日志记录两层', async () => {
  await start();
  // 来源层先满 5 次，其中甲自己贡献了 3 次，两层同时处于上限。
  await fail('jia', 'demo-a', 3);
  await fail('yi', 'demo-a', 2);

  assert.equal((await login('jia', 'demo-a')).status, 401);
  const { body } = await get('/api/demo/log?limit=10');
  const blocked = body.entries.find((entry) => entry.event === 'login_blocked');
  assert.deepEqual(blocked.layers, ['account', 'source']);
  assert.equal(blocked.layer, 'account');

  // 乙账号本身没有到 3 次，但来源满员，仍然会被来源层拦下。
  await fail('yi', 'demo-a', 1);
  assert.equal((await login('yi', 'demo-a')).status, 401);
  const second = await get('/api/demo/log?limit=10');
  const sourceOnly = second.body.entries.find(
    (entry) => entry.event === 'login_blocked' && entry.account === 'yi',
  );
  assert.deepEqual(sourceOnly.layers, ['source']);
});

test('被拦截的请求不会延长原有截止时间', async () => {
  await start();
  await fail('jia', 'demo-a', 2);
  await fail('jia', 'demo-b', 1);

  const before = await get('/api/demo/status?account=jia&source=demo-c');
  // 多次被拦截的尝试不应写入新的失败时间戳。
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await login('jia', 'demo-c')).status, 401);
  }
  const after = await get('/api/demo/status?account=jia&source=demo-c');
  assert.equal(after.body.accountWindow.used, 3);
  assert.equal(after.body.accountWindow.retryAt, before.body.accountWindow.retryAt);
});

test('样例走查：两个来源累计 3 次后换新来源仍受限，其他人可登录，时钟推过后恢复', async () => {
  await start({ accountWindowMs: 10 * MINUTE, sourceWindowMs: 10 * MINUTE });

  // 1. 甲用两个演示来源累计失败 3 次。
  await fail('jia', 'demo-a', 2);
  await fail('jia', 'demo-b', 1);

  // 2. 甲换到全新的 demo-c：来源计数为 0，仍被拦截——限制来自账号层。
  const blockedStatus = await get('/api/demo/status?account=jia&source=demo-c');
  assert.equal(blockedStatus.body.sourceWindow.used, 0);
  assert.equal(blockedStatus.body.accountWindow.used, 3);
  assert.deepEqual(blockedStatus.body.blockedBy, ['account']);
  assert.equal((await login('jia', 'demo-c')).status, 401);

  // 3. 乙在另一个用量未满的来源仍能登录。
  const yiStatus = await get('/api/demo/status?account=yi&source=demo-c');
  assert.equal(yiStatus.body.sourceWindow.blocked, false);
  assert.equal((await login('yi', 'demo-c')).status, 200);

  // 4. 把时钟推进超过账号窗口，甲用正确密码即可登录。
  assert.equal((await login('jia', 'demo-c')).status, 401);
  await post('/api/demo/clock', { advanceMinutes: 11 });
  assert.equal((await login('jia', 'demo-c')).status, 200);
});

test('本机可以访问演示接口', async () => {
  await start();
  const response = await fetch(`${base}/api/demo/status?account=jia&source=demo-a`);
  assert.equal(response.status, 200);
});

test('关闭演示模式后演示入口返回 404', async () => {
  await start({ demoEnabled: false });
  const result = await get('/api/demo/status?account=jia&source=demo-a');
  assert.equal(result.status, 404);
  assert.equal((await login('jia', 'demo-a')).status, 404);
});
