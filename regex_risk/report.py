"""把 :class:`~regex_risk.checker.CheckResult` 渲染成文本或 JSON。

输出字段保持稳定、顺序固定，便于脚本消费。JSON 中风险发现、
输入错误、检查正常通过三类状态分别用不同的 ``status`` 区分。
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from .analyzer import RISK_LEVELS
from .checker import CheckResult, InputFileError, LineResult

_LEVEL_LABELS = {
    "high": "高风险",
    "medium": "中风险",
    "low": "低风险",
    "info": "信息",
}

_STATUS_LABELS = {
    "ok": "检查通过",
    "findings": "发现风险",
    "invalid": "表达式不合法",
}


def _finding_to_dict(finding) -> Dict[str, Any]:
    return {
        "level": finding.level,
        "code": finding.code,
        "position": finding.position,
        "end_position": finding.end_position,
        "snippet": finding.snippet,
        "reason": finding.reason,
    }


def _line_to_dict(line: LineResult) -> Dict[str, Any]:
    data: Dict[str, Any] = {
        "line_number": line.line_number,
        "pattern": line.pattern,
        "status": line.status,
        "findings": [_finding_to_dict(item) for item in line.findings],
        "notes": list(line.notes),
    }
    if line.error is not None:
        data["error"] = line.error
    return data


def build_json(result: CheckResult) -> str:
    """机器可读的 JSON 报告（键顺序固定，缩进两空格，不转义非 ASCII 字符）。"""
    payload = {
        "tool": "regex_risk",
        "input_file": result.path,
        "summary": {
            "total_non_blank_lines": result.total_non_blank,
            "lines_with_findings": result.finding_count,
            "invalid_lines": result.invalid_count,
            "clean_lines": result.clean_count,
            "risk_levels": list(RISK_LEVELS),
        },
        "lines": [_line_to_dict(line) for line in result.lines],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False)


def build_input_error_json(path: str, message: str) -> str:
    payload = {
        "tool": "regex_risk",
        "input_file": path,
        "status": "input_error",
        "error": message,
        "lines": [],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False)


def build_text(result: CheckResult) -> str:
    """面向人的纯文本报告。"""
    out: List[str] = []
    out.append(f"正则风险检查报告：{result.path}")
    out.append(
        f"共检查 {result.total_non_blank} 条非空表达式："
        f"{result.finding_count} 条发现风险，"
        f"{result.invalid_count} 条不合法，"
        f"{result.clean_count} 条检查通过"
    )
    out.append("")
    for line in result.lines:
        header = (
            f"第 {line.line_number} 行 [{_STATUS_LABELS[line.status]}]：{line.pattern}"
        )
        out.append(header)
        if line.status == "invalid":
            out.append(f"  - 错误：{line.error}")
        for finding in line.findings:
            label = _LEVEL_LABELS[finding.level]
            out.append(
                f"  - [{label}] 位置 {finding.position}-{finding.end_position} "
                f"({finding.code}) {finding.snippet!r}"
            )
            out.append(f"      理由：{finding.reason}")
        for note in line.notes:
            out.append(f"  - 说明：{note}")
        if line.status == "ok" and not line.notes:
            out.append("  - 未发现符合当前规则的风险写法")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def build_input_error_text(path: str, message: str) -> str:
    return f"输入错误：{message}\n"
