"""根目录规范化、相对路径计算与边界判定。

设计原则：
- 根目录在采集开始时做一次 realpath 规范化，之后所有边界判定都基于它，
  避免 ``a/../b``、``./x``、符号链接等路径变体绕过限制。
- 普通条目的绝对路径不经过 realpath（否则无法发现符号链接），
  先做词法规范化（normpath），再用 commonpath 做边界判定；
  对普通文件而言词法规范化后的路径必须仍在根目录内。
- 符号链接一律不跟随；其目标单独解析并判定是否逃逸。
"""

from __future__ import annotations

import os
import posixpath


class PathError(Exception):
    """路径不合法或越界。"""


def normalize_root(root: str) -> str:
    """返回根目录的规范化绝对路径（解析根自身上的符号链接）。

    根目录必须真实存在且是一个目录。
    """
    if not isinstance(root, str) or not root:
        raise PathError("根目录路径不能为空")
    expanded = os.path.expanduser(root)
    resolved = os.path.realpath(expanded)
    if not os.path.isabs(resolved):
        raise PathError(f"根目录无法规范化为绝对路径: {root}")
    if not os.path.exists(resolved):
        raise PathError(f"根目录不存在: {root}")
    if not os.path.isdir(resolved):
        raise PathError(f"根目录不是目录: {root}")
    return resolved


def lexical_abs(path: str) -> str:
    """词法规范化为绝对路径，不解析任何符号链接。"""
    return os.path.normpath(os.path.abspath(os.path.expanduser(path)))


def relative_posix(root: str, abs_path: str) -> str:
    """计算条目相对根目录的 POSIX 风格相对路径（使用 / 分隔）。

    要求 abs_path 已通过 :func:`is_within_root` 判定。
    """
    rel = os.path.relpath(abs_path, root)
    # 统一为 POSIX 风格，保证清单在不同平台上稳定可比对
    return rel.replace(os.sep, "/")


def is_within_root(root: str, abs_path: str) -> bool:
    """词法层面判定 abs_path 是否位于 root 之内（或就是 root 本身）。

    只做字符串/路径段比较，不触碰文件系统、不解析符号链接。
    """
    root_parts = os.path.normpath(root).split(os.sep)
    path_parts = os.path.normpath(abs_path).split(os.sep)
    if len(path_parts) < len(root_parts):
        return False
    return path_parts[: len(root_parts)] == root_parts


def resolve_symlink_target(root: str, link_abs_path: str, target: str) -> tuple[bool, str]:
    """解析符号链接目标并判定是否逃逸出根目录。

    返回 ``(是否在根内, 解析后的绝对路径)``。
    目标为相对路径时，相对的是链接所在目录；解析使用 realpath，
    会展开目标链路上的全部符号链接，从而识别多层跳转逃逸。
    """
    if posixpath.isabs(target) or os.path.isabs(target):
        target_abs = os.path.normpath(target)
    else:
        link_dir = os.path.dirname(link_abs_path)
        target_abs = os.path.normpath(os.path.join(link_dir, target))
    # realpath 展开目标本身（及链路）上的符号链接；目标不存在时 realpath 仍可用
    resolved = os.path.realpath(target_abs)
    return is_within_root(root, resolved), resolved


def safe_join_copy_root(copy_root: str, rel_path: str) -> str:
    """把清单里的相对路径安全拼接到副本根目录。

    再次做边界校验，防止被损坏/篡改的清单把副本写到副本目录之外。
    """
    if rel_path.startswith("/") or rel_path.startswith("\\"):
        raise PathError(f"副本相对路径不能是绝对路径: {rel_path}")
    dest = os.path.normpath(os.path.join(copy_root, rel_path))
    if not is_within_root(copy_root, dest):
        raise PathError(f"副本路径逃逸: {rel_path}")
    return dest
