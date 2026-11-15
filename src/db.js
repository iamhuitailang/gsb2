import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 打开并初始化数据库。
 * @param {string} path SQLite 文件路径，':memory:' 为内存库（测试用）
 */
export function openDb(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  // WAL 让并发读取者不阻塞写；写入本身由 BEGIN IMMEDIATE 串行化
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id            TEXT PRIMARY KEY,              -- 卡号
  balance_cents INTEGER NOT NULL DEFAULT 0,    -- 当前余额（分）
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 全部流水（含暂存、被拒绝），只追加不删除
CREATE TABLE IF NOT EXISTS transactions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id            TEXT NOT NULL,
  register_id        TEXT NOT NULL,            -- 收银点
  seq                TEXT NOT NULL,            -- 该收银点下的流水号
  type               TEXT NOT NULL,            -- recharge | purchase | refund
  amount_cents       INTEGER NOT NULL,
  status             TEXT NOT NULL,            -- posted | pending | rejected
  reason_code        TEXT,                     -- pending/rejected 时的原因码
  reason_detail      TEXT,
  linked_ref_register TEXT,                    -- 退款：原消费收银点
  linked_ref_seq      TEXT,                    -- 退款：原消费流水号
  linked_tx_id        INTEGER,                 -- 退款命中的原消费流水 id
  balance_after_cents INTEGER,                 -- 入账后该卡余额快照；未入账为 NULL
  refunded_cents      INTEGER NOT NULL DEFAULT 0, -- 该笔消费已退累计（仅 purchase 有意义）
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  posted_at           TEXT,
  UNIQUE (register_id, seq),                   -- 按收银点 + 流水号去重
  FOREIGN KEY (card_id) REFERENCES cards(id)
);

-- 暂存退款按"原消费定位键 + 到达顺序"取 FIFO
CREATE INDEX IF NOT EXISTS idx_tx_pending
  ON transactions(linked_ref_register, linked_ref_seq, id)
  WHERE status = 'pending';
-- 对账页按卡查询 / 状态筛选
CREATE INDEX IF NOT EXISTS idx_tx_card ON transactions(card_id);
`;
