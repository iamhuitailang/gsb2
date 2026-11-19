"""目录扫描。

关键安全行为：
- 全程不跟随符号链接（os.scandir / lstat 语义），符号链接目录不会被递归进入；
- 特殊文件（FIFO、套接字、字符/块设备）会被识别并标记，绝不当普通文件打开；
- 不可读目录与 stat 失败作为扫描错误返回，由规划器转成 failed 条目，
  而不是静默跳过；
- 输出顺序按相对路径排序，保证多次扫描结果稳定。
"""

from __future__ import annotations

import os
import stat

from .models import (
    Entry,
    TYPE_DIRECTORY,
    TYPE_REGULAR,
    TYPE_SPECIAL,
    TYPE_SYMLINK,
)
from .paths import is_within_root, lexical_abs, relative_posix


def _entry_type_from_mode(mode: int) -> str:
    if stat.S_ISREG(mode):
        return TYPE_REGULAR
    if stat.S_ISDIR(mode):
        return TYPE_DIRECTORY
    if stat.S_ISLNK(mode):
        return TYPE_SYMLINK
    # FIFO、socket、字符设备、块设备等统一归为特殊文件
    return TYPE_SPECIAL


def _make_entry(root: str, abs_path: str, st: os.stat_result, is_link: bool,
                link_target: str | None) -> Entry:
    return Entry(
        rel_path=relative_posix(root, abs_path),
        abs_path=abs_path,
        entry_type=_entry_type_from_mode(st.st_mode),
        size=st.st_size,
        mode=stat.S_IMODE(st.st_mode),
        uid=st.st_uid,
        gid=st.st_gid,
        inode=st.st_ino,
        nlink=st.st_nlink,
        mtime_ns=st.st_mtime_ns,
        is_symlink=is_link,
        symlink_target=link_target,
    )


def scan_tree(root: str) -> tuple[list[Entry], list[tuple[str, str]]]:
    """扫描根目录内的全部条目。

    返回 ``(条目列表, 扫描错误列表)``，扫描错误元素为
    ``(相对路径或绝对路径, 错误说明)``。
    """
    entries: list[Entry] = []
    errors: list[tuple[str, str]] = []
    _walk(root, root, entries, errors)
    entries.sort(key=lambda e: e.rel_path)
    return entries, errors


def _walk(root: str, dir_abs: str, entries: list[Entry],
          errors: list[tuple[str, str]]) -> None:
    try:
        scanner = os.scandir(dir_abs)
    except PermissionError as exc:
        errors.append((relative_posix(root, dir_abs), f"目录无法读取: {exc}"))
        return
    except OSError as exc:
        errors.append((relative_posix(root, dir_abs), f"目录打开失败: {exc}"))
        return

    with scanner:
        children = list(scanner)
    children.sort(key=lambda de: de.name)

    for de in children:
        abs_path = lexical_abs(de.path)
        # 词法边界兜底：正常情况下不会触发，触发说明路径本身包含逃逸变体
        if not is_within_root(root, abs_path):
            errors.append(
                (de.path, f"条目路径位于根目录之外，已拒绝扫描: {abs_path}")
            )
            continue
        try:
            st = de.stat(follow_symlinks=False)
        except OSError as exc:
            errors.append(
                (relative_posix(root, abs_path), f"无法获取文件属性: {exc}")
            )
            continue

        is_link = de.is_symlink()
        link_target = None
        if is_link:
            try:
                link_target = os.readlink(abs_path)
            except OSError as exc:
                errors.append(
                    (relative_posix(root, abs_path), f"无法读取符号链接目标: {exc}")
                )
                link_target = None

        entries.append(_make_entry(root, abs_path, st, is_link, link_target))

        # 只递归真实目录；符号链接目录按符号链接登记，绝不进入
        if stat.S_ISDIR(st.st_mode) and not is_link:
            _walk(root, abs_path, entries, errors)
