// 批次接收、预览、发布、库存查询的业务逻辑。
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, now } from './db.js';
import { parseInventoryCsv, CsvValidationError } from './csv.js';

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(countDate) {
  if (!DATE_RE.test(countDate) || Number.isNaN(Date.parse(countDate))) {
    throw new HttpError(400, '盘点日期格式应为 YYYY-MM-DD');
  }
}

// ---------------- 仓库与批次 ----------------

export function listWarehouses() {
  return getDb()
    .prepare('SELECT code, name FROM warehouses ORDER BY rowid')
    .all();
}

export function listBatches() {
  const db = getDb();
  const batches = db
    .prepare('SELECT * FROM batches ORDER BY count_date DESC, id DESC')
    .all();
  return batches.map((b) => summarizeBatch(b));
}

// 打开某天的批次；不存在则用当前仓库主数据建立“应到名单”
export function getOrCreateBatch(countDate) {
  assertDate(countDate);
  const db = getDb();
  let batch = db.prepare('SELECT * FROM batches WHERE count_date = ?').get(countDate);
  if (batch) return summarizeBatch(batch);

  const txn = db.exec.bind(db);
  db.exec('BEGIN');
  try {
    const info = db
      .prepare('INSERT INTO batches (count_date, status, created_at) VALUES (?, ?, ?)')
      .run(countDate, 'collecting', now());
    const batchId = Number(info.lastInsertRowid);
    const warehouses = db.prepare('SELECT code, name FROM warehouses ORDER BY rowid').all();
    const ins = db.prepare(
      'INSERT INTO batch_warehouses (batch_id, wh_code, wh_name, sort_order) VALUES (?, ?, ?, ?)'
    );
    warehouses.forEach((w, idx) => ins.run(batchId, w.code, w.name, idx));
    db.exec('COMMIT');
    batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return summarizeBatch(batch);
}

export function getBatchDetail(batchId) {
  const db = getDb();
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  if (!batch) throw new HttpError(404, `批次 #${batchId} 不存在`);
  return summarizeBatch(batch);
}

// 批次详情：应到仓库 + 交表状态（missing=未交表，submitted=已交，含零行表）
function summarizeBatch(batch) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT bw.wh_code AS whCode, bw.wh_name AS whName, bw.sort_order AS sortOrder,
              s.version, s.original_name AS originalName, s.stored_path AS storedPath,
              s.item_count AS itemCount, s.total_quantity AS totalQuantity,
              s.is_empty AS isEmpty, s.received_at AS receivedAt
         FROM batch_warehouses bw
         LEFT JOIN submissions s ON s.batch_id = bw.batch_id AND s.wh_code = bw.wh_code
        WHERE bw.batch_id = ?
        ORDER BY bw.sort_order`
    )
    .all(batch.id);

  const warehouses = rows.map((r) => ({
    whCode: r.whCode,
    whName: r.whName,
    sortOrder: r.sortOrder,
    status: r.version == null ? 'missing' : 'submitted',
    version: r.version ?? 0,
    originalName: r.originalName ?? null,
    itemCount: r.itemCount ?? 0,
    totalQuantity: r.totalQuantity ?? 0,
    isEmpty: Boolean(r.isEmpty),
    receivedAt: r.receivedAt ?? null,
  }));

  const submitted = warehouses.filter((w) => w.status === 'submitted');
  return {
    batch: {
      id: batch.id,
      countDate: batch.count_date,
      status: batch.status,
      createdAt: batch.created_at,
      publishedAt: batch.published_at ?? null,
    },
    expectedCount: warehouses.length,
    submittedCount: submitted.length,
    allSubmitted: warehouses.length > 0 && submitted.length === warehouses.length,
    warehouses,
  };
}

// ---------------- 接收文件 ----------------

// 接收（或重交）某仓库的盘点表。
// 重交只影响该仓库这张草稿：删旧草稿、换新文件、version+1，其它仓库不动。
export function submitUpload(batchId, whCode, originalName, buffer, uploadRoot) {
  const db = getDb();
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  if (!batch) throw new HttpError(404, `批次 #${batchId} 不存在`);
  const wh = db
    .prepare('SELECT * FROM batch_warehouses WHERE batch_id = ? AND wh_code = ?')
    .get(batchId, whCode);
  if (!wh) throw new HttpError(404, `仓库 ${whCode} 不在该批次的应到名单中`);
  if (batch.status !== 'collecting') {
    throw new HttpError(409, `批次 ${batch.count_date} 已发布，不能再补交或替换文件`);
  }

  let parsed;
  try {
    parsed = parseInventoryCsv(buffer.toString('utf8'));
  } catch (err) {
    if (err instanceof CsvValidationError) throw new HttpError(400, err.message);
    throw err;
  }

  const existing = db
    .prepare('SELECT * FROM submissions WHERE batch_id = ? AND wh_code = ?')
    .get(batchId, whCode);
  const version = existing ? existing.version + 1 : 1;

  // 先把新文件落盘（唯一文件名），DB 事务成功后再清理旧文件
  const dir = join(uploadRoot, `batch-${batchId}`);
  mkdirSync(dir, { recursive: true });
  const storedPath = join(dir, `${whCode}-v${version}.csv`);
  writeFileSync(storedPath, buffer);

  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM draft_items WHERE batch_id = ? AND wh_code = ?')
      .run(batchId, whCode);
    const insDraft = db.prepare(
      'INSERT INTO draft_items (batch_id, wh_code, sku, product_name, quantity) VALUES (?, ?, ?, ?, ?)'
    );
    for (const it of parsed.items) {
      insDraft.run(batchId, whCode, it.sku, it.productName, it.quantity);
    }
    if (existing) {
      db.prepare(
        `UPDATE submissions SET version = ?, original_name = ?, stored_path = ?,
            item_count = ?, total_quantity = ?, is_empty = ?, received_at = ?
          WHERE batch_id = ? AND wh_code = ?`
      ).run(
        version,
        originalName,
        storedPath,
        parsed.itemCount,
        parsed.totalQuantity,
        parsed.isEmpty ? 1 : 0,
        now(),
        batchId,
        whCode
      );
    } else {
      db.prepare(
        `INSERT INTO submissions (batch_id, wh_code, version, original_name, stored_path,
            item_count, total_quantity, is_empty, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        batchId,
        whCode,
        version,
        originalName,
        storedPath,
        parsed.itemCount,
        parsed.totalQuantity,
        parsed.isEmpty ? 1 : 0,
        now()
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    if (existsSync(storedPath)) unlinkSync(storedPath);
    throw err;
  }

  if (existing && existsSync(existing.stored_path)) {
    unlinkSync(existing.stored_path); // 旧草稿文件已无引用
  }
  return summarizeBatch(batch);
}

// ---------------- 预览 / 发布 ----------------

// 发布前预览：各仓统计 + 全量草稿明细 + 合计
export function previewBatch(batchId) {
  const db = getDb();
  const detail = getBatchDetail(batchId);
  const items = db
    .prepare(
      `SELECT wh_code AS whCode, sku, product_name AS productName, quantity
         FROM draft_items WHERE batch_id = ?
        ORDER BY wh_code, sku`
    )
    .all(batchId);
  const totals = detail.warehouses.reduce(
    (acc, w) => {
      acc.itemCount += w.itemCount;
      acc.totalQuantity += w.totalQuantity;
      return acc;
    },
    { itemCount: 0, totalQuantity: 0 }
  );
  return { ...detail, previewItems: items, totals };
}

// 手动发布：一个事务里把草稿快照进 inventory_items 并翻转批次状态。
// 库存查询永远只认最新 published 批次，因此不可能混用两个日期的数据。
export function publishBatch(batchId) {
  const db = getDb();
  const detail = getBatchDetail(batchId);
  if (detail.batch.status === 'published') {
    throw new HttpError(409, `批次 ${detail.batch.countDate} 已经发布过了`);
  }
  const missing = detail.warehouses.filter((w) => w.status === 'missing').map((w) => w.whCode);
  if (missing.length > 0) {
    throw new HttpError(409, `还有 ${missing.length} 个仓库未交表：${missing.join('、')}，不能发布`);
  }

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO inventory_items (batch_id, wh_code, sku, product_name, quantity)
       SELECT batch_id, wh_code, sku, product_name, quantity FROM draft_items WHERE batch_id = ?`
    ).run(batchId);
    db.prepare("UPDATE batches SET status = 'published', published_at = ? WHERE id = ?")
      .run(now(), batchId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getBatchDetail(batchId);
}

// ---------------- 发布后审计：原始文件 ----------------

export function getSubmissionFile(batchId, whCode) {
  const db = getDb();
  const s = db
    .prepare('SELECT * FROM submissions WHERE batch_id = ? AND wh_code = ?')
    .get(batchId, whCode);
  if (!s) throw new HttpError(404, '该仓库在这个批次没有交表记录');
  if (!existsSync(s.stored_path)) throw new HttpError(410, '原始文件已不在服务器上');
  return { storedPath: s.stored_path, originalName: s.original_name };
}

// ---------------- 库存查询（只看已发布数据） ----------------

export function latestPublishedBatch() {
  return getDb()
    .prepare("SELECT * FROM batches WHERE status = 'published' ORDER BY count_date DESC, id DESC LIMIT 1")
    .get();
}

export function queryInventory({ q = '', whCode = '' } = {}) {
  const db = getDb();
  const current = latestPublishedBatch();
  if (!current) {
    return { currentBatch: null, items: [], totalRows: 0 };
  }
  const where = ['batch_id = ?'];
  const params = [current.id];
  if (whCode) {
    where.push('wh_code = ?');
    params.push(whCode);
  }
  if (q) {
    where.push('(sku LIKE ? OR product_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const rows = db
    .prepare(
      `SELECT wh_code AS whCode, sku, product_name AS productName, quantity
         FROM inventory_items WHERE ${where.join(' AND ')}
        ORDER BY wh_code, sku LIMIT 1000`
    )
    .all(...params);
  return {
    currentBatch: {
      id: current.id,
      countDate: current.count_date,
      publishedAt: current.published_at,
    },
    items: rows,
    totalRows: rows.length,
  };
}
