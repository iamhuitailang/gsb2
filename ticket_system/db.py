"""数据存储：SQLite 建表与连接。"""

from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS work_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'supervisor', 'agent')),
    group_id      INTEGER REFERENCES work_groups(id),
    created_at    TEXT NOT NULL,
    CHECK (role = 'admin' OR group_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS tickets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL REFERENCES work_groups(id),
    title      TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('open', 'processing', 'closed', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_group_status ON tickets(group_id, status);

CREATE TABLE IF NOT EXISTS close_batches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    supervisor_id INTEGER NOT NULL REFERENCES users(id),
    batch_key     TEXT NOT NULL,
    request_hash  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    result_json   TEXT NOT NULL,
    UNIQUE (supervisor_id, batch_key)
);

CREATE TABLE IF NOT EXISTS close_records (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id      INTEGER NOT NULL REFERENCES close_batches(id),
    ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
    supervisor_id INTEGER NOT NULL REFERENCES users(id),
    from_status   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    -- 一张工单最多一条关闭记录：即使幂等键被绕过也不可能重复记账
    UNIQUE (ticket_id)
);

CREATE TABLE IF NOT EXISTS ticket_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id),
    action     TEXT NOT NULL,
    from_value TEXT,
    to_value   TEXT,
    actor_id   INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
"""


def connect(db_path: str | Path) -> sqlite3.Connection:
    """打开连接：自动提交模式，事务由调用方显式 BEGIN/COMMIT。"""
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_db(db_path: str | Path) -> sqlite3.Connection:
    conn = connect(db_path)
    conn.executescript(SCHEMA)
    return conn


def reset_db(db_path: str | Path) -> sqlite3.Connection:
    path = Path(db_path)
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(f"{path}{suffix}")
        if candidate.exists():
            candidate.unlink()
    return init_db(path)
