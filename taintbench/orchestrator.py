"""多文件检查编排：读取限制、逐文件隔离分析、稳定排序。

安全约束：
- 待检源码一律以文本数据读取后交给 ast.parse，绝不 import/exec/compile。
- 文件数量、单文件大小、总大小都有硬性上限，防止工作台被超大输入拖垮。
"""

from __future__ import annotations

import os
from pathlib import Path

from .analyzer import analyze_source
from .models import FileError, FileResult

# 硬性输入限制
MAX_FILES = 20
MAX_FILE_BYTES = 200 * 1024  # 单文件 200KB
MAX_TOTAL_BYTES = 1024 * 1024  # 总计 1MB
MAX_PATH_DEPTH = 6

PYTHON_SUFFIXES = {".py"}


class CheckLimits:
    def __init__(self, max_files=MAX_FILES, max_file_bytes=MAX_FILE_BYTES, max_total_bytes=MAX_TOTAL_BYTES):
        self.max_files = max_files
        self.max_file_bytes = max_file_bytes
        self.max_total_bytes = max_total_bytes


def check_sources(sources: list[tuple[str, str]], limits: CheckLimits | None = None) -> list[FileResult]:
    """检查 (显示名, 源码文本) 列表。任何单文件失败都隔离在自己的结果里。"""
    limits = limits or CheckLimits()
    results: list[FileResult] = []
    if len(sources) > limits.max_files:
        results.append(
            FileResult(
                file="<check-request>",
                errors=[
                    FileError(
                        file="<check-request>",
                        line=0,
                        kind="analysis",
                        message=f"一次最多检查 {limits.max_files} 个文件，本次收到 {len(sources)} 个，请拆分后重试。",
                    )
                ],
            )
        )
        return results
    total = 0
    for display_name, source in sorted(sources, key=lambda item: item[0]):
        encoded_size = len(source.encode("utf-8", errors="replace"))
        total += encoded_size
        if encoded_size > limits.max_file_bytes:
            results.append(
                FileResult(
                    file=display_name,
                    errors=[
                        FileError(
                            file=display_name,
                            line=0,
                            kind="analysis",
                            message=f"文件 {encoded_size} 字节，超过单文件上限 {limits.max_file_bytes} 字节，已跳过。",
                        )
                    ],
                )
            )
            continue
        if total > limits.max_total_bytes:
            results.append(
                FileResult(
                    file=display_name,
                    errors=[
                        FileError(
                            file=display_name,
                            line=0,
                            kind="analysis",
                            message=f"累计输入超过总上限 {limits.max_total_bytes} 字节，该文件已跳过。",
                        )
                    ],
                )
            )
            continue
        results.append(analyze_source(source, display_name))
    return _sort_results(results)


def check_paths(paths: list[str], limits: CheckLimits | None = None) -> list[FileResult]:
    """检查本地路径（文件或目录）。目录只按扩展名收集 .py 文件，不跟随符号链接。"""
    limits = limits or CheckLimits()
    collected: list[tuple[str, str]] = []
    access_errors: list[FileResult] = []
    seen: set[str] = set()
    for raw in paths:
        path = Path(raw).expanduser()
        if not path.exists():
            access_errors.append(_error_result(str(path), f"路径不存在：{path}"))
            continue
        if path.is_file():
            _collect_file(path, seen, collected, access_errors)
        elif path.is_dir():
            for root, dirs, files in os.walk(path):
                dirs.sort()
                for name in sorted(files):
                    child = Path(root) / name
                    if child.suffix in PYTHON_SUFFIXES and not child.is_symlink():
                        _collect_file(child, seen, collected, access_errors)
        else:
            access_errors.append(_error_result(str(path), f"既不是文件也不是目录：{path}"))
    results = check_sources(collected, limits)
    return _sort_results(access_errors + results)


def _collect_file(path: Path, seen: set, collected: list, access_errors: list) -> None:
    key = str(path.resolve())
    if key in seen:
        return
    seen.add(key)
    try:
        # 显式 utf-8；解码失败作为该文件自己的错误，不影响其他文件
        source = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        access_errors.append(_error_result(str(path), f"文件不是 UTF-8 编码，无法解析：{exc.reason}"))
        return
    except OSError as exc:
        access_errors.append(_error_result(str(path), f"读取失败：{exc}"))
        return
    collected.append((str(path), source))


def _error_result(display_name: str, message: str) -> FileResult:
    return FileResult(
        file=display_name,
        errors=[FileError(file=display_name, line=0, kind="analysis", message=message)],
    )


def _sort_results(results: list[FileResult]) -> list[FileResult]:
    return sorted(results, key=lambda r: r.file)


def summarize(results: list[FileResult]) -> dict:
    findings = [f for r in results for f in r.findings]
    safe_calls = [s for r in results for s in r.safe_calls]
    errors = [e for r in results for e in r.errors]
    return {
        "files": len(results),
        "high": sum(1 for f in findings if f.severity == "high"),
        "medium": sum(1 for f in findings if f.severity == "medium"),
        "safe_calls": len(safe_calls),
        "errors": len(errors),
    }
