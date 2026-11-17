/**
 * 服务端规则测试（零依赖，node test/api.test.mjs）。
 * 覆盖：按检查点授权、逐条权限核对、幂等去重、403 不落库、冲突检测、数据校验。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import process from 'node:process';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4319';
const DRAFT_A = '11111111-1111-4111-8111-111111111111';
const DRAFT_B = '22222222-2222-4222-8222-222222222222';

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

let server;
let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      await api('/api/checkpoints');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('服务端启动超时');
}

async function main() {
  if (!process.env.BASE_URL) {
    server = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: '4319' },
      stdio: 'ignore',
    });
  }
  await waitForServer();
  await api('/api/admin/reset', { method: 'POST' });

  // 1. 初始授权：两个检查点都有权限
  await test('初始状态：员工对甲、乙两个检查点都有授权', async () => {
    const { status, body } = await api('/api/me?employeeId=e1');
    assert.equal(status, 200);
    assert.deepEqual(
      body.permissions.map((p) => [p.checkpointId, p.granted]).sort(),
      [
        ['CP-A', true],
        ['CP-B', true],
      ]
    );
  });

  // 2. 参数校验
  await test('缺少必要字段返回 400', async () => {
    const { status } = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({ employeeId: 'e1', checkpointId: 'CP-A' }),
    });
    assert.equal(status, 400);
  });

  await test('非法结论 result 返回 400', async () => {
    const { status } = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: 'e1',
        checkpointId: 'CP-A',
        draftId: crypto.randomUUID(),
        result: 'bogus',
        note: '',
      }),
    });
    assert.equal(status, 400);
  });

  // 3. 主管撤销甲点授权
  await test('主管撤销甲点授权后，权限快照立即变化', async () => {
    const { status } = await api('/api/admin/grants', {
      method: 'POST',
      body: JSON.stringify({ employeeId: 'e1', checkpointId: 'CP-A', granted: false }),
    });
    assert.equal(status, 200);
    const me = await api('/api/me?employeeId=e1');
    const cpA = me.body.permissions.find((p) => p.checkpointId === 'CP-A');
    const cpB = me.body.permissions.find((p) => p.checkpointId === 'CP-B');
    assert.equal(cpA.granted, false);
    assert.equal(cpB.granted, true);
  });

  // 4. 甲点草稿（无权限）：403 且服务端不落库
  await test('甲点草稿提交返回 403，且不进入正式检查单', async () => {
    const { status, body } = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: 'e1',
        checkpointId: 'CP-A',
        draftId: DRAFT_A,
        result: 'pass',
        note: '甲点离线草稿',
      }),
    });
    assert.equal(status, 403);
    assert.match(body.error, /授权/);

    const state = await api('/api/admin/state');
    assert.equal(state.body.records.length, 0);
    assert.equal(
      state.body.records.some((r) => r.draftId === DRAFT_A),
      false
    );
  });

  // 5. 无权限草稿反复重试：始终 403，始终不落库（不影响其他检查点）
  await test('甲点草稿再次重试仍是 403，服务端依旧没有任何记录', async () => {
    const again = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: 'e1',
        checkpointId: 'CP-A',
        draftId: DRAFT_A,
        result: 'pass',
        note: '甲点离线草稿',
      }),
    });
    assert.equal(again.status, 403);
    const state = await api('/api/admin/state');
    assert.equal(state.body.records.length, 0);
  });

  // 6. 乙点草稿（有权限）：成功入库
  await test('乙点草稿提交成功，正式检查单恰好入库一条', async () => {
    const { status, body } = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: 'e1',
        checkpointId: 'CP-B',
        draftId: DRAFT_B,
        result: 'pass',
        note: '乙点离线草稿',
      }),
    });
    assert.equal(status, 201);
    assert.equal(body.duplicated, false);

    const state = await api('/api/admin/state');
    assert.equal(state.body.records.length, 1);
    assert.equal(state.body.records[0].draftId, DRAFT_B);
    assert.equal(state.body.records[0].checkpointId, 'CP-B');
  });

  // 7. 同一份乙点草稿重试：幂等，只保存一份
  await test('同一份乙点草稿重试返回 duplicated=true，记录数仍为 1', async () => {
    const retry = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: 'e1',
        checkpointId: 'CP-B',
        draftId: DRAFT_B,
        result: 'pass',
        note: '乙点离线草稿',
      }),
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicated, true);
    const state = await api('/api/admin/state');
    assert.equal(state.body.records.length, 1);
    assert.equal(state.body.records[0].id, retry.body.record.id);
  });

  // 8. 复用 draftId 但内容不同：拒绝覆盖
  await test('同一 draftId 携带不同内容返回 409，防止覆盖原记录', async () => {
    const { status } = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: 'e1',
        checkpointId: 'CP-B',
        draftId: DRAFT_B,
        result: 'fail',
        note: '被篡改的内容',
      }),
    });
    assert.equal(status, 409);
    const state = await api('/api/admin/state');
    assert.equal(state.body.records.length, 1);
    assert.equal(state.body.records[0].result, 'pass');
  });

  // 9. 恢复甲点授权后，同一条甲点草稿可以正常入库
  await test('恢复甲点授权后，原甲点草稿重新提交成功（草稿不丢、逐条独立）', async () => {
    await api('/api/admin/grants', {
      method: 'POST',
      body: JSON.stringify({ employeeId: 'e1', checkpointId: 'CP-A', granted: true }),
    });
    const { status, body } = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: 'e1',
        checkpointId: 'CP-A',
        draftId: DRAFT_A,
        result: 'pass',
        note: '甲点离线草稿',
      }),
    });
    assert.equal(status, 201);
    assert.equal(body.record.draftId, DRAFT_A);
    const state = await api('/api/admin/state');
    assert.equal(state.body.records.length, 2);
  });

  console.log(`\n全部通过：${passed} 项测试`);
  if (server) server.kill();
}

main().catch((err) => {
  console.error('测试失败：', err);
  if (server) server.kill();
  process.exit(1);
});
