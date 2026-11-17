"""输出脱敏工具。

报告中展示行内容时, 所有命中片段统一替换为固定占位符; 若一行上
存在多个命中, 从右向左替换以保证列偏移不失效。任何报告路径都不
会调用本模块之外的凭据原文。
"""

from __future__ import annotations

REDACTION = "***REDACTED***"


def redact_line(line_text: str, spans: list[tuple[int, int]]) -> str:
    """把一行内若干 [start, end) 字符区间替换为占位符。

    spans 为相对该行起始的字符偏移; 重复或重叠的区间先合并。
    """

    if not spans:
        return line_text
    ordered = sorted(spans)
    merged: list[list[int]] = []
    for start, end in ordered:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    result = line_text
    for start, end in reversed(merged):
        result = result[:start] + REDACTION + result[end:]
    return result
