// 端到端验收：启动真实服务，用真实 HTTP 请求复现“撤权后旧地址失效、乙机构不受影响”。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'ticket-console-'));

let passed = 0;
let failed = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    results.push(`  ✗ ${name}\n      ${err.message}`);
  }
}

// 让系统分配空闲端口（PORT=0），避免测试与其它进程撞端口。
let PORT = 0;
let BASE = '';

function client() {
  let cookie = '';
  return {
    async req(pathname, { method = 'GET', body } = {}) {
      const res = await fetch(BASE + pathname, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      // 记录响应方设置的 Cookie（登录时下发、退出时清除）
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const first = setCookie.split(';')[0];
        const at = first.indexOf('=');
        const value = at === -1 ? '' : first.slice(at + 1);
        cookie = value ? first : '';
      }
      const type = res.headers.get('content-type') ?? '';
      const payload = type.includes('application/json') ? await res.json() : await res.text();
      return { status: res.status, body: payload, headers: res.headers };
    },
    login(username, password = 'demo1234') {
      return this.req('/api/login', { method: 'POST', body: { username, password } });
    },
  };
}

async function waitForServer(proc, timeoutMs = 10000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`服务启动超时\n${out}`));
      }
    }, 200);
    const done = () => clearInterval(timer);
    proc.stdout.on('data', (c) => {
      out += c;
      const m = /http:\/\/[^\s:]+:(\d+)/.exec(out);
      if (m) {
        done();
        resolve(Number(m[1]));
      }
    });
    proc.stderr.on('data', (c) => (out += c));
    proc.on('exit', (code) => {
      done();
      reject(new Error(`服务提前退出（code ${code}）\n${out}`));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPORT_DELAY = 2000; // 导出入队到生成之间的窗口，留足时间在窗口内撤销权限
const EXPORT_WAIT = EXPORT_DELAY + 700;

const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: '0', DATA_DIR: dataDir, EXPORT_DELAY_MS: String(EXPORT_DELAY) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let exitCode = 0;
try {
  PORT = await waitForServer(proc);
  BASE = `http://127.0.0.1:${PORT}`;

  const li = client();
  const wang = client();
  const zhao = client();

  await check('账号可登录，李强在甲乙两机构都是主管', async () => {
    const r = await li.login('li');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const roles = Object.fromEntries(r.body.memberships.map((m) => [m.orgId, m.role]));
    assert.deepEqual(roles, { 'org-a': 'supervisor', 'org-b': 'supervisor' });
  });

  await check('王敏在甲乙两机构都是员工', async () => {
    const r = await wang.login('wang');
    assert.equal(r.status, 200);
    const roles = Object.fromEntries(r.body.memberships.map((m) => [m.orgId, m.role]));
    assert.deepEqual(roles, { 'org-a': 'employee', 'org-b': 'employee' });
  });

  await check('赵磊只在甲机构', async () => {
    const r = await zhao.login('zhao');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.memberships.map((m) => m.orgId), ['org-a']);
  });

  await check('员工只看到本机构分给自己的工单', async () => {
    const r = await wang.req('/api/orgs/org-a');
    assert.equal(r.status, 200);
    assert.equal(r.body.role, 'employee');
    assert.ok(r.body.tickets.length >= 1);
    for (const t of r.body.tickets) {
      assert.equal(t.orgId, 'org-a');
      assert.equal(t.assigneeId, 'u-wang');
    }
    assert.ok(!r.body.tickets.some((t) => t.id === 'TKT-A-002'), '不应看到赵磊的工单');
  });

  await check('主管看到本机构全部工单', async () => {
    const r = await li.req('/api/orgs/org-a');
    assert.equal(r.status, 200);
    assert.equal(r.body.role, 'supervisor');
    assert.deepEqual(r.body.tickets.map((t) => t.id).sort(), ['TKT-A-001', 'TKT-A-002', 'TKT-A-003']);
  });

  await check('员工不能越权看别人的工单详情（403）', async () => {
    const r = await wang.req('/api/orgs/org-a/tickets/TKT-A-002');
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'TICKET_FORBIDDEN');
  });

  await check('员工不能越权下载别人工单的附件（403）', async () => {
    const r = await wang.req('/api/orgs/org-a/tickets/TKT-A-002/attachments/ATT-A-002-1');
    assert.equal(r.status, 403);
  });

  await check('跨机构地址拿不到乙机构的工单（404，不泄露存在性）', async () => {
    // 王敏确实能看 TKT-B-001，但用甲机构前缀去请求必须失败
    const r = await wang.req('/api/orgs/org-a/tickets/TKT-B-001');
    assert.equal(r.status, 404);
  });

  await check('员工不能访问成员权限接口（403）', async () => {
    const r = await wang.req('/api/orgs/org-a/members');
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'NOT_SUPERVISOR');
  });

  // 记录撤销前的地址，用于验证“旧地址失效”
  const oldDetailUrl = '/api/orgs/org-a/tickets/TKT-A-001';
  const oldAttachmentUrl = '/api/orgs/org-a/tickets/TKT-A-001/attachments/ATT-A-001-1';

  await check('撤销前：王敏可打开甲机构详情并下载附件', async () => {
    const d = await wang.req(oldDetailUrl);
    assert.equal(d.status, 200);
    const a = await wang.req(oldAttachmentUrl);
    assert.equal(a.status, 200);
    assert.match(a.body, /E-04/);
  });

  // 先等一个导出生成完成，用于验证“已生成过的文件，撤权后取文件仍被拒绝”
  let readyExportId = null;
  await check('撤销前：甲机构导出已生成完成并可下载', async () => {
    const q = await wang.req('/api/orgs/org-a/exports', { method: 'POST' });
    assert.equal(q.status, 202);
    readyExportId = q.body.export.id;
    await sleep(EXPORT_WAIT);
    const st = await wang.req(`/api/orgs/org-a/exports/${readyExportId}`);
    assert.equal(st.status, 200);
    assert.equal(st.body.export.status, 'ready');
    const file = await wang.req(`/api/orgs/org-a/exports/${readyExportId}/file`);
    assert.equal(file.status, 200, '撤权前应能取到导出文件');
    assert.match(file.body, /TKT-A-001/);
  });

  // 再排一个导出，紧接着撤销权限：让它在“已排队、未生成”的窗口里被撤权
  let queuedExportId = null;
  await check('撤销前：王敏在甲机构发起导出并排队', async () => {
    const r = await wang.req('/api/orgs/org-a/exports', { method: 'POST' });
    assert.equal(r.status, 202);
    assert.equal(r.body.export.status, 'queued');
    queuedExportId = r.body.export.id;
  });

  await check('主管撤销王敏的甲机构权限', async () => {
    const members = await li.req('/api/orgs/org-a/members');
    assert.equal(members.status, 200);
    const target = members.body.members.find((m) => m.username === 'wang');
    assert.ok(target, '应找到王敏的甲机构成员记录');
    const r = await li.req(`/api/orgs/org-a/members/${target.membershipId}/revoke`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.body.active, false);
  });

  await check('撤权后：原来的甲机构详情地址被拒绝（403）', async () => {
    const r = await wang.req(oldDetailUrl);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'NO_ORG_ACCESS');
  });

  await check('撤权后：原来的甲机构附件下载地址被拒绝（403）', async () => {
    const r = await wang.req(oldAttachmentUrl);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'NO_ORG_ACCESS');
  });

  await check('撤权后：甲机构工单列表与成员接口都拒绝', async () => {
    assert.equal((await wang.req('/api/orgs/org-a')).status, 403);
    assert.equal((await wang.req('/api/orgs/org-a/members')).status, 403);
  });

  await check('已排队的导出在生成时重新核对权限，结果被标记为 denied', async () => {
    assert.ok(queuedExportId);
    await sleep(EXPORT_WAIT); // 超过 EXPORT_DELAY_MS，任务已完成生成阶段
    // 王敏已无甲机构权限，状态查询本身就该被拒绝
    const status = await wang.req(`/api/orgs/org-a/exports/${queuedExportId}`);
    assert.equal(status.status, 403);
    // 主管仍可查该任务，看到生成阶段判定为拒绝
    const asSup = await li.req(`/api/orgs/org-a/exports/${queuedExportId}`);
    assert.equal(asSup.status, 200);
    assert.equal(asSup.body.export.status, 'denied');
  });

  await check('已排队的导出：撤权后取文件被拒绝（403）', async () => {
    const r = await wang.req(`/api/orgs/org-a/exports/${queuedExportId}/file`);
    assert.equal(r.status, 403);
  });

  await check('撤权前已生成的导出文件，撤权后取文件同样被拒绝（403）', async () => {
    assert.ok(readyExportId);
    const r = await wang.req(`/api/orgs/org-a/exports/${readyExportId}/file`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'NO_ORG_ACCESS');
  });

  await check('撤销甲机构不影响乙机构：王敏仍能打开乙机构分配给自己的工单', async () => {
    const list = await wang.req('/api/orgs/org-b');
    assert.equal(list.status, 200);
    assert.equal(list.body.role, 'employee');
    assert.deepEqual(list.body.tickets.map((t) => t.id).sort(), ['TKT-B-001', 'TKT-B-002']);

    const detail = await wang.req('/api/orgs/org-b/tickets/TKT-B-001');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.ticket.assigneeId, 'u-wang');

    const att = await wang.req('/api/orgs/org-b/tickets/TKT-B-001/attachments/ATT-B-001-1');
    assert.equal(att.status, 200);
    assert.match(att.body, /91%/);
  });

  await check('乙机构导出正常：生成后可下载', async () => {
    const q = await wang.req('/api/orgs/org-b/exports', { method: 'POST' });
    assert.equal(q.status, 202);
    await sleep(EXPORT_WAIT);
    const st = await wang.req(`/api/orgs/org-b/exports/${q.body.export.id}`);
    assert.equal(st.status, 200);
    assert.equal(st.body.export.status, 'ready');
    assert.equal(st.body.export.rows, 2);
    const file = await wang.req(`/api/orgs/org-b/exports/${q.body.export.id}/file`);
    assert.equal(file.status, 200);
    assert.match(file.body, /TKT-B-001/);
    assert.doesNotMatch(file.body, /TKT-B-003/, '员工导出不应包含未分配/他人的工单');
  });

  await check('主管导出的范围是整个机构', async () => {
    const q = await li.req('/api/orgs/org-b/exports', { method: 'POST' });
    assert.equal(q.status, 202);
    await sleep(EXPORT_WAIT);
    const file = await li.req(`/api/orgs/org-b/exports/${q.body.export.id}/file`);
    assert.equal(file.status, 200);
    assert.match(file.body, /TKT-B-003/);
  });

  await check('恢复甲机构权限后，旧详情地址重新可用', async () => {
    const members = await li.req('/api/orgs/org-a/members');
    const target = members.body.members.find((m) => m.username === 'wang');
    const r = await li.req(`/api/orgs/org-a/members/${target.membershipId}/restore`, { method: 'POST' });
    assert.equal(r.status, 200);
    const d = await wang.req(oldDetailUrl);
    assert.equal(d.status, 200);
  });

  await check('未登录访问任何机构接口都是 401', async () => {
    const anon = client();
    const r = await anon.req('/api/orgs/org-a');
    assert.equal(r.status, 401);
  });

  await check('非本机构成员不能被撤销（主管不能跨机构误操作）', async () => {
    // 赵磊只在甲机构；拿他在甲机构的成员记录去乙机构撤销必须 404
    const membersA = await li.req('/api/orgs/org-a/members');
    const zhaoA = membersA.body.members.find((m) => m.username === 'zhao');
    assert.equal(zhaoA.active, true);

    const membersB = await li.req('/api/orgs/org-b/members');
    assert.equal(membersB.status, 200);
    assert.equal(
      membersB.body.members.find((m) => m.username === 'zhao'),
      undefined,
      '乙机构成员列表里不应出现赵磊',
    );

    const r = await li.req(`/api/orgs/org-b/members/${zhaoA.membershipId}/revoke`, { method: 'POST' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'MEMBERSHIP_NOT_FOUND');

    // 甲机构里赵磊仍然有效，没有被误伤
    const after = await li.req('/api/orgs/org-a/members');
    assert.equal(after.body.members.find((m) => m.username === 'zhao').active, true);
  });

  await check('主管不能撤销自己', async () => {
    const members = await li.req('/api/orgs/org-a/members');
    const self = members.body.members.find((m) => m.username === 'li');
    const r = await li.req(`/api/orgs/org-a/members/${self.membershipId}/revoke`, { method: 'POST' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'CANNOT_REVOKE_SELF');
  });
} catch (err) {
  failed++;
  results.push(`  ✗ 测试执行中断：${err.message}`);
} finally {
  proc.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('\n本地工单后台 · 验收测试\n');
console.log(results.join('\n'));
console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
exitCode = failed > 0 ? 1 : 0;
process.exit(exitCode);
