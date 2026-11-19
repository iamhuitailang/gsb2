"""SQLite persistence for scans, findings, reviews and baselines.

The database never stores the matched secret text.  Findings only carry a
redacted preview, metadata, and keyed fingerprints.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence

from .utils import canonical_json, to_iso, utc_now

SCHEMA = """
CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    root_real TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    ruleset_version TEXT NOT NULL,
    ruleset_snapshot TEXT NOT NULL,
    options TEXT NOT NULL,
    stats TEXT NOT NULL DEFAULT '{}',
    prev_scan_id TEXT
);

CREATE TABLE IF NOT EXISTS skipped_files (
    scan_id TEXT NOT NULL,
    path TEXT NOT NULL,
    reason TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (scan_id, path)
);

CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    match_key TEXT NOT NULL,
    family TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_name TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    rule_semantic_hash TEXT NOT NULL,
    severity TEXT NOT NULL,
    path TEXT NOT NULL,
    line INTEGER NOT NULL,
    column_no INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    preview TEXT NOT NULL,
    context_hash TEXT NOT NULL,
    secret_length INTEGER NOT NULL,
    secret_entropy REAL NOT NULL,
    is_block INTEGER NOT NULL DEFAULT 0,
    block_line_count INTEGER NOT NULL DEFAULT 1,
    terminated INTEGER NOT NULL DEFAULT 1,
    overlaps TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    verification TEXT NOT NULL DEFAULT 'verified',
    verification_reason TEXT NOT NULL DEFAULT '',
    location_source TEXT NOT NULL DEFAULT 'scan',
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_scan_fp
    ON findings(scan_id, fingerprint, path, line, rule_id);
CREATE INDEX IF NOT EXISTS idx_findings_scan ON findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_fp ON findings(fingerprint);

CREATE TABLE IF NOT EXISTS reviews (
    fingerprint TEXT NOT NULL,
    family TEXT NOT NULL,
    semantic_hash TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ignore_until TEXT,
    PRIMARY KEY (fingerprint, family, semantic_hash)
);
CREATE INDEX IF NOT EXISTS idx_reviews_fp ON reviews(fingerprint, family);

CREATE TABLE IF NOT EXISTS review_events (
    id TEXT PRIMARY KEY,
    reviewed_at TEXT NOT NULL,
    scan_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    family TEXT NOT NULL,
    semantic_hash TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    ignore_until TEXT
);

CREATE TABLE IF NOT EXISTS baselines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    root_real TEXT NOT NULL,
    scan_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ruleset_version TEXT NOT NULL,
    ruleset_snapshot TEXT NOT NULL,
    finding_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS baseline_findings (
    baseline_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    family TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_name TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    rule_semantic_hash TEXT NOT NULL,
    severity TEXT NOT NULL,
    path TEXT NOT NULL,
    line INTEGER NOT NULL,
    column_no INTEGER NOT NULL,
    context_hash TEXT NOT NULL,
    preview TEXT NOT NULL,
    is_block INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (baseline_id, fingerprint, path, line)
);
CREATE INDEX IF NOT EXISTS idx_baseline_fp ON baseline_findings(baseline_id, fingerprint);
"""

SCAN_FIELDS = {
    "status",
    "started_at",
    "finished_at",
    "error",
    "stats",
    "prev_scan_id",
}

FINDING_COLUMNS = (
    "id",
    "scan_id",
    "fingerprint",
    "match_key",
    "family",
    "rule_id",
    "rule_name",
    "rule_version",
    "rule_semantic_hash",
    "severity",
    "path",
    "line",
    "column_no",
    "end_column",
    "preview",
    "context_hash",
    "secret_length",
    "secret_entropy",
    "is_block",
    "block_line_count",
    "terminated",
    "overlaps",
    "status",
    "verification",
    "verification_reason",
    "location_source",
    "created_at",
)


def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def _finding_values(finding: Dict[str, Any]) -> tuple:
    return (
        finding["id"],
        finding["scan_id"],
        finding["fingerprint"],
        finding["match_key"],
        finding["family"],
        finding["rule_id"],
        finding["rule_name"],
        finding["rule_version"],
        finding["rule_semantic_hash"],
        finding["severity"],
        finding["path"],
        int(finding["line"]),
        int(finding["column"]),
        int(finding["end_column"]),
        finding["preview"],
        finding["context_hash"],
        int(finding["secret_length"]),
        float(finding["secret_entropy"]),
        1 if finding.get("block") else 0,
        int(finding.get("block_line_count", 1)),
        1 if finding.get("terminated", True) else 0,
        canonical_json(list(finding.get("overlaps") or [])),
        finding["status"],
        finding.get("verification", "verified"),
        finding.get("verification_reason", ""),
        finding.get("location_source", "scan"),
        finding["created_at"],
    )


class Store:
    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        self._init_lock = threading.Lock()
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self._initialise()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def _initialise(self) -> None:
        with self._init_lock:
            connection = self._connect()
            try:
                connection.execute("PRAGMA journal_mode = WAL")
                connection.executescript(SCHEMA)
            finally:
                connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.execute("COMMIT")
        except BaseException:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            connection.close()

    @contextmanager
    def reader(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    # ----------------------------------------------------------------- scans
    def create_scan(
        self,
        root: str,
        root_real: str,
        ruleset_version: str,
        ruleset_snapshot: Dict[str, Any],
        options: Dict[str, Any],
        status: str = "queued",
    ) -> Dict[str, Any]:
        scan_id = uuid.uuid4().hex
        now = to_iso(utc_now())
        with self.transaction() as connection:
            connection.execute(
                "INSERT INTO scans (id, root, root_real, status, created_at, ruleset_version,"
                " ruleset_snapshot, options, stats) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    scan_id,
                    root,
                    root_real,
                    status,
                    now,
                    ruleset_version,
                    canonical_json(ruleset_snapshot),
                    canonical_json(options),
                    "{}",
                ),
            )
        return self.get_scan(scan_id) or {}

    def update_scan(self, scan_id: str, **fields: Any) -> None:
        unknown = set(fields) - SCAN_FIELDS
        if unknown:
            raise ValueError("unknown scan fields: %s" % ", ".join(sorted(unknown)))
        if not fields:
            return
        assignments = ", ".join("%s = ?" % key for key in fields)
        values = [
            canonical_json(value) if key == "stats" and not isinstance(value, str) else value
            for key, value in fields.items()
        ]
        with self.transaction() as connection:
            connection.execute(
                "UPDATE scans SET %s WHERE id = ?" % assignments, values + [scan_id]
            )

    def get_scan(self, scan_id: str) -> Optional[Dict[str, Any]]:
        with self.reader() as connection:
            row = connection.execute("SELECT * FROM scans WHERE id = ?", (scan_id,)).fetchone()
        return self._scan_row(row) if row else None

    def list_scans(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self.reader() as connection:
            rows = connection.execute(
                "SELECT * FROM scans ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [self._scan_row(row) for row in rows]

    def latest_completed_scan(self, root_real: str) -> Optional[Dict[str, Any]]:
        with self.reader() as connection:
            row = connection.execute(
                "SELECT * FROM scans WHERE root_real = ? AND status = 'completed'"
                " ORDER BY created_at DESC LIMIT 1",
                (root_real,),
            ).fetchone()
        return self._scan_row(row) if row else None

    def previous_completed_scan(self, root_real: str, scan_id: str) -> Optional[Dict[str, Any]]:
        with self.reader() as connection:
            row = connection.execute(
                "SELECT * FROM scans WHERE root_real = ? AND status = 'completed' AND id != ?"
                " ORDER BY created_at DESC LIMIT 1",
                (root_real, scan_id),
            ).fetchone()
        return self._scan_row(row) if row else None

    def _scan_row(self, row: sqlite3.Row) -> Dict[str, Any]:
        item = _row_to_dict(row)
        item["ruleset_snapshot"] = json.loads(item["ruleset_snapshot"])
        item["options"] = json.loads(item["options"])
        item["stats"] = json.loads(item["stats"] or "{}")
        return item

    # ------------------------------------------------------------- skip list
    def replace_skipped(self, scan_id: str, skipped: Iterable[Dict[str, Any]]) -> None:
        with self.transaction() as connection:
            connection.execute("DELETE FROM skipped_files WHERE scan_id = ?", (scan_id,))
            connection.executemany(
                "INSERT OR REPLACE INTO skipped_files (scan_id, path, reason, size, message)"
                " VALUES (?, ?, ?, ?, ?)",
                [
                    (
                        scan_id,
                        item["path"],
                        item["reason"],
                        int(item.get("size", 0)),
                        item.get("message", ""),
                    )
                    for item in skipped
                ],
            )

    def list_skipped(self, scan_id: str) -> List[Dict[str, Any]]:
        with self.reader() as connection:
            rows = connection.execute(
                "SELECT path, reason, size, message FROM skipped_files WHERE scan_id = ?"
                " ORDER BY path",
                (scan_id,),
            ).fetchall()
        return [_row_to_dict(row) for row in rows]

    # -------------------------------------------------------------- findings
    def insert_findings(self, findings: Sequence[Dict[str, Any]]) -> None:
        if not findings:
            return
        with self.transaction() as connection:
            self._insert_rows(connection, findings)

    def replace_scan_findings(self, scan_id: str, findings: Sequence[Dict[str, Any]]) -> None:
        with self.transaction() as connection:
            connection.execute("DELETE FROM findings WHERE scan_id = ?", (scan_id,))
            self._insert_rows(connection, findings)

    def _insert_rows(self, connection: sqlite3.Connection, findings: Sequence[Dict[str, Any]]) -> None:
        if not findings:
            return
        connection.executemany(
            "INSERT OR REPLACE INTO findings (%s) VALUES (%s)"
            % (", ".join(FINDING_COLUMNS), ", ".join(["?"] * len(FINDING_COLUMNS))),
            [_finding_values(finding) for finding in findings],
        )

    def get_finding(self, finding_id: str) -> Optional[Dict[str, Any]]:
        with self.reader() as connection:
            row = connection.execute(
                "SELECT * FROM findings WHERE id = ?", (finding_id,)
            ).fetchone()
        return self._finding_row(row) if row else None

    def list_findings(self, scan_id: str) -> List[Dict[str, Any]]:
        with self.reader() as connection:
            rows = connection.execute(
                "SELECT * FROM findings WHERE scan_id = ?"
                " ORDER BY path, line, column_no, rule_id",
                (scan_id,),
            ).fetchall()
        return [self._finding_row(row) for row in rows]

    def detected_findings(self, scan_id: str) -> List[Dict[str, Any]]:
        with self.reader() as connection:
            rows = connection.execute(
                "SELECT * FROM findings WHERE scan_id = ? AND status IN ('new', 'persistent')"
                " ORDER BY path, line, column_no, rule_id",
                (scan_id,),
            ).fetchall()
        return [self._finding_row(row) for row in rows]

    def _finding_row(self, row: sqlite3.Row) -> Dict[str, Any]:
        item = _row_to_dict(row)
        item["overlaps"] = json.loads(item["overlaps"] or "[]")
        item["block"] = bool(item.pop("is_block"))
        item["terminated"] = bool(item["terminated"])
        return item

    # --------------------------------------------------------------- reviews
    def all_reviews(self) -> List[Dict[str, Any]]:
        with self.reader() as connection:
            rows = connection.execute(
                "SELECT * FROM reviews ORDER BY updated_at DESC"
            ).fetchall()
        return [_row_to_dict(row) for row in rows]

    def get_review(
        self, fingerprint: str, family: str, semantic_hash: str
    ) -> Optional[Dict[str, Any]]:
        with self.reader() as connection:
            row = connection.execute(
                "SELECT * FROM reviews WHERE fingerprint = ? AND family = ? AND semantic_hash = ?",
                (fingerprint, family, semantic_hash),
            ).fetchone()
        return _row_to_dict(row) if row else None

    def reviews_for_fingerprint(self, fingerprint: str, family: str) -> List[Dict[str, Any]]:
        with self.reader() as connection:
            rows = connection.execute(
                "SELECT * FROM reviews WHERE fingerprint = ? AND family = ?"
                " ORDER BY updated_at DESC",
                (fingerprint, family),
            ).fetchall()
        return [_row_to_dict(row) for row in rows]

    def upsert_review(
        self,
        fingerprint: str,
        family: str,
        semantic_hash: str,
        decision: str,
        reason: str,
        actor: str,
        ignore_until: Optional[str],
        now: Optional[str] = None,
    ) -> Dict[str, Any]:
        timestamp = now or to_iso(utc_now())
        with self.transaction() as connection:
            existing = connection.execute(
                "SELECT created_at FROM reviews WHERE fingerprint = ? AND family = ?"
                " AND semantic_hash = ?",
                (fingerprint, family, semantic_hash),
            ).fetchone()
            created = existing["created_at"] if existing else timestamp
            connection.execute(
                "INSERT INTO reviews (fingerprint, family, semantic_hash, decision, reason, actor,"
                " created_at, updated_at, ignore_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(fingerprint, family, semantic_hash) DO UPDATE SET"
                " decision = excluded.decision, reason = excluded.reason, actor = excluded.actor,"
                " updated_at = excluded.updated_at, ignore_until = excluded.ignore_until",
                (
                    fingerprint,
                    family,
                    semantic_hash,
                    decision,
                    reason,
                    actor,
                    created,
                    timestamp,
                    ignore_until,
                ),
            )
            row = connection.execute(
                "SELECT * FROM reviews WHERE fingerprint = ? AND family = ? AND semantic_hash = ?",
                (fingerprint, family, semantic_hash),
            ).fetchone()
        return _row_to_dict(row)

    def delete_review(self, fingerprint: str, family: str, semantic_hash: str) -> bool:
        with self.transaction() as connection:
            cursor = connection.execute(
                "DELETE FROM reviews WHERE fingerprint = ? AND family = ? AND semantic_hash = ?",
                (fingerprint, family, semantic_hash),
            )
        return cursor.rowcount > 0

    def add_review_event(
        self,
        scan_id: str,
        finding_id: str,
        fingerprint: str,
        family: str,
        semantic_hash: str,
        decision: str,
        reason: str,
        actor: str,
        ignore_until: Optional[str],
        now: Optional[str] = None,
    ) -> None:
        with self.transaction() as connection:
            connection.execute(
                "INSERT INTO review_events (id, reviewed_at, scan_id, finding_id, fingerprint,"
                " family, semantic_hash, decision, reason, actor, ignore_until)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    uuid.uuid4().hex,
                    now or to_iso(utc_now()),
                    scan_id,
                    finding_id,
                    fingerprint,
                    family,
                    semantic_hash,
                    decision,
                    reason,
                    actor,
                    ignore_until,
                ),
            )

    def review_events(self, limit: int = 200) -> List[Dict[str, Any]]:
        with self.reader() as connection:
            rows = connection.execute(
                "SELECT * FROM review_events ORDER BY reviewed_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [_row_to_dict(row) for row in rows]

    # -------------------------------------------------------------- baselines
    def create_baseline(
        self,
        name: str,
        note: str,
        root_real: str,
        scan_id: str,
        ruleset_version: str,
        ruleset_snapshot: Dict[str, Any],
        findings: Sequence[Dict[str, Any]],
    ) -> Dict[str, Any]:
        baseline_id = uuid.uuid4().hex
        now = to_iso(utc_now())
        with self.transaction() as connection:
            connection.execute(
                "INSERT INTO baselines (id, name, note, root_real, scan_id, created_at,"
                " ruleset_version, ruleset_snapshot, finding_count)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    baseline_id,
                    name,
                    note,
                    root_real,
                    scan_id,
                    now,
                    ruleset_version,
                    canonical_json(ruleset_snapshot),
                    len(findings),
                ),
            )
            connection.executemany(
                "INSERT OR REPLACE INTO baseline_findings (baseline_id, fingerprint, family,"
                " rule_id, rule_name, rule_version, rule_semantic_hash, severity, path, line,"
                " column_no, context_hash, preview, is_block)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        baseline_id,
                        finding["fingerprint"],
                        finding["family"],
                        finding["rule_id"],
                        finding["rule_name"],
                        finding["rule_version"],
                        finding["rule_semantic_hash"],
                        finding["severity"],
                        finding["path"],
                        int(finding["line"]),
                        int(finding["column"]),
                        finding["context_hash"],
                        finding["preview"],
                        1 if finding.get("block") else 0,
                    )
                    for finding in findings
                ],
            )
        return self.get_baseline(baseline_id) or {}

    def get_baseline(self, baseline_id: str) -> Optional[Dict[str, Any]]:
        with self.reader() as connection:
            row = connection.execute(
                "SELECT * FROM baselines WHERE id = ?", (baseline_id,)
            ).fetchone()
        if not row:
            return None
        item = _row_to_dict(row)
        item["ruleset_snapshot"] = json.loads(item["ruleset_snapshot"])
        return item

    def list_baselines(self) -> List[Dict[str, Any]]:
        with self.reader() as connection:
            rows = connection.execute(
                "SELECT id, name, note, root_real, scan_id, created_at, ruleset_version,"
                " finding_count FROM baselines ORDER BY created_at DESC"
            ).fetchall()
        return [_row_to_dict(row) for row in rows]

    def baseline_findings(self, baseline_id: str) -> List[Dict[str, Any]]:
        with self.reader() as connection:
            rows = connection.execute(
                "SELECT * FROM baseline_findings WHERE baseline_id = ?"
                " ORDER BY path, line, rule_id",
                (baseline_id,),
            ).fetchall()
        result = []
        for row in rows:
            item = _row_to_dict(row)
            item["block"] = bool(item.pop("is_block"))
            result.append(item)
        return result

    def delete_baseline(self, baseline_id: str) -> bool:
        with self.transaction() as connection:
            connection.execute(
                "DELETE FROM baseline_findings WHERE baseline_id = ?", (baseline_id,)
            )
            cursor = connection.execute("DELETE FROM baselines WHERE id = ?", (baseline_id,))
        return cursor.rowcount > 0

    # ------------------------------------------------------------ housekeeping
    def delete_scan(self, scan_id: str) -> None:
        with self.transaction() as connection:
            connection.execute("DELETE FROM findings WHERE scan_id = ?", (scan_id,))
            connection.execute("DELETE FROM skipped_files WHERE scan_id = ?", (scan_id,))
            connection.execute("DELETE FROM scans WHERE id = ?", (scan_id,))
