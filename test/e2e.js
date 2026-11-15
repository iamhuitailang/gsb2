'use strict';

/**
 * 端到端验收脚本：真实启动模拟后台 + 真实 Chrome，完整跑一遍题目要求的流程。
 *
 *   node test/e2e.js             （默认无头模式）
 *   node test/e2e.js --headful   （显示浏览器窗口）
 *
 * 覆盖场景：
 *   1. 预览：浏览器逐条读出三件商品当前价 20/30/40，全部可以改价；
 *   2. 预览后手动把第二件改成 29 元；
 *   3. 执行：第一、三件保存成功后重新打开详情核对，把实际价格写回执行记录；
 *   4. 第二件被后台按预计旧价拒绝覆盖，执行台标记为留待处理；最终 18 / 29 / 38 元；
 *   5. 保存成功但未记下结果进程就退出 → 续跑时先查后台历史，不重复保存；
 *   6. 同一操作编号重复提交不会二次写入；
 *   7. 暂停后可从断点继续，已完成的商品不重做。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const headful = process.argv.includes('--headful');
const PORT = 4311;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsb2-e2e-'));
const dataDir = path.join(tmpRoot, 'data');
const runsDir = path.join(dataDir, 'runs');
const csvPath = path.join(tmpRoot, 'price-changes.csv');
fs.mkdirSync(dataDir, { recursive: true });
fs.copyFileSync(path.join(repoRoot, 'data', 'price-changes.csv'), csvPath);

const env = {
  ...process.env,
  PORT: String(PORT),
  ADMIN_BASE_URL: BASE_URL,
  GSB_DATA_DIR: dataDir,
  GSB_RUNS_DIR: runsDir,
};
delete env.GSB_FAULT_KILL_AFTER_SAVE;
delete env.GSB_FAULT_PAUSE_AFTER_ITEM;

let passCount = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function runNode(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForServer(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('模拟后台启动超时');
}

function readStore() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
}

function readRunFile(runId) {
  return JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'journal.json'), 'utf8'));
}

function latestRunId() {
  return JSON.parse(fs.readFileSync(path.join(runsDir, 'latest.json'), 'utf8')).runId;
}

function priceOf(store, code) {
  const p = store.products.find((x) => x.code === code);
  return p ? p.priceCents / 100 : null;
}

function pricesNow() {
  const store = readStore();
  return ['P-1001', 'P-1002', 'P-1003'].map((c) => priceOf(store, c));
}

async function manualChange(code, price) {
  const body = new URLSearchParams({ source: 'manual', code, newPrice: price }).toString();
  const res = await fetch(`${BASE_URL}/change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return { status: res.status, text: await res.text() };
}

async function setPrices(targets) {
  // 通过普通手动入口把三件商品摆回指定价格（价格相同则跳过）
  const current = pricesNow();
  for (let i = 0; i < targets.length; i += 1) {
    if (current[i] !== targets[i]) {
      await manualChange(`P-100${i + 1}`, targets[i].toFixed(2));
    }
  }
}

function withHeadful() {
  return headful ? ['--headful'] : [];
}

async function main() {
  console.log(`临时数据目录：${tmpRoot}`);
  const server = spawn(process.execPath, [path.join(repoRoot, 'server', 'server.js')], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(d));

  try {
    await waitForServer(BASE_URL);

    /* ------------------------------------------------------------------ */
    console.log('\n[1] 预览：浏览器逐条读出当前价');
    const preview = await runNode([
      'executor/executor.js',
      'preview',
      '--file',
      csvPath,
      ...withHeadful(),
    ]);
    check('preview 退出码为 0', () => assert.strictEqual(preview.code, 0, preview.stderr));
    check('三件商品预览后均可执行', () => {
      const run = readRunFile(latestRunId());
      assert.strictEqual(run.items.length, 3);
      for (const item of run.items) assert.strictEqual(item.status, 'ready', `${item.code}: ${item.note}`);
    });
    check('预览读到的当前价是 20 / 30 / 40 元', () => {
      const run = readRunFile(latestRunId());
      assert.deepStrictEqual(
        run.items.map((i) => i.preview.priceCents),
        [2000, 3000, 4000]
      );
    });
    check('预览输出说明可以改价', () => {
      assert.ok(preview.stdout.includes('3 条可以改价'), preview.stdout);
    });
    check('每条商品都分配了操作编号', () => {
      const run = readRunFile(latestRunId());
      for (const item of run.items) assert.ok(/^OP-/.test(item.opId), item.opId);
    });

    /* ------------------------------------------------------------------ */
    console.log('\n[2] 预览完成后手动把第二件改成 29 元');
    const manual = await manualChange('P-1002', '29.00');
    check('手动改价返回 200', () => assert.strictEqual(manual.status, 200, manual.text.slice(0, 500)));
    check('后台当前价变为 29 元', () => assert.strictEqual(priceOf(readStore(), 'P-1002'), 29));
    check('手动改价在历史里带操作编号', () => {
      const h = readStore().history.find((x) => x.code === 'P-1002');
      assert.ok(h && /MANUAL-/.test(h.opId), JSON.stringify(h));
    });

    /* ------------------------------------------------------------------ */
    console.log('\n[3] 执行：保存、重新打开详情核对、回写实际价格');
    const execute = await runNode(['executor/executor.js', 'execute', ...withHeadful()]);
    check('execute 退出码为 0', () => assert.strictEqual(execute.code, 0, execute.stderr));
    check('第一、三件已保存为新价格', () => {
      const store = readStore();
      assert.strictEqual(priceOf(store, 'P-1001'), 18);
      assert.strictEqual(priceOf(store, 'P-1003'), 38);
    });
    check('第二件因价格已变化被拒绝覆盖', () => {
      const item = readRunFile(latestRunId()).items.find((i) => i.code === 'P-1002');
      assert.strictEqual(item.status, 'rejected', item.note);
      assert.ok(item.note.includes('留待人工处理'), item.note);
    });
    check('第二件仍是手动改成的 29 元，没有被覆盖', () => {
      assert.strictEqual(priceOf(readStore(), 'P-1002'), 29);
    });
    check('最终价格为 18 / 29 / 38 元', () => {
      assert.deepStrictEqual(pricesNow(), [18, 29, 38]);
    });
    check('执行记录里写回了实际价格', () => {
      const run = readRunFile(latestRunId());
      const byCode = Object.fromEntries(run.items.map((i) => [i.code, i]));
      assert.strictEqual(byCode['P-1001'].result.actualPriceCents, 1800);
      assert.strictEqual(byCode['P-1003'].result.actualPriceCents, 3800);
      assert.strictEqual(byCode['P-1002'].result.actualPriceCents, 2900);
      assert.strictEqual(byCode['P-1001'].status, 'saved');
      assert.strictEqual(byCode['P-1003'].status, 'saved');
    });
    check('result.csv 记录了实际价格', () => {
      const csv = fs.readFileSync(path.join(runsDir, latestRunId(), 'result.csv'), 'utf8');
      assert.ok(csv.includes('18.00'), csv);
      assert.ok(csv.includes('38.00'), csv);
      assert.ok(csv.includes('29.00'), csv);
    });
    check('执行台输出指出第二件留待处理', () => {
      assert.ok(execute.stdout.includes('留待处理'), execute.stdout);
      assert.ok(execute.stdout.includes('P-1002'), execute.stdout);
    });
    check('后台改价历史里自动操作带操作编号', () => {
      const autoRows = readStore().history.filter((h) => h.source === 'automation');
      assert.strictEqual(autoRows.length, 2, JSON.stringify(autoRows));
      for (const row of autoRows) assert.ok(/^OP-/.test(row.opId), row.opId);
    });
    check('自动改价的旧价是新价生效前的价格', () => {
      const store = readStore();
      const h1 = store.history.find((h) => h.code === 'P-1001' && h.source === 'automation');
      assert.strictEqual(h1.oldPriceCents, 2000);
      assert.strictEqual(h1.newPriceCents, 1800);
    });

    /* ------------------------------------------------------------------ */
    console.log('\n[4] 幂等：同一操作编号重复提交不会二次写入');
    const runId = latestRunId();
    const savedOp = readRunFile(runId).items.find((i) => i.code === 'P-1001').opId;
    const before = readStore().history.length;
    const res = await fetch(`${BASE_URL}/change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: 'P-1001',
        newPrice: '18.00',
        expectedOldPrice: '20.00',
        expectedVersion: '1',
        opId: savedOp,
      }).toString(),
    });
    const dupText = await res.text();
    check('重复操作编号返回 200 且提示未重复写入', () => {
      assert.strictEqual(res.status, 200, dupText.slice(0, 400));
      assert.ok(dupText.includes('未重复写入') || dupText.includes('改价已存在'), dupText.slice(0, 500));
    });
    check('历史条数没有增加', () => assert.strictEqual(readStore().history.length, before));

    /* ------------------------------------------------------------------ */
    console.log('\n[5] 保存成功但结果未记下就退出 → 续跑先查后台历史');
    await setPrices([20, 30, 40]);
    // 重新预览，让 20/30/40 三条都变成 ready
    const p2 = await runNode(['executor/executor.js', 'preview', '--file', csvPath, ...withHeadful()]);
    check('新批次预览三条可执行', () => {
      assert.strictEqual(p2.code, 0, p2.stderr);
      const r = readRunFile(latestRunId());
      assert.strictEqual(r.items.filter((i) => i.status === 'ready').length, 3, JSON.stringify(r.items));
    });
    const crashedRunId = latestRunId();
    // 故障注入：第一件保存成功后立刻退出，journal 里只留下 saving 状态
    const crashed = await runNode(
      ['executor/executor.js', 'execute', '--run', crashedRunId, ...withHeadful()],
      { GSB_FAULT_KILL_AFTER_SAVE: '0' }
    );
    check('进程在保存后台成功之后异常退出', () => {
      assert.notStrictEqual(crashed.code, 0);
    });
    check('退出时执行记录里第一件处于保存中、结果未知', () => {
      const r = readRunFile(crashedRunId);
      const item = r.items.find((i) => i.code === 'P-1001');
      assert.strictEqual(item.status, 'saving', `${item.status}: ${item.note}`);
      assert.strictEqual(item.result, null);
      assert.notStrictEqual(r.phase, 'finished');
    });
    check('但后台历史里其实已经保存了这次操作编号', () => {
      const opId = readRunFile(crashedRunId).items.find((i) => i.code === 'P-1001').opId;
      const rows = readStore().history.filter((h) => h.opId === opId);
      assert.strictEqual(rows.length, 1, JSON.stringify(rows));
      assert.strictEqual(rows[0].newPriceCents, 1800);
    });
    const resumedCrash = await runNode(['executor/executor.js', 'resume', '--run', crashedRunId, ...withHeadful()]);
    check('续跑退出码为 0', () => assert.strictEqual(resumedCrash.code, 0, resumedCrash.stderr));
    check('续跑从历史确认第一件已保存，并标记出来', () => {
      const item = readRunFile(crashedRunId).items.find((i) => i.code === 'P-1001');
      assert.strictEqual(item.status, 'already_saved', `${item.status}: ${item.note}`);
      assert.strictEqual(item.result.recoveredFromHistory, true);
      assert.ok(resumedCrash.stdout.includes('跳过保存'), resumedCrash.stdout);
    });
    check('已成功的操作没有被保存第二次', () => {
      const opId = readRunFile(crashedRunId).items.find((i) => i.code === 'P-1001').opId;
      const rows = readStore().history.filter((h) => h.opId === opId);
      assert.strictEqual(rows.length, 1, JSON.stringify(rows));
    });
    check('续跑继续完成剩余商品', () => {
      const r = readRunFile(crashedRunId);
      assert.strictEqual(r.phase, 'finished');
      assert.deepStrictEqual(pricesNow(), [18, 28, 38]);
    });

    /* ------------------------------------------------------------------ */
    console.log('\n[6] 暂停后从断点继续');
    await setPrices([20, 29, 40]);
    const p3 = await runNode(['executor/executor.js', 'preview', '--file', csvPath, ...withHeadful()]);
    const pausedRunId = latestRunId();
    check('新批次预览：第二件 29 元需复核，第一、三件可执行', () => {
      assert.strictEqual(p3.code, 0, p3.stderr);
      const r = readRunFile(pausedRunId);
      assert.strictEqual(r.items.find((i) => i.code === 'P-1001').status, 'ready');
      assert.strictEqual(r.items.find((i) => i.code === 'P-1002').status, 'needs_review');
      assert.strictEqual(r.items.find((i) => i.code === 'P-1003').status, 'ready');
    });
    const paused = await runNode(
      ['executor/executor.js', 'execute', '--run', pausedRunId, ...withHeadful()],
      { GSB_FAULT_PAUSE_AFTER_ITEM: '0' }
    );
    check('执行在第一件处理后暂停', () => {
      assert.strictEqual(paused.code, 0, paused.stderr);
      const r = readRunFile(pausedRunId);
      assert.strictEqual(r.phase, 'paused');
      assert.strictEqual(r.items.find((i) => i.code === 'P-1001').status, 'saved');
      assert.strictEqual(r.items.find((i) => i.code === 'P-1003').status, 'ready');
    });
    check('暂停时提示可以 resume', () => assert.ok(paused.stdout.includes('resume'), paused.stdout));
    const resumed = await runNode(['executor/executor.js', 'resume', '--run', pausedRunId, ...withHeadful()]);
    check('resume 完成剩余部分', () => {
      assert.strictEqual(resumed.code, 0, resumed.stderr);
      const r = readRunFile(pausedRunId);
      assert.strictEqual(r.phase, 'finished');
      assert.strictEqual(r.items.find((i) => i.code === 'P-1003').status, 'saved');
      assert.strictEqual(priceOf(readStore(), 'P-1003'), 38);
      assert.strictEqual(priceOf(readStore(), 'P-1002'), 29);
    });
    check('已完成的商品没有重复保存', () => {
      const opId = readRunFile(pausedRunId).items.find((i) => i.code === 'P-1001').opId;
      const rows = readStore().history.filter((h) => h.opId === opId);
      assert.strictEqual(rows.length, 1, JSON.stringify(rows));
    });

    /* ------------------------------------------------------------------ */
    console.log('\n[7] 重演题目给出的完整场景');
    await setPrices([20, 30, 40]);
    const finalPreview = await runNode(['executor/executor.js', 'preview', '--file', csvPath, ...withHeadful()]);
    check('预览 3 条可执行', () => {
      assert.strictEqual(finalPreview.code, 0, finalPreview.stderr);
      const r = readRunFile(latestRunId());
      assert.strictEqual(r.items.filter((i) => i.status === 'ready').length, 3);
    });
    const manual29 = await manualChange('P-1002', '29.00');
    check('预览后手动把第二件改成 29 元', () => {
      assert.strictEqual(manual29.status, 200);
      assert.strictEqual(priceOf(readStore(), 'P-1002'), 29);
    });
    const finalExec = await runNode(['executor/executor.js', 'execute', ...withHeadful()]);
    check('执行后台当前价为 18 / 29 / 38 元', () => assert.deepStrictEqual(pricesNow(), [18, 29, 38]));
    check('执行台明确标出第二件因价格变化留待处理', () => {
      assert.strictEqual(finalExec.code, 0, finalExec.stderr);
      assert.ok(finalExec.stdout.includes('P-1002'), finalExec.stdout);
      assert.ok(finalExec.stdout.includes('留待处理'), finalExec.stdout);
      const item = readRunFile(latestRunId()).items.find((i) => i.code === 'P-1002');
      assert.strictEqual(item.status, 'rejected');
      assert.strictEqual(item.result.actualPriceCents, 2900);
    });
    check('执行记录回写了三条的实际价格', () => {
      const r = readRunFile(latestRunId());
      const byCode = Object.fromEntries(r.items.map((i) => [i.code, i]));
      assert.strictEqual(byCode['P-1001'].result.actualPriceCents, 1800);
      assert.strictEqual(byCode['P-1002'].result.actualPriceCents, 2900);
      assert.strictEqual(byCode['P-1003'].result.actualPriceCents, 3800);
    });
    const st = await runNode(['executor/executor.js', 'status', '--json']);
    check('status 命令可查看执行记录', () => {
      assert.strictEqual(st.code, 0, st.stderr);
      assert.ok(st.stdout.includes('留待处理'), st.stdout);
    });
  } finally {
    server.kill('SIGTERM');
  }

  console.log(`\n结果：${passCount} 项通过，${failures.length} 项失败。`);
  if (failures.length) {
    for (const f of failures) console.error(`\n失败：${f.name}\n${f.error.stack}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
