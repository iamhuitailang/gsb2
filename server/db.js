// SQLite 连接与建表。使用 Node 内置 node:sqlite，零外部依赖。
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
-- 活动主数据：从每条接受的点击 upsert，用于报表“零单活动也出一行”的补零
CREATE TABLE IF NOT EXISTS campaigns (
  campaign_id   TEXT PRIMARY KEY,
  campaign_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);

-- 点击流（只追加；PRIMARY KEY 承担 click_id 幂等）
CREATE TABLE IF NOT EXISTS clicks (
  click_id      TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  campaign_id   TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  click_time_ms INTEGER NOT NULL,          -- 毫秒，本地时区解析结果
  received_at   TEXT NOT NULL              -- 接收时刻，审计/理由文案用
);
CREATE INDEX IF NOT EXISTS idx_clicks_account_time
  ON clicks (account_id, click_time_ms);

-- 订单 = 付款事实 + 当前归因 + 整单退款标记（直接成交用 NULL 活动表示）
CREATE TABLE IF NOT EXISTS orders (
  order_id               TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL,
  payment_time_ms        INTEGER NOT NULL,
  pay_date               TEXT NOT NULL,     -- 'YYYY-MM-DD' 入库时固化，报表按它分组
  current_click_id       TEXT REFERENCES clicks(click_id),
  current_campaign_id    TEXT,              -- NULL = 直接成交
  current_campaign_name  TEXT,
  refund_id              TEXT,
  refund_time_ms         INTEGER,
  refunded_at            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_paydate ON orders (pay_date);
CREATE INDEX IF NOT EXISTS idx_orders_campaign ON orders (current_campaign_id, pay_date);
CREATE INDEX IF NOT EXISTS idx_orders_account ON orders (account_id, payment_time_ms);

-- 追加式归因历史（只增不改不删）
CREATE TABLE IF NOT EXISTS attribution_history (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id           TEXT NOT NULL REFERENCES orders(order_id),
  seq                INTEGER NOT NULL,      -- 订单内自增序号
  change_type        TEXT NOT NULL,         -- 'initial' | 'reattribute'
  old_click_id       TEXT,
  old_campaign_id    TEXT,
  old_campaign_name  TEXT,
  new_click_id       TEXT,
  new_campaign_id    TEXT,                  -- NULL 表示直接成交
  new_campaign_name  TEXT,
  reason             TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_order ON attribution_history (order_id, seq);

-- 退款事件（双 UNIQUE：同退款单只处理一次，每单至多一次整单退款）
CREATE TABLE IF NOT EXISTS refunds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id      TEXT NOT NULL UNIQUE,
  order_id       TEXT NOT NULL UNIQUE REFERENCES orders(order_id),
  refund_time_ms INTEGER NOT NULL,
  received_at    TEXT NOT NULL
);

-- 上传批次与计数回执
CREATE TABLE IF NOT EXISTS ingest_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type   TEXT NOT NULL,              -- 'click' | 'payment' | 'refund'
  original_name TEXT NOT NULL,
  total_rows    INTEGER NOT NULL,
  accepted      INTEGER NOT NULL,
  duplicate     INTEGER NOT NULL,
  error_rows    INTEGER NOT NULL,
  errors        TEXT NOT NULL,              -- JSON 数组，最多 10 条
  created_at    TEXT NOT NULL
);
`;
