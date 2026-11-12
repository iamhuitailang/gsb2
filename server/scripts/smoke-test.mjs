// 端到端冒烟测试：独立测试库 + 无头 Playwright，全程只访问 127.0.0.1
// 用法：npm run smoke
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 3399;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

const testDataDir = path.join(root, 'data', 'smoke-test');
fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(testDataDir, { recursive: true });

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST,
  HEADLESS: '1',
  STEP_DELAY: '0',
  DATA_DIR: testDataDir, // 数据库、截图、模拟后台 JSON 全部隔离到测试目录
};

const server = spawn(process.execPath, [path.join(root, 'src', 'index.js')], { env });
let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`  ❌ ${name} ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/mock/api/applications`);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('测试服务启动超时');
}

async function waitStatus(jobId, expected, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/api/jobs/${jobId}`);
    const body = await r.json();
    if (expected.includes(body.job.status)) return body;
    await sleep(500);
  }
  throw new Error(`任务 ${jobId} 状态未进入 ${expected.join('/')}`);
}

async function importCsv(csvPath) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(csvPath)]), path.basename(csvPath));
  const r = await fetch(`${BASE}/api/jobs/import`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`导入失败: ${JSON.stringify(await r.json())}`);
  return r.json();
}

async function main() {
  await waitForServer();
  console.log('① CSV 校验（错误演示文件应只导入有效行）');
  const bad = await importCsv(path.resolve(root, '..', 'samples', 'demo-applications-with-errors.csv'));
  check('3 行错误被排除', bad.validationErrors.length === 3, `got ${bad.validationErrors.length}`);
  check('1 行有效被导入', bad.records.length === 1, `got ${bad.records.length}`);
  check('初始状态为 preview', bad.job.status === 'preview');

  console.log('② 正常演示文件导入与确认');
  const imported = await importCsv(path.resolve(root, '..', 'samples', 'demo-applications.csv'));
  const jobId = imported.job.id;
  check('8 条记录全部导入', imported.records.length === 8, `got ${imported.records.length}`);
  let r = await fetch(`${BASE}/api/jobs/${jobId}/confirm`, { method: 'POST' });
  check('确认后状态为 ready', (await r.json()).job.status === 'ready');

  console.log('③ 开始执行（无头浏览器自动录入模拟网站）');
  r = await fetch(`${BASE}/api/jobs/${jobId}/start`, { method: 'POST' });
  check('启动返回 started', (await r.json()).started === true);
  let final = await waitStatus(jobId, ['completed', 'failed']);
  check('任务最终 completed', final.job.status === 'completed', `got ${final.job.status}`);
  check('8 条全部 success', final.counts.success === 8, JSON.stringify(final.counts));
  check('无失败记录', final.counts.failed === 0);

  const mockApps = await (await fetch(`${BASE}/mock/api/applications`)).json();
  check('模拟后台收到本任务 8 条申请', mockApps.length === 8, `got ${mockApps.length}`);
  const shots = fs.readdirSync(path.join(testDataDir, 'screenshots')).filter((f) => f.endsWith('.png'));
  check('每条成功记录都有截图（≥8 张）', shots.length >= 8, `got ${shots.length}`);

  console.log('④ 幂等：对同一任务再次启动，不得重复提交');
  r = await fetch(`${BASE}/api/jobs/${jobId}/start`, { method: 'POST' });
  const again = await r.json();
  check('无待处理记录，直接 nothingToDo', again.nothingToDo === true, JSON.stringify(again));
  const mockApps2 = await (await fetch(`${BASE}/mock/api/applications`)).json();
  check('模拟后台数量不变', mockApps2.length === mockApps.length);

  console.log('⑤ 新任务复用相同申请编号：前置查重应全部跳过，不产生重复 POST');
  const dup = await importCsv(path.resolve(root, '..', 'samples', 'demo-applications.csv'));
  const dupId = dup.job.id;
  await fetch(`${BASE}/api/jobs/${dupId}/confirm`, { method: 'POST' });
  await fetch(`${BASE}/api/jobs/${dupId}/start`, { method: 'POST' });
  const dupFinal = await waitStatus(dupId, ['completed', 'failed']);
  check('8 条全部 skipped', dupFinal.counts.skipped === 8, JSON.stringify(dupFinal.counts));
  check('success 为 0', dupFinal.counts.success === 0);
  const mockApps3 = await (await fetch(`${BASE}/mock/api/applications`)).json();
  check('模拟后台数量仍不变', mockApps3.length === mockApps.length);

  console.log('⑥ 中断与恢复：新任务执行中停止，再恢复，最终不丢不重');
  const third = await importCsv(path.resolve(root, '..', 'samples', 'demo-applications.csv'));
  const thirdId = third.job.id;
  await fetch(`${BASE}/api/jobs/${thirdId}/confirm`, { method: 'POST' });
  await fetch(`${BASE}/api/jobs/${thirdId}/start`, { method: 'POST' });
  await sleep(1200);
  // 记录已全部被模拟后台查重跳过，停止主要验证状态机；等待自然结束也可
  const stopped = await fetch(`${BASE}/api/jobs/${thirdId}/stop`, { method: 'POST' }).catch(() => null);
  if (stopped && stopped.ok) {
    const mid = await waitStatus(thirdId, ['interrupted', 'completed']);
    check('停止后任务为 interrupted 或已完成', ['interrupted', 'completed'].includes(mid.job.status));
    if (mid.job.status === 'interrupted') {
      await fetch(`${BASE}/api/jobs/${thirdId}/start`, { method: 'POST' });
      const recovered = await waitStatus(thirdId, ['completed', 'failed']);
      check('恢复后任务 completed', recovered.job.status === 'completed');
      check('恢复后仍无重复提交', recovered.counts.success === 0 && recovered.counts.skipped === 8);
    }
  }

  console.log('⑦ 日志 PII 遮蔽');
  const logs = await (await fetch(`${BASE}/api/jobs/${jobId}/logs`)).json();
  const allText = logs.map((l) => l.message).join('\n');
  check('日志中不出现完整手机号', !/13800138001/.test(allText));
  check('日志中存在遮蔽后的手机号', /138\*\*\*\*8001/.test(allText));
  check('日志中不存在 undefined 字段', !/undefined/.test(allText));
  check('日志含具体申请编号', /APP20261112001/.test(allText));
  check('日志行数 > 0', logs.length > 0);

  console.log('⑧ 重启恢复：重启服务后未完成任务标记为 interrupted');
  server.kill('SIGTERM');
  await sleep(800);
  // 手动把一条记录改成 running 模拟崩溃现场
  const { default: BetterSqlite3 } = await import('better-sqlite3');
  const crashDb = new BetterSqlite3(path.join(testDataDir, 'rpa.db'));
  crashDb.prepare("UPDATE jobs SET status='running' WHERE id = ?").run(thirdId);
  crashDb
    .prepare("UPDATE records SET status='running' WHERE job_id = ? AND row_no = 2")
    .run(thirdId);
  crashDb.close();

  const server2 = spawn(process.execPath, [path.join(root, 'src', 'index.js')], { env });
  await waitForServer();
  const afterReboot = await (await fetch(`${BASE}/api/jobs/${thirdId}`)).json();
  check('重启后任务被标记为 interrupted', afterReboot.job.status === 'interrupted', `got ${afterReboot.job.status}`);
  check('running 记录被标记为 interrupted', afterReboot.records.every((x) => x.status !== 'running'));

  console.log('⑨ 崩溃恢复后继续执行：幂等保证不丢不重');
  const beforeCount = (await (await fetch(`${BASE}/mock/api/applications`)).json()).length;
  await fetch(`${BASE}/api/jobs/${thirdId}/start`, { method: 'POST' });
  const resumed = await waitStatus(thirdId, ['completed', 'failed']);
  check('恢复执行后任务 completed', resumed.job.status === 'completed', `got ${resumed.job.status}`);
  check('无记录卡在 running/interrupted', resumed.counts.running === 0 && resumed.counts.interrupted === 0);
  const afterCount = (await (await fetch(`${BASE}/mock/api/applications`)).json()).length;
  check('模拟后台总量未增加（重复编号全部跳过）', afterCount === beforeCount, `${beforeCount} -> ${afterCount}`);
  server2.kill('SIGTERM');
}

main()
  .then(() => {
    server.kill('SIGTERM');
    console.log(`\n冒烟测试完成：${passed} 项通过，${failures.length} 项失败`);
    process.exit(failures.length ? 1 : 0);
  })
  .catch((err) => {
    server.kill('SIGTERM');
    console.error('冒烟测试异常：', err);
    process.exit(1);
  });
