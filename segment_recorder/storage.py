from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from .util import now_iso


SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pid INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    note TEXT
);

CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id TEXT NOT NULL DEFAULT 'local',
    epoch_id TEXT NOT NULL,
    epoch_index INTEGER,
    sequence INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    sha256 TEXT NOT NULL,
    uri TEXT,
    source_path TEXT,
    archive_path TEXT,
    duration REAL NOT NULL DEFAULT 0,
    planned_at TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    completed_at TEXT,
    expected_size INTEGER,
    source_size INTEGER,
    archived_size INTEGER NOT NULL DEFAULT 0,
    source_mtime_ns INTEGER,
    status TEXT NOT NULL,
    present INTEGER NOT NULL DEFAULT 0,
    seen_count INTEGER NOT NULL DEFAULT 1,
    resume_count INTEGER NOT NULL DEFAULT 0,
    last_message TEXT,
    UNIQUE(epoch_id, sequence, sha256)
);

CREATE INDEX IF NOT EXISTS idx_segments_status ON segments(status);
CREATE INDEX IF NOT EXISTS idx_segments_logical ON segments(epoch_id, sequence);
CREATE INDEX IF NOT EXISTS idx_segments_present ON segments(present);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    run_id INTEGER,
    kind TEXT NOT NULL,
    epoch_id TEXT,
    sequence INTEGER,
    sha256 TEXT,
    message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_at ON events(id);
"""


class Store:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def commit(self) -> None:
        self.conn.commit()

    # ---- runs/events -------------------------------------------------

    def start_run(self, pid: int, note: str = "") -> int:
        cur = self.conn.execute(
            "INSERT INTO runs(pid, started_at, status, note) VALUES (?, ?, 'running', ?)",
            (pid, now_iso(), note),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def end_run(self, run_id: int | None, status: str = "stopped", note: str = "") -> None:
        if run_id is None:
            return
        self.conn.execute(
            "UPDATE runs SET ended_at=?, status=?, note=? WHERE id=?",
            (now_iso(), status, note, run_id),
        )
        self.conn.commit()

    def log_event(
        self,
        kind: str,
        message: str,
        *,
        run_id: int | None = None,
        epoch_id: str | None = None,
        sequence: int | None = None,
        sha256: str | None = None,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO events(at, run_id, kind, epoch_id, sequence, sha256, message)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (now_iso(), run_id, kind, epoch_id, sequence, sha256, message),
        )
        self.conn.commit()

    def recent_events(self, limit: int = 30) -> list[sqlite3.Row]:
        return list(
            self.conn.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        )

    # ---- segments ----------------------------------------------------

    def saved_by_sha(self, sha256: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM segments WHERE sha256=? AND status='saved' LIMIT 1",
            (sha256,),
        ).fetchone()

    def get_segment(self, segment_id: int) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM segments WHERE id=?", (segment_id,)
        ).fetchone()

    def find_open_logical(self, epoch_id: str, sequence: int) -> sqlite3.Row | None:
        return self.conn.execute(
            """
            SELECT * FROM segments
            WHERE epoch_id=? AND sequence=? AND status != 'saved'
            ORDER BY id DESC LIMIT 1
            """,
            (epoch_id, sequence),
        ).fetchone()

    def discover(
        self,
        *,
        epoch_id: str,
        sequence: int,
        sha256: str | None,
        uri: str,
        source_path: str,
        stream_id: str = "local",
        epoch_index: int | None = None,
        duration: float = 0.0,
        planned_at: str | None = None,
        expected_size: int | None = None,
    ) -> int:
        """登记清单中的一段；重复出现只增加 seen_count，不创建第二个收录任务。"""
        timestamp = now_iso()

        if sha256:
            existing = self.conn.execute(
                "SELECT * FROM segments WHERE epoch_id=? AND sequence=? AND sha256=?",
                (epoch_id, sequence, sha256),
            ).fetchone()
        else:
            existing = self.find_open_logical(epoch_id, sequence)

        if existing is not None:
            resolved_sha = sha256 or existing["sha256"]
            self.conn.execute(
                """
                UPDATE segments SET
                    sha256=?, uri=?, source_path=?, last_seen_at=?, present=1,
                    seen_count=seen_count + 1,
                    duration=CASE WHEN ? > 0 THEN ? ELSE duration END,
                    planned_at=COALESCE(?, planned_at),
                    expected_size=COALESCE(?, expected_size),
                    epoch_index=COALESCE(?, epoch_index)
                WHERE id=?
                """,
                (
                    resolved_sha,
                    uri,
                    source_path,
                    timestamp,
                    duration,
                    duration,
                    planned_at,
                    expected_size,
                    epoch_index,
                    existing["id"],
                ),
            )
            self.conn.commit()
            return int(existing["id"])

        revision_row = self.conn.execute(
            "SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision "
            "FROM segments WHERE epoch_id=? AND sequence=?",
            (epoch_id, sequence),
        ).fetchone()
        revision = int(revision_row["next_revision"])
        storage_sha = sha256 or f"pending-{epoch_id}-{sequence}-r{revision}"

        cur = self.conn.execute(
            """
            INSERT INTO segments(
                stream_id, epoch_id, epoch_index, sequence, revision, sha256,
                uri, source_path, duration, planned_at, first_seen_at, last_seen_at,
                expected_size, status, present, last_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', 1, ?)
            """,
            (
                stream_id,
                epoch_id,
                epoch_index,
                sequence,
                revision,
                storage_sha,
                uri,
                source_path,
                duration,
                planned_at,
                timestamp,
                timestamp,
                expected_size,
                "已在清单中发现，准备接收",
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def update_progress(
        self,
        segment_id: int,
        *,
        status: str | None = None,
        source_size: int | None = None,
        archived_size: int | None = None,
        expected_size: int | None = None,
        source_mtime_ns: int | None = None,
        message: str | None = None,
        increment_resume: bool = False,
    ) -> None:
        row = self.get_segment(segment_id)
        if row is None:
            return
        fields: dict[str, Any] = {}
        if status is not None:
            fields["status"] = status
        if source_size is not None:
            fields["source_size"] = source_size
        if archived_size is not None:
            fields["archived_size"] = archived_size
        if expected_size is not None:
            fields["expected_size"] = expected_size
        if source_mtime_ns is not None:
            fields["source_mtime_ns"] = source_mtime_ns
        if message is not None:
            fields["last_message"] = message

        assignments = [f"{key}=?" for key in fields]
        values = list(fields.values())
        if increment_resume:
            assignments.append("resume_count=resume_count+1")
        assignments.append("last_seen_at=?")
        values.append(now_iso())
        values.append(segment_id)
        self.conn.execute(
            f"UPDATE segments SET {', '.join(assignments)} WHERE id=?", values
        )
        self.conn.commit()

    def mark_saved(
        self,
        segment_id: int,
        *,
        sha256: str,
        archive_path: str,
        size: int,
        duration: float | None = None,
        message: str = "已完整保存并校验",
    ) -> None:
        self.conn.execute(
            """
            UPDATE segments SET
                status='saved', sha256=?, archive_path=?, archived_size=?,
                source_size=?, completed_at=?, last_seen_at=?, present=1,
                duration=CASE WHEN ? IS NOT NULL AND ? > 0 THEN ? ELSE duration END,
                last_message=?
            WHERE id=?
            """,
            (
                sha256,
                archive_path,
                size,
                size,
                now_iso(),
                now_iso(),
                duration,
                duration,
                duration,
                message,
                segment_id,
            ),
        )
        self.conn.commit()

    def previously_present(self) -> list[sqlite3.Row]:
        return list(
            self.conn.execute("SELECT * FROM segments WHERE present=1").fetchall()
        )

    def mark_present(self, segment_id: int, present: bool = True) -> None:
        self.conn.execute(
            "UPDATE segments SET present=? WHERE id=?",
            (1 if present else 0, segment_id),
        )
        self.conn.commit()

    def incomplete_segments(self) -> list[sqlite3.Row]:
        return list(
            self.conn.execute(
                """
                SELECT * FROM segments
                WHERE status NOT IN ('saved', 'lost')
                ORDER BY id
                """
            ).fetchall()
        )

    def saved_segments(self) -> list[sqlite3.Row]:
        return list(
            self.conn.execute(
                """
                SELECT * FROM segments
                WHERE status='saved' AND archive_path IS NOT NULL
                ORDER BY epoch_index, epoch_id, sequence, id
                """
            ).fetchall()
        )

    def status_counts(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT status, COUNT(*) AS n FROM segments GROUP BY status"
        ).fetchall()
        counts = {row["status"]: int(row["n"]) for row in rows}
        counts["total"] = sum(counts.values())
        return counts
