"""项目文件发现：跳过虚拟环境、版本控制、缓存等目录。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Iterable, Iterator, List, Optional, Tuple

# 默认跳过的目录名（虚拟环境 / 版本控制 / 缓存 / 构建产物 / IDE）
DEFAULT_SKIP_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".bzr",
        "__pycache__",
        ".venv",
        "venv",
        "env",
        ".env",
        "virtualenv",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".pyre",
        ".tox",
        ".nox",
        ".idea",
        ".vscode",
        "node_modules",
        ".eggs",
        "egg-info",
        "build",
        "dist",
    }
)


@dataclass
class DiscoveredFile:
    relpath: str   # 相对扫描根目录、使用 posix 分隔符的路径
    abspath: str


def _to_posix(path: str) -> str:
    return path.replace(os.sep, "/")


def discover_python_files(
    root: str,
    subdirs: Optional[Iterable[str]] = None,
    extra_skip: Optional[Iterable[str]] = None,
) -> Tuple[List[DiscoveredFile], List[str]]:
    """枚举需要扫描的 .py 文件。

    root 可以是目录，也可以是单个 .py 文件。
    subdirs 给出时只扫描 root 下这些子目录（跳过规则仍然生效）。
    返回 (文件列表, 警告信息列表)。
    """
    warnings: List[str] = []
    skip_dirs = set(DEFAULT_SKIP_DIRS)
    if extra_skip:
        skip_dirs.update(extra_skip)

    root = os.path.abspath(root)

    # root 本身就是单个文件
    if os.path.isfile(root):
        if root.endswith(".py"):
            return [DiscoveredFile(relpath=os.path.basename(root), abspath=root)], warnings
        warnings.append(f"不是 Python 文件，已跳过: {root}")
        return [], warnings

    if not os.path.isdir(root):
        raise FileNotFoundError(f"扫描路径不存在: {root}")

    # 校验并规范化子目录
    walk_roots: List[str] = []
    real_root = os.path.realpath(root)
    if subdirs:
        for sub in subdirs:
            candidate = os.path.abspath(os.path.join(root, sub))
            if os.path.realpath(candidate) != real_root and not os.path.realpath(
                candidate
            ).startswith(real_root + os.sep):
                warnings.append(f"子目录超出扫描根目录，已忽略: {sub}")
                continue
            if not os.path.isdir(candidate):
                warnings.append(f"子目录不存在，已忽略: {sub}")
                continue
            walk_roots.append(candidate)
    else:
        walk_roots = [root]

    discovered: List[DiscoveredFile] = []
    seen = set()
    for base in walk_roots:
        for dirpath, dirnames, filenames in os.walk(base):
            # 原地裁剪：跳过环境/缓存/版本控制目录，以及指向外部的符号链接目录
            pruned = []
            for name in dirnames:
                full = os.path.join(dirpath, name)
                if name in skip_dirs:
                    pruned.append(name)
                elif os.path.islink(full):
                    warnings.append(f"跳过符号链接目录: {os.path.relpath(full, root)}")
                    pruned.append(name)
            for name in pruned:
                dirnames.remove(name)
            dirnames.sort()

            for filename in sorted(filenames):
                if not filename.endswith(".py"):
                    continue
                abspath = os.path.join(dirpath, filename)
                if abspath in seen:
                    continue
                seen.add(abspath)
                relpath = _to_posix(os.path.relpath(abspath, root))
                discovered.append(DiscoveredFile(relpath=relpath, abspath=abspath))

    discovered.sort(key=lambda f: f.relpath)
    return discovered, warnings
