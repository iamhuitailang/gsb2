"""SQLite connection management and schema definition."""
from __future__ import annotations

import os
import sqlite3

DB_PATH = os.environ.get(
    "TEMP_DB_PATH",
    os.path.join(os.getcwd(), "data", "temps.db"),
)

SCHEMA_STATEMENTS = [
    # Every version of every reading ever received is retained here.
    """
    CREATE TABLE IF NOT EXISTS readings (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id       TEXT NOT NULL,
        reading_id      TEXT NOT NULL,
        version         INTEGER NOT NULL,
        measured_at     TEXT NOT NULL,   -- measurement instant, normalized to UTC ISO
        measured_at_raw TEXT NOT NULL,   -- original payload string (keeps its timezone)
        temperature     REAL NOT NULL,
        received_at     TEXT NOT NULL,   -- when the batch carrying this version arrived
        batch_id        INTEGER NOT NULL REFERENCES batches(id),
        classification  TEXT NOT NULL,   -- new | correction | stale
        UNIQUE (device_id, reading_id, version)
    )
    """,
    # One row per reading: the winning version that participates in statistics.
    """
    CREATE TABLE IF NOT EXISTS current_readings (
        device_id    TEXT NOT NULL,
        reading_id   TEXT NOT NULL,
        reading_pk   INTEGER NOT NULL REFERENCES readings(id),
        version      INTEGER NOT NULL,
        window_start TEXT NOT NULL,      -- UTC ISO, floored to a 5-minute boundary
        measured_at  TEXT NOT NULL,
        temperature  REAL NOT NULL,
        PRIMARY KEY (device_id, reading_id)
    )
    """,
    # Stored five-minute aggregates served to the web page.
    """
    CREATE TABLE IF NOT EXISTS windows (
        device_id    TEXT NOT NULL,
        window_start TEXT NOT NULL,      -- UTC ISO, five-minute boundary
        count        INTEGER NOT NULL,
        min_temp     REAL NOT NULL,
        max_temp     REAL NOT NULL,
        sum_temp     REAL NOT NULL,
        avg_temp     REAL NOT NULL,
        PRIMARY KEY (device_id, window_start)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS batches (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at TEXT NOT NULL,
        note        TEXT
    )
    """,
    # Per-record outcome of a batch, including conflicts and invalid rows.
    """
    CREATE TABLE IF NOT EXISTS batch_items (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id       INTEGER NOT NULL REFERENCES batches(id),
        device_id      TEXT NOT NULL,
        reading_id     TEXT NOT NULL,
        version        INTEGER NOT NULL,
        classification TEXT NOT NULL,    -- new|correction|duplicate|stale|conflict|invalid
        reading_pk     INTEGER REFERENCES readings(id),
        detail         TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS recompute_jobs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id    TEXT NOT NULL,
        window_start TEXT NOT NULL,      -- first covered window (inclusive)
        window_end   TEXT NOT NULL,      -- exclusive upper bound
        started_at   TEXT NOT NULL,
        finished_at  TEXT,
        status       TEXT NOT NULL       -- running | done
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS recompute_changes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id       INTEGER NOT NULL REFERENCES recompute_jobs(id),
        device_id    TEXT NOT NULL,
        window_start TEXT NOT NULL,
        change_type  TEXT NOT NULL,      -- created | updated | removed
        before_json  TEXT,
        after_json   TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_readings_key ON readings(device_id, reading_id, version)",
    "CREATE INDEX IF NOT EXISTS idx_current_window ON current_readings(device_id, window_start)",
    "CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id)",
    "CREATE INDEX IF NOT EXISTS idx_recompute_changes_job ON recompute_changes(job_id)",
]


def get_conn() -> sqlite3.Connection:
    """Open a connection. Caller owns closing it."""
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = get_conn()
    try:
        for stmt in SCHEMA_STATEMENTS:
            conn.execute(stmt)
    finally:
        conn.close()


def reset_db() -> None:
    """Wipe all data and recreate the schema (local operator tool)."""
    init_db()
    conn = get_conn()
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        try:
            for table in (
                "recompute_changes",
                "recompute_jobs",
                "batch_items",
                "batches",
                "windows",
                "current_readings",
                "readings",
            ):
                conn.execute(f"DELETE FROM {table}")
            conn.execute("DELETE FROM sqlite_sequence")
        finally:
            conn.execute("PRAGMA foreign_keys=ON")
    finally:
        conn.close()
