import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 打开数据库并建表。同一个 db 文件里放两套库表：
 * - supplier_* : 模拟供应商接口侧的数据（由供应商"发布"写入）
 * - products / sync_runs / kv : 采购侧同步台自己的数据
 */
export function openDb(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 供应商侧：已发布的商品目录（供应商的"真相"）
  CREATE TABLE IF NOT EXISTS supplier_products (
    sku        TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    price      REAL NOT NULL,
    version    INTEGER NOT NULL,   -- 该商品当前来源版本号，每次变更递增
    updated_at TEXT NOT NULL       -- ISO 时间；允许多个商品相同
  );

  -- 供应商侧：批次发布记录
  CREATE TABLE IF NOT EXISTS supplier_batches (
    batch_no       INTEGER PRIMARY KEY,
    published_at   TEXT NOT NULL,
    change_count   INTEGER NOT NULL,
    note           TEXT NOT NULL
  );

  -- 采购侧：本地商品目录。sku 唯一键，由同步任务 UPSERT 维护
  CREATE TABLE IF NOT EXISTS products (
    sku             TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    price           REAL NOT NULL,
    source_version  INTEGER NOT NULL,   -- 本地记录的来源版本号
    updated_at      TEXT NOT NULL,      -- 供应商给的变更时间
    synced_at       TEXT NOT NULL       -- 本地写入时间
  );

  -- 采购侧：每一轮同步任务
  CREATE TABLE IF NOT EXISTS sync_runs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    mode               TEXT NOT NULL CHECK (mode IN ('full', 'incremental')),
    status             TEXT NOT NULL CHECK (status IN ('running', 'paused', 'done', 'failed')),
    since_version      INTEGER NOT NULL,          -- 本轮拉取的水位线
    next_cursor        TEXT,                      -- 下一页游标；NULL = 从头一页
    pages_done         INTEGER NOT NULL DEFAULT 0,-- 已完整写完并提交的页数
    fetched_rows       INTEGER NOT NULL DEFAULT 0,-- 接口累计返回行数
    inserted_count     INTEGER NOT NULL DEFAULT 0,-- 实际新增
    updated_count      INTEGER NOT NULL DEFAULT 0,-- 实际改价/改名等更新
    skipped_count      INTEGER NOT NULL DEFAULT 0,-- 旧版本被跳过
    pause_requested    INTEGER NOT NULL DEFAULT 0,
    error              TEXT,
    started_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    finished_at        TEXT
  );
  `);
}

export function getKv(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setKv(db, key, value) {
  db.prepare(
    `INSERT INTO kv(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, JSON.stringify(value));
}
