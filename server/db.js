// SQLite 连接与建表。使用 Node 24 内置的 node:sqlite，零外部依赖。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db;

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function getDb() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 openDb()');
  return db;
}

// 当前时间（本地 ISO 字符串，仅用于展示与审计）
export function now() {
  return new Date().toISOString();
}

const SCHEMA = `
-- 仓库主数据：决定每个盘点批次“应到”的仓库名单
CREATE TABLE IF NOT EXISTS warehouses (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 盘点批次，按盘点日期唯一
CREATE TABLE IF NOT EXISTS batches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  count_date   TEXT NOT NULL UNIQUE,          -- 盘点日期 YYYY-MM-DD
  status       TEXT NOT NULL DEFAULT 'collecting', -- collecting | published
  created_at   TEXT NOT NULL,
  published_at TEXT
);

-- 批次应到仓库（建批次时从 warehouses 快照复制）
CREATE TABLE IF NOT EXISTS batch_warehouses (
  batch_id    INTEGER NOT NULL REFERENCES batches(id),
  wh_code     TEXT NOT NULL,
  wh_name     TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  PRIMARY KEY (batch_id, wh_code)
);

-- 各仓库交表记录（一个仓库在同一批次里同时只保留一条；重交是覆盖 + version+1）
CREATE TABLE IF NOT EXISTS submissions (
  batch_id        INTEGER NOT NULL REFERENCES batches(id),
  wh_code         TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  original_name   TEXT NOT NULL,              -- 上传时的原始文件名
  stored_path     TEXT NOT NULL,              -- 服务端落盘路径（发布后仍可下载）
  item_count      INTEGER NOT NULL,           -- 商品数（数据行数）
  total_quantity  INTEGER NOT NULL,           -- 库存数量合计
  is_empty        INTEGER NOT NULL DEFAULT 0, -- 是否零行表（只有表头）
  received_at     TEXT NOT NULL,
  PRIMARY KEY (batch_id, wh_code)
);

-- 草稿明细：收到文件即解析入库，发布前预览和重交都基于它
CREATE TABLE IF NOT EXISTS draft_items (
  batch_id    INTEGER NOT NULL REFERENCES batches(id),
  wh_code     TEXT NOT NULL,
  sku         TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity    INTEGER NOT NULL,
  PRIMARY KEY (batch_id, wh_code, sku)
);

-- 已发布库存快照：库存查询只从这里读，batch_id 锁定同一批
CREATE TABLE IF NOT EXISTS inventory_items (
  batch_id     INTEGER NOT NULL REFERENCES batches(id),
  wh_code      TEXT NOT NULL,
  sku          TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity     INTEGER NOT NULL,
  PRIMARY KEY (batch_id, wh_code, sku)
);

CREATE INDEX IF NOT EXISTS idx_inventory_lookup
  ON inventory_items (sku, batch_id);
CREATE INDEX IF NOT EXISTS idx_draft_batch
  ON draft_items (batch_id, wh_code);
`;
