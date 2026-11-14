import { BATCHES } from './seed-data.js';
import { getKv, setKv } from './db.js';

/**
 * 模拟供应商接口侧逻辑。
 *
 * 对外只提供一种查询：按来源版本号取变更 + keyset 游标分页。
 * - sinceVersion=0 且游标为空 => 从头取全量
 * - sinceVersion=N            => 只返回 version > N 的变更（增量）
 *
 * 排序固定为 (version ASC, sku ASC)，游标就是上一页最后一条的 (version, sku)，
 * 因此翻页过程中即使供应商又发布了新数据，当前这一轮的遍历顺序也不会错乱。
 */

const BATCH_POINTER_KEY = 'supplier_batch_pointer'; // 已发布到第几批（0-based）
export const PAGE_SIZE_DEFAULT = 3;

export function encodeCursor(version, sku) {
  return Buffer.from(JSON.stringify({ v: version, s: sku })).toString('base64url');
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof obj.v !== 'number' || typeof obj.s !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}

/** 首次启动时自动发布第一批 */
export function ensureInitialized(db) {
  const pointer = getKv(db, BATCH_POINTER_KEY, -1);
  if (pointer === -1) publishBatch(db, 0);
}

/** 发布下一批；没有更多批次时返回 null */
export function publishNext(db) {
  const pointer = getKv(db, BATCH_POINTER_KEY, -1);
  const next = pointer + 1;
  if (next >= BATCHES.length) return null;
  return publishBatch(db, next);
}

function publishBatch(db, index) {
  const batch = BATCHES[index];
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO supplier_products(sku, name, price, version, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sku) DO UPDATE SET
       name = excluded.name,
       price = excluded.price,
       version = excluded.version,
       updated_at = excluded.updated_at`
  );
  const tx = db.exec.bind(db);
  db.exec('BEGIN');
  try {
    for (const p of batch.products) upsert.run(p.sku, p.name, p.price, p.version, p.updated_at);
    const row = db
      .prepare(
        `INSERT INTO supplier_batches(batch_no, published_at, change_count, note)
         VALUES (?, ?, ?, ?)
         RETURNING batch_no, published_at, change_count, note`
      )
      .get(index + 1, now, batch.products.length, batch.note);
    setKv(db, BATCH_POINTER_KEY, index);
    db.exec('COMMIT');
    return row;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getStatus(db) {
  const pointer = getKv(db, BATCH_POINTER_KEY, -1);
  const total = db.prepare('SELECT count(*) c FROM supplier_products').get().c;
  const maxVersion = db.prepare('SELECT COALESCE(max(version), 0) v FROM supplier_products').get().v;
  const batches = db
    .prepare('SELECT batch_no, published_at, change_count, note FROM supplier_batches ORDER BY batch_no')
    .all();
  return {
    publishedBatches: pointer + 1,
    totalBatches: BATCHES.length,
    hasNextBatch: pointer + 1 < BATCHES.length,
    productCount: total,
    maxVersion,
    batches,
  };
}

/**
 * 游标分页查询变更。
 * @returns {{items: object[], nextCursor: string|null, hasMore: boolean}}
 */
export function queryChanges(db, sinceVersion, cursor, limit = PAGE_SIZE_DEFAULT) {
  const since = Number.isInteger(sinceVersion) && sinceVersion >= 0 ? sinceVersion : 0;
  const lim = Math.min(Math.max(Number(limit) || PAGE_SIZE_DEFAULT, 1), 100);
  const key = decodeCursor(cursor);

  const where = ['version > ?'];
  const params = [since];
  if (key) {
    where.push('(version > ? OR (version = ? AND sku > ?))');
    params.push(key.v, key.v, key.s);
  }
  const rows = db
    .prepare(
      `SELECT sku, name, price, version, updated_at
       FROM supplier_products
       WHERE ${where.join(' AND ')}
       ORDER BY version ASC, sku ASC
       LIMIT ?`
    )
    .all(...params, lim + 1);

  const hasMore = rows.length > lim;
  const items = hasMore ? rows.slice(0, lim) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.version, last.sku) : null;
  return { items, nextCursor, hasMore };
}
