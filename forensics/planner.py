"""采集规划：把扫描结果转换成带处理状态的清单条目。

规划阶段负责四类判定，全部在读取任何文件内容之前完成：
1. 边界判定：词法越界的条目、目标逃逸的符号链接；
2. 路径冲突：规范化后相对路径重复，或副本落盘路径在大小写不敏感
   文件系统上冲突（macOS 默认即如此）；
3. 采集上限：按确定性顺序（相对路径字典序）预占文件数与总字节数，
   超出部分显式标记 limit_exceeded，绝不静默丢弃；
4. 扫描错误：不可读目录等转成 failed 条目。
"""

from __future__ import annotations

import os
import stat
from typing import Optional

from .models import (
    Entry,
    ManifestEntry,
    REASON_CASE_COLLISION,
    REASON_DUPLICATE_RELPATH,
    REASON_MAX_BYTES,
    REASON_MAX_FILES,
    REASON_PATH_ESCAPE,
    REASON_SPECIAL_FILE,
    REASON_SYMLINK_ESCAPE,
    REASON_UNREADABLE_DIR,
    STATUS_CONFLICT,
    STATUS_FAILED,
    STATUS_LIMIT_EXCEEDED,
    STATUS_OUT_OF_BOUNDS,
    STATUS_PENDING,
    STATUS_RECORDED,
    STATUS_SKIPPED,
    TYPE_DIRECTORY,
    TYPE_REGULAR,
    TYPE_SPECIAL,
    TYPE_SYMLINK,
)
from .paths import is_within_root, resolve_symlink_target


def _mode_octal(mode_bits: int) -> str:
    return oct(stat.S_IMODE(mode_bits))


def _base_manifest_entry(entry: Entry, status: str) -> ManifestEntry:
    return ManifestEntry(
        rel_path=entry.rel_path,
        entry_type=entry.entry_type,
        status=status,
        size=entry.size,
        mode=_mode_octal(entry.mode),
        uid=entry.uid,
        gid=entry.gid,
        inode=entry.inode,
        nlink=entry.nlink,
        mtime_ns=entry.mtime_ns,
        symlink_target=entry.symlink_target,
    )


def plan_entries(
    root: str,
    entries: list[Entry],
    scan_errors: list[tuple[str, str]],
    max_files: Optional[int] = None,
    max_bytes: Optional[int] = None,
) -> list[ManifestEntry]:
    """生成初始清单条目（普通文件状态为 pending，其余已定级）。"""
    result: list[ManifestEntry] = []

    # ---- 1. 边界判定 ----
    in_bounds: list[Entry] = []
    for entry in entries:
        if not is_within_root(root, entry.abs_path):
            me = _base_manifest_entry(entry, STATUS_OUT_OF_BOUNDS)
            me.reason = REASON_PATH_ESCAPE
            me.detail = "路径规范化后位于根目录之外"
            result.append(me)
            continue
        if entry.is_symlink and entry.symlink_target is not None:
            inside, resolved = resolve_symlink_target(
                root, entry.abs_path, entry.symlink_target
            )
            if not inside:
                me = _base_manifest_entry(entry, STATUS_OUT_OF_BOUNDS)
                me.reason = REASON_SYMLINK_ESCAPE
                me.detail = f"符号链接目标逃逸出根目录: {entry.symlink_target} -> {resolved}"
                result.append(me)
                continue
        in_bounds.append(entry)

    # ---- 2. 相对路径冲突（规范化后完全相同） ----
    seen_rel: dict[str, Entry] = {}
    no_dup: list[Entry] = []
    for entry in in_bounds:
        if entry.rel_path in seen_rel:
            me = _base_manifest_entry(entry, STATUS_CONFLICT)
            me.reason = REASON_DUPLICATE_RELPATH
            me.detail = (
                f"相对路径与另一条目冲突: {entry.rel_path} "
                f"({entry.abs_path} vs {seen_rel[entry.rel_path].abs_path})"
            )
            result.append(me)
            continue
        seen_rel[entry.rel_path] = entry
        no_dup.append(entry)

    # ---- 3. 副本落盘路径冲突（大小写不敏感，覆盖 macOS/Windows 场景） ----
    seen_lower: dict[str, Entry] = {}
    no_collision: list[Entry] = []
    for entry in no_dup:
        key = entry.rel_path.lower()
        if key in seen_lower:
            me = _base_manifest_entry(entry, STATUS_CONFLICT)
            me.reason = REASON_CASE_COLLISION
            me.detail = (
                f"副本路径在大小写不敏感文件系统上冲突: {entry.rel_path} "
                f"与 {seen_lower[key].rel_path}"
            )
            result.append(me)
            continue
        seen_lower[key] = entry
        no_collision.append(entry)

    # ---- 4. 采集上限预占（仅普通文件计入，按相对路径字典序） ----
    regular = sorted(
        (e for e in no_collision if e.entry_type == TYPE_REGULAR),
        key=lambda e: e.rel_path,
    )
    non_regular = [e for e in no_collision if e.entry_type != TYPE_REGULAR]

    files_used = 0
    bytes_used = 0
    limited: set[str] = set()
    for entry in regular:
        hit: Optional[str] = None
        if max_files is not None and files_used >= max_files:
            hit = REASON_MAX_FILES
        elif max_bytes is not None and bytes_used + entry.size > max_bytes:
            hit = REASON_MAX_BYTES
        if hit is not None:
            limited.add(entry.rel_path)
            me = _base_manifest_entry(entry, STATUS_LIMIT_EXCEEDED)
            me.reason = hit
            me.detail = (
                f"命中采集上限（max_files={max_files}, "
                f"max_bytes={max_bytes}，已规划 {files_used} 个文件/"
                f"{bytes_used} 字节）"
            )
            result.append(me)
            continue
        files_used += 1
        bytes_used += entry.size

    # ---- 5. 其余条目定级 ----
    for entry in no_collision:
        if entry.rel_path in limited:
            continue
        if entry.entry_type == TYPE_REGULAR:
            result.append(_base_manifest_entry(entry, STATUS_PENDING))
        elif entry.entry_type in (TYPE_DIRECTORY, TYPE_SYMLINK):
            # 目录与边界内符号链接只登记属性，不复制内容
            result.append(_base_manifest_entry(entry, STATUS_RECORDED))
        elif entry.entry_type == TYPE_SPECIAL:
            me = _base_manifest_entry(entry, STATUS_SKIPPED)
            me.reason = REASON_SPECIAL_FILE
            me.detail = "特殊文件（FIFO/套接字/设备），按规则不读取不复制"
            result.append(me)
        else:  # pragma: no cover - 防御性分支
            me = _base_manifest_entry(entry, STATUS_SKIPPED)
            result.append(me)

    # ---- 6. 扫描错误转 failed 条目（不可读目录等） ----
    for rel, detail in scan_errors:
        result.append(
            ManifestEntry(
                rel_path=rel,
                entry_type=TYPE_DIRECTORY,
                status=STATUS_FAILED,
                reason=REASON_UNREADABLE_DIR,
                detail=detail,
            )
        )

    result.sort(key=lambda me: me.rel_path)
    return result
