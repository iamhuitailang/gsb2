"""SQLite 数据访问层：规则版本、批次、校验结果、预跑报告。"""
import sqlite3
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS rule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_no INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
  config_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS publish_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  action TEXT NOT NULL CHECK(action IN ('publish','rollback')),
  operator TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  total_rows INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER NOT NULL DEFAULT 0,
  reject_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batch_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  row_no INTEGER NOT NULL,
  raw_line TEXT NOT NULL,
  parcel_no TEXT NOT NULL DEFAULT '',
  weight REAL,
  service_type TEXT NOT NULL DEFAULT '',
  is_cold_chain INTEGER NOT NULL DEFAULT 0,
  temp_zone TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS validation_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_row_id INTEGER NOT NULL REFERENCES batch_rows(id),
  rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('pass','reject')),
  reasons_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS dryrun_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  base_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  draft_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  pass_to_reject INTEGER NOT NULL DEFAULT 0,
  reject_to_pass INTEGER NOT NULL DEFAULT 0,
  reason_changed INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dryrun_report_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES dryrun_reports(id),
  batch_row_id INTEGER NOT NULL REFERENCES batch_rows(id),
  change_type TEXT NOT NULL CHECK(change_type IN
    ('pass_to_reject','reject_to_pass','reason_changed','unchanged')),
  base_outcome TEXT NOT NULL,
  base_reasons_json TEXT NOT NULL DEFAULT '[]',
  draft_outcome TEXT NOT NULL,
  draft_reasons_json TEXT NOT NULL DEFAULT '[]'
);
"""


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path):
    conn = connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def next_version_no(conn):
    row = conn.execute("SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM rule_versions").fetchone()
    return row["n"]


def get_published(conn):
    return conn.execute(
        "SELECT * FROM rule_versions WHERE status = 'published' ORDER BY version_no DESC LIMIT 1"
    ).fetchone()


def create_version(conn, config_json, note="", status="draft"):
    cur = conn.execute(
        "INSERT INTO rule_versions (version_no, status, config_json, note, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (next_version_no(conn), status, config_json, note, now()),
    )
    return cur.lastrowid


def publish_version(conn, version_id, operator="", action="publish"):
    """发布指定版本：当前生效版本归档，目标版本置为 published。回滚复用同一逻辑。"""
    current = get_published(conn)
    if current and current["id"] != version_id:
        conn.execute("UPDATE rule_versions SET status = 'archived' WHERE id = ?", (current["id"],))
    conn.execute(
        "UPDATE rule_versions SET status = 'published', published_at = ? WHERE id = ?",
        (now(), version_id),
    )
    conn.execute(
        "INSERT INTO publish_events (version_id, action, operator, created_at) VALUES (?,?,?,?)",
        (version_id, action, operator, now()),
    )
