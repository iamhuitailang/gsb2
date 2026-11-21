"""SQLite persistence for trust configurations and analyses."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS trust_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    demo_slug TEXT,
    peer_raw TEXT NOT NULL,
    headers_json TEXT NOT NULL,
    config_snapshot_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    status TEXT NOT NULL,
    outcome TEXT NOT NULL,
    outcome_label TEXT NOT NULL,
    final_client TEXT,
    summary TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analyses_created_at ON analyses(created_at);
CREATE INDEX IF NOT EXISTS idx_analyses_status ON analyses(status);
CREATE INDEX IF NOT EXISTS idx_analyses_outcome ON analyses(outcome);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class Database:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _init(self) -> None:
        with self.connect() as connection:
            connection.executescript(SCHEMA)

    # ---------- trust configs ----------
    def save_config(
        self,
        config: dict[str, Any],
        fingerprint: str,
        config_id: int | None = None,
    ) -> int:
        now = utc_now()
        payload = json.dumps(config, ensure_ascii=False, sort_keys=True)
        with self.connect() as connection:
            if config_id is None:
                cursor = connection.execute(
                    "INSERT INTO trust_configs(name, config_json, fingerprint, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (config["name"], payload, fingerprint, now, now),
                )
                return int(cursor.lastrowid)
            updated = connection.execute(
                "UPDATE trust_configs SET name=?, config_json=?, fingerprint=?, updated_at=?"
                " WHERE id=?",
                (config["name"], payload, fingerprint, now, config_id),
            )
            if updated.rowcount == 0:
                raise KeyError(f"配置 {config_id} 不存在")
            return config_id

    def list_configs(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT id, name, config_json, fingerprint, created_at, updated_at"
                " FROM trust_configs ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        return [
            {
                "id": row["id"],
                "name": row["name"],
                "config": json.loads(row["config_json"]),
                "fingerprint": row["fingerprint"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def get_config(self, config_id: int) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT id, name, config_json, fingerprint, created_at, updated_at"
                " FROM trust_configs WHERE id=?",
                (config_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "name": row["name"],
            "config": json.loads(row["config_json"]),
            "fingerprint": row["fingerprint"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def delete_config(self, config_id: int) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM trust_configs WHERE id=?", (config_id,)
            )
            return cursor.rowcount > 0

    # ---------- analyses ----------
    def save_analysis(
        self,
        *,
        peer_raw: str,
        headers: list[dict[str, str]],
        config: dict[str, Any],
        result: dict[str, Any],
        source: str = "manual",
        demo_slug: str | None = None,
    ) -> int:
        verdict = result["verdict"]
        with self.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO analyses(created_at, source, demo_slug, peer_raw,"
                " headers_json, config_snapshot_json, result_json, status, outcome,"
                " outcome_label, final_client, summary)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    utc_now(),
                    source,
                    demo_slug,
                    peer_raw,
                    json.dumps(headers, ensure_ascii=False),
                    json.dumps(config, ensure_ascii=False, sort_keys=True),
                    json.dumps(result, ensure_ascii=False),
                    verdict["status"],
                    verdict["outcome"],
                    verdict["outcome_label"],
                    verdict["final_client"],
                    verdict["summary"],
                ),
            )
            return int(cursor.lastrowid)

    def list_analyses(
        self,
        *,
        status: str | None = None,
        outcome: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        source: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        where: list[str] = []
        params: list[Any] = []
        if status:
            where.append("status = ?")
            params.append(status)
        if outcome:
            where.append("outcome = ?")
            params.append(outcome)
        if source:
            where.append("source = ?")
            params.append(source)
        if date_from:
            where.append("created_at >= ?")
            params.append(date_from)
        if date_to:
            where.append("created_at <= ?")
            params.append(date_to)
        clause = (" WHERE " + " AND ".join(where)) if where else ""

        with self.connect() as connection:
            total = connection.execute(
                f"SELECT COUNT(*) AS count FROM analyses{clause}", params
            ).fetchone()["count"]
            rows = connection.execute(
                "SELECT id, created_at, source, demo_slug, peer_raw, status, outcome,"
                " outcome_label, final_client, summary, config_snapshot_json"
                f" FROM analyses{clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ).fetchall()
        items = [
            {
                "id": row["id"],
                "created_at": row["created_at"],
                "source": row["source"],
                "demo_slug": row["demo_slug"],
                "peer_raw": row["peer_raw"],
                "status": row["status"],
                "outcome": row["outcome"],
                "outcome_label": row["outcome_label"],
                "final_client": row["final_client"],
                "summary": row["summary"],
                "config_name": json.loads(row["config_snapshot_json"]).get("name"),
            }
            for row in rows
        ]
        return items, int(total)

    def get_analysis(self, analysis_id: int) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM analyses WHERE id=?", (analysis_id,)
            ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "created_at": row["created_at"],
            "source": row["source"],
            "demo_slug": row["demo_slug"],
            "peer_raw": row["peer_raw"],
            "headers": json.loads(row["headers_json"]),
            "config_snapshot": json.loads(row["config_snapshot_json"]),
            "result": json.loads(row["result_json"]),
        }

    def for_export(
        self,
        *,
        status: str | None = None,
        outcome: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        source: str | None = None,
    ) -> list[dict[str, Any]]:
        where: list[str] = []
        params: list[Any] = []
        if status:
            where.append("status = ?")
            params.append(status)
        if outcome:
            where.append("outcome = ?")
            params.append(outcome)
        if source:
            where.append("source = ?")
            params.append(source)
        if date_from:
            where.append("created_at >= ?")
            params.append(date_from)
        if date_to:
            where.append("created_at <= ?")
            params.append(date_to)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM analyses" + clause + " ORDER BY created_at ASC, id ASC",
                params,
            ).fetchall()
        return [
            {
                "record_id": row["id"],
                "created_at": row["created_at"],
                "source": row["source"],
                "demo_slug": row["demo_slug"],
                "peer": row["peer_raw"],
                "headers": json.loads(row["headers_json"]),
                "trust_config": json.loads(row["config_snapshot_json"]),
                "result": json.loads(row["result_json"]),
            }
            for row in rows
        ]

    def delete_demo_data(self) -> int:
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM analyses WHERE source LIKE 'demo%'"
            )
            return cursor.rowcount

    def delete_analysis(self, analysis_id: int) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM analyses WHERE id=?", (analysis_id,)
            )
            return cursor.rowcount > 0

    def counts(self) -> dict[str, Any]:
        with self.connect() as connection:
            analyses = connection.execute(
                "SELECT COUNT(*) AS count FROM analyses"
            ).fetchone()["count"]
            demos = connection.execute(
                "SELECT COUNT(*) AS count FROM analyses WHERE source LIKE 'demo%'"
            ).fetchone()["count"]
            configs = connection.execute(
                "SELECT COUNT(*) AS count FROM trust_configs"
            ).fetchone()["count"]
        return {"analyses": analyses, "demo_analyses": demos, "configs": configs}
