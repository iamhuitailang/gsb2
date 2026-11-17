'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('../lib/password');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'app.db');
const dbPath = process.env.APP_DB_PATH || DEFAULT_DB_PATH;

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  display_name TEXT NOT NULL,
  address TEXT NOT NULL,
  delivery_note TEXT NOT NULL DEFAULT '',
  credit_level TEXT NOT NULL DEFAULT 'B',
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'supervisor')),
  password_hash TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  store_id INTEGER REFERENCES stores(id)
);

-- 审计表刻意不保存地址原文：address 的旧值/新值在写入前就被掩码
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  actor_id INTEGER,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  customer_id INTEGER,
  action TEXT NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  result TEXT NOT NULL,
  detail TEXT
);
`);

// 幂等播种：已有用户数据则跳过，保证重启不重置演示数据
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (count.n > 0) return;

  const insertStore = db.prepare('INSERT INTO stores (id, name) VALUES (?, ?)');
  insertStore.run(1, '甲店');
  insertStore.run(2, '乙店');

  const insertCustomer = db.prepare(`
    INSERT INTO customers (id, store_id, display_name, address, delivery_note, credit_level, disabled)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `);
  insertCustomer.run(1, 1, '王小明', '甲市甲区甲路 1 号', '工作日白天签收', 'B');
  insertCustomer.run(2, 2, '李小华', '乙市乙区乙路 2 号', '放前台即可', 'B');

  const insertUser = db.prepare(`
    INSERT INTO users (id, username, display_name, role, password_hash, customer_id, store_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const pw = hashPassword('demo1234');
  // 两个客户
  insertUser.run(1, 'cust_jia', '王小明', 'customer', pw, 1, null);
  insertUser.run(2, 'cust_yi', '李小华', 'customer', pw, 2, null);
  // 两名不同门店的主管
  insertUser.run(3, 'mgr_jia', '甲店主管', 'supervisor', pw, null, 1);
  insertUser.run(4, 'mgr_yi', '乙店主管', 'supervisor', pw, null, 2);
}

seed();

module.exports = db;
