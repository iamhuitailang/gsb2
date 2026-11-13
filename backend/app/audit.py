"""SQLite-backed nonce reservation and audit trail.

The database file lives wherever ``database_path`` points (local config only).
Audit rows deliberately never contain the raw request body or a full signature.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import time
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import unquote

SCHEMA_VERSION = 2

# Query parameters whose values are never written verbatim to the audit table.
_SENSITIVE_PARAM_RE = re.compile(
    r"(?i)(token|secret|password|passwd|auth|credential|signature|api[-_]?key|access[-_]?key)"
)
# U+2028 / U+2029 are line separators to many log viewers, so they are stripped
# to keep every audit field on a single physical line.  chr() keeps the source
# file unambiguous.
_LINE_SEPARATORS = (chr(0x2028), chr(0x2029))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
    reason_code TEXT NOT NULL,
    reason_detail TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    query TEXT NOT NULL,
    key_id TEXT,
    key_status TEXT,
    timestamp INTEGER,
    nonce_masked TEXT NOT NULL,
    nonce_hash TEXT NOT NULL,
    signature_masked TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    body_bytes INTEGER NOT NULL,
    source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_events(decision);

CREATE TABLE IF NOT EXISTS nonces (
    nonce_hash TEXT PRIMARY KEY,
    key_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    seen_at REAL NOT NULL,
    expires_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nonces_expires_at ON nonces(expires_at);
"""


def nonce_hash(nonce: str) -> str:
    return hashlib.sha256(nonce.encode("utf-8")).hexdigest()


def mask_nonce(nonce: str) -> str:
    if len(nonce) <= 6:
        return "***"
    return nonce[:3] + "…" + nonce[-2:]


def mask_signature(signature: str) -> str:
    if len(signature) <= 12:
        return "***"
    return signature[:4] + "…" + signature[-4:]


def _sanitize(value: str, limit: int = 512) -> str:
    """Keep audit text single-line and bounded while preserving UTF-8.

    Only C0 controls, DEL and the Unicode line/paragraph separators are
    dropped; Chinese reason text must survive.
    """
    clean = "".join(
        ch
        for ch in value
        if ord(ch) >= 0x20 and ord(ch) != 0x7F and ch not in _LINE_SEPARATORS
    )
    if len(clean) > limit:
        clean = clean[:limit] + "…"
    return clean


def _sanitize_query(query: str, limit: int = 2048) -> str:
    """Mask values of sensitive-looking query parameters before storage.

    Only the parameter *name* is decoded for the sensitivity check, so an
    encoded spelling such as ``tok%65n=...`` cannot slip past the masker.
    The rest of the query is stored as it was written.
    """
    parts: list[str] = []
    for part in query.split("&"):
        name, sep, value = part.partition("=")
        if sep and _SENSITIVE_PARAM_RE.search(unquote(name, errors="replace")):
            value = "***"
        parts.append(f"{name}={value}" if sep else part)
    return _sanitize("&".join(parts), limit)


@dataclass
class VerificationContext:
    request_id: str
    source: str
    method: str
    path: str
    query: str
    key_id: str | None
    key_status: str | None
    timestamp: int | None
    nonce: str
    signature: str
    body_sha256: str
    body_bytes: int


class AuditStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = Path(database_path)
        self._lock = threading.Lock()
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # isolation_level=None keeps the connection out of implicit
        # transactions; the caller controls begin/commit explicitly so that
        # the nonce insert and the audit row form one atomic unit.
        conn = sqlite3.connect(self.database_path, timeout=5.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            yield conn
        finally:
            conn.close()

    def _initialize(self) -> None:
        with self._connect() as conn:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version and version < SCHEMA_VERSION:
                # Nonce rows are ephemeral by design; dropping the table is the
                # safe migration and leaves the audit trail untouched.
                conn.execute("DROP TABLE IF EXISTS nonces")
            conn.executescript(_SCHEMA)
            if version != SCHEMA_VERSION:
                conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    def _insert_audit(
        self,
        conn: sqlite3.Connection,
        ctx: VerificationContext,
        *,
        decision: str,
        reason_code: str,
        reason_detail: str,
        now: float,
    ) -> int:
        cursor = conn.execute(
            """
            INSERT INTO audit_events (
                request_id, created_at, decision, reason_code, reason_detail,
                method, path, query, key_id, key_status, timestamp,
                nonce_masked, nonce_hash, signature_masked, body_sha256,
                body_bytes, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                ctx.request_id,
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
                decision,
                reason_code,
                _sanitize(reason_detail, 1024),
                _sanitize(ctx.method, 32),
                _sanitize(ctx.path, 512),
                _sanitize_query(ctx.query, 2048),
                _sanitize(ctx.key_id, 64) if ctx.key_id else None,
                ctx.key_status,
                ctx.timestamp,
                mask_nonce(ctx.nonce),
                nonce_hash(ctx.nonce),
                mask_signature(ctx.signature),
                ctx.body_sha256,
                ctx.body_bytes,
                ctx.source,
            ),
        )
        return int(cursor.lastrowid)

    def reject(
        self,
        ctx: VerificationContext,
        *,
        reason_code: str,
        reason_detail: str,
        now: float | None = None,
    ) -> int:
        # ``0.0`` is a valid epoch second, so test the value explicitly.
        now = time.time() if now is None else now
        with self._lock, self._connect() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                self._cleanup_nonces(conn, now)
                audit_id = self._insert_audit(
                    conn,
                    ctx,
                    decision="rejected",
                    reason_code=reason_code,
                    reason_detail=reason_detail,
                    now=now,
                )
                conn.execute("COMMIT")
            except BaseException:
                with suppress(sqlite3.Error):
                    conn.execute("ROLLBACK")
                raise
            return audit_id

    def accept(
        self,
        ctx: VerificationContext,
        *,
        nonce_retention_seconds: int,
        now: float | None = None,
    ) -> tuple[dict[str, Any], bool]:
        """Reserve the nonce and write the audit row as one atomic unit.

        Returns ``(audit_row, accepted)``.  Nonces are globally unique: any
        nonce already seen in the retention window is rejected, regardless of
        which key signed the earlier request.  If the nonce was already
        reserved, the audit row records ``reason_code=nonce_replayed``.
        """
        now = time.time() if now is None else now
        nonce_digest = nonce_hash(ctx.nonce)
        with self._lock, self._connect() as conn:
            try:
                # One write transaction for the whole check-and-insert, so two
                # concurrent replays cannot both observe "nonce unused".
                conn.execute("BEGIN IMMEDIATE")
                self._cleanup_nonces(conn, now)
                # Explicit existence check instead of relying on
                # ``cursor.rowcount`` after an ON CONFLICT DO NOTHING insert,
                # whose value differs between sqlite3 versions.
                existing = conn.execute(
                    "SELECT 1 FROM nonces WHERE nonce_hash = ?", (nonce_digest,)
                ).fetchone()
                accepted = existing is None
                if accepted:
                    conn.execute(
                        """
                        INSERT INTO nonces (nonce_hash, key_id, request_id, seen_at, expires_at)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (
                            nonce_digest,
                            ctx.key_id or "",
                            ctx.request_id,
                            now,
                            now + nonce_retention_seconds,
                        ),
                    )
                audit_id = self._insert_audit(
                    conn,
                    ctx,
                    decision="accepted" if accepted else "rejected",
                    reason_code="accepted" if accepted else "nonce_replayed",
                    reason_detail=(
                        "签名有效，nonce 首次使用"
                        if accepted
                        else "该 nonce 已在有效时间窗内被使用过，疑似重放"
                    ),
                    now=now,
                )
                row = conn.execute(
                    "SELECT * FROM audit_events WHERE id = ?", (audit_id,)
                ).fetchone()
                conn.execute("COMMIT")
            except BaseException:
                with suppress(sqlite3.Error):
                    conn.execute("ROLLBACK")
                raise
            return dict(row), accepted

    @staticmethod
    def _cleanup_nonces(conn: sqlite3.Connection, now: float) -> None:
        # Lazy cleanup: rows are only removed while a request is processed.
        conn.execute("DELETE FROM nonces WHERE expires_at <= ?", (now,))

    def list_audit(
        self,
        limit: int = 50,
        before_id: int | None = None,
        decision: str | None = None,
    ) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 200))
        clauses: list[str] = []
        params: list[Any] = []
        if before_id is not None:
            clauses.append("id < ?")
            params.append(before_id)
        if decision in {"accepted", "rejected"}:
            clauses.append("decision = ?")
            params.append(decision)
        sql = "SELECT * FROM audit_events"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    def stats(self) -> dict[str, Any]:
        with self._connect() as conn:
            total = conn.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]
            rejected = conn.execute(
                "SELECT COUNT(*) FROM audit_events WHERE decision='rejected'"
            ).fetchone()[0]
            accepted = total - rejected
            last = conn.execute(
                "SELECT created_at FROM audit_events ORDER BY id DESC LIMIT 1"
            ).fetchone()
            reasons = conn.execute(
                """
                SELECT reason_code, COUNT(*) AS count FROM audit_events
                WHERE decision='rejected' GROUP BY reason_code ORDER BY count DESC
                """
            ).fetchall()
        return {
            "total": total,
            "accepted": accepted,
            "rejected": rejected,
            "last_event_at": last[0] if last else None,
            "reject_reasons": [dict(row) for row in reasons],
        }

    def export_json(self, limit: int = 200) -> str:
        return json.dumps(self.list_audit(limit=limit), ensure_ascii=False, indent=2)
