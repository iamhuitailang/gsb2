"""JSONL 事件导入：校验、规范化、去重、冲突隔离、行级错误与导入限额。"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from . import storage

CANONICAL_FIELDS = (
    "source",
    "event_id",
    "event_time",
    "subject",
    "src_ip",
    "action",
    "target",
    "result",
)


class ImportRejected(Exception):
    """整批导入被拒绝（超限或编码错误），不写入任何事件。"""


def content_hash_of(record: dict[str, Any]) -> str:
    """按规范化 JSON 计算内容指纹：字段顺序不同但内容相同视为同一记录。"""
    payload = json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def parse_event_time(value: Any) -> str:
    """把多种 ISO8601 写法统一为 UTC 的 ``YYYY-MM-DDTHH:MM:SSZ``；失败抛 ValueError。"""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("event_time 缺失或不是字符串")
    text = value.strip()
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"无效时间: {value!r}") from exc
    if dt.tzinfo is None:
        # 设备日志常见的无时区写法，按 UTC 解释（README 中明确说明）
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc).replace(microsecond=0)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def validate_record(record: Any) -> dict[str, str]:
    """校验单条记录并返回规范化字段；任何问题抛 ValueError（行级错误）。"""
    if not isinstance(record, dict):
        raise ValueError("记录不是 JSON 对象")
    missing = [f for f in CANONICAL_FIELDS if f not in record]
    if missing:
        raise ValueError(f"缺少必填字段: {', '.join(missing)}")
    source = record["source"]
    if not isinstance(source, str) or not source.strip():
        raise ValueError("source 为空或不是字符串")
    if source not in storage.VALID_SOURCES:
        raise ValueError(
            f"未知来源: {source!r}，允许的来源: {', '.join(sorted(storage.VALID_SOURCES))}"
        )
    normalized: dict[str, str] = {"source": source}
    for field in ("event_id", "subject", "src_ip", "action", "target", "result"):
        value = record[field]
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"字段 {field} 缺失、为空或不是字符串")
        normalized[field] = value.strip()
    normalized["event_time"] = parse_event_time(record["event_time"])
    return normalized


def import_jsonl_bytes(
    conn: sqlite3.Connection, raw_bytes: bytes, filename: str
) -> dict[str, Any]:
    """导入一批 JSONL 字节，返回接收/重复/隔离/错误计数与明细。

    整批在单个事务内提交；任何未预期异常都会回滚，不影响此前数据。
    超限或编码错误抛 :class:`ImportRejected`，不写入任何事件。
    """
    settings = storage.get_settings(conn)
    max_bytes = int(settings["max_import_bytes"])
    max_events = int(settings["max_import_events"])

    if len(raw_bytes) > max_bytes:
        reason = f"文件大小 {len(raw_bytes)} 字节超过上限 {max_bytes} 字节，整批拒绝"
        _record_rejected_import(conn, filename, reason)
        raise ImportRejected(reason)

    try:
        text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        reason = f"文件不是合法 UTF-8 文本: {exc}"
        _record_rejected_import(conn, filename, reason)
        raise ImportRejected(reason) from exc

    lines = [(i + 1, line) for i, line in enumerate(text.splitlines()) if line.strip()]
    if len(lines) > max_events:
        reason = f"事件数 {len(lines)} 超过单次上限 {max_events}，整批拒绝"
        _record_rejected_import(conn, filename, reason)
        raise ImportRejected(reason)

    import_id = storage.create_import(conn, filename)
    counts = {"total": len(lines), "accepted": 0, "duplicate": 0,
              "quarantined": 0, "error": 0}
    errors: list[dict[str, Any]] = []
    quarantined: list[dict[str, Any]] = []

    try:
        for line_no, raw_line in lines:
            raw_line = raw_line.strip()
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError as exc:
                _add_row_error(conn, import_id, line_no, f"JSON 解析失败: {exc.msg}", raw_line)
                counts["error"] += 1
                errors.append({"line_no": line_no, "reason": f"JSON 解析失败: {exc.msg}"})
                continue

            try:
                normalized = validate_record(record)
            except ValueError as exc:
                _add_row_error(conn, import_id, line_no, str(exc), raw_line)
                counts["error"] += 1
                errors.append({"line_no": line_no, "reason": str(exc)})
                continue

            digest = content_hash_of(record)
            outcome = _store_record(conn, import_id, normalized, digest, raw_line, record)
            counts[outcome["bucket"]] += 1
            if outcome["bucket"] == "quarantined":
                quarantined.append({"line_no": line_no, "reason": outcome["reason"]})
            if outcome["bucket"] == "error":
                errors.append({"line_no": line_no, "reason": outcome["reason"]})

        storage.finish_import(conn, import_id, counts)
    except Exception:
        conn.rollback()
        raise

    return {
        "import_id": import_id,
        "filename": filename,
        "counts": counts,
        "errors": errors,
        "quarantined": quarantined,
    }


def _record_rejected_import(conn: sqlite3.Connection, filename: str, reason: str) -> None:
    import_id = storage.create_import(conn, filename)
    storage.finish_import(
        conn, import_id,
        {"total": 0, "accepted": 0, "duplicate": 0, "quarantined": 0, "error": 0},
        rejected_reason=reason,
    )


def _add_row_error(
    conn: sqlite3.Connection, import_id: int, line_no: int, reason: str, raw_line: str
) -> None:
    conn.execute(
        "INSERT INTO row_errors(import_id, line_no, reason, raw_line, held_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (import_id, line_no, reason, raw_line, storage.now_iso()),
    )


def _store_record(
    conn: sqlite3.Connection,
    import_id: int,
    normalized: dict[str, str],
    digest: str,
    raw_line: str,
    record: dict[str, Any],
) -> dict[str, Any]:
    source = normalized["source"]
    event_id = normalized["event_id"]

    # 同一冲突记录此前已被隔离过：仍不入库，按重复计数（同来源+编号+内容只计一次）
    held_same = conn.execute(
        "SELECT id FROM quarantined WHERE source=? AND event_id=? AND reason LIKE ? LIMIT 1",
        (source, event_id, f"%{digest[:12]}%"),
    ).fetchone()
    if held_same is not None:
        return {"bucket": "duplicate", "reason": "与已隔离冲突记录内容相同"}

    existing = conn.execute(
        "SELECT id, content_hash FROM events WHERE source=? AND event_id=? LIMIT 1",
        (source, event_id),
    ).fetchone()

    if existing is not None:
        if existing["content_hash"] == digest:
            return {"bucket": "duplicate", "reason": "同来源同事件编号且内容相同"}
        reason = (
            f"事件编号冲突：来源 {source} 的事件编号 {event_id} 已存在"
            f"（events.id={existing['id']}，指纹 {existing['content_hash'][:12]}…），"
            f"新记录指纹 {digest[:12]}… 内容不同，已隔离且不覆盖原记录"
        )
        conn.execute(
            "INSERT INTO quarantined(import_id, source, event_id, reason, raw_line, parsed, held_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (import_id, source, event_id, reason, raw_line,
             json.dumps(normalized, ensure_ascii=False), storage.now_iso()),
        )
        return {"bucket": "quarantined", "reason": reason}

    conn.execute(
        "INSERT INTO events(import_id, source, event_id, content_hash, event_time, "
        "subject, src_ip, action, target, result, normalized, raw_line, received_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            import_id, source, event_id, digest, normalized["event_time"],
            normalized["subject"], normalized["src_ip"], normalized["action"],
            normalized["target"], normalized["result"],
            json.dumps(normalized, ensure_ascii=False), raw_line, storage.now_iso(),
        ),
    )
    return {"bucket": "accepted", "reason": ""}
