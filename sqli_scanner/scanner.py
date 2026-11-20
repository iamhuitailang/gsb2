"""扫描编排：发现文件 -> 逐文件 AST 分析 -> 汇总排序。"""

from __future__ import annotations

from typing import Iterable, List, Optional, Set

from .analyzer import ModuleAnalyzer
from .model import ScanResult
from .walker import discover_python_files


def scan_path(
    root: str,
    subdirs: Optional[Iterable[str]] = None,
    extra_sources: Optional[Iterable[str]] = None,
    extra_skip: Optional[Iterable[str]] = None,
    assume_params_tainted: bool = False,
) -> ScanResult:
    """扫描一个目录或单个 Python 文件，返回汇总结果。

    整个过程只做语法解析，不执行被扫描项目的任何代码。
    """
    extra_source_set: Set[str] = set(extra_sources or [])
    files, warnings = discover_python_files(root, subdirs=subdirs, extra_skip=extra_skip)

    result = ScanResult(
        root=root,
        findings=[],
        files_scanned=[],
        warnings=list(warnings),
        extra_sources=sorted(extra_source_set),
    )

    for discovered in files:
        try:
            with open(discovered.abspath, "r", encoding="utf-8") as fh:
                source = fh.read()
        except (OSError, UnicodeDecodeError) as exc:
            result.warnings.append(f"无法读取 {discovered.relpath}: {exc}")
            continue

        try:
            analyzer = ModuleAnalyzer(
                path=discovered.relpath,
                source=source,
                extra_sources=extra_source_set,
                assume_params_tainted=assume_params_tainted,
            )
            findings = analyzer.analyze()
        except SyntaxError as exc:
            result.warnings.append(
                f"语法解析失败，已跳过 {discovered.relpath}: "
                f"{exc.msg} (行 {exc.lineno})"
            )
            continue
        result.findings.extend(findings)
        result.files_scanned.append(discovered.relpath)

    result.sort_findings()
    return result


def scan_source(source: str, path: str = "<inline>", **kwargs) -> ScanResult:
    """直接分析源码字符串，主要供测试使用。"""
    analyzer = ModuleAnalyzer(path=path, source=source, **kwargs)
    findings = analyzer.analyze()
    result = ScanResult(
        root=path,
        findings=findings,
        files_scanned=[path],
        warnings=[],
        extra_sources=sorted(kwargs.get("extra_sources") or []),
    )
    result.sort_findings()
    return result
