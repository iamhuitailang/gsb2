import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoServer } from '../server.js';

const JIA = 'cp-jia';
const YI = 'cp-yi';

const jiaPayload = {
  answers: {
    temp: { result: 'pass' },
    stack: { result: 'fail', note: '通道被托盘占用' },
    gear: { result: 'pass' },
  },
  note: '甲点现场检查',
  filledAt: '2026-11-16T09:00:00.000Z',
};
const yiPayload = {
  answers: {
    label: { result: 'pass' },
    vent: { result: 'pass' },
    lock: { result: 'na', note: '当日无出入库' },
  },
  note: '乙点现场检查',
  filledAt: '2026-11-16T09:01:00.000Z',
};

/** 每个测试起一个独立服务端实例，互不影响。 */
async function withServer(fn) {
  const { server } = createDemoServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    // fetch（undici）会保留 keep-alive 连接，直接 close 会一直等它超时。
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function api(base, path, { method = 'GET', body, actor = 'li' } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'x-actor': actor,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const json = async (res) => ({ status: res.status, body: await res.json() });

async function grant(base, checkpointId, granted) {
  const res = await json(
    await api(base, '/api/authorization', {
      method: 'POST',
      actor: 'wang',
      body: { inspectorId: 'li', checkpointId, granted },
    }),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function submit(base, draftId, checkpointId, payload) {
  return json(
    await api(base, '/api/drafts', {
      method: 'POST',
      body: { draftId, checkpointId, payload },
    }),
  );
}

async function records(base, actor = 'wang') {
  const res = await json(await api(base, '/api/state', { actor }));
  assert.equal(res.status, 200);
  return res.body.records;
}

test('演示主流程：离线两条草稿 → 撤销甲点授权 → 乙入库一条、甲留待处理 → 重试不重复入库', async () => {
  await withServer(async (base) => {
    // 1. 两个检查点初始都有授权，检查员拿到的任务与资料齐全。
    const initial = await json(await api(base, '/api/state'));
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.checkpoints.map((cp) => cp.code), ['甲', '乙']);
    for (const cp of initial.body.checkpoints) {
      assert.equal(cp.authorized, true);
      assert.equal(cp.materials.length, 3);
      assert.equal(cp.items.length, 3);
    }

    // 2. 离线状态各保存一条草稿（离线操作不触网，草稿只在本机队列里）。
    const jiaDraft = 'draft-jia-offline-0001';
    const yiDraft = 'draft-yi-offline-0001';

    // 3. 主管撤掉甲点授权。
    await grant(base, JIA, false);

    const inspectorView = await json(await api(base, '/api/state'));
    const jiaNow = inspectorView.body.checkpoints.find((cp) => cp.id === JIA);
    assert.equal(jiaNow.authorized, false);
    assert.equal(jiaNow.task, null, '撤权后不再下发任务');
    assert.deepEqual(jiaNow.materials, [], '撤权后不再下发资料');
    assert.deepEqual(jiaNow.items, [], '撤权后不再下发检查项');
    const yiNow = inspectorView.body.checkpoints.find((cp) => cp.id === YI);
    assert.equal(yiNow.authorized, true);
    assert.equal(yiNow.materials.length, 3);

    // 4. 恢复网络后逐条上报：乙成功，甲被拒但流程继续。
    const yiRes = await submit(base, yiDraft, YI, yiPayload);
    assert.equal(yiRes.status, 200);
    assert.equal(yiRes.body.ok, true);
    assert.equal(yiRes.body.record.checkpointId, YI);

    const jiaRes = await submit(base, jiaDraft, JIA, jiaPayload);
    assert.equal(jiaRes.status, 403);
    assert.equal(jiaRes.body.error, 'CHECKPOINT_NOT_AUTHORIZED');

    // 5. 服务端正式检查单里只有乙点，甲点草稿不出现。
    const wangRecords = await records(base);
    assert.equal(wangRecords.length, 1);
    assert.equal(wangRecords[0].checkpointId, YI);
    assert.equal(wangRecords[0].draftId, yiDraft);

    // 6. 再次同步（乙重复、甲重试）：乙不会入库第二条。
    const yiAgain = await submit(base, yiDraft, YI, yiPayload);
    assert.equal(yiAgain.status, 200);
    assert.equal(yiAgain.body.duplicate, true);
    assert.equal(yiAgain.body.record.seq, yiRes.body.record.seq, '同一草稿返回同一条正式记录');

    const jiaAgain = await submit(base, jiaDraft, JIA, jiaPayload);
    assert.equal(jiaAgain.status, 403);

    const finalRecords = await records(base);
    assert.equal(finalRecords.length, 1, '重复提交不会新增记录');
    assert.equal(finalRecords[0].draftId, yiDraft);
  });
});

test('同一草稿编号并发重试只保存一份', async () => {
  await withServer(async (base) => {
    const draftId = 'draft-concurrent-0001';
    const results = await Promise.all(
      Array.from({ length: 8 }, () => submit(base, draftId, YI, yiPayload)),
    );
    for (const res of results) assert.equal(res.status, 200);
    const seqs = new Set(results.map((res) => res.body.record.seq));
    assert.equal(seqs.size, 1, '所有重试应指向同一个正式记录');
    assert.equal(results.filter((res) => res.body.duplicate === false).length, 1, '只有一次真正的入库');

    const list = await records(base);
    assert.equal(list.length, 1);
    assert.equal(list[0].draftId, draftId);
  });
});

test('撤权后重新授权，甲点草稿可正常入库', async () => {
  await withServer(async (base) => {
    const draftId = 'draft-jia-retry-0001';
    await grant(base, JIA, false);
    const blocked = await submit(base, draftId, JIA, jiaPayload);
    assert.equal(blocked.status, 403);

    await grant(base, JIA, true);
    const accepted = await submit(base, draftId, JIA, jiaPayload);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.duplicate, false);
    assert.equal((await records(base)).length, 1);
  });
});

test('授权只能由主管调整，检查员无权改授权', async () => {
  await withServer(async (base) => {
    const res = await json(
      await api(base, '/api/authorization', {
        method: 'POST',
        actor: 'li',
        body: { inspectorId: 'li', checkpointId: JIA, granted: true },
      }),
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'SUPERVISOR_ONLY');
  });
});

test('检查单内容不合格时不入库', async () => {
  await withServer(async (base) => {
    const bad = await submit(base, 'draft-bad-0001', YI, {
      answers: { label: { result: 'maybe' }, vent: { result: 'pass' }, lock: { result: 'pass' } },
    });
    assert.equal(bad.status, 422);
    const missing = await submit(base, 'draft-bad-0002', YI, {
      answers: { label: { result: 'pass' } },
    });
    assert.equal(missing.status, 422);
    assert.match(missing.body.message, /尚未作答/);
    assert.equal((await records(base)).length, 0);
  });
});

test('同一草稿编号对应不同检查点会被拒绝', async () => {
  await withServer(async (base) => {
    const draftId = 'draft-conflict-0001';
    assert.equal((await submit(base, draftId, YI, yiPayload)).status, 200);
    const conflict = await submit(base, draftId, JIA, jiaPayload);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'DRAFT_ID_CONFLICT');
    assert.equal((await records(base)).length, 1);
  });
});

test('主管能看到拒绝与去重记录，检查员只看到自己的记录', async () => {
  await withServer(async (base) => {
    await submit(base, 'draft-audit-0001', YI, yiPayload);
    await grant(base, JIA, false);
    await submit(base, 'draft-audit-0002', JIA, jiaPayload);

    const supervisor = await json(await api(base, '/api/state', { actor: 'wang' }));
    const kinds = supervisor.body.audit.map((entry) => entry.type);
    assert.ok(kinds.includes('accepted'));
    assert.ok(kinds.includes('authorization'));
    assert.ok(kinds.includes('rejected'));

    const inspector = await json(await api(base, '/api/state', { actor: 'li' }));
    assert.equal(inspector.body.records.length, 1);
    assert.equal(inspector.body.records[0].draftId, 'draft-audit-0001');
    assert.deepEqual(inspector.body.audit, [], '检查员看不到管理侧操作记录');
  });
});

test('静态页面与 SPA 路由可访问', async () => {
  await withServer(async (base) => {
    for (const path of ['/', '/supervisor', '/app.js', '/style.css']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, `${path} 应可访问`);
    }
    const missing = await fetch(`${base}/nope.html`);
    assert.equal(missing.status, 404);
    const traversal = await fetch(`${base}/..%2Fserver.js`);
    assert.notEqual(traversal.status, 200, '不允许目录穿越');
  });
});
