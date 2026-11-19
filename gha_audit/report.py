"""报告输出：人类可读文本与稳定的机器可读 JSON。"""
from __future__ import annotations

import json

from . import __version__
from .model import LEVELS
from .rules import RULES

_LEVEL_LABEL = {"high": "高", "medium": "中", "low": "低", "notice": "提示"}


def sort_findings(findings):
    """稳定的排序：文件 -> 行号 -> 规则编号。"""
    return sorted(findings, key=lambda f: (f.file, f.line, f.rule_id))


def _finding_dict(f):
    d = {
        "rule_id": f.rule_id,
        "rule": RULES.get(f.rule_id, ""),
        "level": f.level,
        "confidence": f.confidence,
        "file": f.file,
        "line": f.line,
        "message": f.message,
    }
    if f.job is not None:
        d["job"] = f.job
    if f.step is not None:
        d["step"] = f.step
    if f.evidence:
        d["evidence"] = list(f.evidence)
    return d


def render_json(result) -> str:
    active = sort_findings(result.active_findings)
    suppressed = sort_findings(result.suppressed_findings)
    by_level = {level: 0 for level in LEVELS}
    for f in active:
        by_level[f.level] += 1
    doc = {
        "tool": {"name": "gha-audit", "version": __version__},
        "summary": {
            "files_scanned": len(result.scanned),
            "files_skipped": len(result.skipped),
            "files_with_errors": len(result.errors),
            "findings": len(active),
            "suppressed": len(suppressed),
            "by_level": by_level,
        },
        "findings": [_finding_dict(f) for f in active],
        "suppressed_findings": [_finding_dict(f) for f in suppressed],
        "errors": [{"file": e.file, "reason": e.reason}
                   for e in sorted(result.errors, key=lambda e: e.file)],
    }
    return json.dumps(doc, ensure_ascii=False, indent=2)


def _render_finding(lines, f):
    location = f"L{f.line}" if f.line else "L?"
    context = ""
    if f.job:
        context = f" [任务: {f.job}]"
        if f.step:
            context += f" [步骤: {f.step}]"
    confidence = "（无法确认，需人工复核）" if f.confidence == "undetermined" else ""
    lines.append(
        f"  {location:<7}[{_LEVEL_LABEL.get(f.level, f.level)}] "
        f"{f.rule_id} {RULES.get(f.rule_id, '')}: {f.message}{context}{confidence}")
    for ev in f.evidence:
        lines.append(f"          依据: {ev}")


def render_text(result) -> str:
    lines = []
    active = sort_findings(result.active_findings)
    suppressed = sort_findings(result.suppressed_findings)
    lines.append(
        f"gha-audit {__version__}: 扫描 {len(result.scanned)} 个文件，"
        f"{len(active)} 项发现，{len(suppressed)} 项已豁免，"
        f"{len(result.errors)} 个文件错误")

    by_file = {}
    for f in active:
        by_file.setdefault(f.file, []).append(f)
    for path in sorted(by_file):
        lines.append("")
        lines.append(path)
        for f in by_file[path]:
            _render_finding(lines, f)

    if suppressed:
        lines.append("")
        lines.append("已豁免的发现（由行内例外覆盖）:")
        for f in suppressed:
            lines.append(f"  {f.file} L{f.line} {f.rule_id} {f.message}")

    if result.errors:
        lines.append("")
        lines.append("文件错误:")
        for e in sorted(result.errors, key=lambda e: e.file):
            lines.append(f"  {e.file}: {e.reason}")

    if result.skipped:
        lines.append("")
        lines.append(f"跳过 {len(result.skipped)} 个非工作流 YAML 文件")

    return "\n".join(lines)
