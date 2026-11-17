import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestRequestGate } from '../public/guard.js';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('晚到的旧组织结果被判为过期，不会成为当前结果', async () => {
  const gate = new LatestRequestGate();
  const applied = [];
  let staleFired = false;

  const slowJia = gate.run(
    async () => {
      await tick(60);
      return '甲组织的数据';
    },
    { onStale: () => { staleFired = true; } },
  );
  await tick(5);
  const quickYi = gate.run(async () => '乙组织的数据');

  const [old, fresh] = await Promise.all([slowJia, quickYi]);
  if (fresh.status === 'ok') applied.push(fresh.value);
  if (old.status === 'ok') applied.push(old.value);

  assert.equal(fresh.status, 'ok');
  assert.equal(old.status, 'stale');
  assert.equal(staleFired, true);
  assert.deepEqual(applied, ['乙组织的数据']);
});

test('切换组织时硬作废，在途请求被中止', async () => {
  const gate = new LatestRequestGate();
  const pending = gate.run(async ({ signal }) => {
    await tick(100);
    if (signal.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    return '旧组织';
  });
  await tick(5);
  gate.cancel();
  const outcome = await pending;
  assert.equal(outcome.status, 'aborted');
});

test('连续切换三次，只有最后一次能落到页面', async () => {
  const gate = new LatestRequestGate();
  const results = [];
  const delays = [120, 80, 40]; // 越早的请求越慢，确保晚到的都是旧结果
  const runs = ['甲', '乙', '甲'].map((org, index) =>
    gate.run(async () => {
      await tick(delays[index]);
      return org;
    }).then((outcome) => ({ org, outcome })),
  );
  for (const { org, outcome } of await Promise.all(runs)) {
    if (outcome.status === 'ok') results.push(org);
  }
  assert.deepEqual(results, ['甲']); // 只有最后发出的那次算数
});

test('invalidate 让在途请求过期但不中止，结果仍被判为 stale', async () => {
  const gate = new LatestRequestGate();
  let resolved = false;
  const outcome = await (async () => {
    const pending = gate.run(async () => {
      await tick(40);
      resolved = true;
      return '甲组织';
    });
    gate.invalidate();
    return pending;
  })();
  assert.equal(resolved, true); // 请求确实完成过
  assert.equal(outcome.status, 'stale');
});

test('isCurrent 对旧代号返回 false', () => {
  const gate = new LatestRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first.generation), false);
  assert.equal(gate.isCurrent(second.generation), true);
});
