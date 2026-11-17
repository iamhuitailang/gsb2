// 端到端测试：通过真实 HTTP 服务验证业务规则与并发安全。
// 运行：npm test（node --test）
import { test, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/db.js';
import { createApp } from '../server.js';

const db = openDatabase(':memory:');
const server = createApp(db);

await new Promise((resolve) => server.listen(0, resolve));
const port = (server.address() as AddressInfo).port;
const BASE = `http://localhost:${port}`;

const JIA = 'u_jia';
const YI = 'u_yi';
const BING = 'u_bing';

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

let demoId = '';

beforeEach(async () => {
  await call('POST', '/api/reset');
  const { json } = await call('GET', '/api/instructions');
  demoId = json.instructions[0].id;
});

after(() => server.close());

describe('基础数据', () => {
  test('重置后存在甲提交的 120.00 元样例指令，处于待复核 v1', async () => {
    const { status, json } = await call('GET', `/api/instructions/${demoId}`);
    assert.equal(status, 200);
    assert.equal(json.status, 'PENDING_APPROVAL');
    assert.equal(json.current_version, 1);
    assert.equal(json.versions[0].amount_cents, 12000);
    assert.equal(json.versions[0].payee, '华东供应商有限公司');
    assert.equal(json.submitter.id, JIA);
    assert.equal(json.versions[0].approvals.length, 0);
  });
});

describe('复核权限与幂等', () => {
  test('提交人不能给自己复核', async () => {
    const { status, json } = await call('POST', `/api/instructions/${demoId}/approvals`, {
      user_id: JIA, expected_version: 1,
    });
    assert.equal(status, 403);
    assert.equal(json.error.code, 'FORBIDDEN_SELF_REVIEW');

    const detail = (await call('GET', `/api/instructions/${demoId}`)).json;
    assert.equal(detail.versions[0].approvals.length, 0);
    assert.ok(detail.audit_events.some((e: any) => e.action === 'APPROVAL_REJECTED'),
      '被拒绝的复核应写入审计时间线');
  });

  test('同一复核人重复点击只算一次（幂等）', async () => {
    const first = await call('POST', `/api/instructions/${demoId}/approvals`, {
      user_id: YI, expected_version: 1,
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.duplicate, false);

    const second = await call('POST', `/api/instructions/${demoId}/approvals`, {
      user_id: YI, expected_version: 1,
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.duplicate, true, '重复点击返回幂等标记');

    const detail = (await call('GET', `/api/instructions/${demoId}`)).json;
    assert.equal(detail.versions[0].approvals.length, 1);
    assert.equal(detail.status, 'PENDING_APPROVAL', '单人重复点击不能凑数进入待执行');
  });
});

describe('版本化复核（演示主剧本）', () => {
  test('乙同意 v1 → 甲改金额为 150 生成 v2 → 丙持旧页面同意被版本拦截', async () => {
    // 1. 乙对 v1 同意
    const yiApprove = await call('POST', `/api/instructions/${demoId}/approvals`, {
      user_id: YI, expected_version: 1,
    });
    assert.equal(yiApprove.json.entered_pending_execution, false);

    // 2. 甲把金额 120 → 150，生成 v2
    const edit = await call('POST', `/api/instructions/${demoId}/versions`, {
      user_id: JIA, payee: '华东供应商有限公司', amount_yuan: 150, expected_version: 1,
    });
    assert.equal(edit.status, 200);
    assert.equal(edit.json.current_version, 2);
    assert.equal(edit.json.versions.length, 2);
    assert.equal(edit.json.versions[1].amount_cents, 15000);

    // 3. 乙在 v1 的复核保留在历史版本上，但不计入 v2
    const v1 = edit.json.versions.find((v: any) => v.version === 1);
    const v2 = edit.json.versions.find((v: any) => v.version === 2);
    assert.equal(v1.approvals.length, 1);
    assert.equal(v1.approvals[0].reviewer_id, YI);
    assert.equal(v2.approvals.length, 0);

    // 4. 丙在未刷新的页面仍提交 expected_version=1 → VERSION_CHANGED
    const stale = await call('POST', `/api/instructions/${demoId}/approvals`, {
      user_id: BING, expected_version: 1,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'VERSION_CHANGED');
    assert.equal(stale.json.error.current_version, 2);

    const afterStale = (await call('GET', `/api/instructions/${demoId}`)).json;
    assert.equal(afterStale.versions[1].approvals.length, 0, '过期复核不能写入新版本');
    assert.equal(afterStale.status, 'PENDING_APPROVAL');
    assert.ok(afterStale.audit_events.some((e: any) =>
      e.action === 'APPROVAL_REJECTED' && e.detail.includes('版本已变化')));
  });

  test('乙丙重新核对 v2 后，只有 150 元版本进入待执行', async () => {
    // 前置：乙同意 v1，甲改版到 v2
    await call('POST', `/api/instructions/${demoId}/approvals`, { user_id: YI, expected_version: 1 });
    await call('POST', `/api/instructions/${demoId}/versions`, {
      user_id: JIA, payee: '华东供应商有限公司', amount_yuan: 150, expected_version: 1,
    });

    // 乙、丙分别对 v2 同意
    const byYi = await call('POST', `/api/instructions/${demoId}/approvals`, {
      user_id: YI, expected_version: 2,
    });
    assert.equal(byYi.json.entered_pending_execution, false);

    const byBing = await call('POST', `/api/instructions/${demoId}/approvals`, {
      user_id: BING, expected_version: 2,
    });
    assert.equal(byBing.json.entered_pending_execution, true, '第二人同意时进入待执行');

    const detail = (await call('GET', `/api/instructions/${demoId}`)).json;
    assert.equal(detail.status, 'PENDING_EXECUTION');
    assert.equal(detail.current_version, 2);
    assert.equal(detail.versions[1].amount_cents, 15000, '进入待执行的是 150 元新版');
    assert.equal(detail.versions[1].approvals.length, 2);
    assert.deepEqual(
      detail.versions[1].approvals.map((a: any) => a.reviewer_id).sort(),
      [BING, YI],
    );

    // 待执行后不再接受修改或复核
    const editAfter = await call('POST', `/api/instructions/${demoId}/versions`, {
      user_id: JIA, payee: '其他公司', amount_yuan: 999, expected_version: 2,
    });
    assert.equal(editAfter.status, 409);
    assert.equal(editAfter.json.error.code, 'INSTRUCTION_FINALIZED');

    const approveAfter = await call('POST', `/api/instructions/${demoId}/approvals`, {
      user_id: YI, expected_version: 2,
    });
    assert.equal(approveAfter.status, 409);
    assert.equal(approveAfter.json.error.code, 'INSTRUCTION_FINALIZED');
  });
});

describe('并发安全', () => {
  test('两名复核人同时提交：各自权限与版本都校验，且只生成一条待执行结果', async () => {
    const results = await Promise.all([
      call('POST', `/api/instructions/${demoId}/approvals`, { user_id: YI, expected_version: 1 }),
      call('POST', `/api/instructions/${demoId}/approvals`, { user_id: BING, expected_version: 1 }),
    ]);
    const entered = results.filter((r) => r.json.entered_pending_execution === true);
    assert.equal(entered.length, 1, '只能有一次状态翻转，不会产生两条待执行记录');
    assert.ok(results.every((r) => r.status === 200));

    const detail = (await call('GET', `/api/instructions/${demoId}`)).json;
    assert.equal(detail.status, 'PENDING_EXECUTION');
    assert.equal(detail.versions[0].approvals.length, 2);

    // 审计事件中 ENTERED_PENDING_EXECUTION 恰好一条
    const executionEvents = detail.audit_events.filter(
      (e: any) => e.action === 'ENTERED_PENDING_EXECUTION',
    );
    assert.equal(executionEvents.length, 1);
  });

  test('并发混合：复核与改版同时发生时，持旧版本号的复核必然失败且不产生脏数据', async () => {
    // 乙先同意 v1；随后甲改版 v2 与丙的 v1 复核并发
    await call('POST', `/api/instructions/${demoId}/approvals`, { user_id: YI, expected_version: 1 });

    const [editRes, bingRes] = await Promise.all([
      call('POST', `/api/instructions/${demoId}/versions`, {
        user_id: JIA, payee: '华南供应商有限公司', amount_yuan: 200, expected_version: 1,
      }),
      call('POST', `/api/instructions/${demoId}/approvals`, { user_id: BING, expected_version: 1 }),
    ]);

    const detail = (await call('GET', `/api/instructions/${demoId}`)).json;
    assert.equal(detail.current_version, 2);
    assert.equal(detail.status, 'PENDING_APPROVAL', '无论谁先落库，都不会错误进入待执行');
    assert.equal(detail.versions[1].approvals.length, 0);

    if (editRes.status === 200) {
      // 改版先提交：丙的旧版本复核必须被版本拦截
      assert.equal(bingRes.status, 409);
      assert.equal(bingRes.json.error.code, 'VERSION_CHANGED');
    } else {
      // 复核先提交：丙成功但只有乙+丙对 v1 的两条复核……
      // 乙已先同意 v1，丙再同意 v1 会直接进入待执行，改版随后被 INSTRUCTION_FINALIZED 拒绝
      assert.equal(bingRes.status, 200);
      assert.equal(editRes.json.error.code, 'INSTRUCTION_FINALIZED');
      assert.equal(detail.status, 'PENDING_EXECUTION');
    }
  });

  test('同一复核人并发重复点击只落一条记录', async () => {
    const results = await Promise.all([
      call('POST', `/api/instructions/${demoId}/approvals`, { user_id: YI, expected_version: 1 }),
      call('POST', `/api/instructions/${demoId}/approvals`, { user_id: YI, expected_version: 1 }),
      call('POST', `/api/instructions/${demoId}/approvals`, { user_id: YI, expected_version: 1 }),
    ]);
    assert.ok(results.every((r) => r.status === 200));
    const detail = (await call('GET', `/api/instructions/${demoId}`)).json;
    assert.equal(detail.versions[0].approvals.length, 1);
    assert.equal(detail.status, 'PENDING_APPROVAL');
  });
});

describe('角色与输入校验', () => {
  test('复核人不能创建/修改指令', async () => {
    const create = await call('POST', '/api/instructions', {
      user_id: YI, payee: '某公司', amount_yuan: 100,
    });
    assert.equal(create.status, 403);
    assert.equal(create.json.error.code, 'FORBIDDEN_NOT_SUBMITTER');

    const edit = await call('POST', `/api/instructions/${demoId}/versions`, {
      user_id: BING, payee: '某公司', amount_yuan: 100, expected_version: 1,
    });
    assert.equal(edit.status, 403);
  });

  test('金额与收款方非法时拒绝', async () => {
    const badAmount = await call('POST', '/api/instructions', {
      user_id: JIA, payee: '某公司', amount_yuan: -5,
    });
    assert.equal(badAmount.status, 400);
    assert.equal(badAmount.json.error.code, 'VALIDATION_ERROR');

    const emptyPayee = await call('POST', `/api/instructions/${demoId}/versions`, {
      user_id: JIA, payee: '   ', amount_yuan: 130, expected_version: 1,
    });
    assert.equal(emptyPayee.status, 400);

    const precision = await call('POST', `/api/instructions/${demoId}/versions`, {
      user_id: JIA, payee: '华东供应商有限公司', amount_yuan: 120.005, expected_version: 1,
    });
    assert.equal(precision.status, 400);
  });

  test('内容无变化不生成新版本；过期 expected_version 的编辑被拦截', async () => {
    const noChange = await call('POST', `/api/instructions/${demoId}/versions`, {
      user_id: JIA, payee: '华东供应商有限公司', amount_yuan: 120, expected_version: 1,
    });
    assert.equal(noChange.status, 400);

    const stale = await call('POST', `/api/instructions/${demoId}/versions`, {
      user_id: JIA, payee: '新收款方', amount_yuan: 130, expected_version: 99,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'VERSION_CHANGED');
  });
});

describe('页面与时间线', () => {
  test('首页与静态资源可访问', async () => {
    const html = await fetch(`${BASE}/`);
    assert.equal(html.status, 200);
    assert.ok((await html.text()).includes('付款指令复核系统'));

    const js = await fetch(`${BASE}/app.js`);
    assert.equal(js.status, 200);

    const css = await fetch(`${BASE}/styles.css`);
    assert.equal(css.status, 200);
  });

  test('详情时间线完整记录每次改动与对应复核', async () => {
    await call('POST', `/api/instructions/${demoId}/approvals`, { user_id: YI, expected_version: 1 });
    await call('POST', `/api/instructions/${demoId}/versions`, {
      user_id: JIA, payee: '华东供应商有限公司', amount_yuan: 150, expected_version: 1,
    });
    await call('POST', `/api/instructions/${demoId}/approvals`, { user_id: YI, expected_version: 2 });
    await call('POST', `/api/instructions/${demoId}/approvals`, { user_id: BING, expected_version: 2 });

    const detail = (await call('GET', `/api/instructions/${demoId}`)).json;
    const actions = detail.audit_events.map((e: any) => e.action);
    assert.ok(actions.includes('CREATED'));
    assert.ok(actions.includes('APPROVED'));
    assert.ok(actions.includes('UPDATED'));
    assert.ok(actions.includes('ENTERED_PENDING_EXECUTION'));
    // 每条复核事件都带版本号，可对应到具体版本
    const approveEvents = detail.audit_events.filter((e: any) => e.action === 'APPROVED');
    assert.deepEqual(approveEvents.map((e: any) => e.version).sort(), [1, 2, 2]);
  });
});
