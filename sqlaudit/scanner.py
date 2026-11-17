"""扫描编排：遍历目录 -> 解析注册 -> 污点分析 -> 汇总结果。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .flow import FlowAnalyzer
from .model import AnalysisError, Finding, Severity
from .registry import RegistryBuilder

# 遍历时默认跳过的目录名（依赖、缓存、版本控制目录等）
_SKIP_DIRS = frozenset({
    ".git", ".hg", ".svn", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".venv", "venv", "env", "node_modules", "build", "dist",
    ".tox", ".nox", "site-packages",
})


@dataclass
class ScanResult:
    target: str
    findings: list[Finding] = field(default_factory=list)
    errors: list[AnalysisError] = field(default_factory=list)
    scanned_files: list[str] = field(default_factory=list)

    def filter_by_level(self, min_level: Severity) -> "ScanResult":
        """返回只包含指定等级及以上发现的新结果（错误信息始终保留）。"""
        kept = [f for f in self.findings if f.severity >= min_level]
        return ScanResult(
            target=self.target,
            findings=sorted(kept, key=lambda f: f.sort_key()),
            errors=list(self.errors),
            scanned_files=list(self.scanned_files),
        )

    def to_dict(self) -> dict:
        return {
            "target": self.target,
            "summary": {
                "scanned_files": len(self.scanned_files),
                "findings": len(self.findings),
                "errors": len(self.errors),
                "by_severity": {
                    "high": sum(1 for f in self.findings
                                if f.severity == Severity.HIGH),
                    "medium": sum(1 for f in self.findings
                                  if f.severity == Severity.MEDIUM),
                    "low": sum(1 for f in self.findings
                               if f.severity == Severity.LOW),
                },
            },
            "findings": [f.to_dict() for f in self.findings],
            "analysis_errors": [e.to_dict() for e in self.errors],
            "scanned_files": list(self.scanned_files),
        }


def discover_python_files(target: str,
                          excludes: list[str] | None = None) -> list[str]:
    """收集目标目录下所有 .py 文件（或目标本身就是一个文件）。

    跳过符号链接目录与常见的依赖/缓存目录，结果排序保证扫描稳定。
    """
    exclude_set = set(excludes or [])
    if os.path.isfile(target):
        return [target]

    files: list[str] = []
    for dirpath, dirnames, filenames in os.walk(target):
        # 原地修改 dirnames 以阻止 os.walk 下钻
        pruned = []
        for d in dirnames:
            full = os.path.join(dirpath, d)
            if d in _SKIP_DIRS or d in exclude_set or os.path.islink(full):
                continue
            pruned.append(d)
        dirnames[:] = sorted(pruned)
        for name in sorted(filenames):
            if not name.endswith(".py"):
                continue
            if name in exclude_set:
                continue
            files.append(os.path.join(dirpath, name))
    return sorted(files)


def scan_project(target: str,
                 excludes: list[str] | None = None) -> ScanResult:
    """对一个 Python 项目目录执行静态安全审查。"""
    target = os.path.abspath(target)
    files = discover_python_files(target, excludes)

    builder = RegistryBuilder(root=target, files=files)
    builder.build()

    analyzer = FlowAnalyzer(builder)
    findings = analyzer.analyze()

    errors = sorted(builder.errors, key=lambda e: e.sort_key())
    # 结果里所有文件位置统一使用相对 target 的路径，便于阅读与跨环境对比
    scanned = sorted(builder.registries.keys())
    return ScanResult(
        target=target,
        findings=findings,
        errors=errors,
        scanned_files=scanned,
    )
