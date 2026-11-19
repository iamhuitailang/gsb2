"""SQLite 存储层。

所有数据只保存在本机数据库文件中（默认 ./secbench_data/secbench.db），
不依赖任何外部服务或第三方库。
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any, Iterable

# ---- 规则版本：规则逻辑或默认阈值变更时递增，导出时随告警输出 ----
RULE_VERSION = "1.0.0"

DEFAULT_SETTINGS: dict[str, Any] = {
    # 导入限制
    "max_import_bytes": 2 * 1024 * 1024,      # 单文件 2 MiB
    "max_import_events": 5000,                # 单次导入事件数上限
    # 规则一：同源地址连续认证失败后成功登录（撞库/暴力破解）
    "r1_fail_threshold": 3,                   # 窗口内失败账号去重数下限
    "r1_window_seconds": 600,                 # 失败统计窗口
    "r1_success_window_seconds": 300,         # 末次失败到成功登录的最大间隔
    # 规则二：可疑路径探测后同源相关访问/异常
    "r2_window_seconds": 600,
    # 规则三：登录后短时间内跨来源地址敏感数据导出
    "r3_window_seconds": 900,
}

VALID_SOURCES = {"auth", "proxy", "endpoint"}


def now_iso() -> str:
    """当前 UTC 时间的 ISO8601 字符串（秒级，Z 结尾）。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_db_path() -> str:
    return os.environ.get("SECBENCH_DB", os.path.join("secbench_data", "secbench.db"))


def connect(db_path: str | None = None) -> sqlite3.Connection:
    path = db_path or get_db_path()
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    imported_at        TEXT NOT NULL,
    filename           TEXT NOT NULL,
    total_lines        INTEGER NOT NULL,
    accepted_count     INTEGER NOT NULL,
    duplicate_count    INTEGER NOT NULL,
    quarantined_count INTEGER NOT NULL,
    error_count        INTEGER NOT NULL,
    rejected_reason    TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id    INTEGER NOT NULL REFERENCES imports(id),
    source       TEXT NOT NULL,
    event_id     TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    event_time   TEXT NOT NULL,
    subject      TEXT,
    src_ip       TEXT,
    action       TEXT,
    target       TEXT,
    result       TEXT,
    normalized   TEXT NOT NULL,   -- 规范化字段 JSON
    raw_line     TEXT NOT NULL,   -- 原始记录原文
    received_at  TEXT NOT NULL,
    UNIQUE(source, event_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_events_lookup ON events(source, event_id);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(event_time);
CREATE INDEX IF NOT EXISTS idx_events_src_ip ON events(src_ip);
CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject);

-- 内容冲突隔离区：相同 (source, event_id) 但 content_hash 与已入库记录不同
CREATE TABLE IF NOT EXISTS quarantined (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id   INTEGER NOT NULL REFERENCES imports(id),
    source      TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    reason      TEXT NOT NULL,
    raw_line    TEXT NOT NULL,
    parsed      TEXT,
    held_at     TEXT NOT NULL
);

-- 行级错误（坏 JSON、无效时间、缺字段、未知来源等）
CREATE TABLE IF NOT EXISTS row_errors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id   INTEGER NOT NULL REFERENCES imports(id),
    line_no     INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    raw_line    TEXT NOT NULL,
    held_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id        TEXT NOT NULL,
    rule_version   TEXT NOT NULL,
    scope_key      TEXT NOT NULL,          -- 规则身份：同规则同范围视为同一告警
    severity       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open',   -- open / confirmed / false_positive
    disposition_note TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    rationale      TEXT NOT NULL,          -- 关联依据的人类可读说明
    summary        TEXT NOT NULL,
    involved_sources TEXT NOT NULL,        -- JSON 数组
    involved_subjects TEXT NOT NULL,       -- JSON 数组
    involved_targets  TEXT NOT NULL,       -- JSON 数组
    first_event_time TEXT NOT NULL,
    last_event_time  TEXT NOT NULL,
    superseded       INTEGER NOT NULL DEFAULT 0,  -- 重评估后规则不再命中：保留审计但默认隐藏
    UNIQUE(rule_id, scope_key)
);

CREATE TABLE IF NOT EXISTS alert_events (
    alert_id      INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    event_pk      INTEGER NOT NULL REFERENCES events(id),
    evidence_role TEXT NOT NULL,
    PRIMARY KEY (alert_id, event_pk)
);
"""


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    # 旧库迁移：补列（SQLite 不支持 IF NOT EXISTS 的 ADD COLUMN）
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(alerts)").fetchall()}
    if "superseded" not in cols:
        conn.execute("ALTER TABLE alerts ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0")
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
            (key, json.dumps(value)),
        )
    conn.commit()


# ---------------- 设置 ----------------

def get_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    saved = {r["key"]: json.loads(r["value"]) for r in rows}
    merged = dict(DEFAULT_SETTINGS)
    merged.update(saved)
    return merged


def update_settings(conn: sqlite3.Connection, updates: dict[str, Any]) -> dict[str, Any]:
    current = get_settings(conn)
    for key, value in updates.items():
        if key not in DEFAULT_SETTINGS:
            raise KeyError(f"未知配置项: {key}")
        if not isinstance(value, int) or value <= 0:
            raise ValueError(f"配置项 {key} 必须为正整数，收到: {value!r}")
        current[key] = value
        conn.execute(
            "UPDATE settings SET value = ? WHERE key = ?",
            (json.dumps(value), key),
        )
    conn.commit()
    return current


# ---------------- 事件查询 ----------------

def list_events(
    conn: sqlite3.Connection,
    *,
    source: str | None = None,
    subject: str | None = None,
    src_ip: str | None = None,
    limit: int = 500,
) -> list[sqlite3.Row]:
    sql = "SELECT * FROM events WHERE 1=1"
    params: list[Any] = []
    if source:
        sql += " AND source = ?"
        params.append(source)
    if subject:
        sql += " AND subject = ?"
        params.append(subject)
    if src_ip:
        sql += " AND src_ip = ?"
        params.append(src_ip)
    sql += " ORDER BY event_time ASC, id ASC LIMIT ?"
    params.append(limit)
    return conn.execute(sql, params).fetchall()


def get_event(conn: sqlite3.Connection, event_pk: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM events WHERE id = ?", (event_pk,)).fetchone()


def all_event_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM events ORDER BY event_time ASC, id ASC"
    ).fetchall()


# ---------------- 导入批次 ----------------

def create_import(conn: sqlite3.Connection, filename: str) -> int:
    cur = conn.execute(
        "INSERT INTO imports(imported_at, filename, total_lines, accepted_count, "
        "duplicate_count, quarantined_count, error_count, rejected_reason) "
        "VALUES (?, ?, 0, 0, 0, 0, 0, NULL)",
        (now_iso(), filename),
    )
    return int(cur.lastrowid)


def finish_import(
    conn: sqlite3.Connection,
    import_id: int,
    counts: dict[str, int],
    rejected_reason: str | None = None,
) -> None:
    conn.execute(
        "UPDATE imports SET total_lines=?, accepted_count=?, duplicate_count=?, "
        "quarantined_count=?, error_count=?, rejected_reason=? WHERE id=?",
        (
            counts["total"],
            counts["accepted"],
            counts["duplicate"],
            counts["quarantined"],
            counts["error"],
            rejected_reason,
            import_id,
        ),
    )
    conn.commit()


def list_imports(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM imports ORDER BY id DESC"
    ).fetchall()


def list_row_errors(conn: sqlite3.Connection, import_id: int | None = None) -> list[sqlite3.Row]:
    if import_id is None:
        return conn.execute("SELECT * FROM row_errors ORDER BY id DESC").fetchall()
    return conn.execute(
        "SELECT * FROM row_errors WHERE import_id=? ORDER BY line_no ASC", (import_id,)
    ).fetchall()


def list_quarantined(conn: sqlite3.Connection, import_id: int | None = None) -> list[sqlite3.Row]:
    if import_id is None:
        return conn.execute("SELECT * FROM quarantined ORDER BY id DESC").fetchall()
    return conn.execute(
        "SELECT * FROM quarantined WHERE import_id=? ORDER BY id ASC", (import_id,)
    ).fetchall()


# ---------------- 告警 ----------------

def get_alert(conn: sqlite3.Connection, alert_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()


def list_alerts(
    conn: sqlite3.Connection,
    *,
    severity: str | None = None,
    source: str | None = None,
    subject: str | None = None,
    status: str | None = None,
    time_from: str | None = None,
    time_to: str | None = None,
    include_superseded: bool = False,
) -> list[sqlite3.Row]:
    sql = "SELECT DISTINCT a.* FROM alerts a"
    joins = ""
    where = ""
    params: list[Any] = []
    if source or subject:
        joins = " JOIN alert_events ae ON ae.alert_id = a.id JOIN events e ON e.id = ae.event_pk"
    if source:
        where += " AND e.source = ?"
        params.append(source)
    if subject:
        where += " AND e.subject = ?"
        params.append(subject)
    if severity:
        where += " AND a.severity = ?"
        params.append(severity)
    if status:
        where += " AND a.status = ?"
        params.append(status)
    if time_from:
        where += " AND a.last_event_time >= ?"
        params.append(time_from)
    if time_to:
        where += " AND a.first_event_time <= ?"
        params.append(time_to)
    if not include_superseded:
        where += " AND a.superseded = 0"
    sql += joins + " WHERE 1=1" + where + " ORDER BY a.first_event_time DESC, a.id DESC"
    return conn.execute(sql, params).fetchall()


def alert_evidence(conn: sqlite3.Connection, alert_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT e.*, ae.evidence_role FROM alert_events ae "
        "JOIN events e ON e.id = ae.event_pk "
        "WHERE ae.alert_id = ? ORDER BY e.event_time ASC, e.id ASC",
        (alert_id,),
    ).fetchall()


VALID_STATUS = {"open", "confirmed", "false_positive"}
STATUS_LABEL = {"open": "待处理", "confirmed": "已确认", "false_positive": "误报"}


def set_alert_status(
    conn: sqlite3.Connection, alert_id: int, status: str, note: str
) -> sqlite3.Row:
    if status not in VALID_STATUS:
        raise ValueError(f"非法处置状态: {status}")
    conn.execute(
        "UPDATE alerts SET status=?, disposition_note=?, updated_at=? WHERE id=?",
        (status, note, now_iso(), alert_id),
    )
    conn.commit()
    row = get_alert(conn, alert_id)
    if row is None:
        raise KeyError(f"告警不存在: {alert_id}")
    return row


def reset_all(conn: sqlite3.Connection) -> None:
    """清空本机全部演示数据并重建空库（不删数据库文件本身）。"""
    conn.executescript(
        """
        DROP TABLE IF EXISTS alert_events;
        DROP TABLE IF EXISTS alerts;
        DROP TABLE IF EXISTS row_errors;
        DROP TABLE IF EXISTS quarantined;
        DROP TABLE IF EXISTS events;
        DROP TABLE IF EXISTS imports;
        DROP TABLE IF EXISTS settings;
        """
    )
    conn.commit()
    init_db(conn)


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]
