/**
 * 持久化层：node:sqlite（Node 内置，无需原生编译）。
 * 两张表：
 *  - tasks      每个上传任务一行，记录检查结论、拒收原因与服务端存储名
 *  - audit_log  所有状态变化的追加式审计记录，只增不改不删
 * 注意：数据库中不保存任何本机绝对路径，存储位置仅以相对 data 目录的文件名表达。
 */
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.mjs';

let db;

export function openDb() {
  db = new DatabaseSync(config.dirs.db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      original_name   TEXT NOT NULL,
      client_mime     TEXT,
      client_ext      TEXT,
      declared_size   INTEGER NOT NULL,
      detected_type   TEXT,
      status          TEXT NOT NULL,
      reasons         TEXT NOT NULL DEFAULT '[]',
      storage_name    TEXT,
      stored_size     INTEGER,
      width           INTEGER,
      height          INTEGER,
      zip_meta        TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id   TEXT,
      at        TEXT NOT NULL,
      action    TEXT NOT NULL,
      detail    TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `);
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

export function createTask(row) {
  const stmt = db.prepare(`
    INSERT INTO tasks (id, created_at, updated_at, original_name, client_mime, client_ext,
                       declared_size, detected_type, status, reasons, storage_name,
                       stored_size, width, height, zip_meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    row.id, row.created_at, row.updated_at, row.original_name,
    row.client_mime ?? null, row.client_ext ?? null, row.declared_size,
    row.detected_type ?? null, row.status, JSON.stringify(row.reasons ?? []),
    row.storage_name ?? null, row.stored_size ?? null,
    row.width ?? null, row.height ?? null,
    row.zip_meta ? JSON.stringify(row.zip_meta) : null,
  );
}

export function updateTask(id, patch) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'reasons' || key === 'zip_meta') {
      fields.push(`${key} = ?`);
      values.push(JSON.stringify(value ?? []));
    } else {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getTask(id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

export function listTasks() {
  return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all().map(hydrate);
}

export function listByStatus(status) {
  return db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC').all(status).map(hydrate);
}

export function deleteTask(id) {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function addAudit(taskId, action, detail = '') {
  db.prepare(
    'INSERT INTO audit_log (task_id, at, action, detail) VALUES (?, ?, ?, ?)',
  ).run(taskId, nowIso(), action, detail);
}

export function listAudit(taskId = null) {
  const rows = taskId
    ? db.prepare('SELECT * FROM audit_log WHERE task_id = ? ORDER BY id DESC').all(taskId)
    : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all();
  return rows;
}

function hydrate(row) {
  return {
    ...row,
    reasons: JSON.parse(row.reasons || '[]'),
    zip_meta: row.zip_meta ? JSON.parse(row.zip_meta) : null,
  };
}
