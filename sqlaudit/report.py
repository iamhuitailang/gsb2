"""面向人的纯文本报告渲染。"""

from __future__ import annotations

from .model import Severity
from .scanner import ScanResult

_SEVERITY_COLOR = {
    Severity.HIGH: "\033[31m",   # 红
    Severity.MEDIUM: "\033[33m",  # 黄
    Severity.LOW: "\033[36m",     # 青
}
_RESET = "\033[0m"
_DIM = "\033[2m"


def render_text(result: ScanResult, color: bool = True) -> str:
    lines: list[str] = []
    lines.append("=" * 72)
    lines.append("SQL 注入静态审查报告 (sqlaudit)")
    lines.append("=" * 72)
    lines.append(f"扫描目标   : {result.target}")
    lines.append(f"已分析文件 : {len(result.scanned_files)}")
    lines.append(f"风险发现   : {len(result.findings)}"
                 f" (HIGH {_count(result, Severity.HIGH)} / "
                 f"MEDIUM {_count(result, Severity.MEDIUM)} / "
                 f"LOW {_count(result, Severity.LOW)})")
    lines.append(f"分析失败   : {len(result.errors)} 个文件")
    lines.append("")

    if not result.findings:
        lines.append("✓ 未发现 SQL 注入风险。")
    for idx, finding in enumerate(result.findings, start=1):
        lines.extend(_render_finding(idx, finding, color))

    if result.errors:
        lines.append("-" * 72)
        lines.append("无法分析的文件（这些文件未参与污点分析，请人工检查）：")
        for err in result.errors:
            location = err.file if err.line == 0 else f"{err.file}:{err.line}"
            lines.append(f"  [{err.error_type}] {location}: {err.message}")
        lines.append("")

    lines.append("-" * 72)
    lines.append("说明: 本工具只做静态分析，不会执行被扫描项目的代码，"
                 "也不访问网络。")
    return "\n".join(lines)


def _count(result: ScanResult, severity: Severity) -> int:
    return sum(1 for f in result.findings if f.severity == severity)


def _render_finding(idx: int, finding, color: bool) -> list[str]:
    out: list[str] = []
    title = f"[{idx}] {finding.rule_id} 风险等级: {finding.severity.label}"
    if color:
        c = _SEVERITY_COLOR[finding.severity]
        title = f"{c}{title}{_RESET}"
    out.append(title)
    out.append(f"  原因     : {finding.reason}")
    out.append(f"  输入来源 : {finding.origin.source_kind} "
               f"@ {finding.origin.file}:{finding.origin.line}")
    out.append(f"             {_dim_code(finding.origin.code, color)}")
    out.append(f"  危险调用 : {finding.sink_function} "
               f"@ {finding.file}:{finding.line}"
               + ("  (同时存在参数化实参)" if finding.has_params else ""))
    out.append(f"             {_dim_code(finding.code, color)}")

    if finding.hops:
        out.append("  传递路径 :")
        for step, hop in enumerate(finding.hops, start=1):
            out.append(
                f"    {step}. {hop.function} "
                f"@ {hop.file}:{hop.line}"
            )
            out.append(f"       {_dim_code(hop.code, color)}")
    else:
        out.append("  传递路径 : 输入源直接到达危险调用，无中间函数传递")
    out.append("")
    return out


def _dim_code(code: str, color: bool) -> str:
    if color:
        return f"{_DIM}{code}{_RESET}"
    return code
