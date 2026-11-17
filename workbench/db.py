"""SQLite storage for the archive-purge workbench."""

from __future__ import annotations

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .security import hash_password

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "workbench.db"
DEFAULT_USERNAME = "archivist"
DEFAULT_PASSWORD = "Archive-Admin-2026"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS records (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id  INTEGER NOT NULL REFERENCES folders(id),
    title      TEXT NOT NULL,
    batch      TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS records_scope
    ON records(folder_id, batch, id);

CREATE TABLE IF NOT EXISTS sessions (
    id               TEXT PRIMARY KEY,
    token_hash       TEXT NOT NULL UNIQUE,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    active_folder_id INTEGER REFERENCES folders(id),
    active_batch     TEXT NOT NULL DEFAULT '',
    active_keyword   TEXT NOT NULL DEFAULT '',
    created_at       REAL NOT NULL,
    last_seen_at     REAL NOT NULL,
    expires_at       REAL NOT NULL,
    revoked_at       REAL
);

CREATE TABLE IF NOT EXISTS confirmations (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(id),
    user_id       INTEGER NOT NULL REFERENCES users(id),
    operation_id  TEXT NOT NULL,
    folder_id     INTEGER NOT NULL REFERENCES folders(id),
    folder_name   TEXT NOT NULL,
    filter_json   TEXT NOT NULL,
    filter_label  TEXT NOT NULL,
    record_snapshot TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    record_count  INTEGER NOT NULL,
    created_at    REAL NOT NULL,
    expires_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS permits (
    id            TEXT PRIMARY KEY,
    token_hash    TEXT NOT NULL UNIQUE,
    confirmation_id TEXT NOT NULL,
    session_id    TEXT NOT NULL REFERENCES sessions(id),
    user_id       INTEGER NOT NULL REFERENCES users(id),
    operation_id  TEXT NOT NULL,
    folder_id     INTEGER NOT NULL REFERENCES folders(id),
    filter_json   TEXT NOT NULL,
    record_ids    TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    record_count  INTEGER NOT NULL,
    created_at    REAL NOT NULL,
    expires_at    REAL NOT NULL,
    consumed_at   REAL,
    revoked_at    REAL
);

CREATE TABLE IF NOT EXISTS operations (
    id               TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL,
    user_id          INTEGER NOT NULL,
    username         TEXT NOT NULL,
    folder_id        INTEGER NOT NULL,
    folder_name      TEXT NOT NULL,
    filter_json      TEXT NOT NULL,
    filter_label     TEXT NOT NULL,
    record_snapshot  TEXT NOT NULL,
    deleted_snapshot TEXT,
    record_digest    TEXT NOT NULL,
    record_count     INTEGER NOT NULL,
    status           TEXT NOT NULL,
    created_at       REAL NOT NULL,
    completed_at     REAL,
    completed_by     TEXT
);

CREATE INDEX IF NOT EXISTS operations_completed
    ON operations(status, completed_at);

CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           REAL NOT NULL,
    action       TEXT NOT NULL,
    operation_id TEXT,
    user_id      INTEGER,
    username     TEXT,
    folder_id    INTEGER,
    folder_name  TEXT,
    record_count INTEGER,
    detail       TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS audit_operation
    ON audit_log(operation_id, id);
"""


def resolve_db_path() -> Path:
    return Path(os.environ.get("WORKBENCH_DB", str(DEFAULT_DB_PATH)))


def connect(db_path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def init_db(db_path: str | Path, *, seed: bool = True) -> None:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        if seed:
            _seed(conn)
    finally:
        conn.close()


def _seed(conn: sqlite3.Connection) -> None:
    now = time.time()
    if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        return
    with transaction(conn):
        conn.execute(
            "INSERT INTO users(username, password_hash, created_at) VALUES (?,?,?)",
            (DEFAULT_USERNAME, hash_password(DEFAULT_PASSWORD), now),
        )
        conn.executemany(
            "INSERT INTO folders(name) VALUES (?)",
            [("甲目录",), ("乙目录",)],
        )
        folder_ids = {
            row["name"]: row["id"]
            for row in conn.execute("SELECT id, name FROM folders")
        }
        rows = [
            (folder_ids["甲目录"], "2026年第三季度采购合同（归档）", "2026-Q3", now),
            (folder_ids["甲目录"], "2026年第三季度验收材料（归档）", "2026-Q3", now),
            (folder_ids["乙目录"], "2025年度财务凭证（归档）", "2025-annual", now),
        ]
        conn.executemany(
            "INSERT INTO records(folder_id, title, batch, created_at) VALUES (?,?,?,?)",
            rows,
        )


def reset_db(db_path: str | Path) -> None:
    """Drop and recreate all tables.  Only used by tests and tooling."""
    conn = connect(db_path)
    try:
        for table in (
            "audit_log",
            "operations",
            "permits",
            "confirmations",
            "sessions",
            "records",
            "folders",
            "users",
        ):
            conn.execute(f"DROP TABLE IF EXISTS {table}")
    finally:
        conn.close()
    init_db(db_path, seed=True)


def to_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def from_json(text: str):
    return json.loads(text)
