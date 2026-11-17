/**
 * 端到端验收测试：覆盖题目要求的完整剧本。
 * node --test 内置运行器，零依赖；每个用例使用独立临时数据文件与内存时钟。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { createApp } from '../src/app.js';

let baseUrl;
let server;
let app;
let dir;
const mkdtempAsync = promisify(mkdtemp);
const rmAsync = promisify(rm);

async function start() {
  dir = await mkdtempAsync(join(tmpdir(), 'gsb2-test-'));
  app = createApp({ dbPath: join(dir, 'db.json'), queueDelayMs: 0 });
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stop() {
  clearInterval(app.timer);
  await new Promise((resolve) => server.close(resolve));
  await rmAsync(dir, { recursive: true, force: true });
}

async function call(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

const admin = {
  state: () => call('GET', '/api/admin/state'),
  issue: (payload) => call('POST', '/api/admin/keys', { body: payload }),
  rotate: (keyId, overlapMs = 3_600_000) =>
    call('POST', '/api/admin/keys/rotate', { body: { keyId, overlapMs } }),
  revoke: (keyId) => call('POST', '/api/admin/keys/revoke', { body: { keyId } }),
  toggle: (id) => call('POST', '/api/admin/service-accounts/toggle', { body: { id } }),
  advance: (ms) => call('POST', '/api/admin/clock/advance', { body: { ms } }),
  resetDemo: () => call('POST', '/api/admin/demo/reset', {}),
};

const READ = 'inventory:read';
const WRITE = 'stocktake:submit';

beforeEach(start);
afterEach(stop);

test('初始播种：两个仓库、两个服务账号、零把钥匙', async () => {
  const { data } = await admin.state();
  assert.deepEqual(data.warehouses.map((w) => w.code), ['WH1', 'WH2']);
  assert.equal(data.serviceAccounts.length, 2);
  assert.equal(data.keys.length, 0);
  const ro = data.serviceAccounts.find((a) => a.id === 'sa_ro_wh1');
  assert.deepEqual(ro.allowedWarehouses, ['WH1']);
  assert.deepEqual(ro.allowedActions, [READ]);
});

test('签发：明文仅返回一次；状态接口只暴露前缀和哈希外的字段', async () => {
  const { status, data } = await admin.issue({
    serviceAccountId: 'sa_ro_wh1',
    warehouses: ['WH1'],
    actions: [READ],
  });
  assert.equal(status, 201);
  assert.match(data.issued.secret, /^gsb2_live_/);
  assert.ok(data.issued.secret.length > 40);

  const state = await admin.state();
  const key = state.data.keys[0];
  assert.ok(!JSON.stringify(key).includes(data.issued.secret), '状态里绝不能出现明文');
  assert.ok(!('hash' in key), '状态里不能暴露哈希');
  assert.match(key.prefix, /…$/);
  assert.equal(key.status, 'active');
  assert.deepEqual(key.warehouses, ['WH1']);
  assert.deepEqual(key.actions, [READ]);
});

test('签发即被服务账号权限夹住：只读账号不能申请盘点动作或仓库二', async () => {
  const overAction = await admin.issue({
    serviceAccountId: 'sa_ro_wh1',
    warehouses: ['WH1'],
    actions: [READ, WRITE],
  });
  assert.equal(overAction.status, 403);
  assert.equal(overAction.data.error, 'FORBIDDEN');

  const overWarehouse = await admin.issue({
    serviceAccountId: 'sa_ro_wh1',
    warehouses: ['WH1', 'WH2'],
    actions: [READ],
  });
  assert.equal(overWarehouse.status, 403);

  // 停用中的账号不能签发
  await admin.toggle('sa_ro_wh1');
  const disabled = await admin.issue({
    serviceAccountId: 'sa_ro_wh1',
    warehouses: ['WH1'],
    actions: [READ],
  });
  assert.equal(disabled.status, 409);
});

test('只读钥匙：可查仓库一；仓库二与盘点提交都被拒绝', async () => {
  const { data } = await admin.issue({
    serviceAccountId: 'sa_ro_wh1',
    warehouses: ['WH1'],
    actions: [READ],
  });
  const token = data.issued.secret;

  const ok = await call('GET', '/api/inventory?warehouse=WH1', { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.items.length, 2);

  const wh2 = await call('GET', '/api/inventory?warehouse=WH2', { token });
  assert.equal(wh2.status, 403);

  const write = await call('POST', '/api/stocktakes', {
    token,
    body: { warehouse: 'WH1', sku: 'SKU-1001', countedQty: 1 },
  });
  assert.equal(write.status, 403);
});

test('无钥匙 / 错钥匙 / 畸形请求头一律 401', async () => {
  const none = await call('GET', '/api/inventory?warehouse=WH1');
  assert.equal(none.status, 401);

  const wrong = await call('GET', '/api/inventory?warehouse=WH1', { token: 'gsb2_live_nope' });
  assert.equal(wrong.status, 401);

  const res = await fetch(`${baseUrl}/api/inventory?warehouse=WH1`, {
    headers: { authorization: 'Basic abc' },
  });
  assert.equal(res.status, 401);
});

test('轮换：重叠期新旧两把钥匙都能查仓库一；截止时刻后旧钥匙停止使用', async () => {
  const issued = await admin.issue({
    serviceAccountId: 'sa_ro_wh1',
    warehouses: ['WH1'],
    actions: [READ],
  });
  const oldSecret = issued.data.issued.secret;
  const oldId = issued.data.issued.key.id;

  // 重叠期 1 小时
  const rotated = await admin.rotate(oldId, 3_600_000);
  assert.equal(rotated.status, 201);
  const newSecret = rotated.data.issued.secret;
  assert.notEqual(newSecret, oldSecret);

  let s = (await admin.state()).data;
  const oldKey = s.keys.find((k) => k.id === oldId);
  const newKey = s.keys.find((k) => k.id === rotated.data.issued.key.id);
  assert.equal(oldKey.status, 'overlapping');
  assert.equal(newKey.status, 'active');
  // 新钥匙复制原范围，且没有突破账号权限
  assert.deepEqual(newKey.warehouses, ['WH1']);
  assert.deepEqual(newKey.actions, [READ]);
  assert.equal(newKey.rotatedFromId, oldId);

  // 重叠期：两把都能查仓库一
  assert.equal((await call('GET', '/api/inventory?warehouse=WH1', { token: oldSecret })).status, 200);
  assert.equal((await call('GET', '/api/inventory?warehouse=WH1', { token: newSecret })).status, 200);
  // 两把都不能查仓库二
  assert.equal((await call('GET', '/api/inventory?warehouse=WH2', { token: oldSecret })).status, 403);
  assert.equal((await call('GET', '/api/inventory?warehouse=WH2', { token: newSecret })).status, 403);

  // 快进到截止时刻之后
  await admin.advance(3_600_001);
  s = (await admin.state()).data;
  assert.equal(s.keys.find((k) => k.id === oldId).status, 'expired');

  const oldNow = await call('GET', '/api/inventory?warehouse=WH1', { token: oldSecret });
  assert.equal(oldNow.status, 401);
  const newNow = await call('GET', '/api/inventory?warehouse=WH1', { token: newSecret });
  assert.equal(newNow.status, 200, '到期后只剩新钥匙生效');

  // 已到期的钥匙不能再次轮换
  const again = await admin.rotate(oldId);
  assert.equal(again.status, 409);
});

test('停用服务账号：所有钥匙立即失效，重新启用也不复活已到期钥匙', async () => {
  const issued = await admin.issue({
    serviceAccountId: 'sa_ro_wh1',
    warehouses: ['WH1'],
    actions: [READ],
  });
  const token = issued.data.issued.secret;
  assert.equal((await call('GET', '/api/inventory?warehouse=WH1', { token })).status, 200);

  await admin.toggle('sa_ro_wh1');
  const denied = await call('GET', '/api/inventory?warehouse=WH1', { token });
  assert.equal(denied.status, 401);
  assert.match(denied.data.message, /服务账号已停用/);

  // 停用期间不能轮换
  const rot = await admin.rotate(issued.data.issued.key.id);
  assert.equal(rot.status, 409);

  await admin.toggle('sa_ro_wh1');
  assert.equal((await call('GET', '/api/inventory?warehouse=WH1', { token })).status, 200);
});

test('排队盘点：入队核对范围；执行前再次确认，账号停用则拒写', async () => {
  // 读写账号签发一把可盘点钥匙
  const issued = await admin.issue({
    serviceAccountId: 'sa_rw',
    warehouses: ['WH1'],
    actions: [READ, WRITE],
  });
  const token = issued.data.issued.secret;

  const before = (await admin.state()).data.inventory.find(
    (i) => i.sku === 'SKU-1001' && i.warehouse === 'WH1'
  ).qty;

  const enq = await call('POST', '/api/stocktakes', {
    token,
    body: { warehouse: 'WH1', sku: 'SKU-1001', countedQty: 999 },
  });
  assert.equal(enq.status, 202);
  assert.equal(enq.data.job.status, 'queued');

  // 任务还在排队时停用账号：执行时刻的再次确认必须拒写
  await admin.toggle('sa_rw');
  await admin.advance(10); // queueDelayMs=0，推进时钟触发 tick
  let s = (await admin.state()).data;
  let job = s.jobs.find((j) => j.id === enq.data.job.id);
  assert.equal(job.status, 'rejected');
  assert.match(job.result, /服务账号已停用/);
  const stock = s.inventory.find((i) => i.sku === 'SKU-1001' && i.warehouse === 'WH1');
  assert.equal(stock.qty, before, '被拒写的任务不能改动库存');

  // 重新启用后再提交一把，正常排队并写入
  await admin.toggle('sa_rw');
  const enq2 = await call('POST', '/api/stocktakes', {
    token,
    body: { warehouse: 'WH1', sku: 'SKU-1001', countedQty: 888 },
  });
  await admin.advance(10);
  s = (await admin.state()).data;
  job = s.jobs.find((j) => j.id === enq2.data.job.id);
  assert.equal(job.status, 'applied');
  assert.equal(
    s.inventory.find((i) => i.sku === 'SKU-1001' && i.warehouse === 'WH1').qty,
    888
  );
});

test('排队盘点：重叠期到期的旧钥匙在执行时刻被拒写，新钥匙正常', async () => {
  const issued = await admin.issue({
    serviceAccountId: 'sa_rw',
    warehouses: ['WH1'],
    actions: [READ, WRITE],
  });
  const oldSecret = issued.data.issued.secret;
  const oldId = issued.data.issued.key.id;
  const rotated = await admin.rotate(oldId, 3_600_000);
  const newSecret = rotated.data.issued.secret;

  // 旧钥匙在重叠期入队
  const enq = await call('POST', '/api/stocktakes', {
    token: oldSecret,
    body: { warehouse: 'WH1', sku: 'SKU-1002', countedQty: 1 },
  });
  assert.equal(enq.status, 202);

  // 越过旧钥匙截止时刻
  await admin.advance(3_600_001);
  const job = (await admin.state()).data.jobs.find((j) => j.id === enq.data.job.id);
  assert.equal(job.status, 'rejected');
  assert.match(job.result, /expired|到期|失效/);

  // 新钥匙的盘点正常写入
  const enq2 = await call('POST', '/api/stocktakes', {
    token: newSecret,
    body: { warehouse: 'WH1', sku: 'SKU-1002', countedQty: 77 },
  });
  await admin.advance(10);
  const final = (await admin.state()).data;
  const applied = final.jobs.find((j) => j.id === enq2.data.job.id);
  assert.equal(applied.status, 'applied');
  assert.equal(
    final.inventory.find((i) => i.sku === 'SKU-1002' && i.warehouse === 'WH1').qty,
    77
  );
});

test('手动吊销钥匙立即不可用；重置演示数据回到初始态', async () => {
  const issued = await admin.issue({
    serviceAccountId: 'sa_ro_wh1',
    warehouses: ['WH1'],
    actions: [READ],
  });
  const token = issued.data.issued.secret;
  await admin.revoke(issued.data.issued.key.id);
  assert.equal((await call('GET', '/api/inventory?warehouse=WH1', { token })).status, 401);

  await admin.resetDemo();
  const s = (await admin.state()).data;
  assert.equal(s.keys.length, 0);
  assert.equal(s.jobs.length, 0);
  assert.equal(s.clock.offsetMs, 0);
});
