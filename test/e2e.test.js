// 端到端验证：零依赖，spawn 真实服务进程，通过 SSE 原始报文 + HTTP 接口验证
// 运行：npm test
//
// 覆盖题目验收点：
//  1. 员工同时订阅两个项目，消息含任务标题和状态
//  2. 订阅范围服务端决定（无项目入参；伪造项目 id 越权读取被拒）
//  3. 撤销甲项目权限后：在线连接只收到控制事件，收不到甲的新任务事件，乙照常
//  4. 撤权后历史接口不再提供甲标题，未读数同步剔除甲
//  5. 断线重连（Last-Event-ID）补发按当前权限过滤，甲标题不出现
//  6. 关闭页面再重开（全新连接、无 Last-Event-ID）同样看不到撤权后的甲标题
//  7. 员工不能调用管理员接口

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EMPLOYEE = 'employee-token';
const ADMIN = 'admin-token';
const ALPHA = 'proj-alpha';
const BETA = 'proj-beta';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 启动服务（随机端口，避免冲突）----
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: '0' },
});
// 无论测试正常结束、异常还是被中断，都回收子进程，避免留下孤儿服务
const cleanup = () => {
  if (!child.killed) child.kill('SIGKILL');
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let base = '';
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('服务启动超时')), 8000);
  child.stdout.on('data', (chunk) => {
    const line = chunk.toString();
    process.stdout.write(`  [server] ${line}`);
    const m = line.match(/http:\/\/localhost:(\d+)/);
    if (m && !base) {
      base = `http://localhost:${m[1]}`;
      clearTimeout(timer);
      resolve();
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('exit', (code) => {
    if (!base) reject(new Error(`服务进程提前退出，code=${code}`));
  });
});

async function api(p, { method = 'GET', token = EMPLOYEE, body } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ---- 最小 SSE 客户端：解析 id/event/data 帧 ----
function openStream(token) {
  const controller = new AbortController();
  const events = [];
  const waiters = [];
  let connected = false;

  fetch(`${base}/api/stream?token=${token}`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  }).then(async (res) => {
    if (!res.ok || !res.body) throw new Error(`SSE 握手失败: ${res.status}`);
    connected = true;
    // 持久缓冲：帧可能跨 chunk 到达，只消费以 \n\n 结尾的完整帧，残片留待下次拼接
    const decoder = new TextDecoder();
    let pending = '';
    const parseFrame = (raw) => {
      let id = null;
      let type = 'message';
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (!line || line.startsWith(':')) continue; // SSE 注释/心跳行
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        else if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) return;
      let data = null;
      try { data = JSON.parse(dataLines.join('')); } catch { return; }
      const evt = { id, type, data };
      events.push(evt);
      while (waiters.length) waiters.shift()();
    };
    for await (const chunk of res.body) {
      pending += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = pending.indexOf('\n\n')) !== -1) {
        parseFrame(pending.slice(0, idx));
        pending = pending.slice(idx + 2);
      }
    }
  }).catch((err) => {
    if (!controller.signal.aborted) console.error('  [stream]', err.message);
  });

  return {
    events,
    controller,
    waitReady: async () => {
      while (!connected) await sleep(10);
      await sleep(30);
    },
    // 等待满足条件的事件：每次到达都全量扫描已缓冲队列，避免漏掉先到的事件
    waitFor: async (predicate, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = events.find(predicate);
        if (found) return found;
        await new Promise((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, Math.min(100, deadline - Date.now()));
        });
      }
      throw new Error('等待 SSE 事件超时');
    },
    close: () => controller.abort(),
  };
}

// 用 Last-Event-ID 模拟浏览器原生重连，收完补发帧后立即断开
async function reconnectOnce(token, lastEventId, settleMs = 400) {
  const controller = new AbortController();
  const collected = [];
  const res = await fetch(`${base}/api/stream?token=${token}`, {
    headers: {
      Accept: 'text/event-stream',
      ...(lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {}),
    },
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), settleMs);
  const decoder = new TextDecoder();
  let pending = '';
  const parseFrame = (raw) => {
    if (!raw.includes('data:')) return;
    const type = (raw.match(/event: (.+)/) || [])[1];
    const dataLine = raw
      .split('\n')
      .find((l) => l.startsWith('data:'));
    if (!dataLine) return;
    collected.push({ type, data: JSON.parse(dataLine.slice(5).trim()) });
  };
  try {
    for await (const chunk of res.body) {
      pending += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = pending.indexOf('\n\n')) !== -1) {
        parseFrame(pending.slice(0, idx));
        pending = pending.slice(idx + 2);
      }
    }
  } catch { /* abort 后正常结束收集 */ }
  clearTimeout(timer);
  return collected;
}

const titles = (evts) => evts.map((e) => e.data?.title).filter(Boolean);

try {
  // 等服务就绪
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch { /* 重试 */ }
    await sleep(100);
  }

  console.log('\n① 重置到初始状态：员工对甲乙两个项目都有权限，各有两条任务');
  await api('/api/test/reset', { method: 'POST', token: ADMIN });
  const initial = await api('/api/state');
  check('初始可见两个项目', initial.data.projects?.length === 2);
  check('每个项目两条任务，共四条', initial.data.tasks?.length === 4);
  check('事件含标题与状态字段',
    initial.status === 200 &&
    initial.data.tasks.every((t) => typeof t.title === 'string' && typeof t.status === 'string'));

  console.log('\n② 建立实时连接：订阅范围由服务端下发，请求中不含任何项目参数');
  const stream = openStream(EMPLOYEE);
  await stream.waitReady();
  const subscribed = await stream.waitFor((e) => e.type === 'subscribed');
  check('服务端确认订阅甲乙两个项目',
    Array.isArray(subscribed.data.projectIds) &&
    subscribed.data.projectIds.length === 2 &&
    subscribed.data.projectIds.includes(ALPHA) &&
    subscribed.data.projectIds.includes(BETA));

  console.log('\n③ 两边各更新一条任务，员工实时收到带标题和状态的消息');
  const alphaTask = initial.data.tasks.find((t) => t.projectId === ALPHA);
  const betaTask = initial.data.tasks.find((t) => t.projectId === BETA);
  const r1 = await api('/api/admin/tasks/update', { method: 'POST', token: ADMIN, body: { taskId: alphaTask.id } });
  const r2 = await api('/api/admin/tasks/update', { method: 'POST', token: ADMIN, body: { taskId: betaTask.id } });
  const ev1 = await stream.waitFor((e) => e.type === 'task.updated' && e.data.taskId === alphaTask.id);
  const ev2 = await stream.waitFor((e) => e.type === 'task.updated' && e.data.taskId === betaTask.id);
  check('收到甲项目任务事件且含标题', ev1.data.title === alphaTask.title && ev1.data.status === '进行中');
  check('收到乙项目任务事件且含标题', ev2.data.title === betaTask.title && ev2.data.status === '进行中');

  console.log('\n④ 越权防护：员工无法调用管理员接口，伪造项目 id 读取被拒');
  const forbiddenUpdate = await api('/api/admin/tasks/update', {
    method: 'POST', token: EMPLOYEE, body: { taskId: alphaTask.id },
  });
  check('员工不能推进任务（403）', forbiddenUpdate.status === 403);
  const noToken = await api('/api/state', { token: null });
  check('无 token 拒绝访问（401）', noToken.status === 401);

  console.log('\n⑤ 管理员撤销员工对甲项目的权限');
  const revoke = await api('/api/admin/access', {
    method: 'POST', token: ADMIN, body: { userId: 'u1', projectId: ALPHA, grant: false },
  });
  check('撤权成功，服务端口径只剩乙项目',
    revoke.status === 200 &&
    revoke.data.projectIds.length === 1 &&
    revoke.data.projectIds[0] === BETA);
  const ctrl = await stream.waitFor((e) => e.type === 'permission.revoked');
  check('在线连接即时收到撤权控制事件', ctrl.data.projectId === ALPHA);

  console.log('\n⑥ 撤权后分别再更新甲乙任务：甲被拦截，乙照常推送');
  const beforeCount = stream.events.length;
  await api('/api/admin/tasks/update', { method: 'POST', token: ADMIN, body: { taskId: alphaTask.id } });
  const r3 = await api('/api/admin/tasks/update', { method: 'POST', token: ADMIN, body: { taskId: betaTask.id } });
  const ev3 = await stream.waitFor(
    (e) => e.type === 'task.updated' && e.data.taskId === betaTask.id && e.id === r3.data.event.id
  );
  await sleep(300);
  const leaked = stream.events
    .slice(beforeCount)
    .filter((e) => e.type === 'task.updated' && e.data.projectId === ALPHA);
  check('甲项目新事件没有推送给已撤权的连接', leaked.length === 0);
  check('乙项目更新照常实时推送', ev3.data.title === betaTask.title && ev3.data.status === '评审中');

  console.log('\n⑦ 历史接口与未读数同步剔除甲项目（旧标题也不再提供）');
  const after = await api('/api/state');
  check('快照中不再包含甲项目', after.data.projects.every((p) => p.id !== ALPHA));
  check('任务列表无甲项目任务', after.data.tasks.every((t) => t.projectId !== ALPHA));
  check('事件列表无任何甲项目标题', !after.data.events.some((e) => e.projectId === ALPHA));
  check('未读数只统计乙项目',
    Object.keys(after.data.unread).every((pid) => pid === BETA) &&
    after.data.unread[BETA] === 2);
  const direct = await api(`/api/projects/${ALPHA}/events`);
  check('直接按 id 读取甲项目被拒（403）', direct.status === 403);
  const directBeta = await api(`/api/projects/${BETA}/events`);
  check('乙项目仍可直接读取', directBeta.status === 200 && directBeta.data.events.length === 2);

  console.log('\n⑧ 断线重连补发（Last-Event-ID）按当前权限过滤');
  stream.close();
  await sleep(100);
  const replay = await reconnectOnce(EMPLOYEE, ev2.id);
  check('补发内容不含撤权后的甲项目标题',
    !replay.some((e) => e.data?.projectId === ALPHA));
  check('补发仍包含乙项目新事件（含标题/状态）',
    replay.some((e) => e.type === 'task.updated' && e.data.projectId === BETA && e.data.title));
  check('补发的订阅范围只剩乙项目，客户端据此重建撤权状态',
    replay.find((e) => e.type === 'subscribed')?.data.projectIds.join() === BETA);

  console.log('\n⑨ 关闭页面再重开（全新连接，不带 Last-Event-ID）');
  const reopen = await reconnectOnce(EMPLOYEE, null, 400);
  check('重开后订阅范围只有乙项目',
    reopen.find((e) => e.type === 'subscribed')?.data.projectIds.join() === BETA);
  check('重开后的全量补发里没有任何甲项目标题',
    !titles(reopen).some((t) => t.includes('甲-')));
  check('重开后仍能看到乙项目两条任务标题',
    titles(reopen).filter((t) => t.includes('乙-')).length === 2);

  console.log('\n⑩ 恢复甲项目权限后，推送与历史立即恢复');
  await api('/api/admin/access', {
    method: 'POST', token: ADMIN, body: { userId: 'u1', projectId: ALPHA, grant: true },
  });
  const restored = await api('/api/state');
  check('恢复后再次可见两个项目', restored.data.projects.length === 2);
  const stream2 = openStream(EMPLOYEE);
  await stream2.waitReady();
  await api('/api/admin/tasks/update', { method: 'POST', token: ADMIN, body: { taskId: alphaTask.id } });
  const ev4 = await stream2.waitFor(
    (e) => e.type === 'task.updated' && e.data.projectId === ALPHA
  );
  check('恢复权限后甲项目推送恢复，标题状态完整',
    ev4.data.title === alphaTask.title && typeof ev4.data.status === 'string');
  stream2.close();
} catch (err) {
  failed++;
  console.error('  ❌ 测试异常中断:', err.message);
} finally {
  cleanup();
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
