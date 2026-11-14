import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { ensureInitialized, publishNext, queryChanges, getStatus } from '../src/supplier.js';
import { SyncEngine } from '../src/sync-engine.js';

function makeFetcher(db) {
  return ({ sinceVersion, cursor, limit }) =>
    Promise.resolve(queryChanges(db, sinceVersion, cursor, limit));
}

function makeContext() {
  const db = openDb(':memory:');
  ensureInitialized(db);
  const fetcher = makeFetcher(db);
  const engine = new SyncEngine(db, { fetcher, pageSize: 3 });
  return { db, engine, fetcher };
}

async function waitForStatus(engine, runId, status, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = engine.getRun(runId);
    if (run.status === status) return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待任务 ${runId} 变为 ${status} 超时，当前状态 ${engine.getRun(runId).status}`);
}

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('等待条件超时');
}

/**
 * 可控 fetcher：正常逐页返回，但调用方可以通过 gate 在"第 N 次拉取"上挂起循环，
 * 或直接放开。用调用计数而非事件时序控制，结果确定。
 * 计数在安装门闩时归零，因此 blockCall(2) 永远指本次门闩安装后的第 2 次拉取。
 */
function gatedFetcher(engine, fetcher) {
  let callCount = 0;
  const waiters = [];
  let blockOnCall = 0; // 0 = 不拦截；>0 = 第几次拉取要挂起
  engine.fetcher = async (args) => {
    callCount += 1;
    if (blockOnCall > 0 && callCount === blockOnCall) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    return fetcher(args);
  };
  return {
    get callCount() {
      return callCount;
    },
    get blocked() {
      return waiters.length > 0;
    },
    /** 让第 n 次拉取（1-based，相对本次安装）挂起 */
    blockCall(n) {
      blockOnCall = n;
    },
    /** 放开被挂起的拉取，之后所有拉取都不再拦截 */
    release() {
      blockOnCall = 0;
      while (waiters.length) waiters.shift()();
    },
  };
}

test('供应商接口：全量按游标翻页，排序为 (version, sku) 且页内包含相同更新时间的商品', () => {
  const { db } = makeContext();
  const p1 = queryChanges(db, 0, null, 3);
  assert.equal(p1.items.length, 3);
  assert.equal(p1.hasMore, true);
  assert.deepEqual(p1.items.map((i) => i.sku), ['SKU1001', 'SKU1002', 'SKU1003']);
  // 第一页三个商品更新时间相同、编号不同
  assert.equal(new Set(p1.items.map((i) => i.updated_at)).size, 1);

  const p2 = queryChanges(db, 0, p1.nextCursor, 3);
  const p3 = queryChanges(db, 0, p2.nextCursor, 3);
  const all = [...p1.items, ...p2.items, ...p3.items];
  assert.equal(all.length, 8);
  assert.equal(p3.nextCursor, null);
  // 版本号严格递增
  assert.ok(all.every((it, idx) => idx === 0 || it.version > all[idx - 1].version));
});

test('首轮全量：8 个商品全部新增，计数按实际写入结果', async () => {
  const { engine } = makeContext();
  const { run } = await engine.start();
  const done = await waitForStatus(engine, run.id, 'done');

  assert.equal(done.mode, 'full');
  assert.equal(done.pages_done, 3);
  assert.equal(done.fetched_rows, 8);
  assert.equal(done.inserted_count, 8);
  assert.equal(done.updated_count, 0);
  assert.equal(done.skipped_count, 0);
  assert.equal(engine.listProducts().length, 8);
});

test('同一页重复拉取：不会生成两条商品，计数全部变为跳过', async () => {
  const { db, engine, fetcher } = makeContext();
  const first = await fetcher({ sinceVersion: 0, cursor: null, limit: 3 });

  const { run } = await engine.start();
  await waitForStatus(engine, run.id, 'done');
  const before = engine.listProducts().map((p) => p.sku).sort();

  // 用同一游标再拉同一页，再走一遍完整的页写入
  const result = await engine.writePage(run.id, first.items, first.nextCursor);
  assert.deepEqual(result, { inserted: 0, updated: 0, skipped: 3 });

  const after = engine.listProducts().map((p) => p.sku).sort();
  assert.deepEqual(after, before);
  assert.equal(engine.listProducts().length, 8);

  // 数据库层面 sku 唯一键也在（同名再插入必须冲突）
  assert.throws(
    () => db.prepare('INSERT INTO products(sku, name, price, source_version, updated_at, synced_at) VALUES (?,?,?,?,?,?)')
      .run('SKU1001', 'x', 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    /UNIQUE constraint failed/
  );
});

test('旧版本不能覆盖新价格：高版本已入库后，低版本同编号变更被跳过', async () => {
  const { engine } = makeContext();
  const { run } = await engine.start();
  await waitForStatus(engine, run.id, 'done');

  const current = engine.getProduct('SKU1001');
  assert.equal(current.price, 39.9);
  assert.equal(current.source_version, 1);

  // 模拟接口重放旧版本：一条同版本、一条更低版本
  const staleSame = [{ sku: 'SKU1001', name: '东北珍珠米 5kg', price: 999, version: 1, updated_at: '2026-01-01T00:00:00Z' }];
  const staleOlder = [{ sku: 'SKU1001', name: '东北珍珠米 5kg', price: 888, version: 0, updated_at: '2026-01-01T00:00:00Z' }];

  const r1 = await engine.writePage(run.id, staleSame, null);
  const r2 = await engine.writePage(run.id, staleOlder, null);
  assert.deepEqual(r1, { inserted: 0, updated: 0, skipped: 1 });
  assert.deepEqual(r2, { inserted: 0, updated: 0, skipped: 1 });

  const untouched = engine.getProduct('SKU1001');
  assert.equal(untouched.price, 39.9);
  assert.equal(untouched.source_version, 1);
});

test('第二轮增量：供应商发布第二批后，只拉变更并正确区分改价与新上架', async () => {
  const { db, engine } = makeContext();
  const { run: first } = await engine.start();
  await waitForStatus(engine, first.id, 'done');

  const published = publishNext(db);
  assert.equal(published.change_count, 5);
  assert.equal(getStatus(db).publishedBatches, 2);

  const { run: second } = await engine.start();
  assert.equal(second.mode, 'incremental');
  assert.equal(second.since_version, 8); // 上一轮水位线
  const done = await waitForStatus(engine, second.id, 'done');

  assert.equal(done.fetched_rows, 5);
  assert.equal(done.inserted_count, 2); // SKU1009、SKU1010 新上架
  assert.equal(done.updated_count, 3);  // SKU1001、SKU1003 改价 + SKU1006 改名
  assert.equal(done.skipped_count, 0);
  assert.equal(engine.listProducts().length, 10);

  const p1001 = engine.getProduct('SKU1001');
  assert.equal(p1001.price, 35.9);
  assert.equal(p1001.source_version, 9);

  const p1003 = engine.getProduct('SKU1003');
  assert.equal(p1003.price, 23.8);
  assert.equal(p1003.source_version, 10);

  const p1006 = engine.getProduct('SKU1006');
  assert.equal(p1006.name, '柔肤抽纸 3 层*100 抽*24');
  assert.equal(p1006.source_version, 11);

  const p1009 = engine.getProduct('SKU1009');
  assert.equal(p1009.price, 33.5);
  const p1010 = engine.getProduct('SKU1010');
  assert.equal(p1010.price, 49.9);
  // 两个新商品更新时间相同、编号不同
  assert.equal(p1009.updated_at, p1010.updated_at);
  assert.notEqual(p1009.sku, p1010.sku);

  // 未出现在第二批的商品保持原样
  assert.equal(engine.getProduct('SKU1002').source_version, 2);
});

test('暂停 / 继续：页边界挂起，继续后沿用保存的游标跑到完成', async () => {
  const { engine, fetcher } = makeContext();
  const gate = gatedFetcher(engine, fetcher);
  // 让第 2 次拉取挂起：第 1 页一定能写完，第 2 页稳定停在拉取阶段
  gate.blockCall(2);

  const { run } = await engine.start();
  await waitFor(() => engine.getRun(run.id).pages_done === 1);
  engine.requestPause(run.id);
  // 放开挂起的第 2 页：循环拿到数据后在页边界先看到暂停标记，不写第 2 页
  gate.release();
  const paused = await waitForStatus(engine, run.id, 'paused');
  assert.equal(paused.pages_done, 1);
  assert.notEqual(paused.next_cursor, null);
  // 暂停期间库里商品数 == 已完成页写入的数量，没有半成品页
  assert.equal(engine.listProducts().length, 3);

  // 继续：沿用保存的游标，剩下两页正常拉取直到完成
  const { run: resumed } = await engine.resume(run.id);
  assert.equal(resumed.status, 'running');
  const done = await waitForStatus(engine, run.id, 'done');
  assert.equal(done.pages_done, 3);
  assert.equal(done.inserted_count, 8);
  assert.equal(engine.listProducts().length, 8);
});

test('提交前崩溃：页数据和游标一起回滚，重试同一页不产生重复', async () => {
  const { engine } = makeContext();
  let crashed = false;
  engine.hooks.beforeCommit = () => {
    // 只在第一页提交前炸一次，之后正常提交
    if (!crashed) {
      crashed = true;
      throw new Error('模拟进程在 COMMIT 前崩溃');
    }
  };

  const { run } = await engine.start();
  const failed = await waitForStatus(engine, run.id, 'failed');
  assert.match(failed.error, /模拟进程在 COMMIT 前崩溃/);
  // 首页事务整体回滚：页数、游标、商品全部停在起点
  assert.equal(failed.pages_done, 0);
  assert.equal(failed.next_cursor, null);
  assert.equal(engine.listProducts().length, 0);

  // 去掉崩溃钩子，从失败任务保存的游标（空 = 第一页）重试
  engine.hooks = {};
  const { run: resumed } = await engine.resume(run.id);
  assert.equal(resumed.status, 'running');
  const done = await waitForStatus(engine, run.id, 'done');
  // 首页重新完整写入：没有重复，也没有被误判成跳过
  assert.equal(done.inserted_count, 8);
  assert.equal(done.updated_count, 0);
  assert.equal(done.skipped_count, 0);
  assert.equal(engine.listProducts().length, 8);
});

test('服务重启：未完成的 running 任务兜底转 paused，恢复后从记录的页继续', async () => {
  const { db, engine } = makeContext();

  // 第一轮全量正常跑完
  const { run: first } = await engine.start();
  await waitForStatus(engine, first.id, 'done');
  publishNext(db);

  // 第二轮增量：让第 2 次拉取挂起，循环停在第一页之后，拿到一个真实的"半程"游标
  const gate = gatedFetcher(engine, makeFetcher(db));
  gate.blockCall(2);
  const { run: second } = await engine.start();
  await waitFor(() => gate.blocked);
  const half = engine.getRun(second.id);
  assert.equal(half.pages_done, 1);
  assert.notEqual(half.next_cursor, null);
  const savedCursor = half.next_cursor;

  // 模拟进程被 kill：循环卡在第二页拉取上，DB 里任务状态仍是 running
  db.prepare("UPDATE sync_runs SET status = 'running' WHERE id = ?").run(second.id);

  // 新进程启动时的兜底逻辑：running -> paused，页数和游标原样保留
  engine.recoverInterrupted();
  const recovered = engine.getRun(second.id);
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.pages_done, 1);
  assert.equal(recovered.next_cursor, savedCursor);

  // 放开挂起的拉取（其结果会被新循环取代，旧循环通过 loopToken 自行退出），
  // 再从记录的游标继续，跑到完成；计数仍是这一轮的实际写入结果
  gate.release();
  await engine.resume(second.id);
  const done = await waitForStatus(engine, second.id, 'done');
  assert.equal(done.fetched_rows, 5);
  assert.equal(done.inserted_count, 2);
  assert.equal(done.updated_count, 3);
  assert.equal(engine.listProducts().length, 10);
});

test('增量接口本身带水位线：since_version 之后才返回数据', () => {
  const { db } = makeContext();
  const page = queryChanges(db, 5, null, 100);
  assert.deepEqual(page.items.map((i) => i.sku), ['SKU1006', 'SKU1007', 'SKU1008']);
  assert.equal(page.nextCursor, null);
});
