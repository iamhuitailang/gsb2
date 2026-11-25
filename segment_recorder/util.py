from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


def now_iso() -> str:
    """当前本地时间，带时区偏移，精确到秒。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def iso_or_fallback(value: str | None, fallback: datetime) -> str:
    dt = parse_iso(value)
    return (dt or fallback).isoformat(timespec="seconds")


def format_clock(value: str | datetime | None) -> str:
    dt = value if isinstance(value, datetime) else parse_iso(value)
    if dt is None:
        return "未知时间"
    return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S")


def format_clock_compact(value: str | datetime | None) -> str:
    dt = value if isinstance(value, datetime) else parse_iso(value)
    if dt is None:
        return "--:--:--"
    return dt.astimezone().strftime("%m-%d %H:%M:%S")


def format_duration(seconds: float | None) -> str:
    if seconds is None:
        return "未知时长"
    seconds = max(0.0, float(seconds))
    if seconds < 60:
        return f"{seconds:.2f} 秒"
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{int(hours)}小时{int(minutes)}分{sec:.1f}秒"
    return f"{int(minutes)}分{sec:.1f}秒"


def clock_range(start: str | None, end: str | None) -> str:
    if not start or not end:
        return "时间待核对"
    return f"{format_clock(start)} → {format_clock(end)}"


def sha256_file(path: Path | str, buffer_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while True:
            block = handle.read(buffer_size)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def sha256_prefix(path: Path | str, length: int, buffer_size: int = 1024 * 1024) -> str:
    """只计算文件前 length 字节的 SHA-256，用于判断旧 .part 前缀是否仍有效。"""
    digest = hashlib.sha256()
    remaining = max(0, int(length))
    with Path(path).open("rb") as handle:
        while remaining > 0:
            block = handle.read(min(buffer_size, remaining))
            if not block:
                break
            digest.update(block)
            remaining -= len(block)
    return digest.hexdigest()


def same_prefix(part_path: Path, source_path: Path, length: int) -> bool:
    try:
        if length <= 0:
            return True
        if part_path.stat().st_size < length:
            return False
        return sha256_file(part_path) == sha256_prefix(source_path, length)
    except OSError:
        return False


def atomic_write_json(path: Path | str, data: Any) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def read_json(path: Path | str) -> Any | None:
    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def ensure_dir(path: Path | str) -> Path:
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    return path


def seconds_to_vtt_timestamp(value: float) -> str:
    value = max(0.0, float(value))
    hours = int(value // 3600)
    value -= hours * 3600
    minutes = int(value // 60)
    value -= minutes * 60
    seconds = int(value)
    millis = int(round((value - seconds) * 1000))
    if millis == 1000:
        seconds += 1
        millis = 0
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def safe_filename(text: str) -> str:
    cleaned = []
    for char in text:
        if char.isalnum() or char in ("-", "_", "."):
            cleaned.append(char)
        else:
            cleaned.append("_")
    return "".join(cleaned).strip("._") or "item"


def timedelta_seconds(start: datetime | None, end: datetime | None) -> float | None:
    if start is None or end is None:
        return None
    return max(0.0, (end - start).total_seconds())
