"""Domain logic for scoped archive purges.

The workbench separates three steps:

* a *preview* of the records a filter currently matches,
* a *permit* issued only after the operator re-enters their password, bound to
  the session, the operation and the exact record set that was shown, and
* the *submission*, which redeems the permit and deletes the records in a
  single SQLite transaction.

Raw session tokens, permits and passwords are never written to the audit log
or to the database.  Only hashes of the session and permit tokens are stored.
"""

from __future__ import annotations

import hashlib
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from . import db as dbm
from .security import (
    constant_time_equal,
    derive_csrf,
    new_token,
    token_hash,
    verify_password,
)

DEFAULT_SESSION_TTL = 8 * 60 * 60
DEFAULT_PERMIT_TTL = 180
DEFAULT_CONFIRMATION_TTL = 300

CONFIRM_MAX_FAILURES = 5
CONFIRM_WINDOW = 300
LOGIN_MAX_FAILURES = 8
LOGIN_WINDOW = 300


class WorkbenchError(Exception):
    """Base error carrying an HTTP-ish status and a machine readable code."""

    status = 400
    code = "error"

    def __init__(
        self,
        message: str,
        *,
        manifest: dict[str, Any] | None = None,
        operation: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.message = message
        self.manifest = manifest
        self.operation = operation


class NotFound(WorkbenchError):
    status = 404
    code = "not_found"


class Unauthorized(WorkbenchError):
    status = 401
    code = "unauthorized"


class BadCredentials(WorkbenchError):
    status = 401
    code = "bad_credentials"


class Forbidden(WorkbenchError):
    status = 403
    code = "forbidden"


class CsrfRejected(Forbidden):
    code = "csrf_rejected"


class Expired(WorkbenchError):
    status = 410
    code = "expired"


class TooManyAttempts(WorkbenchError):
    status = 429
    code = "too_many_attempts"


class AlreadyProcessed(WorkbenchError):
    status = 409
    code = "already_processed"


class ScopeChanged(WorkbenchError):
    status = 409
    code = "scope_changed"


class ScopeDrift(WorkbenchError):
    status = 409
    code = "scope_drift"


def _now_default() -> float:
    return time.time()


def _digest(folder_id: int, batch: str, keyword: str, records) -> str:
    """Fingerprint the exact record set shown to the operator.

    Titles are part of the fingerprint so a reused row id cannot collide with
    a previously confirmed set, and an in-place edit is detected too.
    """
    payload = dbm.to_json(
        {
            "folder_id": folder_id,
            "batch": batch,
            "keyword": keyword,
            "records": [
                {"id": record["id"], "title": record["title"], "batch": record["batch"]}
                for record in records
            ],
        }
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _filter_json(batch: str, keyword: str) -> str:
    return dbm.to_json({"batch": batch, "keyword": keyword})


def _filter_parts(filter_json: str) -> tuple[str, str]:
    parts = dbm.from_json(filter_json)
    return parts.get("batch", ""), parts.get("keyword", "")


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _filter_label(folder_name: str, batch: str, keyword: str) -> str:
    parts = [f"目录：{folder_name}", f"批次：{batch or '全部'}"]
    if keyword:
        parts.append(f"关键字：{keyword}")
    return " · ".join(parts)


def _clean(text: str | None, limit: int = 64) -> str:
    return (text or "").strip()[:limit]


@dataclass(frozen=True)
class Session:
    id: str
    user_id: int
    username: str
    active_folder_id: int | None
    active_batch: str
    active_keyword: str


class Workbench:
    def __init__(
        self,
        db_path,
        secret: bytes,
        *,
        session_ttl: int = DEFAULT_SESSION_TTL,
        permit_ttl: int = DEFAULT_PERMIT_TTL,
        confirmation_ttl: int = DEFAULT_CONFIRMATION_TTL,
        clock: Callable[[], float] = _now_default,
    ) -> None:
        self.db_path = db_path
        self.secret = secret
        self.session_ttl = session_ttl
        self.permit_ttl = permit_ttl
        self.confirmation_ttl = confirmation_ttl
        self.clock = clock
        self._confirm_failures: dict[str, list[float]] = {}
        self._login_failures: dict[str, list[float]] = {}
        self._throttle_lock = threading.Lock()

    # ------------------------------------------------------------------ utils

    def connect(self) -> sqlite3.Connection:
        return dbm.connect(self.db_path)

    def _audit(
        self,
        conn: sqlite3.Connection,
        action: str,
        *,
        now: float,
        session: Session | None = None,
        operation_id: str | None = None,
        folder_id: int | None = None,
        folder_name: str | None = None,
        record_count: int | None = None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        # Callers must pass only non-secret data.  Tokens, permit values and
        # passwords never appear in detail.
        conn.execute(
            """
            INSERT INTO audit_log
                (at, action, operation_id, user_id, username, folder_id,
                 folder_name, record_count, detail)
            VALUES (?,?,?,?,?,?,?,?,?)
            """,
            (
                now,
                action,
                operation_id,
                session.user_id if session else None,
                session.username if session else None,
                folder_id,
                folder_name,
                record_count,
                dbm.to_json(detail or {}),
            ),
        )

    def _load_session(
        self, conn: sqlite3.Connection, session: Session, now: float
    ) -> sqlite3.Row:
        row = conn.execute(
            """
            SELECT s.*, u.username
              FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.id = ?
            """,
            (session.id,),
        ).fetchone()
        if not row or row["revoked_at"] is not None or row["expires_at"] <= now:
            raise Unauthorized("会话已失效，请重新登录。")
        return row

    def _row_session(self, row: sqlite3.Row) -> Session:
        return Session(
            row["id"],
            row["user_id"],
            row["username"],
            row["active_folder_id"],
            row["active_batch"],
            row["active_keyword"],
        )

    def _folder(self, conn: sqlite3.Connection, folder_id: int) -> sqlite3.Row:
        row = conn.execute(
            "SELECT id, name FROM folders WHERE id = ?", (folder_id,)
        ).fetchone()
        if not row:
            raise NotFound("目录不存在。")
        return row

    def _preview(
        self,
        conn: sqlite3.Connection,
        folder: sqlite3.Row,
        batch: str,
        keyword: str,
    ) -> dict[str, Any]:
        clauses = ["folder_id = ?"]
        params: list[Any] = [folder["id"]]
        if batch:
            clauses.append("batch = ?")
            params.append(batch)
        if keyword:
            clauses.append("title LIKE ? ESCAPE '\\'")
            params.append("%" + _escape_like(keyword) + "%")
        rows = conn.execute(
            "SELECT id, title, batch FROM records WHERE "
            + " AND ".join(clauses)
            + " ORDER BY id",
            params,
        ).fetchall()
        records = [
            {"id": row["id"], "title": row["title"], "batch": row["batch"]}
            for row in rows
        ]
        return {
            "folder_id": folder["id"],
            "folder_name": folder["name"],
            "batch": batch,
            "keyword": keyword,
            "filter_label": _filter_label(folder["name"], batch, keyword),
            "records": records,
            "count": len(records),
            "digest": _digest(folder["id"], batch, keyword, records),
        }

    def _preview_for_session(
        self, conn: sqlite3.Connection, row: sqlite3.Row
    ) -> dict[str, Any]:
        if row["active_folder_id"] is None:
            return {
                "folder_id": None,
                "folder_name": None,
                "batch": row["active_batch"],
                "keyword": row["active_keyword"],
                "filter_label": "没有可用目录。",
                "records": [],
                "count": 0,
                "digest": "",
            }
        folder = self._folder(conn, row["active_folder_id"])
        return self._preview(
            conn, folder, row["active_batch"], row["active_keyword"]
        )

    def _operation_public(self, row: sqlite3.Row) -> dict[str, Any]:
        deleted = row["deleted_snapshot"]
        started = row["record_snapshot"]
        return {
            "id": row["id"],
            "status": row["status"],
            "folder_id": row["folder_id"],
            "folder_name": row["folder_name"],
            "filter_label": row["filter_label"],
            "filter": dbm.from_json(row["filter_json"]),
            "record_count": row["record_count"],
            "username": row["username"],
            "created_at": row["created_at"],
            "completed_at": row["completed_at"],
            "completed_by": row["completed_by"],
            "records": dbm.from_json(deleted or started or "[]"),
        }

    # ------------------------------------------------------------------- auth

    def _check_login_throttle(self, username: str, now: float) -> None:
        with self._throttle_lock:
            failures = [
                at
                for at in self._login_failures.get(username, [])
                if now - at < LOGIN_WINDOW
            ]
            self._login_failures[username] = failures
            if len(failures) >= LOGIN_MAX_FAILURES:
                raise TooManyAttempts("登录尝试过于频繁，请稍后再试。")

    def _record_login_failure(self, username: str, now: float) -> None:
        with self._throttle_lock:
            self._login_failures.setdefault(username, []).append(now)

    def login(self, username: str, password: str) -> tuple[str, Session, str]:
        now = self.clock()
        username = _clean(username, 64)
        self._check_login_throttle(username, now)
        conn = self.connect()
        try:
            user = conn.execute(
                "SELECT id, username, password_hash FROM users WHERE username = ?",
                (username,),
            ).fetchone()
            ok = bool(user) and verify_password(password, user["password_hash"])
            if not ok:
                self._record_login_failure(username, now)
                with dbm.transaction(conn):
                    self._audit(
                        conn,
                        "login_denied",
                        now=now,
                        detail={"username": username},
                    )
                raise BadCredentials("用户名或密码不正确。")
            with self._throttle_lock:
                self._login_failures.pop(username, None)

            first_folder = conn.execute(
                "SELECT id FROM folders ORDER BY id LIMIT 1"
            ).fetchone()
            raw = new_token("wbs_")
            session_id = uuid.uuid4().hex
            with dbm.transaction(conn):
                conn.execute(
                    """
                    INSERT INTO sessions
                        (id, token_hash, user_id, active_folder_id, active_batch,
                         active_keyword, created_at, last_seen_at, expires_at)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        session_id,
                        token_hash(raw),
                        user["id"],
                        first_folder["id"] if first_folder else None,
                        "",
                        "",
                        now,
                        now,
                        now + self.session_ttl,
                    ),
                )
                session = Session(
                    session_id,
                    user["id"],
                    user["username"],
                    first_folder["id"] if first_folder else None,
                    "",
                    "",
                )
                self._audit(conn, "login", now=now, session=session)
            return raw, session, derive_csrf(self.secret, session_id)
        finally:
            conn.close()

    def session_for_token(self, raw_token: str | None) -> Session | None:
        if not raw_token:
            return None
        now = self.clock()
        conn = self.connect()
        try:
            row = conn.execute(
                """
                SELECT s.*, u.username
                  FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ?
                """,
                (token_hash(raw_token),),
            ).fetchone()
            if not row or row["revoked_at"] is not None or row["expires_at"] <= now:
                return None
            if now - row["last_seen_at"] > 60:
                conn.execute(
                    "UPDATE sessions SET last_seen_at = ? WHERE id = ?",
                    (now, row["id"]),
                )
            return self._row_session(row)
        finally:
            conn.close()

    def logout(self, session: Session) -> None:
        now = self.clock()
        conn = self.connect()
        try:
            with dbm.transaction(conn):
                conn.execute(
                    "UPDATE sessions SET revoked_at = ? "
                    "WHERE id = ? AND revoked_at IS NULL",
                    (now, session.id),
                )
                conn.execute(
                    "UPDATE permits SET revoked_at = ? "
                    "WHERE session_id = ? AND consumed_at IS NULL "
                    "AND revoked_at IS NULL",
                    (now, session.id),
                )
                self._audit(conn, "logout", now=now, session=session)
        finally:
            conn.close()

    def csrf_for(self, session: Session) -> str:
        return derive_csrf(self.secret, session.id)

    def verify_csrf(self, session: Session, token: str) -> bool:
        expected = derive_csrf(self.secret, session.id)
        return constant_time_equal(token or "", expected)

    # ---------------------------------------------------------------- catalog

    def folders(self) -> list[dict[str, Any]]:
        conn = self.connect()
        try:
            return [
                dict(row)
                for row in conn.execute("SELECT id, name FROM folders ORDER BY id")
            ]
        finally:
            conn.close()

    def batches(self, folder_id: int) -> list[str]:
        conn = self.connect()
        try:
            self._folder(conn, folder_id)
            return [
                row["batch"]
                for row in conn.execute(
                    "SELECT DISTINCT batch FROM records WHERE folder_id = ? "
                    "ORDER BY batch",
                    (folder_id,),
                )
            ]
        finally:
            conn.close()

    def add_record(self, folder_id: int, title: str, batch: str) -> int:
        """Add a record.  Used by tooling/tests to simulate new arrivals."""
        now = self.clock()
        conn = self.connect()
        try:
            with dbm.transaction(conn):
                folder = self._folder(conn, folder_id)
                cursor = conn.execute(
                    "INSERT INTO records(folder_id, title, batch, created_at) "
                    "VALUES (?,?,?,?)",
                    (folder["id"], _clean(title, 200), _clean(batch, 64), now),
                )
                record_id = int(cursor.lastrowid)
                self._audit(
                    conn,
                    "record_added",
                    now=now,
                    folder_id=folder["id"],
                    folder_name=folder["name"],
                    record_count=1,
                    detail={"record_id": record_id, "title": _clean(title, 200)},
                )
            return record_id
        finally:
            conn.close()

    def set_scope(
        self, session: Session, folder_id: int, batch: str, keyword: str
    ) -> dict[str, Any]:
        batch = _clean(batch)
        keyword = _clean(keyword)
        now = self.clock()
        conn = self.connect()
        try:
            folder = self._folder(conn, int(folder_id))
            with dbm.transaction(conn):
                self._load_session(conn, session, now)
                conn.execute(
                    """
                    UPDATE sessions
                       SET active_folder_id = ?, active_batch = ?,
                           active_keyword = ?, last_seen_at = ?
                     WHERE id = ?
                    """,
                    (folder["id"], batch, keyword, now, session.id),
                )
                manifest = self._preview(conn, folder, batch, keyword)
                self._audit(
                    conn,
                    "scope_set",
                    now=now,
                    session=session,
                    folder_id=folder["id"],
                    folder_name=folder["name"],
                    record_count=manifest["count"],
                    detail={"batch": batch, "keyword": keyword},
                )
            return manifest
        finally:
            conn.close()

    def preview(self, session: Session) -> dict[str, Any]:
        now = self.clock()
        conn = self.connect()
        try:
            row = self._load_session(conn, session, now)
            return self._preview_for_session(conn, row)
        finally:
            conn.close()

    def active_scope(self, session: Session) -> dict[str, Any]:
        now = self.clock()
        conn = self.connect()
        try:
            row = self._load_session(conn, session, now)
            manifest = self._preview_for_session(conn, row)
            return {
                "folder_id": row["active_folder_id"],
                "batch": row["active_batch"],
                "keyword": row["active_keyword"],
                "folders": self.folders(),
                "batches": self.batches(row["active_folder_id"])
                if row["active_folder_id"] is not None
                else [],
                "manifest": manifest,
            }
        finally:
            conn.close()

    # --------------------------------------------------------------- confirm

    def _check_confirm_throttle(self, session: Session, now: float) -> None:
        with self._throttle_lock:
            failures = [
                at
                for at in self._confirm_failures.get(session.id, [])
                if now - at < CONFIRM_WINDOW
            ]
            self._confirm_failures[session.id] = failures
            if len(failures) >= CONFIRM_MAX_FAILURES:
                raise TooManyAttempts(
                    "身份验证尝试过于频繁，请稍后再试。"
                )

    def _record_confirm_failure(self, session: Session, now: float) -> None:
        with self._throttle_lock:
            self._confirm_failures.setdefault(session.id, []).append(now)

    def _clear_confirm_failures(self, session: Session) -> None:
        with self._throttle_lock:
            self._confirm_failures.pop(session.id, None)

    def _password_hash(self, user_id: int) -> str:
        conn = self.connect()
        try:
            row = conn.execute(
                "SELECT password_hash FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            return row["password_hash"] if row else ""
        finally:
            conn.close()

    def confirm(
        self,
        session: Session,
        *,
        folder_id: int,
        batch: str,
        keyword: str,
        expected_digest: str,
        password: str,
    ) -> dict[str, Any]:
        """Verify the operator's password and mint a short-lived permit."""
        batch = _clean(batch)
        keyword = _clean(keyword)
        now = self.clock()
        self._check_confirm_throttle(session, now)

        if not verify_password(password, self._password_hash(session.user_id)):
            self._record_confirm_failure(session, now)
            conn = self.connect()
            try:
                with dbm.transaction(conn):
                    self._audit(
                        conn,
                        "confirm_denied",
                        now=now,
                        session=session,
                        folder_id=folder_id,
                        record_count=None,
                        detail={"reason": "bad_password"},
                    )
            finally:
                conn.close()
            raise BadCredentials("身份验证未通过，未生成许可。")
        self._clear_confirm_failures(session)

        conn = self.connect()
        try:
            with dbm.transaction(conn):
                row = self._load_session(conn, session, now)
                current_filter = _filter_json(
                    row["active_batch"], row["active_keyword"]
                )
                if (
                    row["active_folder_id"] != int(folder_id)
                    or current_filter != _filter_json(batch, keyword)
                ):
                    raise ScopeChanged(
                        "当前筛选条件已经变化，请重新核对清单后再确认。",
                        manifest=self._preview_for_session(conn, row),
                    )

                folder = self._folder(conn, int(folder_id))
                manifest = self._preview(conn, folder, batch, keyword)
                if not manifest["count"]:
                    raise ScopeChanged(
                        "当前范围内没有可清理的资料，无需确认。",
                        manifest=manifest,
                    )
                if not expected_digest or expected_digest != manifest["digest"]:
                    raise ScopeChanged(
                        "清单在确认前发生了变化，请核对新的清单后再确认。",
                        manifest=manifest,
                    )

                prepared_op = conn.execute(
                    """
                    SELECT * FROM operations
                     WHERE session_id = ? AND folder_id = ? AND filter_json = ?
                       AND status = 'prepared'
                     ORDER BY created_at DESC LIMIT 1
                    """,
                    (session.id, folder["id"], _filter_json(batch, keyword)),
                ).fetchone()
                if prepared_op is None:
                    operation_id = uuid.uuid4().hex
                    conn.execute(
                        """
                        INSERT INTO operations
                            (id, session_id, user_id, username, folder_id,
                             folder_name, filter_json, filter_label,
                             record_snapshot, record_digest, record_count,
                             status, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,'prepared',?)
                        """,
                        (
                            operation_id,
                            session.id,
                            session.user_id,
                            session.username,
                            folder["id"],
                            folder["name"],
                            _filter_json(batch, keyword),
                            manifest["filter_label"],
                            dbm.to_json(manifest["records"]),
                            manifest["digest"],
                            manifest["count"],
                            now,
                        ),
                    )
                else:
                    operation_id = prepared_op["id"]
                    # Refresh the snapshot for the same scope: the operator may
                    # have abandoned an earlier confirmation, or the set may
                    # have changed since it was recorded.
                    conn.execute(
                        """
                        UPDATE operations
                           SET record_snapshot = ?, record_digest = ?,
                               record_count = ?, filter_label = ?
                         WHERE id = ? AND status = 'prepared'
                        """,
                        (
                            dbm.to_json(manifest["records"]),
                            manifest["digest"],
                            manifest["count"],
                            manifest["filter_label"],
                            operation_id,
                        ),
                    )

                # Issuing a new permit does not revoke older ones for the same
                # operation: each permit is independently bound to the session,
                # the operation and the confirmed record set, and exactly one
                # of them can ever complete the deletion (see _redeem).

                confirmation_id = uuid.uuid4().hex
                conn.execute(
                    """
                    INSERT INTO confirmations
                        (id, session_id, user_id, operation_id, folder_id,
                         folder_name, filter_json, filter_label,
                         record_snapshot, record_digest, record_count,
                         created_at, expires_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        confirmation_id,
                        session.id,
                        session.user_id,
                        operation_id,
                        folder["id"],
                        folder["name"],
                        _filter_json(batch, keyword),
                        manifest["filter_label"],
                        dbm.to_json(manifest["records"]),
                        manifest["digest"],
                        manifest["count"],
                        now,
                        now + self.confirmation_ttl,
                    ),
                )

                permit_id = uuid.uuid4().hex
                permit_token = new_token("wbp_")
                permit_expires = now + self.permit_ttl
                conn.execute(
                    """
                    INSERT INTO permits
                        (id, token_hash, confirmation_id, session_id, user_id,
                         operation_id, folder_id, filter_json, record_ids,
                         record_digest, record_count, created_at, expires_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        permit_id,
                        token_hash(permit_token),
                        confirmation_id,
                        session.id,
                        session.user_id,
                        operation_id,
                        folder["id"],
                        _filter_json(batch, keyword),
                        dbm.to_json([r["id"] for r in manifest["records"]]),
                        manifest["digest"],
                        manifest["count"],
                        now,
                        permit_expires,
                    ),
                )
                self._audit(
                    conn,
                    "permit_issued",
                    now=now,
                    session=session,
                    operation_id=operation_id,
                    folder_id=folder["id"],
                    folder_name=folder["name"],
                    record_count=manifest["count"],
                    detail={
                        "filter": dbm.from_json(_filter_json(batch, keyword)),
                        "record_ids": [r["id"] for r in manifest["records"]],
                        "expires_at": permit_expires,
                    },
                )
                return {
                    "permit": permit_token,
                    "operation_id": operation_id,
                    "expires_at": permit_expires,
                    "expires_in": max(0, int(permit_expires - now)),
                    "manifest": manifest,
                }
        finally:
            conn.close()

    # ---------------------------------------------------------------- submit

    def discard_permit(self, session: Session, raw_permit: str) -> None:
        """Voluntarily revoke a permit the operator no longer wants to use."""
        now = self.clock()
        conn = self.connect()
        try:
            with dbm.transaction(conn):
                self._load_session(conn, session, now)
                permit = conn.execute(
                    "SELECT * FROM permits WHERE token_hash = ?",
                    (token_hash(raw_permit or ""),),
                ).fetchone()
                if (
                    permit is None
                    or permit["session_id"] != session.id
                    or permit["user_id"] != session.user_id
                    or permit["consumed_at"] is not None
                ):
                    self._audit(
                        conn,
                        "discard_denied",
                        now=now,
                        session=session,
                        detail={"reason": "unusable_permit"},
                    )
                    error: WorkbenchError | None = Forbidden("许可不可用。")
                else:
                    conn.execute(
                        "UPDATE permits SET revoked_at = ? "
                        "WHERE id = ? AND consumed_at IS NULL "
                        "AND revoked_at IS NULL",
                        (now, permit["id"]),
                    )
                    self._audit(
                        conn,
                        "permit_discarded",
                        now=now,
                        session=session,
                        operation_id=permit["operation_id"],
                        folder_id=permit["folder_id"],
                        record_count=permit["record_count"],
                    )
                    error = None
            if error is not None:
                raise error
        finally:
            conn.close()

    def submit(self, session: Session, raw_permit: str) -> dict[str, Any]:
        """Redeem the permit and delete the confirmed records atomically.

        Denials still write their audit rows, so the redemption logic reports
        an error *after* the write transaction commits instead of raising
        inside it (which would roll the audit and revocations back).
        """
        now = self.clock()
        conn = self.connect()
        try:
            with dbm.transaction(conn):
                row = self._load_session(conn, session, now)
                current_session = self._row_session(row)
                result, error = self._redeem(
                    conn, current_session, row, raw_permit, now
                )
            if error is not None:
                raise error
            return result
        finally:
            conn.close()

    def _redeem(
        self,
        conn: sqlite3.Connection,
        current_session: Session,
        session_row: sqlite3.Row,
        raw_permit: str,
        now: float,
    ) -> tuple[dict[str, Any] | None, WorkbenchError | None]:
        permit = conn.execute(
            "SELECT * FROM permits WHERE token_hash = ?",
            (token_hash(raw_permit or ""),),
        ).fetchone()
        if permit is None:
            self._audit(
                conn,
                "submit_denied",
                now=now,
                session=current_session,
                detail={"reason": "unknown_permit"},
            )
            return None, Forbidden("许可无效，请重新确认清单后再提交。")

        operation = conn.execute(
            "SELECT * FROM operations WHERE id = ?",
            (permit["operation_id"],),
        ).fetchone()
        if operation is None:
            return None, Forbidden("许可对应的操作不存在。")

        if (
            permit["session_id"] != current_session.id
            or permit["user_id"] != current_session.user_id
        ):
            self._audit(
                conn,
                "submit_denied",
                now=now,
                session=current_session,
                operation_id=operation["id"],
                folder_id=permit["folder_id"],
                record_count=permit["record_count"],
                detail={"reason": "wrong_session"},
            )
            return None, Forbidden("许可不属于当前会话，无法使用。")

        if permit["revoked_at"] is not None:
            self._audit(
                conn,
                "submit_denied",
                now=now,
                session=current_session,
                operation_id=operation["id"],
                folder_id=permit["folder_id"],
                record_count=permit["record_count"],
                detail={"reason": "revoked"},
            )
            return None, Forbidden("许可已失效，请重新确认清单后再提交。")

        if permit["consumed_at"] is not None:
            self._audit(
                conn,
                "submit_denied",
                now=now,
                session=current_session,
                operation_id=operation["id"],
                folder_id=operation["folder_id"],
                folder_name=operation["folder_name"],
                record_count=operation["record_count"],
                detail={"reason": "permit_already_consumed"},
            )
            return None, AlreadyProcessed(
                "本次操作已处理，不会重复删除。",
                operation=self._operation_public(operation),
            )

        if permit["expires_at"] <= now:
            self._audit(
                conn,
                "submit_denied",
                now=now,
                session=current_session,
                operation_id=operation["id"],
                folder_id=operation["folder_id"],
                record_count=operation["record_count"],
                detail={"reason": "expired"},
            )
            return None, Expired("短期许可已过期，请重新确认清单。")

        if operation["status"] != "prepared":
            self._audit(
                conn,
                "submit_denied",
                now=now,
                session=current_session,
                operation_id=operation["id"],
                folder_id=operation["folder_id"],
                folder_name=operation["folder_name"],
                record_count=operation["record_count"],
                detail={"reason": "operation_completed"},
            )
            return None, AlreadyProcessed(
                "本次操作已处理，不会重复删除。",
                operation=self._operation_public(operation),
            )

        # A permit is only usable for the scope it was confirmed against.
        # Switching folders or filters does not consume it; switching back to
        # the original scope makes it usable again until it expires.
        session_filter = _filter_json(
            current_session.active_batch,
            current_session.active_keyword,
        )
        if (
            current_session.active_folder_id != permit["folder_id"]
            or session_filter != permit["filter_json"]
        ):
            self._audit(
                conn,
                "submit_denied",
                now=now,
                session=current_session,
                operation_id=operation["id"],
                folder_id=permit["folder_id"],
                record_count=permit["record_count"],
                detail={"reason": "scope_mismatch"},
            )
            return None, ScopeChanged(
                "当前筛选条件与许可不一致，该许可不能用于当前清单。",
                manifest=self._preview_for_session(conn, session_row),
            )

        batch, keyword = _filter_parts(permit["filter_json"])
        folder = self._folder(conn, permit["folder_id"])
        current = self._preview(conn, folder, batch, keyword)
        if current["digest"] != permit["record_digest"]:
            # If this very scope was already cleaned, an untouched permit from
            # a sibling confirmation must report "already processed" rather
            # than a scary "list changed" error.
            performed = conn.execute(
                """
                SELECT * FROM operations
                 WHERE session_id = ? AND folder_id = ? AND filter_json = ?
                   AND record_digest = ? AND status = 'completed'
                 ORDER BY completed_at DESC LIMIT 1
                """,
                (
                    current_session.id,
                    folder["id"],
                    permit["filter_json"],
                    permit["record_digest"],
                ),
            ).fetchone()
            if performed is not None:
                conn.execute(
                    "UPDATE permits SET consumed_at = ? "
                    "WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL",
                    (now, permit["id"]),
                )
                return None, AlreadyProcessed(
                    "本次操作已处理，不会重复删除。",
                    operation=self._operation_public(performed),
                )

            # New records entered (or left) the scope after the confirmation.
            # The permit must not be used for a set the operator never saw.
            # Revoke only this permit: a later re-confirmation refreshes the
            # prepared operation for the same scope.
            conn.execute(
                "UPDATE permits SET revoked_at = ? "
                "WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL",
                (now, permit["id"]),
            )
            self._audit(
                conn,
                "permit_revoked",
                now=now,
                session=current_session,
                operation_id=operation["id"],
                folder_id=folder["id"],
                folder_name=folder["name"],
                record_count=current["count"],
                detail={
                    "reason": "scope_drift",
                    "confirmed_count": permit["record_count"],
                    "current_count": current["count"],
                },
            )
            return None, ScopeDrift(
                "确认之后清单发生了变化，请重新核对并确认。",
                manifest=current,
            )

        record_ids = [int(i) for i in dbm.from_json(permit["record_ids"])]
        if current["count"] != len(record_ids):
            return None, ScopeDrift(
                "确认的清单与当前清单不一致，请重新核对并确认。",
                manifest=current,
            )

        # Redemption and deletion share this one write transaction, and the
        # conditional UPDATEs are what make concurrent double-submits safe:
        # exactly one caller can move the permit from unused to consumed.
        claimed_permit = conn.execute(
            """
            UPDATE permits SET consumed_at = ?
             WHERE id = ? AND consumed_at IS NULL
               AND revoked_at IS NULL
            """,
            (now, permit["id"]),
        )
        if claimed_permit.rowcount != 1:
            return None, AlreadyProcessed(
                "本次操作已处理，不会重复删除。",
                operation=self._operation_public(operation),
            )

        claimed_operation = conn.execute(
            """
            UPDATE operations
               SET status = 'completed', completed_at = ?,
                   completed_by = ?, deleted_snapshot = ?
             WHERE id = ? AND status = 'prepared'
            """,
            (
                now,
                current_session.username,
                dbm.to_json(current["records"]),
                operation["id"],
            ),
        )
        if claimed_operation.rowcount != 1:
            self._audit(
                conn,
                "submit_denied",
                now=now,
                session=current_session,
                operation_id=operation["id"],
                folder_id=operation["folder_id"],
                folder_name=operation["folder_name"],
                record_count=operation["record_count"],
                detail={"reason": "operation_completed"},
            )
            return None, AlreadyProcessed(
                "本次操作已处理，不会重复删除。",
                operation=self._operation_public(
                    conn.execute(
                        "SELECT * FROM operations WHERE id = ?",
                        (operation["id"],),
                    ).fetchone()
                ),
            )

        placeholders = ",".join("?" for _ in record_ids)
        deleted = conn.execute(
            f"DELETE FROM records WHERE folder_id = ? "
            f"AND id IN ({placeholders})",
            [permit["folder_id"], *record_ids],
        )
        if deleted.rowcount != len(record_ids):
            # Unreachable while the write lock is held; abort the whole
            # transaction rather than delete a partial set.
            raise ScopeDrift(
                "清单在执行时发生变化，请重新核对并确认。",
                manifest=self._preview(conn, folder, batch, keyword),
            )

        self._audit(
            conn,
            "cleanup_completed",
            now=now,
            session=current_session,
            operation_id=operation["id"],
            folder_id=folder["id"],
            folder_name=folder["name"],
            record_count=len(record_ids),
            detail={
                "record_ids": record_ids,
                "filter": dbm.from_json(permit["filter_json"]),
            },
        )
        completed = conn.execute(
            "SELECT * FROM operations WHERE id = ?",
            (operation["id"],),
        ).fetchone()
        return (
            {
                "status": "deleted",
                "message": "清理完成。",
                "operation": self._operation_public(completed),
                "manifest": current,
            },
            None,
        )

    # --------------------------------------------------------------- history

    def cleanup_history(self) -> list[dict[str, Any]]:
        conn = self.connect()
        try:
            return [
                self._operation_public(row)
                for row in conn.execute(
                    """
                    SELECT * FROM operations
                     WHERE status = 'completed'
                     ORDER BY completed_at DESC, rowid DESC
                    """
                )
            ]
        finally:
            conn.close()

    def operation(self, operation_id: str) -> dict[str, Any]:
        conn = self.connect()
        try:
            row = conn.execute(
                "SELECT * FROM operations WHERE id = ?", (operation_id,)
            ).fetchone()
            if not row or row["status"] != "completed":
                raise NotFound("清理记录不存在。")
            return self._operation_public(row)
        finally:
            conn.close()

    def audit_for_operation(self, operation_id: str) -> list[dict[str, Any]]:
        conn = self.connect()
        try:
            return [
                {
                    "at": row["at"],
                    "action": row["action"],
                    "username": row["username"],
                    "record_count": row["record_count"],
                    "detail": dbm.from_json(row["detail"]),
                }
                for row in conn.execute(
                    "SELECT * FROM audit_log WHERE operation_id = ? ORDER BY id",
                    (operation_id,),
                )
            ]
        finally:
            conn.close()


def create_workbench(db_path, secret: bytes, **kwargs) -> Workbench:
    dbm.init_db(db_path, seed=True)
    return Workbench(db_path, secret, **kwargs)
