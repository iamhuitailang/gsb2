'use strict';

/**
 * 执行台命令行入口。
 *
 *   node executor/executor.js preview --file data/price-changes.csv
 *   node executor/executor.js execute
 *   node executor/executor.js resume
 *   node executor/executor.js status [--run <id>]
 *   node executor/executor.js pause  [--run <id>]
 *   node executor/executor.js runs
 *
 * 通用参数：--base-url（默认 http://127.0.0.1:4310）、--headful（显示浏览器窗口）。
 */

const fs = require('fs');
const path = require('path');
const { launch } = require('../lib/browser');
const { loadImportFile } = require('./importer');
const journal = require('./journal');
const core = require('./core');
const { formatCents } = require('../lib/money');

const DEFAULT_BASE_URL = process.env.ADMIN_BASE_URL || 'http://127.0.0.1:4310';

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.flags[key] = next;
        i += 1;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function log(message) {
  console.log(message);
}

async function assertServerReady(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/healthz`);
    if (!res.ok) throw new Error(`状态码 ${res.status}`);
  } catch (err) {
    throw new Error(
      `无法连接模拟后台 ${baseUrl}（${err.message}）。请先在另一个终端运行 npm run server`
    );
  }
}

async function withBrowser({ headful }, fn) {
  const browser = await launch({ headless: !headful });
  try {
    return await fn(browser.page);
  } finally {
    await browser.close().catch(() => {});
  }
}

function resolveRun(flags) {
  const runId = flags.run || journal.latestRunId();
  if (!runId) throw new Error('没有找到执行记录，请先运行 preview');
  const run = journal.load(runId);
  if (!run) throw new Error(`找不到执行记录 ${runId}`);
  return run;
}

function moneyOrEmpty(cents) {
  return typeof cents === 'number' && Number.isFinite(cents) ? formatCents(cents) : '';
}

function writeResultFiles(run) {
  const dir = journal.runDir(run.runId);
  fs.mkdirSync(dir, { recursive: true });
  const rows = run.items.map((item) => ({
    code: item.code,
    opId: item.opId,
    status: item.status,
    statusLabel: core.label(item.status),
    expectedOldPrice: item.expectedOldCents === null ? null : formatCents(item.expectedOldCents),
    targetPrice: formatCents(item.newCents),
    previewPrice:
      item.preview && typeof item.preview.priceCents === 'number'
        ? formatCents(item.preview.priceCents)
        : null,
    actualPrice: item.result ? moneyOrEmpty(item.result.actualPriceCents) || null : null,
    backendSeq: item.result && typeof item.result.seq === 'number' ? item.result.seq : null,
    note: item.note,
    updatedAt: run.updatedAt,
  }));
  fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(rows, null, 2)}\n`);
  const csv = [
    '商品编号,操作编号,状态,预计旧价,目标价,实际价格,后台序号,说明',
    ...rows.map((r) =>
      [
        r.code,
        r.opId,
        r.statusLabel,
        r.expectedOldPrice || '',
        r.targetPrice,
        r.actualPrice || '',
        r.backendSeq === null || r.backendSeq === undefined ? '' : r.backendSeq,
        `"${String(r.note).replace(/"/g, '""')}"`,
      ].join(',')
    ),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'result.csv'), `${csv}\n`);
  return { json: path.join(dir, 'result.json'), csv: path.join(dir, 'result.csv') };
}

async function cmdPreview(flags) {
  const file = flags.file || path.join(__dirname, '..', 'data', 'price-changes.csv');
  const baseUrl = flags['base-url'] || DEFAULT_BASE_URL;
  const parsed = loadImportFile(file);
  if (!parsed.ok) {
    console.error('导入文件有问题：');
    for (const err of parsed.errors) console.error(`  - ${err}`);
    process.exitCode = 2;
    return null;
  }

  console.log(`导入文件：${parsed.absPath}`);
  console.log(`共 ${parsed.items.length} 行，开始用浏览器逐条读出当前价……`);

  await assertServerReady(baseUrl);
  const run = core.createRun({ file: parsed.absPath, fileHash: parsed.fileHash, items: parsed.items, baseUrl });
  journal.appendEvent(run, 'run-created', { file: parsed.absPath, fileHash: parsed.fileHash });
  journal.save(run);

  await withBrowser(flags, async (page) => {
    await core.previewRun({ run, page, baseUrl, log });
  });

  console.log('');
  console.log(`执行记录：${journal.journalPath(run.runId)}`);
  console.log('');
  core.printTable(core.summaryRows(run));
  const reviewable = run.items.filter((i) => i.status === 'ready').length;
  const reviewNeeded = run.items.filter((i) => i.status === 'needs_review' || i.status === 'not_found').length;
  console.log(`预览完成：${reviewable} 条可以改价，${reviewNeeded} 条需要复核。`);
  if (reviewable > 0) console.log('确认无误后运行：npm run execute');
  writeResultFiles(run);
  return run;
}

async function cmdExecute(flags) {
  const run = resolveRun(flags);
  const baseUrl = flags['base-url'] || run.baseUrl || DEFAULT_BASE_URL;

  if (run.phase === 'created') {
    console.error('这条执行记录还没做预览。请先运行：npm run preview');
    process.exitCode = 2;
    return run;
  }
  if (run.phase === 'finished') {
    const unfinished = run.items.filter((item) => !core.isTerminal(item.status));
    if (unfinished.length === 0) {
      const pending = run.items.filter(
        (item) => !['saved', 'already_saved', 'already_at_target'].includes(item.status)
      );
      if (pending.length === 0) {
        console.log(`执行记录 ${run.runId} 已全部保存并核对通过，无需再执行。`);
      } else {
        console.log(
          `执行记录 ${run.runId} 已执行完毕：${run.items.length - pending.length} 条已保存，${
            pending.length
          } 条留待人工处理，本次没有可自动执行的条目。`
        );
      }
      core.printTable(core.summaryRows(run));
      return run;
    }
  }

  await assertServerReady(baseUrl);

  let stopRequested = false;
  const onSignal = () => {
    if (stopRequested) {
      console.log('\n再按一次 Ctrl-C：强制退出（保存结果可能来不及记录，续跑时会从后台历史核对）。');
      process.exit(130);
    }
    stopRequested = true;
    console.log('\n收到中断信号：完成当前商品后暂停，稍后可 resume 继续。');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  journal.markPause(run.runId, false);
  console.log(`执行记录：${run.runId}（${run.phase}）`);
  console.log('开始执行，每条都会在浏览器里查询、提交，再重新打开详情核对。');

  await withBrowser(flags, async (page) => {
    await core.executeRun({
      run,
      page,
      baseUrl,
      log,
      shouldStop: () => stopRequested,
      // 每处理一条就落一次结果文件，进程意外退出也不丢已得到的实际价格
      onItemDone: () => writeResultFiles(run),
    });
  });

  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  console.log('');
  core.printTable(core.summaryRows(run));
  const files = writeResultFiles(run);
  console.log(`执行记录已写回：${files.json}`);
  console.log(`              ${files.csv}`);
  if (run.phase === 'paused') {
    console.log('状态：已暂停。运行 npm run resume 从未完成处继续。');
  } else {
    const pending = run.items.filter(
      (item) => !['saved', 'already_saved', 'already_at_target'].includes(item.status)
    );
    console.log(
      pending.length
        ? `状态：结束。${run.items.length - pending.length} 条已保存，${pending.length} 条留待处理。`
        : `状态：全部 ${run.items.length} 条已保存并核对通过。`
    );
  }
  return run;
}

async function cmdStatus(flags) {
  const run = resolveRun(flags);
  console.log(`执行记录：${run.runId}`);
  console.log(`导入文件：${run.file}`);
  console.log(`阶段：${run.phase}　创建：${run.createdAt}　更新：${run.updatedAt}`);
  console.log('');
  core.printTable(core.summaryRows(run));
  if (flags.json) {
    console.log(JSON.stringify(core.summaryRows(run), null, 2));
  }
  return run;
}

async function cmdPause(flags) {
  const run = resolveRun(flags);
  journal.markPause(run.runId, true);
  console.log(`已为执行记录 ${run.runId} 设置暂停标记；正在运行的 execute 会在当前商品处理完后停下。`);
  return run;
}

async function cmdRuns() {
  const runs = journal.listRuns();
  if (!runs.length) {
    console.log('暂无执行记录。');
    return;
  }
  for (const r of runs) {
    const counts = Object.entries(r.counts)
      .map(([status, n]) => `${core.label(status)}×${n}`)
      .join('，');
    console.log(`${r.runId}  ${r.createdAt}  ${counts}`);
  }
}

function usage() {
  console.log(`用法：
  node executor/executor.js preview --file <csv>
  node executor/executor.js execute [--run <id>] [--base-url <url>] [--headful]
  node executor/executor.js resume  [--run <id>]
  node executor/executor.js status  [--run <id>] [--json]
  node executor/executor.js pause   [--run <id>]
  node executor/executor.js runs`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    switch (command) {
      case 'preview':
        await cmdPreview(args.flags);
        break;
      case 'execute':
      case 'resume':
      case 'run':
        await cmdExecute(args.flags);
        break;
      case 'status':
        await cmdStatus(args.flags);
        break;
      case 'pause':
        await cmdPause(args.flags);
        break;
      case 'runs':
        await cmdRuns();
        break;
      default:
        usage();
        if (!command) process.exitCode = 2;
    }
  } catch (err) {
    console.error(`出错：${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { cmdPreview, cmdExecute, cmdStatus, cmdPause, cmdRuns };
