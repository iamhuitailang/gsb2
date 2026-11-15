"""SQLite 存储层：事件入库、车牌更正、全量重算、查询接口。

设计要点：
- events 以 (停车场, 闸机号, 流水号) 为唯一键，重复导入自动忽略，
  同一条事件永远不会被重复配对。
- 更正不覆盖原始车牌：raw_plate 保留导入原样，corrections 追加留痕，
  生效车牌取该事件最近一次更正，没有更正则取原始车牌。
- 每次导入 / 更正后全量重算配对，结果以"重算批次 + 配对历史"追加保存，
  因此任何事件都能追溯它曾经 / 后来和哪条事件配过对。
"""

from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime

from .pairing import ENTRY, EXIT, Event, Pair, pair_events

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY,
    lot         TEXT NOT NULL,
    gate        TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    raw_plate   TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    event_time  TEXT NOT NULL,
    source_file TEXT NOT NULL,
    import_batch_id INTEGER NOT NULL,
    imported_at TEXT NOT NULL,
    UNIQUE(lot, gate, seq)
);

CREATE TABLE IF NOT EXISTS corrections (
    id         INTEGER PRIMARY KEY,
    event_id   INTEGER NOT NULL REFERENCES events(id),
    old_plate  TEXT NOT NULL,
    new_plate  TEXT NOT NULL,
    reason     TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
    id          INTEGER PRIMARY KEY,
    filename    TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    total_rows  INTEGER NOT NULL,
    inserted    INTEGER NOT NULL,
    duplicates  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recompute_runs (
    id         INTEGER PRIMARY KEY,
    reason     TEXT NOT NULL,
    ref_id     INTEGER,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pair_history (
    id             INTEGER PRIMARY KEY,
    run_id         INTEGER NOT NULL REFERENCES recompute_runs(id),
    entry_event_id INTEGER NOT NULL,
    exit_event_id  INTEGER NOT NULL,
    lot            TEXT NOT NULL,
    plate          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pair_history_run ON pair_history(run_id);
CREATE INDEX IF NOT EXISTS idx_corrections_event ON corrections(event_id);
"""

# 生效车牌：优先取最近一次更正，否则用导入时的原始车牌
EFFECTIVE_PLATE_SQL = """
SELECT e.*,
       COALESCE(
           (SELECT c.new_plate FROM corrections c
             WHERE c.event_id = e.id ORDER BY c.id DESC LIMIT 1),
           e.raw_plate
       ) AS plate
FROM events e
"""


def parse_event_time(value: str) -> datetime:
    """兼容 'YYYY-MM-DD HH:MM:SS' 与 ISO 'T' 两种写法。"""
    value = value.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    raise ValueError(f"无法解析的事件时间: {value!r}")


@dataclass
class ImportResult:
    batch_id: int
    total_rows: int
    inserted: int
    duplicates: int


class _LockedStorage(type):
    """元类：公开方法自动持锁，保证多线程下 SQLite 访问串行化。"""

    def __new__(mcs, name, bases, namespace):
        cls = super().__new__(mcs, name, bases, namespace)
        for attr_name, attr in list(namespace.items()):
            if attr_name.startswith("_") or not callable(attr):
                continue

            def make_locked(fn):
                def wrapper(self, *args, **kwargs):
                    with self._lock:
                        return fn(self, *args, **kwargs)

                wrapper.__name__ = attr_name
                wrapper.__doc__ = attr.__doc__
                return wrapper

            setattr(cls, attr_name, make_locked(attr))
        return cls


class Storage(metaclass=_LockedStorage):
    def __init__(self, db_path: str):
        self.db_path = db_path
        # HTTP 服务多线程共用本对象：关闭同线程限制，用 RLock 串行化访问
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        with self._lock:
            self.conn.executescript(SCHEMA)
            self.conn.commit()

    def close(self):
        self.conn.close()

    # ------------------------------------------------------------------ #
    # 导入
    # ------------------------------------------------------------------ #
    def import_rows(self, filename: str, rows: list[dict]) -> ImportResult:
        """导入解析后的事件行。重复 (停车场, 闸机号, 流水号) 计为 duplicates。"""
        now = datetime.now().isoformat(timespec="seconds")
        cur = self.conn.execute(
            "INSERT INTO import_batches(filename, imported_at, total_rows, inserted, duplicates)"
            " VALUES (?, ?, ?, 0, 0)",
            (filename, now, len(rows)),
        )
        batch_id = cur.lastrowid

        inserted = 0
        duplicates = 0
        for row in rows:
            event_time = parse_event_time(row["event_time"])
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO events"
                "(lot, gate, seq, raw_plate, event_type, event_time,"
                " source_file, import_batch_id, imported_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    row["lot"],
                    row["gate"],
                    int(row["seq"]),
                    row["plate"],
                    row["event_type"],
                    event_time.isoformat(sep=" "),
                    filename,
                    batch_id,
                    now,
                ),
            )
            if cur.rowcount:
                inserted += 1
            else:
                duplicates += 1

        self.conn.execute(
            "UPDATE import_batches SET inserted=?, duplicates=? WHERE id=?",
            (inserted, duplicates, batch_id),
        )
        self.conn.commit()
        if inserted:
            # 有新事件才需要重算；纯重复文件不改变配对结果
            self.recompute(reason="import", ref_id=batch_id)
        return ImportResult(batch_id, len(rows), inserted, duplicates)

    # ------------------------------------------------------------------ #
    # 车牌更正
    # ------------------------------------------------------------------ #
    def correct_plate(self, event_id: int, new_plate: str, reason: str | None) -> dict:
        row = self.conn.execute(
            "SELECT * FROM events WHERE id=?", (event_id,)
        ).fetchone()
        if row is None:
            raise KeyError(f"事件不存在: {event_id}")
        effective = self._effective_plate(row["id"], row["raw_plate"])
        new_plate = new_plate.strip().upper()
        if not new_plate:
            raise ValueError("新车牌不能为空")
        if new_plate == effective:
            raise ValueError("新车牌与当前生效车牌相同，无需更正")

        now = datetime.now().isoformat(timespec="seconds")
        cur = self.conn.execute(
            "INSERT INTO corrections(event_id, old_plate, new_plate, reason, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (event_id, effective, new_plate, reason, now),
        )
        correction_id = cur.lastrowid
        self.conn.commit()
        # 更正后全量重算：受影响的两个车牌的停车记录与未配对清单一起更新
        self.recompute(reason="correction", ref_id=correction_id)
        return self.get_event(event_id)

    def _effective_plate(self, event_id: int, raw_plate: str) -> str:
        row = self.conn.execute(
            "SELECT new_plate FROM corrections WHERE event_id=? ORDER BY id DESC LIMIT 1",
            (event_id,),
        ).fetchone()
        return row["new_plate"] if row else raw_plate

    # ------------------------------------------------------------------ #
    # 配对重算
    # ------------------------------------------------------------------ #
    def _load_events(self) -> list[Event]:
        rows = self.conn.execute(EFFECTIVE_PLATE_SQL).fetchall()
        return [
            Event(
                event_id=r["id"],
                lot=r["lot"],
                gate=r["gate"],
                seq=r["seq"],
                plate=r["plate"],
                event_type=r["event_type"],
                event_time=datetime.fromisoformat(r["event_time"]),
            )
            for r in rows
        ]

    def recompute(self, reason: str, ref_id: int | None = None) -> int:
        """全量重算配对并追加一个重算批次，返回新批次 id。"""
        now = datetime.now().isoformat(timespec="seconds")
        cur = self.conn.execute(
            "INSERT INTO recompute_runs(reason, ref_id, created_at) VALUES (?, ?, ?)",
            (reason, ref_id, now),
        )
        run_id = cur.lastrowid

        pairs, _unpaired = pair_events(self._load_events())
        self.conn.executemany(
            "INSERT INTO pair_history(run_id, entry_event_id, exit_event_id, lot, plate)"
            " VALUES (?, ?, ?, ?, ?)",
            [
                (run_id, p.entry_id, p.exit_id, p.lot, p.plate) for p in pairs
            ],
        )
        self.conn.commit()
        return run_id

    def _latest_run_id(self) -> int | None:
        row = self.conn.execute(
            "SELECT MAX(id) AS rid FROM recompute_runs"
        ).fetchone()
        return row["rid"]

    # ------------------------------------------------------------------ #
    # 查询：停车记录 / 未配对
    # ------------------------------------------------------------------ #
    def list_pairs(self, lot: str | None = None, plate: str | None = None) -> list[dict]:
        run_id = self._latest_run_id()
        if run_id is None:
            return []
        sql = (
            "SELECT ph.id AS pair_id, ph.plate, ph.lot,"
            "  en.id AS entry_id, en.gate AS entry_gate, en.seq AS entry_seq,"
            "  en.event_time AS entry_time, en.raw_plate AS entry_raw_plate,"
            "  ex.id AS exit_id, ex.gate AS exit_gate, ex.seq AS exit_seq,"
            "  ex.event_time AS exit_time, ex.raw_plate AS exit_raw_plate"
            " FROM pair_history ph"
            " JOIN events en ON en.id = ph.entry_event_id"
            " JOIN events ex ON ex.id = ph.exit_event_id"
            " WHERE ph.run_id = ?"
        )
        params: list = [run_id]
        if lot:
            sql += " AND ph.lot = ?"
            params.append(lot)
        if plate:
            sql += " AND ph.plate = ?"
            params.append(plate.strip().upper())
        sql += " ORDER BY en.event_time"
        result = []
        for r in self.conn.execute(sql, params):
            d = dict(r)
            d["duration_seconds"] = int(
                (
                    datetime.fromisoformat(d["exit_time"])
                    - datetime.fromisoformat(d["entry_time"])
                ).total_seconds()
            )
            result.append(d)
        return result

    def list_unpaired(self, lot: str | None = None, plate: str | None = None) -> list[dict]:
        run_id = self._latest_run_id()
        sql = (
            "SELECT e.id, e.lot, e.gate, e.seq, e.raw_plate, e.event_type,"
            "  e.event_time, e.source_file, v.plate AS effective_plate"
            " FROM (" + EFFECTIVE_PLATE_SQL + ") v JOIN events e ON e.id = v.id"
        )
        params: list = []
        if run_id is not None:
            sql += (
                " WHERE e.id NOT IN ("
                " SELECT entry_event_id FROM pair_history WHERE run_id=?"
                " UNION"
                " SELECT exit_event_id FROM pair_history WHERE pair_history.run_id=?)"
            )
            params.extend([run_id, run_id])
        if lot:
            sql += (" AND " if run_id is not None else " WHERE ") + " e.lot = ?"
            params.append(lot)
        if plate:
            sql += (" AND " if (run_id is not None or lot) else " WHERE ")
            sql += " v.plate = ?"
            params.append(plate.strip().upper())
        sql += " ORDER BY e.event_time"
        rows = [dict(r) for r in self.conn.execute(sql, params)]
        # 附带配对轨迹：未配对事件后来 / 曾经跟谁配过
        for row in rows:
            row["trail"] = self.pairing_trail(row["id"])
        return rows

    # ------------------------------------------------------------------ #
    # 查询：事件详情、更正记录、配对轨迹
    # ------------------------------------------------------------------ #
    def list_events(self, lot: str | None = None, plate: str | None = None) -> list[dict]:
        sql = (
            "SELECT v.id, v.lot, v.gate, v.seq, v.raw_plate, v.event_type,"
            "  v.event_time, v.source_file, v.import_batch_id, v.imported_at,"
            "  v.plate AS effective_plate"
            " FROM (" + EFFECTIVE_PLATE_SQL + ") v"
        )
        conds, params = [], []
        if lot:
            conds.append("v.lot = ?")
            params.append(lot)
        if plate:
            conds.append("v.plate = ?")
            params.append(plate.strip().upper())
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        sql += " ORDER BY v.event_time, v.gate, v.seq"
        return [dict(r) for r in self.conn.execute(sql, params)]

    def get_event(self, event_id: int) -> dict:
        row = self.conn.execute(
            "SELECT v.*, v.plate AS effective_plate FROM ("
            + EFFECTIVE_PLATE_SQL
            + ") v WHERE v.id=?",
            (event_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"事件不存在: {event_id}")
        d = dict(row)
        d["corrections"] = [
            dict(r)
            for r in self.conn.execute(
                "SELECT * FROM corrections WHERE event_id=? ORDER BY id", (event_id,)
            )
        ]
        d["trail"] = self.pairing_trail(event_id)
        return d

    def pairing_trail(self, event_id: int) -> list[dict]:
        """事件在历次重算中的配对轨迹（含当前未配对但曾经配过的情况）。"""
        rows = self.conn.execute(
            "SELECT ph.run_id, rr.reason, rr.created_at AS run_at,"
            "  ph.entry_event_id, ph.exit_event_id"
            " FROM pair_history ph"
            " JOIN recompute_runs rr ON rr.id = ph.run_id"
            " WHERE ph.entry_event_id=? OR ph.exit_event_id=?"
            " ORDER BY ph.run_id",
            (event_id, event_id),
        ).fetchall()
        trail = []
        for r in rows:
            partner_id = (
                r["exit_event_id"]
                if r["entry_event_id"] == event_id
                else r["entry_event_id"]
            )
            partner = self.conn.execute(
                "SELECT id, lot, gate, seq, event_type, event_time FROM events WHERE id=?",
                (partner_id,),
            ).fetchone()
            trail.append(
                {
                    "run_id": r["run_id"],
                    "run_reason": r["reason"],
                    "run_at": r["run_at"],
                    "role": "entry" if r["entry_event_id"] == event_id else "exit",
                    "partner": dict(partner),
                }
            )
        return trail

    # ------------------------------------------------------------------ #
    # 每日统计 / 导入批次
    # ------------------------------------------------------------------ #
    def daily_stats(self) -> list[dict]:
        """每日离场次数按出场日期统计；停留时长取配对后的实际时间差。"""
        pairs = self.list_pairs()
        agg: dict[tuple[str, str], dict] = {}
        for p in pairs:
            exit_date = p["exit_time"][:10]
            key = (exit_date, p["lot"])
            bucket = agg.setdefault(
                key,
                {"exit_date": exit_date, "lot": p["lot"], "exit_count": 0,
                 "total_seconds": 0},
            )
            bucket["exit_count"] += 1
            bucket["total_seconds"] += p["duration_seconds"]
        result = []
        for bucket in sorted(agg.values(), key=lambda b: (b["exit_date"], b["lot"])):
            total = bucket.pop("total_seconds")
            bucket["avg_duration_minutes"] = round(
                total / bucket["exit_count"] / 60, 1
            )
            result.append(bucket)
        return result

    def list_batches(self) -> list[dict]:
        return [
            dict(r)
            for r in self.conn.execute(
                "SELECT * FROM import_batches ORDER BY id"
            )
        ]
