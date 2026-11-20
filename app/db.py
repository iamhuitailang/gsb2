"""SQLite 存储层：策略版本、审计记录、激活指针。

一致性策略
----------
* 每个策略版本在 ``policy_versions`` 中以整包快照（规范化 JSON）存储。
* ``active_state`` 只有一行，记录当前生效版本的 id 与递增的 generation。
* 应用/回滚都在单个 ``BEGIN IMMEDIATE`` 事务内完成：写版本、写审计、
  原子更新指针。任一步失败都会整体回滚，不存在“写了一半”的生效状态。
* 客户端提交 ``base_generation``；服务端在事务内校验它仍等于当前
  generation，否则抛出 :class:`VersionConflict`，避免并发覆盖。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import MAX_AUDIT_DETAILS_BYTES

_SCHEMA = """
CREATE TABLE IF NOT EXISTS policy_versions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    version_no       INTEGER NOT NULL UNIQUE,
    digest           TEXT    NOT NULL,
    package_id       TEXT    NOT NULL,
    package_name     TEXT    NOT NULL,
    schema_version   TEXT    NOT NULL,
    document         TEXT    NOT NULL,
    source_kind      TEXT    NOT NULL,
    source_note      TEXT    NOT NULL,
    origin_version_id INTEGER,
    created_at       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    at              TEXT    NOT NULL,
    action          TEXT    NOT NULL,
    outcome         TEXT    NOT NULL,
    source_note     TEXT    NOT NULL,
    origin          TEXT    NOT NULL,
    version_id      INTEGER,
    version_no      INTEGER,
    base_generation INTEGER,
    code            TEXT,
    message         TEXT,
    details         TEXT
);

CREATE TABLE IF NOT EXISTS active_state (
    singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
    version_id      INTEGER,
    generation      INTEGER NOT NULL,
    updated_at      TEXT    NOT NULL
);
"""


class VersionConflict(Exception):
    """并发修改：客户端持有的 generation 已过期。"""

    def __init__(self, expected: int, actual: int) -> None:
        super().__init__(
            f"策略已被其他操作修改（期望 generation={expected}，实际 {actual}）"
        )
        self.expected = expected
        self.actual = actual


class StoreError(RuntimeError):
    """存储层不可恢复错误。"""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _dump_details(details: Any) -> str | None:
    if details is None:
        return None
    text = json.dumps(details, ensure_ascii=False, sort_keys=True)
    if len(text.encode("utf-8")) > MAX_AUDIT_DETAILS_BYTES:
        text = json.dumps(
            {
                "truncated": True,
                "note": "审计详情超过存储上限，已截断",
            },
            ensure_ascii=False,
        )
    return text


class Database:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(
            self.path, isolation_level=None, check_same_thread=False
        )
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._connection.execute("PRAGMA synchronous=FULL")
        self._connection.executescript(_SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = self._connection
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
            else:
                conn.execute("COMMIT")

    # ------------------------------------------------------------ active

    def get_active_state(self) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                "SELECT version_id, generation, updated_at FROM active_state "
                "WHERE singleton = 1"
            ).fetchone()
        if row is None:
            return {"version_id": None, "generation": 0, "updated_at": None}
        return {
            "version_id": row["version_id"],
            "generation": row["generation"],
            "updated_at": row["updated_at"],
        }

    def get_active_document(self) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT p.document AS document FROM active_state a "
                "JOIN policy_versions p ON p.id = a.version_id "
                "WHERE a.singleton = 1 AND a.version_id IS NOT NULL"
            ).fetchone()
        if row is None:
            return None
        return json.loads(row["document"])

    # ---------------------------------------------------------- versions

    def list_versions(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT v.id, v.version_no, v.digest, v.package_id, "
                "v.package_name, v.schema_version, v.source_kind, "
                "v.source_note, v.origin_version_id, v.created_at, "
                "(v.id = a.version_id) AS is_active "
                "FROM policy_versions v LEFT JOIN active_state a "
                "ON a.singleton = 1 "
                "ORDER BY v.version_no DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {**dict(row), "is_active": bool(row["is_active"])} for row in rows
        ]

    def get_version(self, version_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM policy_versions WHERE id = ?", (version_id,)
            ).fetchone()
            if row is None:
                return None
            data = dict(row)
            source = self._connection.execute(
                "SELECT * FROM audit_log WHERE version_id = ? ORDER BY id LIMIT 1",
                (version_id,),
            ).fetchone()
        data["document"] = json.loads(data["document"])
        data["audit"] = dict(source) if source else None
        return data

    def count_versions(self) -> int:
        with self._lock:
            row = self._connection.execute(
                "SELECT COUNT(*) AS c FROM policy_versions"
            ).fetchone()
        return int(row["c"])

    def _next_version_no(self, conn: sqlite3.Connection) -> int:
        row = conn.execute(
            "SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM policy_versions"
        ).fetchone()
        return int(row["n"])

    def get_version_meta(self, version_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT id, version_no, digest, package_id, package_name, "
                "schema_version, source_kind, source_note, origin_version_id, "
                "created_at FROM policy_versions WHERE id = ?",
                (version_id,),
            ).fetchone()
        return dict(row) if row else None

    def get_version_document(self, version_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT document FROM policy_versions WHERE id = ?",
                (version_id,),
            ).fetchone()
        return json.loads(row["document"]) if row else None

    # ------------------------------------------------------------ apply

    def apply_version(
        self,
        *,
        document: dict[str, Any],
        digest: str,
        source_kind: str,
        source_note: str,
        origin_version_id: int | None,
        base_generation: int | None,
        operation: str = "apply",
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """在单事务内：写版本 → 写审计 → 原子切换激活指针。"""

        package = document["package"]
        with self.transaction() as conn:
            state = conn.execute(
                "SELECT version_id, generation FROM active_state WHERE singleton = 1"
            ).fetchone()
            current_generation = int(state["generation"]) if state else 0
            if base_generation is not None and base_generation != current_generation:
                raise VersionConflict(base_generation, current_generation)

            version_no = self._next_version_no(conn)
            now = utc_now()
            cursor = conn.execute(
                "INSERT INTO policy_versions (version_no, digest, package_id, "
                "package_name, schema_version, document, source_kind, "
                "source_note, origin_version_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    version_no,
                    digest,
                    package["id"],
                    package["name"],
                    document["schema_version"],
                    json.dumps(document, ensure_ascii=False, sort_keys=True),
                    source_kind,
                    source_note,
                    origin_version_id,
                    now,
                ),
            )
            version_id = int(cursor.lastrowid)
            new_generation = current_generation + 1
            conn.execute(
                "INSERT INTO active_state (singleton, version_id, generation, "
                "updated_at) VALUES (1, ?, ?, ?) "
                "ON CONFLICT(singleton) DO UPDATE SET "
                "version_id = excluded.version_id, "
                "generation = excluded.generation, "
                "updated_at = excluded.updated_at",
                (version_id, new_generation, now),
            )
            conn.execute(
                "INSERT INTO audit_log (at, action, outcome, source_note, origin, "
                "version_id, version_no, base_generation, code, message, details) "
                "VALUES (?, ?, 'applied', ?, ?, ?, ?, ?, NULL, NULL, ?)",
                (
                    now,
                    operation,
                    source_note,
                    "server",
                    version_id,
                    version_no,
                    base_generation,
                    _dump_details(details),
                ),
            )
        return {
            "version_id": version_id,
            "version_no": version_no,
            "generation": new_generation,
            "created_at": now,
        }

    # ------------------------------------------------------------ audit

    def record_event(
        self,
        *,
        action: str,
        outcome: str,
        source_note: str,
        code: str | None = None,
        message: str | None = None,
        details: dict[str, Any] | None = None,
        base_generation: int | None = None,
        version_id: int | None = None,
        version_no: int | None = None,
    ) -> int:
        """写一条审计事件（不触碰激活指针）。"""

        now = utc_now()
        with self.transaction() as conn:
            cursor = conn.execute(
                "INSERT INTO audit_log (at, action, outcome, source_note, origin, "
                "version_id, version_no, base_generation, code, message, details) "
                "VALUES (?, ?, ?, ?, 'server', ?, ?, ?, ?, ?, ?)",
                (
                    now,
                    action,
                    outcome,
                    source_note,
                    version_id,
                    version_no,
                    base_generation,
                    code,
                    message,
                    _dump_details(details),
                ),
            )
            return int(cursor.lastrowid)

    def record_rejection(
        self,
        *,
        action: str,
        source_note: str,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
        base_generation: int | None = None,
        version_id: int | None = None,
        version_no: int | None = None,
    ) -> int:
        """记录被拒绝的导入。不改动激活指针。"""

        return self.record_event(
            action=action,
            outcome="rejected",
            source_note=source_note,
            code=code,
            message=message,
            details=details,
            base_generation=base_generation,
            version_id=version_id,
            version_no=version_no,
        )

    def list_audit(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        results: list[dict[str, Any]] = []
        for row in rows:
            data = dict(row)
            data["details"] = (
                json.loads(data["details"]) if data["details"] else None
            )
            results.append(data)
        return results

    def audit_count(self) -> int:
        with self._lock:
            row = self._connection.execute(
                "SELECT COUNT(*) AS c FROM audit_log"
            ).fetchone()
        return int(row["c"])
