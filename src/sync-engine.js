import { getKv, setKv } from './db.js';
import { PAGE_SIZE_DEFAULT } from './supplier.js';

const LAST_VERSION_KEY = 'last_synced_version';
const ACTIVE_STATUSES = ['running', 'paused'];

/**
 * 同步引擎。
 *
 * 关键保证：
 * 1. 一页的商品写入和游标推进在同一个事务里提交 —— 事务不落盘，游标不动；
 *    进程在提交前崩溃，本页数据和游标都回滚，重启后从这一页重新拉。
 * 2. sku 是唯一键：同页重复拉取靠"先查后判版本号"分支处理，不会产生第二条商品。
 * 3. 版本守卫：只有 source_version < 接口版本号才更新，旧版本不能覆盖新价格。
 * 4. 暂停只在页边界生效：正在写的页一定写完，下一页开始前才挂起。
 */
export class SyncEngine {
  constructor(db, opts = {}) {
    this.db = db;
    this.baseUrl = opts.baseUrl ?? 'http://127.0.0.1:3000';
    this.pageSize = opts.pageSize ?? PAGE_SIZE_DEFAULT;
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.hooks = opts.hooks ?? {};
    // 每个引擎实例独立的循环代号：resume 启动新循环时旧循环自动失效
    this.loopToken = 0;
  }

  /** 进程启动时兜底：上次没跑完（进程被 kill）的任务转成 paused，等用户手动继续 */
  recoverInterrupted() {
    this.db
      .prepare(`UPDATE sync_runs SET status = 'paused', updated_at = ? WHERE status = 'running'`)
      .run(nowIso());
  }

  getActiveRun() {
    return this.db
      .prepare(`SELECT * FROM sync_runs WHERE status IN (${placeholders(ACTIVE_STATUSES)}) ORDER BY id DESC LIMIT 1`)
      .get(...ACTIVE_STATUSES);
  }

  getRun(runId) {
    return this.db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(runId);
  }

  listRuns(limit = 20) {
    return this.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').all(limit);
  }

  /** 开启新一轮：从未同步过 => 全量；否则以上一轮水位线做增量 */
  async start() {
    if (this.getActiveRun()) throw new Error('已有同步任务在进行中，请先暂停或等待完成');
    const lastVersion = getKv(this.db, LAST_VERSION_KEY, 0);
    const mode = lastVersion === 0 ? 'full' : 'incremental';

    const run = this.db
      .prepare(
        `INSERT INTO sync_runs(mode, status, since_version, next_cursor, started_at, updated_at)
         VALUES (?, 'running', ?, NULL, ?, ?)
         RETURNING *`
      )
      .get(mode, lastVersion, nowIso(), nowIso());

    const promise = this.#runLoop(run.id);
    // 等循环真正启动（进入第一次拉取前）再返回，调用方此时设置暂停标记一定能被看到
    await tick();
    return { run, promise };
  }

  /** 继续一个暂停的任务，或重试一个失败的任务；游标沿用任务里保存的 next_cursor */
  async resume(runId) {
    const run = this.mustGet(runId);
    if (run.status !== 'paused' && run.status !== 'failed') {
      throw new Error(`任务 ${runId} 当前状态为 ${run.status}，无法继续`);
    }
    this.db
      .prepare(
        `UPDATE sync_runs
         SET status = 'running', pause_requested = 0, error = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(nowIso(), runId);
    const promise = this.#runLoop(runId);
    await tick();
    return { run: this.getRun(runId), promise };
  }

  /** 请求暂停：当前页写完后、下一页开始前挂起 */
  requestPause(runId) {
    const run = this.mustGet(runId);
    if (run.status !== 'running') throw new Error(`任务 ${runId} 不在运行中`);
    this.db.prepare('UPDATE sync_runs SET pause_requested = 1, updated_at = ? WHERE id = ?').run(nowIso(), runId);
    return this.getRun(runId);
  }

  mustGet(runId) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`同步任务 ${runId} 不存在`);
    return run;
  }

  async #runLoop(runId) {
    const token = ++this.loopToken;
    try {
      while (true) {
        await tick(); // 每轮开头让出事件循环，暂停/停止请求总能在页边界被观察到
        if (token !== this.loopToken) return; // 已被更新的循环取代
        const run = this.getRun(runId);
        if (!run || run.status !== 'running') return;
        if (run.pause_requested === 1) {
          this.db
            .prepare(`UPDATE sync_runs SET status = 'paused', pause_requested = 0, updated_at = ? WHERE id = ?`)
            .run(nowIso(), runId);
          return;
        }

        const page = await this.fetcher({
          baseUrl: this.baseUrl,
          sinceVersion: run.since_version,
          cursor: run.next_cursor,
          limit: this.pageSize,
        });

        if (token !== this.loopToken) return;
        await this.writePage(runId, page.items, page.nextCursor);

        if (page.nextCursor === null) {
          this.#finish(runId);
          return;
        }
      }
    } catch (err) {
      this.#markFailed(runId, err);
    }
  }

  /**
   * 把一整页写入库，并推进游标。单事务，原子提交。
   * 抽成 public 方法方便测试直接验证"重复拉取 / 旧版本"的写入结果。
   */
  async writePage(runId, items, nextCursor) {
    const run = this.mustGet(runId);
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    const selectProduct = this.db.prepare('SELECT source_version FROM products WHERE sku = ?');
    const insertProduct = this.db.prepare(
      `INSERT INTO products(sku, name, price, source_version, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const updateProduct = this.db.prepare(
      `UPDATE products SET name = ?, price = ?, source_version = ?, updated_at = ?, synced_at = ?
       WHERE sku = ?`
    );

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const syncedAt = nowIso();
      for (const item of items) {
        const existing = selectProduct.get(item.sku);
        if (!existing) {
          // 唯一键保证并发下也只会有一条；这里走的是真正的新增
          insertProduct.run(item.sku, item.name, item.price, item.version, item.updated_at, syncedAt);
          inserted += 1;
        } else if (existing.source_version >= item.version) {
          // 同一页重复拉、或接口重放旧版本：原封不动，跳过
          skipped += 1;
        } else {
          // 只有更新的来源版本才能覆盖本地（含改价、改名）
          updateProduct.run(item.name, item.price, item.version, item.updated_at, syncedAt, item.sku);
          updated += 1;
        }
      }

      if (this.hooks.beforeCommit) {
        // 测试钩子：在提交前制造崩溃，验证数据和游标一起回滚
        this.hooks.beforeCommit({ runId, items, nextCursor, pagesDone: run.pages_done });
      }

      // 页数据写完之后，才在同一事务里保存游标和实际写入计数
      this.db
        .prepare(
          `UPDATE sync_runs
           SET next_cursor = ?,
               pages_done = pages_done + 1,
               fetched_rows = fetched_rows + ?,
               inserted_count = inserted_count + ?,
               updated_count = updated_count + ?,
               skipped_count = skipped_count + ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          nextCursor,
          items.length,
          inserted,
          updated,
          skipped,
          syncedAt,
          runId
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { inserted, updated, skipped };
  }

  #finish(runId) {
    const maxVersion = this.db.prepare('SELECT COALESCE(max(source_version), 0) v FROM products').get().v;
    this.db
      .prepare(
        `UPDATE sync_runs
         SET status = 'done', finished_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(nowIso(), nowIso(), runId);
    setKv(this.db, LAST_VERSION_KEY, maxVersion);
  }

  #markFailed(runId, err) {
    this.db
      .prepare(
        `UPDATE sync_runs
         SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`
      )
      .run(String(err?.message ?? err), nowIso(), nowIso(), runId);
  }

  // ---- 同步台查询 ----

  listProducts(keyword = '') {
    const kw = keyword.trim();
    if (!kw) {
      return this.db
        .prepare(
          `SELECT sku, name, price, source_version, updated_at, synced_at
           FROM products ORDER BY sku ASC`
        )
        .all();
    }
    const like = `%${kw}%`;
    return this.db
      .prepare(
        `SELECT sku, name, price, source_version, updated_at, synced_at
         FROM products
         WHERE sku LIKE ? OR name LIKE ?
         ORDER BY sku ASC`
      )
      .all(like, like);
  }

  getProduct(sku) {
    return this.db
      .prepare('SELECT sku, name, price, source_version, updated_at, synced_at FROM products WHERE sku = ?')
      .get(sku);
  }

  catalogStats() {
    const row = this.db
      .prepare(
        `SELECT count(*) AS product_count,
                COALESCE(max(source_version), 0) AS last_synced_version
         FROM products`
      )
      .get();
    return { ...row, lastSyncedVersion: getKv(this.db, LAST_VERSION_KEY, 0) };
  }
}

async function defaultFetcher({ baseUrl, sinceVersion, cursor, limit }) {
  const params = new URLSearchParams({ since_version: String(sinceVersion), limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`${baseUrl}/api/supplier/changes?${params}`);
  if (!res.ok) throw new Error(`供应商接口返回 ${res.status}`);
  return res.json();
}

function placeholders(arr) {
  return arr.map(() => '?').join(',');
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function nowIso() {
  return new Date().toISOString();
}
