// 数据库层：表结构、连接与样例数据初始化。
// 仅保存演示用样例数据；resetDatabase 可随时恢复初始状态。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const INSTRUCTION_STATUS = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL', // 待复核
  PENDING_EXECUTION: 'PENDING_EXECUTION', // 待执行
});

export const REQUIRED_APPROVALS = 2;

// 固定的三位演示用户：甲=提交人，乙/丙=复核人
export const SEED_USERS = Object.freeze([
  { id: 'u_jia', name: '甲', role: 'SUBMITTER' },
  { id: 'u_yi', name: '乙', role: 'REVIEWER' },
  { id: 'u_bing', name: '丙', role: 'REVIEWER' },
]);

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('SUBMITTER', 'REVIEWER'))
);

-- 付款指令主表：current_version 指向当前生效版本
CREATE TABLE IF NOT EXISTS instructions (
  id               TEXT PRIMARY KEY,
  instruction_no   TEXT NOT NULL UNIQUE,
  submitter_id     TEXT NOT NULL REFERENCES users(id),
  current_version  INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                     CHECK (status IN ('PENDING_APPROVAL', 'PENDING_EXECUTION')),
  created_at       TEXT NOT NULL
);

-- 指令版本表：收款方/金额每次修改产生一条新版本
CREATE TABLE IF NOT EXISTS instruction_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  instruction_id  TEXT NOT NULL REFERENCES instructions(id),
  version         INTEGER NOT NULL,
  payee           TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  change_summary  TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  UNIQUE (instruction_id, version)
);

-- 复核记录表：唯一约束保证同一复核人对同一版本只算一次
CREATE TABLE IF NOT EXISTS approvals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  instruction_id  TEXT NOT NULL REFERENCES instructions(id),
  version         INTEGER NOT NULL,
  reviewer_id     TEXT NOT NULL REFERENCES users(id),
  decision        TEXT NOT NULL CHECK (decision = 'APPROVED'),
  created_at      TEXT NOT NULL,
  UNIQUE (instruction_id, version, reviewer_id)
);

-- 审计事件表：所有成功操作与被拒绝的尝试都留痕
CREATE TABLE IF NOT EXISTS audit_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  instruction_id  TEXT NOT NULL REFERENCES instructions(id),
  version         INTEGER,
  actor_id        TEXT REFERENCES users(id),
  action          TEXT NOT NULL CHECK (action IN (
                    'CREATED', 'UPDATED', 'APPROVED',
                    'APPROVAL_REJECTED', 'ENTERED_PENDING_EXECUTION')),
  detail          TEXT,
  created_at      TEXT NOT NULL
);
`;

export function openDatabase(filePath) {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec(SCHEMA);
  // 并发事务抢锁时等待而不是立刻报 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

function seedUsers(db) {
  const stmt = db.prepare('INSERT OR IGNORE INTO users (id, name, role) VALUES (?, ?, ?)');
  for (const u of SEED_USERS) stmt.run(u.id, u.name, u.role);
}

// 样例指令：甲提交、收款方「华东供应商有限公司」、初始金额 120.00 元
function seedInstruction(db) {
  const existing = db.prepare('SELECT id FROM instructions LIMIT 1').get();
  if (existing) return;

  const ts = nowIso();
  const id = 'pi_demo_001';
  db.prepare(`
    INSERT INTO instructions (id, instruction_no, submitter_id, current_version, status, created_at)
    VALUES (?, ?, ?, 1, 'PENDING_APPROVAL', ?)
  `).run(id, 'PI-20261117-0001', 'u_jia', ts);

  db.prepare(`
    INSERT INTO instruction_versions
      (instruction_id, version, payee, amount_cents, change_summary, created_by, created_at)
    VALUES (?, 1, ?, ?, ?, ?, ?)
  `).run(id, '华东供应商有限公司', 12000, '初始提交', 'u_jia', ts);

  db.prepare(`
    INSERT INTO audit_events (instruction_id, version, actor_id, action, detail, created_at)
    VALUES (?, 1, ?, 'CREATED', ?, ?)
  `).run(id, 'u_jia', '甲 创建付款指令，金额 120.00 元，收款方：华东供应商有限公司', ts);
}

export function resetDatabase(db) {
  db.exec(`
    DELETE FROM audit_events;
    DELETE FROM approvals;
    DELETE FROM instruction_versions;
    DELETE FROM instructions;
    DELETE FROM users;
  `);
  seedUsers(db);
  seedInstruction(db);
}

export function initDatabase(db) {
  seedUsers(db);
  seedInstruction(db);
}
