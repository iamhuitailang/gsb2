/**
 * 端到端演示剧本（node test/e2e-demo.mjs）
 *
 * 在内存中复刻检查员页面的本地队列逻辑（localStorage outbox + 同步状态机），
 * 严格按需求剧本走一遍，并在每步打印断言结果：
 *
 *   1. 员工在线加载两处检查点，对甲、乙都有授权
 *   2. 员工“断网”，分别为甲点、乙点各保存一条草稿 → 都在本机待发送
 *   3. 主管在管理台撤销甲点授权（管理台不受断网影响）
 *   4. 员工恢复网络并同步：
 *        - 乙点入库一条
 *        - 甲点按当前权限核对为无权限 → 403，草稿留本机“待处理”，不进正式检查单
 *   5. 再次点同步：乙点不会重复入库（服务端幂等 + 客户端跳过已处理项）
 *   6. 甲点草稿可复制、只存在本机；服务端正式检查单里只有乙点那一条
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import process from 'node:process';

const BASE = 'http://127.0.0.1:4319';
let server;

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ---- 浏览器端队列的最小复刻（与 public/inspector.js 的状态机一致）----
class BrowserSim {
  constructor() {
    this.online = true;
    this.outbox = [];
  }

  saveDraft(item) {
    this.outbox.unshift({
      ...item,
      status: 'queued',
      attempts: 0,
      lastError: null,
      duplicated: false,
    });
    console.log(`      本机队列新增草稿：${item.checkpointName}（${item.draftId.slice(0, 8)}）`);
  }

  async sendOne(draftId) {
    const item = this.outbox.find((i) => i.draftId === draftId);
    if (!item || item.status === 'synced') return 'skip';

    if (!this.online) {
      item.status = 'queued';
      item.lastError = '离线，尚未发送';
      return 'offline'; // 请求没发出，不计入尝试次数
    }

    item.attempts += 1;

    const { status, body } = await api('/api/records', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: item.employeeId,
        checkpointId: item.checkpointId,
        draftId: item.draftId,
        result: item.result,
        note: item.note,
      }),
    });

    if (status === 201 || status === 200) {
      item.status = 'synced';
      item.duplicated = body.duplicated === true;
      item.lastError = null;
      return body.duplicated ? 'duplicated' : 'synced';
    }
    if (status === 403) {
      item.status = 'blocked'; // 留在本机供复制，不进服务端
      item.lastError = body.error;
      return 'blocked';
    }
    item.status = 'queued';
    item.lastError = body.error;
    return 'failed';
  }

  // 与页面一致：只处理 queued；blocked 需用户手动点“重新同步”
  async syncAll({ includeBlocked = false } = {}) {
    const targets = this.outbox.filter(
      (i) => i.status === 'queued' || (includeBlocked && i.status === 'blocked')
    );
    const results = [];
    for (const item of targets) {
      results.push({ draftId: item.draftId, outcome: await this.sendOne(item.draftId) });
    }
    return results;
  }
}

const log = (step, title) => console.log(`\n${step} ${title}`);

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
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: '4319' },
    stdio: 'ignore',
  });
  await waitForServer();
  await api('/api/admin/reset', { method: 'POST' });

  const browser = new BrowserSim();
  const draftA = {
    draftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    employeeId: 'e1',
    checkpointId: 'CP-A',
    checkpointName: '甲点 · 一号车间电气柜',
    result: 'pass',
    note: '甲点离线草稿',
  };
  const draftB = {
    draftId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    employeeId: 'e1',
    checkpointId: 'CP-B',
    checkpointName: '乙点 · 原料仓库消防通道',
    result: 'fail',
    note: '乙点离线草稿：发现通道堆货',
  };

  log('①', '员工在线：两处检查点的任务、资料可访问，授权均为已授权') ;
  const me = await api('/api/me?employeeId=e1');
  assert.equal(me.body.permissions.every((p) => p.granted), true);
  console.log('      权限快照：', me.body.permissions.map((p) => `${p.checkpointId}=已授权`).join('，'));

  log('②', '员工断网：甲、乙各保存一条草稿，请求不出本机，队列都是“待发送”');
  browser.online = false;
  browser.saveDraft(draftA);
  browser.saveDraft(draftB);
  const offlineAttempts = await browser.syncAll();
  assert.deepEqual(offlineAttempts.map((r) => r.outcome), ['offline', 'offline']);
  assert.equal(browser.outbox.every((i) => i.status === 'queued'), true);
  let state = await api('/api/admin/state');
  assert.equal(state.body.records.length, 0);
  console.log('      断网下同步：两条均未发出；服务端正式检查单 0 条 ✓');

  log('③', '主管在管理台撤销甲点授权（管理台始终在线，操作立即生效）');
  const revoke = await api('/api/admin/grants', {
    method: 'POST',
    body: JSON.stringify({ employeeId: 'e1', checkpointId: 'CP-A', granted: false }),
  });
  assert.equal(revoke.status, 200);
  const me2 = await api('/api/me?employeeId=e1');
  assert.equal(me2.body.permissions.find((p) => p.checkpointId === 'CP-A').granted, false);
  assert.equal(me2.body.permissions.find((p) => p.checkpointId === 'CP-B').granted, true);
  console.log('      当前权限：甲点=已撤销，乙点=已授权 ✓');

  log('④', '员工恢复网络并同步：逐条按当前权限核对，互不阻塞');
  browser.online = true;
  const outcomes = (await browser.syncAll()).sort((a, b) => b.draftId.localeCompare(a.draftId));
  const byId = Object.fromEntries(outcomes.map((o) => [o.draftId, o.outcome]));
  assert.equal(byId[draftB.draftId], 'synced', '乙点应成功入库');
  assert.equal(byId[draftA.draftId], 'blocked', '甲点应被权限拦下');
  console.log('      乙点 → 入库成功；甲点 → 403 留在本机“需用户处理” ✓');

  state = await api('/api/admin/state');
  assert.equal(state.body.records.length, 1, '正式检查单只能有乙点一条');
  assert.equal(state.body.records[0].checkpointId, 'CP-B');
  const localA = browser.outbox.find((i) => i.draftId === draftA.draftId);
  assert.equal(localA.status, 'blocked');
  console.log('      服务端正式检查单：仅乙点 1 条；甲点草稿仍在本机待处理 ✓');

  log('⑤', '再次点“立即同步”：乙点不会第二次入库（客户端跳过 + 服务端幂等双保险）');
  const second = await browser.syncAll();
  assert.deepEqual(second, [], 'queued 已清空，自动同步不会重发任何草稿');
  // 用户对甲点手动点“重新点同步”：仍按当前权限核对，依旧 403
  const manualA = await browser.sendOne(draftA.draftId);
  assert.equal(manualA, 'blocked');
  assert.equal(localA.attempts, 2, '甲点草稿已尝试 2 次，始终留在本机');
  // 即便手工重发乙点，服务端也只保留一份
  const manualB = await browser.sendOne(draftB.draftId);
  assert.equal(manualB, 'skip'); // 客户端对 synced 项直接跳过
  state = await api('/api/admin/state');
  assert.equal(state.body.records.length, 1);
  console.log('      队列无待发送项；甲点重试仍 403；乙点记录数保持 1 ✓');

  log('⑥', '权限不足的草稿只留在本机供复制，正式检查单里永远看不到它');
  const copyText = [
    `检查点：${localA.checkpointName}`,
    `备注：${localA.note}`,
    `草稿编号：${localA.draftId}`,
    `未提交原因：${localA.lastError}`,
  ].join('\n');
  assert.match(copyText, /授权/);
  assert.equal(state.body.records.some((r) => r.draftId === draftA.draftId), false);
  console.log('      可复制的本机草稿全文：');
  console.log(copyText.split('\n').map((l) => `        ${l}`).join('\n'));

  console.log('\n端到端剧本全部通过 ✅');
  server.kill();
}

main().catch((err) => {
  console.error('端到端验证失败：', err);
  if (server) server.kill();
  process.exit(1);
});
