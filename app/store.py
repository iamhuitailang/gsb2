"""Storage for organisations, role assignments, audit records and the
separate local audit baseline.

The baseline lives in its own SQLite database file and is ATTACHed to the
main connection.  A role change, its audit record and the corresponding
baseline commitment are therefore committed in a single SQLite
transaction: either all three exist or none of them do.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote

from .canonical import (
    GENESIS_HASH,
    PAYLOAD_FIELDS,
    canonical_json,
    contains_sensitive,
    payload_digest,
    record_hash,
    redact,
    utc_now_iso,
)

MAIN_SCHEMA = """
CREATE TABLE IF NOT EXISTS orgs (
    org_id     TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    rule_set   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
    admin_id      TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    org_id        TEXT REFERENCES orgs(org_id),
    password_hash TEXT NOT NULL,
    is_super      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_assignments (
    org_id     TEXT NOT NULL,
    subject    TEXT NOT NULL,
    role       TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    PRIMARY KEY (org_id, subject, role)
);

CREATE TABLE IF NOT EXISTS org_heads (
    org_id    TEXT PRIMARY KEY,
    last_seq  INTEGER NOT NULL DEFAULT 0,
    last_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_records (
    audit_id   TEXT PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES orgs(org_id),
    seq        INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    action     TEXT NOT NULL,
    outcome    TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
    actor      TEXT NOT NULL,
    target     TEXT NOT NULL,
    role       TEXT,
    changes    TEXT NOT NULL,
    rule_set   TEXT NOT NULL,
    reason     TEXT,
    detail     TEXT NOT NULL,
    prev_hash   TEXT NOT NULL,
    digest      TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    UNIQUE (org_id, seq)
);

CREATE INDEX IF NOT EXISTS audit_records_org_seq
    ON audit_records (org_id, seq);

CREATE TRIGGER IF NOT EXISTS audit_records_no_update
BEFORE UPDATE ON audit_records
BEGIN
    SELECT RAISE(ABORT, 'audit records are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_records_no_delete
BEFORE DELETE ON audit_records
BEGIN
    SELECT RAISE(ABORT, 'audit records are append-only');
END;
"""

BASELINE_SCHEMA = """
CREATE TABLE IF NOT EXISTS baseline_entries (
    audit_id    TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    digest      TEXT NOT NULL,
    prev_hash   TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    UNIQUE (org_id, seq)
);

CREATE TABLE IF NOT EXISTS baseline_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS baseline_no_update
BEFORE UPDATE ON baseline_entries
BEGIN
    SELECT RAISE(ABORT, 'baseline entries are append-only');
END;

CREATE TRIGGER IF NOT EXISTS baseline_no_delete
BEFORE DELETE ON baseline_entries
BEGIN
    SELECT RAISE(ABORT, 'baseline entries are append-only');
END;
"""


class AuditError(Exception):
    """Base error for audit/storage problems."""


class AuditRecordCorrupt(AuditError):
    pass


def sqlite_uri(path: Path, mode: str) -> str:
    """Build a SQLite URI that opens *path* with the requested access mode."""
    if mode not in {"ro", "rw", "rwc"}:
        raise ValueError(f"unsupported sqlite mode: {mode}")
    return f"file:{quote(str(path.resolve()))}?mode={mode}"


class Store:
    def __init__(self, db_path: Path, baseline_path: Path) -> None:
        self.db_path = Path(db_path)
        self.baseline_path = Path(baseline_path)

    # -- connection handling -------------------------------------------------

    def connect(self, *, readonly: bool = False) -> sqlite3.Connection:
        if readonly:
            conn = sqlite3.connect(
                sqlite_uri(self.db_path, "ro"), uri=True, isolation_level=None
            )
        else:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(self.db_path), isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000")
        if not readonly:
            conn.execute("PRAGMA foreign_keys = ON")
            self._attach_baseline(conn)
        return conn

    def _attach_baseline(self, conn: sqlite3.Connection) -> None:
        already = {
            row[1]
            for row in conn.execute("PRAGMA database_list").fetchall()
            if row[1] == "baseline"
        }
        if already:
            return
        self.baseline_path.parent.mkdir(parents=True, exist_ok=True)
        conn.execute(self._attach_sql())

    def _attach_sql(self) -> str:
        escaped = str(self.baseline_path.resolve()).replace("'", "''")
        return f"ATTACH DATABASE '{escaped}' AS baseline"

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """Run a write transaction spanning main data and the baseline."""
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")
        finally:
            conn.close()

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect(readonly=True)
        try:
            yield conn
        finally:
            conn.close()

    def initialize(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.baseline_path.parent.mkdir(parents=True, exist_ok=True)
        # Build each file on its own connection so the baseline schema does
        # not depend on ATTACH schema-qualification rules.
        main_conn = sqlite3.connect(str(self.db_path), isolation_level=None)
        try:
            # Multi-database transactions are only atomic outside WAL mode.
            main_conn.execute("PRAGMA journal_mode = DELETE")
            main_conn.execute("PRAGMA foreign_keys = ON")
            main_conn.executescript(MAIN_SCHEMA)
        finally:
            main_conn.close()

        baseline_conn = sqlite3.connect(str(self.baseline_path), isolation_level=None)
        try:
            baseline_conn.execute("PRAGMA journal_mode = DELETE")
            baseline_conn.executescript(BASELINE_SCHEMA)
        finally:
            baseline_conn.close()

    # -- audit append --------------------------------------------------------

    def append_audit(
        self,
        conn: sqlite3.Connection,
        *,
        org_id: str,
        action: str,
        outcome: str,
        actor: str,
        target: str,
        role: str | None,
        changes: Any,
        rule_set: str,
        reason: str | None = None,
        detail: Any = None,
        created_at: str | None = None,
    ) -> dict[str, Any]:
        """Insert one audit record and its baseline commitment.

        Must be called inside :meth:`tx` so the caller's permission change and
        this record commit together.
        """
        row = conn.execute(
            "SELECT rule_set FROM orgs WHERE org_id = ?", (org_id,)
        ).fetchone()
        if row is None:
            raise AuditError(f"unknown organisation: {org_id}")
        if row["rule_set"] != rule_set:
            raise AuditError("rule set does not match organisation configuration")

        head = conn.execute(
            "SELECT last_seq, last_hash FROM org_heads WHERE org_id = ?", (org_id,)
        ).fetchone()
        if head is None:
            seq, prev_hash = 1, GENESIS_HASH
        else:
            seq, prev_hash = head["last_seq"] + 1, head["last_hash"]

        payload = redact(
            {
                "audit_id": uuid.uuid4().hex,
                "org_id": org_id,
                "seq": seq,
                "created_at": created_at or utc_now_iso(),
                "action": action,
                "outcome": outcome,
                "actor": actor,
                "target": target,
                "role": role,
                "changes": changes if changes is not None else {},
                "rule_set": rule_set,
                "reason": reason,
                "detail": detail if detail is not None else {},
            }
        )
        if set(payload) != set(PAYLOAD_FIELDS):
            raise AuditRecordCorrupt("audit payload does not match canonical fields")
        if contains_sensitive(payload):
            raise AuditRecordCorrupt("credential-shaped value reached the audit record")

        digest = payload_digest(payload)
        rhash = record_hash(prev_hash, digest)

        conn.execute(
            """
            INSERT INTO audit_records (
                audit_id, org_id, seq, created_at, action, outcome, actor,
                target, role, changes, rule_set, reason, detail,
                prev_hash, digest, record_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["audit_id"],
                payload["org_id"],
                payload["seq"],
                payload["created_at"],
                payload["action"],
                payload["outcome"],
                payload["actor"],
                payload["target"],
                payload["role"],
                canonical_json(payload["changes"]),
                payload["rule_set"],
                payload["reason"],
                canonical_json(payload["detail"]),
                prev_hash,
                digest,
                rhash,
            ),
        )
        conn.execute(
            """
            INSERT INTO baseline.baseline_entries (
                audit_id, org_id, seq, created_at, digest, prev_hash, record_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload["audit_id"],
                payload["org_id"],
                payload["seq"],
                payload["created_at"],
                digest,
                prev_hash,
                rhash,
            ),
        )
        conn.execute(
            """
            INSERT INTO org_heads (org_id, last_seq, last_hash) VALUES (?, ?, ?)
            ON CONFLICT(org_id) DO UPDATE
                SET last_seq = excluded.last_seq, last_hash = excluded.last_hash
            """,
            (org_id, seq, rhash),
        )
        record = dict(payload)
        record.update(prev_hash=prev_hash, digest=digest, record_hash=rhash)
        return record

    # -- queries -------------------------------------------------------------

    def get_org(self, org_id: str) -> dict[str, Any] | None:
        with self.read() as conn:
            row = conn.execute(
                "SELECT org_id, name, rule_set FROM orgs WHERE org_id = ?", (org_id,)
            ).fetchone()
            return dict(row) if row else None

    def list_orgs(self) -> list[dict[str, Any]]:
        with self.read() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT org_id, name, rule_set FROM orgs ORDER BY org_id"
                )
            ]

    def get_admin_by_username(self, username: str) -> dict[str, Any] | None:
        with self.read() as conn:
            row = conn.execute(
                "SELECT * FROM admins WHERE username = ?", (username,)
            ).fetchone()
            return dict(row) if row else None

    def list_assignments(self, org_id: str) -> list[dict[str, Any]]:
        with self.read() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT org_id, subject, role, granted_at, granted_by
                    FROM role_assignments WHERE org_id = ?
                    ORDER BY subject, role
                    """,
                    (org_id,),
                )
            ]

    def get_audit_record(self, audit_id: str) -> dict[str, Any] | None:
        with self.read() as conn:
            row = conn.execute(
                "SELECT * FROM audit_records WHERE audit_id = ?", (audit_id,)
            ).fetchone()
            return decode_record(row) if row else None

    def list_audit(
        self, org_id: str, *, limit: int | None = None
    ) -> list[dict[str, Any]]:
        sql = (
            "SELECT * FROM audit_records WHERE org_id = ? ORDER BY seq ASC"
        )
        params: tuple[Any, ...] = (org_id,)
        if limit is not None:
            sql += " LIMIT ?"
            params += (limit,)
        with self.read() as conn:
            return [decode_record(row) for row in conn.execute(sql, params)]

    def all_audit(self) -> list[dict[str, Any]]:
        with self.read() as conn:
            return [
                decode_record(row)
                for row in conn.execute(
                    "SELECT * FROM audit_records ORDER BY org_id, seq"
                )
            ]


def decode_record(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    record = dict(row)
    record["changes"] = json.loads(record["changes"])
    record["detail"] = json.loads(record["detail"])
    return record
