"""存储层：运单数据版本化（valid_from/valid_to 区间）+ 导出任务状态。

每次维护操作（新增/改件数/撤销）都会推进全局 data_version，
并关闭旧行、写入新行。导出任务创建时锁定一个 data_version，
之后所有读取都走同一快照，生成过程中的数据变更不影响本次导出。
"""

import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);

-- 运单：同一运单的不同版本各占一行，valid_to 为 NULL 表示当前生效版本
CREATE TABLE IF NOT EXISTS waybills (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    waybill_no  TEXT NOT NULL,
    zone        TEXT NOT NULL,
    pieces      INTEGER NOT NULL,
    ship_date   TEXT NOT NULL,
    valid_from  INTEGER NOT NULL,
    valid_to    INTEGER            -- NULL = 当前版本
);

CREATE TABLE IF NOT EXISTS export_tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date_from    TEXT NOT NULL,
    date_to      TEXT NOT NULL,
    data_version INTEGER NOT NULL,  -- 任务锁定的数据版本
    status       TEXT NOT NULL DEFAULT 'RUNNING',  -- RUNNING / DONE
    page_size    INTEGER NOT NULL,
    total_rows   INTEGER NOT NULL,
    total_pieces INTEGER NOT NULL,
    total_pages  INTEGER NOT NULL,
    created_at   TEXT NOT NULL
);

-- 已完成的页：断点续传时跳过，同一页不会写第二次
CREATE TABLE IF NOT EXISTS export_pages (
    task_id       INTEGER NOT NULL,
    page_no       INTEGER NOT NULL,
    row_count     INTEGER NOT NULL,
    total_pieces  INTEGER NOT NULL,
    fragment_path TEXT NOT NULL,
    PRIMARY KEY (task_id, page_no)
);

-- 汇总产物（各库区 csv / 统计 / zip）
CREATE TABLE IF NOT EXISTS export_files (
    task_id      INTEGER NOT NULL,
    filename     TEXT NOT NULL,
    row_count    INTEGER NOT NULL,
    total_pieces INTEGER NOT NULL,
    path         TEXT NOT NULL,
    PRIMARY KEY (task_id, filename)
);
"""


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(conn):
    conn.executescript(SCHEMA)
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES ('data_version', 0)"
        )


def current_version(conn):
    row = conn.execute(
        "SELECT value FROM meta WHERE key = 'data_version'"
    ).fetchone()
    return row["value"]


def _bump_version(conn):
    conn.execute("UPDATE meta SET value = value + 1 WHERE key = 'data_version'")
    return current_version(conn)


# ---------- 运单维护（每次操作推进一个数据版本） ----------

def add_waybill(conn, waybill_no, zone, pieces, ship_date):
    with conn:
        v = _bump_version(conn)
        cur = conn.execute(
            "INSERT INTO waybills(waybill_no, zone, pieces, ship_date, valid_from)"
            " VALUES (?, ?, ?, ?, ?)",
            (waybill_no, zone, pieces, ship_date, v),
        )
    return cur.lastrowid


def update_pieces(conn, waybill_id, pieces):
    """修改件数：关闭旧版本行，写入新版本行。"""
    with conn:
        row = conn.execute(
            "SELECT * FROM waybills WHERE id = ? AND valid_to IS NULL",
            (waybill_id,),
        ).fetchone()
        if row is None:
            raise ValueError(f"运单不存在或已撤销: {waybill_id}")
        v = _bump_version(conn)
        conn.execute("UPDATE waybills SET valid_to = ? WHERE id = ?", (v, waybill_id))
        conn.execute(
            "INSERT INTO waybills(waybill_no, zone, pieces, ship_date, valid_from)"
            " VALUES (?, ?, ?, ?, ?)",
            (row["waybill_no"], row["zone"], pieces, row["ship_date"], v),
        )


def cancel_waybill(conn, waybill_id):
    """撤销运单：关闭当前版本行，快照查询自然不再看到它。"""
    with conn:
        v = _bump_version(conn)
        cur = conn.execute(
            "UPDATE waybills SET valid_to = ? WHERE id = ? AND valid_to IS NULL",
            (v, waybill_id),
        )
        if cur.rowcount == 0:
            raise ValueError(f"运单不存在或已撤销: {waybill_id}")


# ---------- 快照查询 ----------

def snapshot_rows(conn, version, date_from, date_to):
    """指定数据版本 + 日期范围内的运单明细，顺序固定（按 id）。"""
    return conn.execute(
        """
        SELECT id, waybill_no, zone, pieces, ship_date
        FROM waybills
        WHERE valid_from <= ?
          AND (valid_to IS NULL OR valid_to > ?)
          AND ship_date BETWEEN ? AND ?
        ORDER BY id
        """,
        (version, version, date_from, date_to),
    ).fetchall()


def current_waybills(conn):
    """维护页面用：当前版本的全部运单。"""
    return conn.execute(
        "SELECT id, waybill_no, zone, pieces, ship_date FROM waybills"
        " WHERE valid_to IS NULL ORDER BY id"
    ).fetchall()
