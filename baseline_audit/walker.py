"""受限目录遍历器。

安全约定：
- 遍历起点解析为真实路径后，整个过程**绝不跟随符号链接**（os.walk 风格的
  followlinks 一律关闭），因此符号链接指向目录外、链接循环等情况都不可能让
  扫描读到选定目录之外的内容；
- 每个符号链接单独分类：in_scope / outside_root / broken / loop / unsupported；
- 单个条目 stat 或目录 scandir 失败只产生一条 read_error 通知，不中断遍历。
"""

from __future__ import annotations

import errno
import os
import stat

from .errors import READ_ERROR


def _is_within(root_real: str, candidate: str) -> bool:
    """判断 candidate 是否位于 root_real 内。

    不使用 commonpath：在 macOS（/var -> /private/var 等）上，对不存在路径
    调用 realpath 会改变前缀字符串，commonpath 会误判越界。
    """
    root = root_real.rstrip(os.sep)
    return candidate == root or candidate.startswith(root + os.sep)


def classify_symlink(abs_link: str, root_real: str) -> tuple[str, str]:
    """返回 (分类, 用于展示的目标说明)。不跟随、不读取目标内容。"""
    try:
        target_raw = os.readlink(abs_link)
    except OSError:
        return "unsupported", "<unreadable link target>"

    # 先判断循环：显式 stat（跟随）触发 ELOOP
    try:
        os.stat(abs_link)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            return "loop", target_raw
        if exc.errno in (errno.ENOENT, errno.ENOTDIR):
            return "broken", target_raw
        return "unsupported", target_raw

    resolved = os.path.realpath(abs_link)
    if _is_within(root_real, resolved):
        return "in_scope", target_raw
    return "outside_root", target_raw


def walk(root_real: str, excluded_realpaths: set[str] | None = None):
    """遍历 ``root_real``，返回 (entries, notices)。

    entries 元素：
      {"kind": "dir"|"file"|"symlink"|"other", "rel": posix 相对路径,
       "abs": 绝对路径, "st": lstat 结果(可空), ...}
    notices 元素：
      {"category": "read_error", "code": ..., "rel": ..., "detail": ...}
    """
    excluded_realpaths = excluded_realpaths or set()
    # 防御性规范化：调用方传入的根可能仍带 /var -> /private/var 这类符号链接
    # 前缀，统一到真实路径后再做所有字符串前缀比较
    root_real = os.path.realpath(root_real)
    excluded_realpaths = {os.path.realpath(p) for p in excluded_realpaths}
    entries: list[dict] = []
    notices: list[dict] = []

    root_st = os.lstat(root_real)
    entries.append({"kind": "dir", "rel": "", "abs": root_real, "st": root_st})

    # 显式栈，绝不跟随符号链接
    stack: list[tuple[str, str]] = [("", root_real)]
    while stack:
        rel_dir, abs_dir = stack.pop()

        if abs_dir in excluded_realpaths:
            notices.append(
                {
                    "category": READ_ERROR,
                    "code": "path_excluded",
                    "rel": rel_dir or ".",
                    "detail": "该目录是核查工具自身的数据目录，已跳过以免把工具状态当作被检对象。",
                }
            )
            continue

        try:
            scanner = os.scandir(abs_dir)
        except OSError as exc:
            notices.append(
                {
                    "category": READ_ERROR,
                    "code": "scandir_failed",
                    "rel": rel_dir or ".",
                    "detail": f"目录无法读取：{errno.errorcode.get(exc.errno, exc.errno)}",
                }
            )
            continue

        with scanner:
            for dir_entry in scanner:
                rel = f"{rel_dir}/{dir_entry.name}" if rel_dir else dir_entry.name
                abs_path = os.path.join(abs_dir, dir_entry.name)
                try:
                    is_link = dir_entry.is_symlink()
                except OSError as exc:
                    notices.append(
                        {
                            "category": READ_ERROR,
                            "code": "stat_failed",
                            "rel": rel,
                            "detail": f"无法判断文件类型：{errno.errorcode.get(exc.errno, exc.errno)}",
                        }
                    )
                    continue

                if is_link:
                    classification, target_raw = classify_symlink(abs_path, root_real)
                    # 相对链接初次判定为越界时，按链接所在目录再解析一次兜底
                    # （/var -> /private/var 前缀差异会让初次 realpath 误判）；
                    # 循环/断裂/不可解析的分类保持不变，绝不改判为 in_scope
                    if classification == "outside_root" and not os.path.isabs(target_raw):
                        joined = os.path.join(os.path.dirname(abs_path), target_raw)
                        try:
                            os.stat(joined)
                        except OSError:
                            pass  # 保持原分类（outside_root），不读取目标
                        else:
                            resolved_rel = os.path.realpath(joined)
                            if _is_within(root_real, resolved_rel):
                                classification = "in_scope"
                    entries.append(
                        {
                            "kind": "symlink",
                            "rel": rel,
                            "abs": abs_path,
                            "target": target_raw,
                            "classification": classification,
                        }
                    )
                    detail_map = {
                        "outside_root": "符号链接指向选定目录之外，未跟随、未读取目标。",
                        "loop": "符号链接存在循环，未跟随、未读取目标。",
                        "broken": "符号链接目标不存在，未读取。",
                        "in_scope": "符号链接指向目录内部；按安全策略不跟随链接，目标会以其自身路径被单独扫描。",
                        "unsupported": "符号链接无法解析，未跟随、未读取目标。",
                    }
                    notices.append(
                        {
                            "category": READ_ERROR,
                            "code": f"symlink_{classification}",
                            "rel": rel,
                            "detail": detail_map[classification],
                        }
                    )
                    continue

                try:
                    st = dir_entry.stat(follow_symlinks=False)
                except OSError as exc:
                    notices.append(
                        {
                            "category": READ_ERROR,
                            "code": "stat_failed",
                            "rel": rel,
                            "detail": f"无法获取状态：{errno.errorcode.get(exc.errno, exc.errno)}",
                        }
                    )
                    continue

                mode = st.st_mode
                if stat.S_ISDIR(mode):
                    entries.append({"kind": "dir", "rel": rel, "abs": abs_path, "st": st})
                    stack.append((rel, abs_path))
                elif stat.S_ISREG(mode):
                    entries.append({"kind": "file", "rel": rel, "abs": abs_path, "st": st})
                else:
                    entries.append({"kind": "other", "rel": rel, "abs": abs_path, "st": st})
                    notices.append(
                        {
                            "category": READ_ERROR,
                            "code": "unsupported_file_type",
                            "rel": rel,
                            "detail": "非常规文件（设备/套接字/FIFO 等），跳过内容与权限分析。",
                        }
                    )

    return entries, notices
