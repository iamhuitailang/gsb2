"""SQLite 持久化层：规则、运行记录、页面当前状态、页面历史快照。"""
import sqlite3
import threading
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data.db"

_lock = threading.Lock()
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")
_conn.execute("PRAGMA foreign_keys=ON")

SCHEMA = """
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_url TEXT NOT NULL,
    max_pages INTEGER NOT NULL DEFAULT 100,
    delay_ms INTEGER NOT NULL DEFAULT 500,
    retry_times INTEGER NOT NULL DEFAULT 2,
    same_domain INTEGER NOT NULL DEFAULT 1,
    include_pattern TEXT NOT NULL DEFAULT '',
    exclude_pattern TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL REFERENCES rules(id),
    status TEXT NOT NULL DEFAULT 'running',   -- running / done / failed
    queued INTEGER NOT NULL DEFAULT 0,
    processing INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    n_new INTEGER NOT NULL DEFAULT 0,
    n_changed INTEGER NOT NULL DEFAULT 0,
    n_unchanged INTEGER NOT NULL DEFAULT 0,
    n_removed INTEGER NOT NULL DEFAULT 0,
    n_failed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at REAL NOT NULL,
    finished_at REAL
);

CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,                 -- 规范化后的 URL
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    updated_text TEXT NOT NULL DEFAULT '',    -- 页面标注的更新时间
    content_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',       -- new / changed / unchanged / removed
    first_seen_run INTEGER,
    last_seen_run INTEGER,
    last_fetch_at REAL
);

CREATE TABLE IF NOT EXISTS page_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    updated_text TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,                     -- new / changed / unchanged / removed / failed
    fetched_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_run ON page_history(run_id);
CREATE INDEX IF NOT EXISTS idx_history_url ON page_history(url);
"""


def init_db():
    with _lock, _conn:
        _conn.executescript(SCHEMA)
        # 预置一条指向本地演示站点的规则
        row = _conn.execute("SELECT COUNT(*) AS c FROM rules").fetchone()
        if row["c"] == 0:
            now = time.time()
            _conn.execute(
                """INSERT INTO rules
                   (name, start_url, max_pages, delay_ms, retry_times,
                    same_domain, include_pattern, exclude_pattern,
                    created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                ("本地演示站点", "http://127.0.0.1:8001/index.html",
                 100, 500, 2, 1, "", "", now, now),
            )


def query(sql, params=()):
    with _lock:
        return _conn.execute(sql, params).fetchall()


def query_one(sql, params=()):
    with _lock:
        return _conn.execute(sql, params).fetchone()


def execute(sql, params=()):
    with _lock, _conn:
        cur = _conn.execute(sql, params)
        return cur.lastrowid
