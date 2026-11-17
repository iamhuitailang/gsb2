// 端到端安全测试：直接起 HTTP 服务，用独立 Cookie 会话模拟两名客服与主管，
// 覆盖题目验收路径及「换入口绕过」类攻击面。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { resetStore } from '../src/store.js';

const FULL_PHONE_1 = '13812345678';
const MASKED_PHONE_1 = '138****5678';
const FULL_PHONE_2 = '13655556666';
const MASKED_PHONE_2 = '136****6666';

let base;
let server;
const sessionCookies = new Map();

async function req(session, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionCookies.get(session) ? { Cookie: sessionCookies.get(session) } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.();
  if (setCookie?.length) {
    const sid = setCookie[0].split(';')[0];
    sessionCookies.set(session, sid);
  }
  const text = await res.text();
  const contentType = res.headers.get('content-type') || '';
  return {
    status: res.status,
    headers: res.headers,
    text,
    body: contentType.includes('application/json') && text ? JSON.parse(text) : {},
  };
}

test.before(async () => {
  resetStore();
  server = createServer().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
});

test('未登录访问 API 返回 401，拿不到任何工单数据', async () => {
  const res = await fetch(base + '/api/tickets');
  assert.equal(res.status, 401);
});

test('两名客服与主管分别建立独立会话', async () => {
  for (const [session, userId] of [
    ['jia', 'u_jia'],
    ['yi', 'u_yi'],
    ['lead', 'u_lead'],
  ]) {
    const res = await req(session, 'POST', '/api/login', { userId });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, userId);
  }
});

test('默认状态：列表、搜索、详情、导出对所有人都是脱敏值', async () => {
  const list = await req('jia', 'GET', '/api/tickets');
  const t1001 = list.body.tickets.find((t) => t.id === 'WO-1001');
  assert.equal(t1001.phone, MASKED_PHONE_1);
  assert.equal(t1001.backupPhone.includes('*'), true);

  // 搜索同样走序列化层
  const search = await req('yi', 'GET', '/api/tickets?q=WO-1001');
  assert.equal(search.body.tickets[0].phone, MASKED_PHONE_1);

  const detail = await req('yi', 'GET', '/api/tickets/WO-1001');
  assert.equal(detail.body.ticket.phone, MASKED_PHONE_1);

  const csvRes = await req('jia', 'GET', '/api/tickets/WO-1001/export');
  assert.equal(csvRes.status, 200);
  assert.ok(!csvRes.text.includes(FULL_PHONE_1));
  assert.ok(csvRes.text.includes(MASKED_PHONE_1));
});

test('接口不接受任何脱敏开关参数，换入口/加参数读不到明文', async () => {
  for (const path of [
    '/api/tickets/WO-1001?unmask=true',
    '/api/tickets/WO-1001?unmask=1',
    '/api/tickets/WO-1001?showFull=1',
  ]) {
    const res = await req('jia', 'GET', path);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(FULL_PHONE_1), `路径 ${path} 泄露了完整号码`);
  }
  // 导出入口加参数同样无效
  const csv = await req('jia', 'GET', '/api/tickets/WO-1001/export?unmask=true');
  assert.ok(!csv.text.includes(FULL_PHONE_1));
});

test('客服甲申请 WO-1001 联系电话的临时查看权限', async () => {
  const res = await req('jia', 'POST', '/api/grants', {
    ticketId: 'WO-1001',
    field: 'phone',
    reason: '客户反馈未签收，需电话联系派件员核实',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.grant.status, 'pending');
});

test('申请理由中的手机号会被掩码，完整号码不进审计日志', async () => {
  await req('jia', 'POST', '/api/grants', {
    ticketId: 'WO-1002',
    field: 'phone',
    reason: `回拨 ${FULL_PHONE_2} 核实`,
  });
  const logs = await req('lead', 'GET', '/api/audit-logs');
  const raw = JSON.stringify(logs.body.logs);
  assert.ok(!raw.includes(FULL_PHONE_1), '审计日志出现 WO-1001 完整号码');
  assert.ok(!raw.includes(FULL_PHONE_2), '审计日志出现 WO-1002 完整号码');
  assert.ok(raw.includes('136****6666'), '理由中的号码未被掩码后记录');
});

test('客服无权访问审批接口与审计接口', async () => {
  assert.equal((await req('jia', 'GET', '/api/audit-logs')).status, 403);
  assert.equal((await req('jia', 'POST', '/api/grants/GR-0001/approve', {})).status, 403);
});

test('主管批准后：甲在 WO-1001 电话字段看到明文，其余工单/字段仍脱敏', async () => {
  const approve = await req('lead', 'POST', '/api/grants/GR-0001/approve', {});
  assert.equal(approve.status, 200);
  assert.equal(approve.body.grant.status, 'approved');

  const d1 = await req('jia', 'GET', '/api/tickets/WO-1001');
  assert.equal(d1.body.ticket.phone, FULL_PHONE_1);            // 授权字段：明文
  assert.equal(d1.body.ticket._permissions.phone.unmasked, true);
  assert.ok(d1.body.ticket.backupPhone.includes('*'));         // 同单其他字段：脱敏

  const d2 = await req('jia', 'GET', '/api/tickets/WO-1002');
  assert.equal(d2.body.ticket.phone, MASKED_PHONE_2);          // 其他工单：脱敏

  const list = await req('jia', 'GET', '/api/tickets');
  const row1 = list.body.tickets.find((t) => t.id === 'WO-1001');
  const row2 = list.body.tickets.find((t) => t.id === 'WO-1002');
  assert.equal(row1.phone, FULL_PHONE_1);
  assert.equal(row2.phone, MASKED_PHONE_2);

  // 导出同样只放行被授权的字段
  const csv = await req('jia', 'GET', '/api/tickets/WO-1001/export');
  assert.ok(csv.text.includes(FULL_PHONE_1));
  assert.ok(!csv.text.includes('13987654321'));
});

test('授权只对甲生效：乙打开相同详情地址（同 URL、不同会话）仍脱敏', async () => {
  const yi = await req('yi', 'GET', '/api/tickets/WO-1001');
  assert.equal(yi.body.ticket.phone, MASKED_PHONE_1);
  assert.equal(yi.body.ticket._permissions.phone.unmasked, false);

  // 乙的导出也是脱敏的
  const csv = await req('yi', 'GET', '/api/tickets/WO-1001/export');
  assert.ok(!csv.text.includes(FULL_PHONE_1));
});

test('主管自己看工单也只能看到脱敏值（授权不向审批人扩散）', async () => {
  const lead = await req('lead', 'GET', '/api/tickets/WO-1001');
  assert.equal(lead.body.ticket.phone, MASKED_PHONE_1);
});

test('主管撤销后，甲下一次读取立即恢复脱敏', async () => {
  const revoke = await req('lead', 'POST', '/api/grants/GR-0001/revoke', {});
  assert.equal(revoke.status, 200);

  const after = await req('jia', 'GET', '/api/tickets/WO-1001');
  assert.equal(after.body.ticket.phone, MASKED_PHONE_1);
  assert.equal(after.body.ticket._permissions.phone.unmasked, false);

  const csv = await req('jia', 'GET', '/api/tickets/WO-1001/export');
  assert.ok(!csv.text.includes(FULL_PHONE_1));
});

test('每次明文查看都留审计，且审计中始终没有完整号码', async () => {
  const logs = await req('lead', 'GET', '/api/audit-logs');
  const views = logs.body.logs.filter((l) => l.action === 'sensitive.view');
  assert.ok(views.length >= 2, '明文查看次数应被记录');
  assert.deepEqual(
    new Set(views.map((v) => v.ticketId + ':' + v.field)),
    new Set(['WO-1001:phone'])
  );
  assert.ok(!JSON.stringify(logs.body.logs).includes(FULL_PHONE_1));
});

test('授权到期后自动失效（短 TTL 场景）', async (t) => {
  // 通过 store 直接构造一条已到期授权，验证惰性过期判定。
  const { createGrantRequest, decideGrant, grantRequests } = await import('../src/store.js');
  const g = createGrantRequest({
    userId: 'u_yi',
    ticketId: 'WO-1002',
    field: 'backupPhone',
    reason: '测试过期',
  });
  decideGrant(g.id, 'u_lead', true);
  const record = grantRequests.find((x) => x.id === g.id);
  record.expiresAt = Date.now() - 1;

  const res = await req('yi', 'GET', '/api/tickets/WO-1002');
  assert.equal(res.body.ticket.backupPhone, '137****2222');
});

test('对不存在/非法字段的申请被拒绝', async () => {
  const badField = await req('jia', 'POST', '/api/grants', {
    ticketId: 'WO-1001',
    field: 'address',
    reason: '试探非敏感字段授权',
  });
  assert.equal(badField.status, 400);

  const noReason = await req('jia', 'POST', '/api/grants', {
    ticketId: 'WO-1001',
    field: 'phone',
    reason: '   ',
  });
  assert.equal(noReason.status, 400);
});
