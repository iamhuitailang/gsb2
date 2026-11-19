"""清单（manifest）的原子读写与自校验。

案件目录布局::

    <case_dir>/
      case.json          案件元数据与采集配置
      MANIFEST.json      全量条目清单（含每个条目的状态与摘要）
      MANIFEST.sha256    清单文件自身的 SHA-256
      copies/            证据副本，保持源目录的相对结构
      events.log         采集过程事件日志（追加写）
      .in_progress       采集中/中断标记

清单采用带缩进的确定性 JSON（sort_keys=True、固定分隔符），
同一份数据多次写入字节完全一致，便于复核与外部比对。
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from typing import Optional

MANIFEST_NAME = "MANIFEST.json"
MANIFEST_SUM_NAME = "MANIFEST.sha256"
CASE_META_NAME = "case.json"
COPY_DIR_NAME = "copies"
EVENT_LOG_NAME = "events.log"
IN_PROGRESS_NAME = ".in_progress"

MANIFEST_VERSION = 1


def canonical_bytes(data: dict) -> bytes:
    """把清单/元数据序列化为确定性的 UTF-8 字节。"""
    return json.dumps(
        data,
        ensure_ascii=False,
        sort_keys=True,
        indent=2,
        separators=(",", ": "),
    ).encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def atomic_write(path: str, data: bytes) -> None:
    """同目录临时文件 + fsync + os.replace，保证写入要么完整要么不存在。"""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def write_manifest(case_dir: str, manifest: dict) -> None:
    """原子写入清单并更新清单自身的校验和文件。"""
    payload = canonical_bytes(manifest)
    digest = sha256_bytes(payload)
    manifest_path = os.path.join(case_dir, MANIFEST_NAME)
    atomic_write(manifest_path, payload)
    atomic_write(
        os.path.join(case_dir, MANIFEST_SUM_NAME),
        (digest + "  " + MANIFEST_NAME + "\n").encode("utf-8"),
    )


def write_case_meta(case_dir: str, meta: dict) -> None:
    atomic_write(os.path.join(case_dir, CASE_META_NAME), canonical_bytes(meta))


def read_json(path: str) -> dict:
    with open(path, "rb") as fh:
        return json.loads(fh.read().decode("utf-8"))


def manifest_paths(case_dir: str) -> tuple[str, str]:
    return (
        os.path.join(case_dir, MANIFEST_NAME),
        os.path.join(case_dir, MANIFEST_SUM_NAME),
    )


def check_manifest_integrity(case_dir: str) -> tuple[bool, Optional[str], Optional[dict]]:
    """复核清单文件自身是否损坏或被篡改。

    返回 ``(是否完好, 问题说明, 解析后的清单字典)``。
    三种损坏来源都会被识别：文件缺失、JSON 无法解析、校验和不匹配。
    """
    manifest_path, sum_path = manifest_paths(case_dir)
    if not os.path.isfile(manifest_path):
        return False, f"清单文件缺失: {MANIFEST_NAME}", None
    try:
        with open(manifest_path, "rb") as fh:
            payload = fh.read()
        manifest = json.loads(payload.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return False, f"清单无法解析: {exc}", None
    if not isinstance(manifest, dict) or "entries" not in manifest:
        return False, "清单结构不完整（缺少 entries 字段）", None

    expected_digest: Optional[str] = None
    if os.path.isfile(sum_path):
        try:
            with open(sum_path, "r", encoding="utf-8") as fh:
                first_line = fh.readline().strip()
            if first_line:
                expected_digest = first_line.split()[0]
        except OSError:
            expected_digest = None
    actual_digest = sha256_bytes(payload)
    if expected_digest is None:
        return False, f"清单校验和文件缺失或不可读: {MANIFEST_SUM_NAME}", manifest
    if expected_digest != actual_digest:
        return (
            False,
            "清单校验和不匹配（清单可能已被篡改或损坏）",
            manifest,
        )
    return True, None, manifest


def in_progress_path(case_dir: str) -> str:
    return os.path.join(case_dir, IN_PROGRESS_NAME)


def copy_root(case_dir: str) -> str:
    return os.path.join(case_dir, COPY_DIR_NAME)


def event_log_path(case_dir: str) -> str:
    return os.path.join(case_dir, EVENT_LOG_NAME)


def append_event(case_dir: str, message: str) -> None:
    """向事件日志追加一行（带时间戳）。日志失败不影响采集主流程。"""
    import datetime

    line = "[%s] %s\n" % (
        datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        message,
    )
    try:
        with open(event_log_path(case_dir), "a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError:
        pass
