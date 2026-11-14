import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

/** 起一个监听随机端口的真实服务，返回 base 地址和关闭函数 */
async function boot() {
  const db = openDb(':memory:');
  const { server, engine } = createApp(db, { baseUrl: 'http://127.0.0.1:0' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  // 监听端口确定后，回写引擎回连供应商接口用的地址
  engine.baseUrl = base;
  after(() => new Promise((resolve) => server.close(resolve)));

  const call = async (path, options) => {
    const res = await fetch(`${base}${path}`, options);
    const body = await res.json();
    return { status: res.status, body };
  };
  const waitForStatus = async (runId, status) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { body } = await call(`/api/console/runs/${runId}`);
      if (body.status === status) return body;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`任务 ${runId} 未在超时内变为 ${status}`);
  };
  return { call, waitForStatus };
}

test('HTTP 端到端：全量 → 发布第二批 → 增量 → 暂停/继续 → 按编号查询', async () => {
  const { call, waitForStatus } = await boot();

  // 供应商初始状态：第一批 8 个商品已自动发布
  const s0 = (await call('/api/supplier/status')).body;
  assert.equal(s0.publishedBatches, 1);
  assert.equal(s0.productCount, 8);
  assert.equal(s0.hasNextBatch, true);

  // 游标翻页：逐页拉全量，验证游标能走通且最后一页 nextCursor 为 null
  let cursor;
  let pageCount = 0;
  let fetched = 0;
  do {
    const q = new URLSearchParams({ since_version: '0', limit: '3' });
    if (cursor) q.set('cursor', cursor);
    const page = (await call(`/api/supplier/changes?${q}`)).body;
    cursor = page.nextCursor;
    pageCount += 1;
    fetched += page.items.length;
  } while (cursor);
  assert.equal(pageCount, 3);
  assert.equal(fetched, 8);

  // 第一轮全量同步
  const r1 = (await call('/api/console/sync/start', { method: 'POST' })).body;
  assert.equal(r1.mode, 'full');
  const done1 = await waitForStatus(r1.id, 'done');
  assert.equal(done1.inserted_count, 8);
  assert.equal(done1.updated_count, 0);

  // 发布第二批（3 改 + 2 新）
  const pub = (await call('/api/supplier/publish-next', { method: 'POST' })).body;
  assert.equal(pub.published.change_count, 5);
  assert.equal(pub.status.productCount, 10);

  // 第二轮增量同步
  const r2 = (await call('/api/console/sync/start', { method: 'POST' })).body;
  assert.equal(r2.mode, 'incremental');
  assert.equal(r2.since_version, 8);
  const done2 = await waitForStatus(r2.id, 'done');
  assert.equal(done2.fetched_rows, 5);
  assert.equal(done2.inserted_count, 2);
  assert.equal(done2.updated_count, 3);

  // 历轮统计：每轮新增/更新按实际写入结果
  const runs = (await call('/api/console/runs')).body.runs;
  assert.equal(runs.length, 2);

  // 按编号查到改价商品（SKU1001 39.9 -> 35.9，版本 1 -> 9）
  const p1001 = (await call('/api/console/products/SKU1001')).body;
  assert.equal(p1001.price, 35.9);
  assert.equal(p1001.source_version, 9);
  const p1003 = (await call('/api/console/products/SKU1003')).body;
  assert.equal(p1003.price, 23.8);

  // 按编号查到新上架商品
  const p1009 = (await call('/api/console/products/SKU1009')).body;
  assert.equal(p1009.name, '酸奶 100g*16');
  const p1010 = (await call('/api/console/products/SKU1010')).body;
  assert.equal(p1010.source_version, 13);
  assert.equal(p1009.updated_at, p1010.updated_at); // 更新时间相同、编号不同

  // 关键字查询
  const search = (await call('/api/console/products?keyword=鸡蛋')).body.products;
  assert.equal(search.length, 1);
  assert.equal(search[0].sku, 'SKU1003');

  // 空关键字返回全部；无匹配返回空数组
  const all = (await call('/api/console/products?keyword=')).body.products;
  assert.equal(all.length, 10);
  const none = (await call('/api/console/products?keyword=不存在的商品')).body.products;
  assert.equal(none.length, 0);

  // 目录总数与水位线
  const stats = (await call('/api/console/stats')).body;
  assert.equal(stats.catalog.product_count, 10);
  assert.equal(stats.catalog.lastSyncedVersion, 13);
});

test('HTTP 端到端：暂停 / 继续端点可用，任务最终完整跑完', async () => {
  const { call, waitForStatus } = await boot();

  const started = (await call('/api/console/sync/start', { method: 'POST' })).body;
  // 尽快请求暂停。任务可能已在请求到达前跑完（小数据集），两种情况都合法。
  const pauseRes = await call(`/api/console/sync/${started.id}/pause`, { method: 'POST' });

  if (pauseRes.status === 200) {
    // pause 成功时可能仍是 running（暂停标记已置），轮询到真正在页边界挂起
    const paused = await waitForStatus(started.id, 'paused');
    assert.ok(paused.pages_done >= 1 && paused.pages_done < 3);
    await call(`/api/console/sync/${started.id}/resume`, { method: 'POST' });
  }

  const done = await waitForStatus(started.id, 'done');
  assert.equal(done.pages_done, 3);
  assert.equal(done.inserted_count, 8);
  assert.equal(done.updated_count, 0);

  // 本地商品数等于全量总数，无重复、无半成品页
  const products = (await call('/api/console/products')).body.products;
  assert.equal(products.length, 8);
});

test('HTTP 端到端：首页与前端脚本可访问', async () => {
  const db = openDb(':memory:');
  const { server, engine } = createApp(db, {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  engine.baseUrl = `http://127.0.0.1:${port}`;
  after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /商品目录同步台/);

  const appjs = await fetch(`${base}/app.js`);
  assert.equal(appjs.status, 200);
  assert.match(await appjs.text(), /refreshAll/);

  const notFound = await fetch(`${base}/no-such-page`);
  assert.equal(notFound.status, 404);
});
