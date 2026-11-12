"""SQLite 数据访问层（aiosqlite 异步驱动）。

页面刷新后任务仍然可见，全部状态以数据库为准；进程内只保留
运行中任务的 FFmpeg 子进程句柄。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from . import config, storage

_conn: aiosqlite.Connection | None = None

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
    id              TEXT PRIMARY KEY,
    original_name   TEXT NOT NULL,
    stored_name     TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    width           INTEGER,
    height          INTEGER,
    video_codec     TEXT,
    probe_info      TEXT NOT NULL DEFAULT '{}',
    deleted         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id               TEXT PRIMARY KEY,
    file_id          TEXT NOT NULL REFERENCES files(id),
    status           TEXT NOT NULL DEFAULT 'queued',
    start_ms         INTEGER NOT NULL,
    end_ms           INTEGER NOT NULL,
    duration_ms      INTEGER NOT NULL,
    format           TEXT NOT NULL,
    video_codec      TEXT NOT NULL,
    audio_codec      TEXT NOT NULL,
    crf              INTEGER,
    preset           TEXT,
    video_bitrate    TEXT,
    audio_bitrate    TEXT,
    progress         INTEGER NOT NULL DEFAULT 0,
    output_name      TEXT,
    output_size      INTEGER,
    ffmpeg_cmd       TEXT NOT NULL DEFAULT '[]',
    error            TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    started_at       TEXT,
    finished_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


async def connect() -> None:
    global _conn
    storage.ensure_dirs()
    _conn = await aiosqlite.connect(config.DB_PATH)
    _conn.row_factory = aiosqlite.Row
    await _conn.executescript(SCHEMA)
    await _conn.commit()


async def close() -> None:
    global _conn
    if _conn is not None:
        await _conn.close()
        _conn = None


def _db() -> aiosqlite.Connection:
    if _conn is None:
        raise RuntimeError("database not connected")
    return _conn


async def insert(table: str, data: dict[str, Any]) -> None:
    cols = ", ".join(data.keys())
    placeholders = ", ".join(f":{k}" for k in data.keys())
    await _db().execute(
        f"INSERT INTO {table} ({cols}) VALUES ({placeholders})", data
    )
    await _db().commit()


async def execute(sql: str, params: tuple[Any, ...] = ()) -> None:
    await _db().execute(sql, params)
    await _db().commit()


async def fetch_one(sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    async with _db().execute(sql, params) as cur:
        row = await cur.fetchone()
        return dict(row) if row else None


async def fetch_all(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    async with _db().execute(sql, params) as cur:
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


# ---- 表级便捷封装 -----------------------------------------------------------

async def create_file_record(
    *,
    file_id: str,
    original_name: str,
    stored_name: str,
    size_bytes: int,
    probe: dict[str, Any],
) -> None:
    await insert(
        "files",
        {
            "id": file_id,
            "original_name": original_name,
            "stored_name": stored_name,
            "size_bytes": size_bytes,
            "duration_ms": int(probe.get("duration_ms", 0)),
            "width": probe.get("width"),
            "height": probe.get("height"),
            "video_codec": probe.get("video_codec"),
            "probe_info": json.dumps(probe.get("streams", []), ensure_ascii=False),
            "deleted": 0,
            "created_at": now_iso(),
        },
    )


async def get_file(file_id: str) -> dict[str, Any] | None:
    return await fetch_one("SELECT * FROM files WHERE id = ? AND deleted = 0", (file_id,))


async def list_files() -> list[dict[str, Any]]:
    return await fetch_all(
        "SELECT * FROM files WHERE deleted = 0 ORDER BY created_at DESC"
    )


async def create_task_record(task: dict[str, Any]) -> None:
    await insert("tasks", task)


async def get_task(task_id: str) -> dict[str, Any] | None:
    return await fetch_one("SELECT * FROM tasks WHERE id = ?", (task_id,))


async def list_tasks(limit: int = config.TASK_LIST_LIMIT) -> list[dict[str, Any]]:
    return await fetch_all(
        "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", (limit,)
    )


async def active_tasks() -> list[dict[str, Any]]:
    """未进入终态的任务，用于服务重启后的恢复。"""
    return await fetch_all(
        "SELECT * FROM tasks WHERE status IN ('queued', 'processing') "
        "ORDER BY created_at ASC"
    )


async def mark_file_deleted(file_id: str) -> None:
    await execute("UPDATE files SET deleted = 1 WHERE id = ?", (file_id,))


async def tasks_using_file(file_id: str) -> list[dict[str, Any]]:
    return await fetch_all(
        "SELECT id, status FROM tasks WHERE file_id = ? "
        "AND status IN ('queued', 'processing', 'paused')",
        (file_id,),
    )


async def update_task(task_id: str, fields: dict[str, Any]) -> None:
    if not fields:
        return
    fields = {**fields, "updated_at": now_iso()}
    assignments = ", ".join(f"{k} = :{k}" for k in fields)
    params = dict(fields)
    params["id"] = task_id
    await _db().execute(f"UPDATE tasks SET {assignments} WHERE id = :id", params)
    await _db().commit()
