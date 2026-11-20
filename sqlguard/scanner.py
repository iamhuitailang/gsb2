"""文件收集与扫描调度。只读扫描，不执行目标代码。"""
from __future__ import annotations

import os
from fnmatch import fnmatch
from pathlib import Path

from .analyzer import Analyzer
from .model import ScanResult

# 默认忽略的目录：版本控制、虚拟环境、缓存、构建产物
DEFAULT_EXCLUDE_DIRS = {
    ".git", ".hg", ".svn", "__pycache__",
    ".venv", "venv", "env", ".env",
    "node_modules", ".tox", ".nox",
    ".mypy_cache", ".pytest_cache", ".ruff_cache",
    "dist", "build", ".eggs", ".idea", ".vscode",
}


def _excluded(name, relpath, extra_patterns):
    if name in DEFAULT_EXCLUDE_DIRS:
        return True
    return any(fnmatch(name, pat) or fnmatch(relpath, pat)
               for pat in extra_patterns)


def gather_files(paths, extra_excludes, errors):
    """收集待扫描的 .py 文件，顺序稳定、去重。"""
    files = []
    for raw in paths:
        p = Path(raw)
        if p.is_file():
            if p.suffix == ".py":
                files.append(p)
            else:
                errors.append({"file": str(p), "error": "不是 Python 文件，未扫描"})
        elif p.is_dir():
            for root, dirs, filenames in os.walk(p):
                dirs[:] = sorted(
                    d for d in dirs
                    if not _excluded(
                        d, os.path.relpath(os.path.join(root, d), p),
                        extra_excludes)
                )
                for fn in sorted(filenames):
                    if fn.endswith(".py"):
                        files.append(Path(root) / fn)
        else:
            errors.append({"file": str(raw), "error": "路径不存在或不可读"})
    seen, ordered = set(), []
    for f in sorted(files, key=lambda x: str(x)):
        key = str(f)
        if key not in seen:
            seen.add(key)
            ordered.append(f)
    return ordered


def run_scan(paths, extra_excludes=()):
    """扫描给定文件/目录，返回 ScanResult。"""
    analyzer = Analyzer()
    errors = []
    files = gather_files(list(paths), list(extra_excludes), errors)
    analyzer.errors.extend(errors)
    for f in files:
        display = str(f)
        try:
            text = f.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            analyzer.errors.append({"file": display, "error": f"无法读取: {exc}"})
            continue
        analyzer.add_file(display, text)
    analyzer.analyze()
    return ScanResult(files_scanned=len(analyzer.trees),
                      findings=analyzer.findings,
                      errors=analyzer.errors)
