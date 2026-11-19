"""逐行读取正则表达式文件并汇总分析结果。

输入文件是纯文本，每行一条正则表达式（按文件中的物理行号定位，
空行跳过且不影响后续行号）。文件本身无法读取时抛出
:class:`InputFileError`，调用方据此区分“输入错误”和“行内错误”。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List, Optional

from .analyzer import Finding, analyze_pattern


class InputFileError(Exception):
    """输入文件无法打开或读取（区别于单行表达式自身的语法错误）。"""


@dataclass
class LineResult:
    line_number: int
    pattern: str
    status: str  # "ok" | "findings" | "invalid"
    findings: List[Finding] = field(default_factory=list)
    error: Optional[str] = None
    notes: List[str] = field(default_factory=list)

    @property
    def max_level(self) -> Optional[str]:
        if not self.findings:
            return None
        order = {"high": 0, "medium": 1, "low": 2, "info": 3}
        return min((item.level for item in self.findings), key=lambda lv: order[lv])


@dataclass
class CheckResult:
    path: str
    lines: List[LineResult]
    total_non_blank: int

    @property
    def invalid_count(self) -> int:
        return sum(1 for line in self.lines if line.status == "invalid")

    @property
    def finding_count(self) -> int:
        return sum(1 for line in self.lines if line.status == "findings")

    @property
    def clean_count(self) -> int:
        return sum(1 for line in self.lines if line.status == "ok")


def check_file(path: str) -> CheckResult:
    """读取并分析 ``path`` 中的所有非空行。"""
    if os.path.isdir(path):
        raise InputFileError(f"输入路径是目录而不是文件：{path}")
    try:
        with open(path, "r", encoding="utf-8", newline="") as handle:
            content = handle.read()
    except FileNotFoundError:
        raise InputFileError(f"文件不存在：{path}")
    except IsADirectoryError:
        raise InputFileError(f"输入路径是目录而不是文件：{path}")
    except UnicodeDecodeError as exc:
        raise InputFileError(
            f"文件不是有效的 UTF-8 文本（第 {exc.start} 字节附近），无法按行解析：{path}"
        )
    except OSError as exc:
        raise InputFileError(f"无法读取文件 {path}：{exc}")

    # 保留物理行号：splitlines 会丢掉最后的空行，空行本来就要跳过。
    physical_lines = content.splitlines()
    results: List[LineResult] = []
    for line_number, raw_line in enumerate(physical_lines, start=1):
        # 去掉 Windows 行尾残留的 \r；正则内部的空白属于模式内容，不做 strip。
        line = raw_line[:-1] if raw_line.endswith("\r") else raw_line
        if line == "":
            continue
        findings, error, notes = analyze_pattern(line)
        if error is not None:
            results.append(
                LineResult(
                    line_number=line_number,
                    pattern=line,
                    status="invalid",
                    error=error,
                    notes=list(notes),
                )
            )
            continue
        assert findings is not None
        status = "findings" if findings else "ok"
        results.append(
            LineResult(
                line_number=line_number,
                pattern=line,
                status=status,
                findings=findings,
                notes=list(notes),
            )
        )

    return CheckResult(
        path=path,
        lines=results,
        total_non_blank=len(results),
    )
