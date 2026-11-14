"""SQLite 存取层：资料站目录、领取入库记录、领取运行日志。"""
import json
import sqlite3
from datetime import datetime
from typing import Any

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no       TEXT NOT NULL,
    version      TEXT NOT NULL,
    month        TEXT NOT NULL,
    store_code   TEXT NOT NULL,
    store_name   TEXT NOT NULL,
    title        TEXT NOT NULL,
    filename     TEXT NOT NULL,
    source_path  TEXT NOT NULL,
    source_sha   TEXT NOT NULL,
    is_current   INTEGER NOT NULL DEFAULT 1,
    note         TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL,
    UNIQUE(doc_no, version)
);

CREATE TABLE IF NOT EXISTS inbox (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no       TEXT NOT NULL,
    version      TEXT NOT NULL,
    month        TEXT NOT NULL,
    store_code   TEXT NOT NULL,
    store_name   TEXT NOT NULL,
    title        TEXT NOT NULL,
    filename     TEXT NOT NULL,
    stored_path  TEXT NOT NULL,
    file_size    INTEGER NOT NULL,
    file_sha     TEXT NOT NULL,
    is_current   INTEGER NOT NULL DEFAULT 1,
    source_url   TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    UNIQUE(doc_no, version)
);

CREATE TABLE IF NOT EXISTS harvest_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    month       TEXT NOT NULL,
    store_code  TEXT NOT NULL,
    status      TEXT NOT NULL,
    stats       TEXT NOT NULL DEFAULT '{}',
    started_at  TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS harvest_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  INTEGER NOT NULL,
    ts      TEXT NOT NULL,
    action  TEXT NOT NULL,
    doc_no  TEXT,
    version TEXT,
    message TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES harvest_runs(id)
);
"""


def get_conn() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------- 资料站目录 ----------------

def upsert_report(conn: sqlite3.Connection, rec: dict[str, Any]) -> None:
    conn.execute(
        """INSERT INTO reports(doc_no, version, month, store_code, store_name,
                               title, filename, source_path, source_sha,
                               is_current, note, published_at)
           VALUES(:doc_no,:version,:month,:store_code,:store_name,:title,
                  :filename,:source_path,:source_sha,:is_current,:note,:published_at)
           ON CONFLICT(doc_no, version) DO UPDATE SET
             month=excluded.month, store_code=excluded.store_code,
             store_name=excluded.store_name, title=excluded.title,
             filename=excluded.filename, source_path=excluded.source_path,
             source_sha=excluded.source_sha, is_current=excluded.is_current,
             note=excluded.note, published_at=excluded.published_at""",
        rec,
    )


def list_reports(
    conn: sqlite3.Connection, month: str, store: str, limit: int, offset: int
) -> tuple[list[sqlite3.Row], int]:
    where, params = [], []
    if month:
        where.append("month = ?")
        params.append(month)
    if store:
        where.append("store_code = ?")
        params.append(store)
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    total = conn.execute(f"SELECT COUNT(*) AS n FROM reports{clause}", params).fetchone()["n"]
    rows = conn.execute(
        f"""SELECT * FROM reports{clause}
            ORDER BY month DESC, store_code, doc_no,
                     is_current DESC, version DESC
            LIMIT ? OFFSET ?""",
        params + [limit, offset],
    ).fetchall()
    return rows, total


def get_report(conn: sqlite3.Connection, doc_no: str, version: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM reports WHERE doc_no=? AND version=?", (doc_no, version)
    ).fetchone()


def distinct_months(conn: sqlite3.Connection) -> list[str]:
    return [r["month"] for r in conn.execute(
        "SELECT DISTINCT month FROM reports ORDER BY month DESC")]


def distinct_stores(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT DISTINCT store_code, store_name FROM reports ORDER BY store_code"
    ).fetchall()


# ---------------- 入库记录 ----------------

def inbox_has(conn: sqlite3.Connection, doc_no: str, version: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM inbox WHERE doc_no=? AND version=?", (doc_no, version)
    ).fetchone()


def insert_inbox(conn: sqlite3.Connection, rec: dict[str, Any]) -> None:
    conn.execute(
        """INSERT INTO inbox(doc_no, version, month, store_code, store_name, title,
                             filename, stored_path, file_size, file_sha, is_current,
                             source_url, received_at)
           VALUES(:doc_no,:version,:month,:store_code,:store_name,:title,:filename,
                  :stored_path,:file_size,:file_sha,:is_current,:source_url,:received_at)""",
        rec,
    )


def list_inbox(conn: sqlite3.Connection, month: str, store: str) -> list[sqlite3.Row]:
    where, params = [], []
    if month:
        where.append("month = ?")
        params.append(month)
    if store:
        where.append("store_code = ?")
        params.append(store)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    return conn.execute(
        f"""SELECT * FROM inbox{clause}
            ORDER BY month DESC, store_code, doc_no, version DESC""",
        params,
    ).fetchall()


def get_inbox(conn: sqlite3.Connection, inbox_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM inbox WHERE id=?", (inbox_id,)).fetchone()


# ---------------- 领取运行日志 ----------------

def create_run(conn: sqlite3.Connection, month: str, store: str) -> int:
    cur = conn.execute(
        "INSERT INTO harvest_runs(month, store_code, status, started_at) VALUES(?,?,?,?)",
        (month, store, "running", now_str()),
    )
    conn.commit()
    return cur.lastrowid


def add_event(
    conn: sqlite3.Connection,
    run_id: int,
    action: str,
    message: str,
    doc_no: str | None = None,
    version: str | None = None,
) -> None:
    conn.execute(
        """INSERT INTO harvest_events(run_id, ts, action, doc_no, version, message)
           VALUES(?,?,?,?,?,?)""",
        (run_id, now_str(), action, doc_no, version, message),
    )
    conn.commit()


def finish_run(conn: sqlite3.Connection, run_id: int, status: str, stats: dict) -> None:
    conn.execute(
        "UPDATE harvest_runs SET status=?, stats=?, finished_at=? WHERE id=?",
        (status, json.dumps(stats, ensure_ascii=False), now_str(), run_id),
    )
    conn.commit()


def get_run(conn: sqlite3.Connection, run_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM harvest_runs WHERE id=?", (run_id,)).fetchone()


def list_events(conn: sqlite3.Connection, run_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM harvest_events WHERE run_id=? ORDER BY id", (run_id,)
    ).fetchall()


def list_runs(conn: sqlite3.Connection, limit: int = 10) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM harvest_runs ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
