"""终端文本报告与结构化 JSON 导出。"""

from __future__ import annotations

import json
from typing import Dict, List, Optional

from .baseline import BaselineDiff
from .model import Finding, ScanResult, SEVERITY_VULNERABILITY

_SEVERITY_LABEL = {
    SEVERITY_VULNERABILITY: "确认风险",
    "review": "待复核",
}

_STATUS_LABEL = {
    "new": "新增",
    "existing": "仍存在",
    "missing": "已消失",
}


def _line(finding: Finding) -> str:
    label = _SEVERITY_LABEL.get(finding.severity, finding.severity)
    return (
        f"[{label}] {finding.finding_id} {finding.rule}\n"
        f"  输入位置: {finding.path}:{finding.source_lineno}  ({finding.source_name})\n"
        f"  执行位置: {finding.path}:{finding.sink_lineno}  ({finding.sink_name})\n"
        f"  原因: {finding.reason}\n"
        f"  传播路径:"
    )


def render_text(
    result: ScanResult,
    diff: Optional[BaselineDiff] = None,
    baseline_path: Optional[str] = None,
) -> str:
    out: List[str] = []
    out.append("=" * 72)
    out.append("SQL 注入离线静态检查报告")
    out.append(f"扫描根目录: {result.root}")
    out.append(f"扫描文件数: {len(result.files_scanned)}")
    if result.extra_sources:
        out.append(f"额外输入源: {', '.join(sorted(result.extra_sources))}")
    out.append(
        f"发现总数: {len(result.findings)} "
        f"(确认风险 {sum(1 for f in result.findings if f.severity == SEVERITY_VULNERABILITY)}, "
        f"待复核 {sum(1 for f in result.findings if f.severity == 'review')})"
    )
    out.append("=" * 72)

    if baseline_path:
        out.append(f"对比清单: {baseline_path}")

    if not result.findings:
        out.append("未发现外部输入进入动态 SQL 的风险。")
    else:
        if diff is not None:
            sections = [
                ("new", diff.new),
                ("existing", diff.existing),
                ("missing", diff.missing),
            ]
            for status, findings in sections:
                if not findings:
                    continue
                out.append("")
                out.append(f"--- {_STATUS_LABEL[status]} ({len(findings)}) ---")
                out.extend(_render_findings(findings, show_status=status))
        else:
            out.append("")
            out.extend(_render_findings(result.findings, show_status=None))

    if result.warnings:
        out.append("")
        out.append("警告:")
        for warning in result.warnings:
            out.append(f"  - {warning}")

    return "\n".join(out) + "\n"


def _render_findings(findings: List[Finding], show_status: Optional[str]) -> List[str]:
    blocks: List[str] = []
    for finding in findings:
        header = _line(finding)
        if show_status is not None:
            header += f"  [{_STATUS_LABEL[show_status]}]"
        lines = [header]
        if finding.trace:
            for step in finding.trace:
                lines.append(f"    L{step.lineno:<5} {step.kind:<15} {step.detail}")
                if step.code:
                    lines.append(f"           > {step.code}")
        else:
            lines.append("    （无可用传播路径）")
        blocks.append("\n".join(lines))
    return blocks


def render_json(
    result: ScanResult,
    diff: Optional[BaselineDiff] = None,
    baseline_path: Optional[str] = None,
) -> str:
    findings_payload: List[dict] = []
    if diff is not None:
        for status, findings in (
            ("new", diff.new),
            ("existing", diff.existing),
            ("missing", diff.missing),
        ):
            for finding in findings:
                item = finding.to_dict()
                item["status"] = status
                findings_payload.append(item)
    else:
        findings_payload = [f.to_dict() for f in result.findings]

    payload = {
        "tool": "sqli_scanner",
        "root": result.root,
        "files_scanned": result.files_scanned,
        "warnings": result.warnings,
        "extra_sources": sorted(result.extra_sources),
        "summary": {
            "total": len(result.findings),
            "vulnerability": sum(
                1 for f in result.findings if f.severity == SEVERITY_VULNERABILITY
            ),
            "review": sum(1 for f in result.findings if f.severity == "review"),
        },
        "baseline": baseline_path,
        "findings": findings_payload,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def write_json_file(path: str, content: str) -> None:
    import os

    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
