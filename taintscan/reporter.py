"""Human-readable and machine-readable report rendering."""

from __future__ import annotations

import json
from typing import Optional, TextIO

from .analyzer import ScanResult
from .baseline import Comparison
from .models import Finding, Warning

_STATUS_LABELS = {
    "new": "NEW",
    "existing": "EXISTING",
}


def _location(file: str, line: int, column: Optional[int] = None) -> str:
    if column is None:
        return f"{file}:{line}"
    return f"{file}:{line}:{column + 1}"


def render_text(
    result: ScanResult,
    stream: TextIO,
    show_status: bool = True,
    comparison: Optional[Comparison] = None,
) -> None:
    """Write findings, then warnings and a summary, in stable order."""

    for finding in result.findings:
        header = (
            f"{_location(finding.file, finding.line, finding.column)}  "
            f"[{finding.severity.name}] {finding.rule_id} {finding.rule_title}"
        )
        if show_status:
            header += f"  ({_STATUS_LABELS.get(finding.status, finding.status.upper())})"
        print(header, file=stream)
        print(f"  sink     : {finding.sink}", file=stream)
        print(f"  source   : {finding.source} ({finding.source_file}:{finding.source_line})", file=stream)
        print(f"  flow     : {finding.flow_label}", file=stream)
        print(f"  advice   : {finding.advice}", file=stream)
        print(file=stream)

    for warning in result.warnings:
        location = _location(
            warning.file, warning.line or 1, warning.column
        )
        print(
            f"WARNING {location} [{warning.kind}] {warning.message}",
            file=stream,
        )

    by_severity: dict[str, int] = {}
    for finding in result.findings:
        by_severity[finding.severity.name] = by_severity.get(finding.severity.name, 0) + 1
    severity_summary = ", ".join(
        f"{name.lower()}={by_severity[name]}"
        for name in ("CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO")
        if name in by_severity
    )

    print(
        f"scanned {result.files_scanned} file(s), "
        f"{result.files_failed} failed, "
        f"{len(result.findings)} finding(s)"
        + (f" ({severity_summary})" if severity_summary else "")
        + f", {len(result.warnings)} warning(s)",
        file=stream,
    )
    if comparison is not None:
        print(
            f"baseline: new={len(comparison.new)}, "
            f"existing={len(comparison.existing)}, "
            f"resolved={len(comparison.resolved)}",
            file=stream,
        )


def report_payload(
    result: ScanResult,
    comparison: Optional[Comparison] = None,
    tool_version: str = "",
) -> dict:
    payload = result.to_dict()
    if tool_version:
        payload["tool_version"] = tool_version
    if comparison is not None:
        payload["baseline"] = comparison.to_dict()
    return payload


def render_json(
    result: ScanResult,
    stream: TextIO,
    comparison: Optional[Comparison] = None,
    tool_version: str = "",
) -> None:
    json.dump(
        report_payload(result, comparison, tool_version),
        stream,
        ensure_ascii=False,
        indent=2,
        sort_keys=False,
    )
    stream.write("\n")
