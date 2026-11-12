import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.screenshotDir, { recursive: true });

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source_file TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'preview',          -- preview | ready | running | paused | interrupted | completed | failed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL,                          -- CSV 行号（含表头从 2 开始）
  application_no TEXT NOT NULL,                     -- 业务幂等键：申请编号
  payload TEXT NOT NULL,                            -- 明文 JSON，仅存本地
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | running | success | failed | skipped | interrupted
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  mock_ref TEXT,                                    -- 模拟后台返回的受理号
  screenshot TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, application_no)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  record_id INTEGER,
  level TEXT NOT NULL,                              -- info | warn | error
  event TEXT NOT NULL,
  message TEXT NOT NULL,                            -- 写入前已做 PII 遮蔽
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_job ON records(job_id);
CREATE INDEX IF NOT EXISTS idx_logs_job ON logs(job_id);
`);

const now = () => new Date().toISOString();

// ---------- jobs ----------

export function createJob(name, sourceFile, records) {
  const ts = now();
  const insertJob = db.prepare(
    `INSERT INTO jobs (name, source_file, total, status, created_at, updated_at)
     VALUES (?, ?, ?, 'preview', ?, ?)`
  );
  const insertRecord = db.prepare(
    `INSERT INTO records (job_id, row_no, application_no, payload, status, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  );
  return db.transaction((rows) => {
    const job = insertJob.run(name, sourceFile, rows.length, ts, ts);
    const jobId = job.lastInsertRowid;
    for (const r of rows) {
      insertRecord.run(jobId, r.rowNo, r.applicationNo, JSON.stringify(r.payload), ts);
    }
    return getJob(jobId);
  })(records);
}

export function getJob(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

export function listJobs() {
  return db.prepare('SELECT * FROM jobs ORDER BY id DESC').all();
}

export function updateJobStatus(id, status) {
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
}

// 进程重启后恢复：把僵在 running 状态的任务/记录显式标记为 interrupted
export function markStaleInterrupted() {
  const staleJobs = db
    .prepare("SELECT id FROM jobs WHERE status IN ('running','paused')")
    .all();
  const markJob = db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?');
  const markRec = db.prepare(
    `UPDATE records SET status = 'interrupted', updated_at = ?
     WHERE job_id = ? AND status = 'running'`
  );
  const tx = db.transaction((jobs) => {
    for (const j of jobs) {
      markRec.run(now(), j.id);
      markJob.run('interrupted', now(), j.id);
    }
  });
  tx(staleJobs);
  return staleJobs.length;
}

// ---------- records ----------

export function getRecords(jobId) {
  return db
    .prepare('SELECT * FROM records WHERE job_id = ? ORDER BY row_no')
    .all(jobId)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function getRecord(id) {
  const r = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
  return r ? { ...r, payload: JSON.parse(r.payload) } : null;
}

export function getRecordByAppNo(jobId, applicationNo) {
  const r = db
    .prepare('SELECT * FROM records WHERE job_id = ? AND application_no = ?')
    .get(jobId, applicationNo);
  return r ? { ...r, payload: JSON.parse(r.payload) } : null;
}

// 按 ID 原子认领指定记录：只有仍处于可执行状态时才置为 running，避免重复执行/错位
const claimByIdStmt = db.prepare(
  `UPDATE records
   SET status = 'running', attempts = attempts + 1, updated_at = ?
   WHERE id = ? AND status IN ('pending','interrupted','failed')
   RETURNING *`
);

export function claimRecord(id) {
  const r = claimByIdStmt.get(now(), id);
  return r ? { ...r, payload: JSON.parse(r.payload) } : null;
}

// 兼容：领取下一条可执行记录
export function claimNextRecord(jobId) {
  const row = db
    .prepare(
      `SELECT id FROM records
       WHERE job_id = ? AND status IN ('pending','interrupted','failed')
       ORDER BY row_no LIMIT 1`
    )
    .get(jobId);
  return row ? claimRecord(row.id) : null;
}

export function markRecordSuccess(id, mockRef, screenshot) {
  db.prepare(
    `UPDATE records SET status = 'success', error = NULL, mock_ref = ?, screenshot = ?, updated_at = ?
     WHERE id = ?`
  ).run(mockRef, screenshot, now(), id);
}

export function markRecordFailed(id, error) {
  db.prepare(
    `UPDATE records SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`
  ).run(error, now(), id);
}

export function markRecordSkipped(id, reason) {
  db.prepare(
    `UPDATE records SET status = 'skipped', error = ?, updated_at = ? WHERE id = ?`
  ).run(reason, now(), id);
}

export function countByStatus(jobId) {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM records WHERE job_id = ? GROUP BY status')
    .all(jobId);
  const counts = { pending: 0, running: 0, success: 0, failed: 0, skipped: 0, interrupted: 0 };
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

// ---------- logs（message 必须已遮蔽） ----------

export function insertLog({ jobId = null, recordId = null, level, event, message }) {
  db.prepare(
    'INSERT INTO logs (job_id, record_id, level, event, message, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(jobId, recordId, level, event, message, now());
}

export function getLogs(jobId, limit = 500) {
  return db
    .prepare('SELECT * FROM logs WHERE job_id = ? ORDER BY id DESC LIMIT ?')
    .all(jobId, limit)
    .reverse();
}
