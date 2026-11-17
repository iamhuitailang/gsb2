"""文本与 JSON 报告渲染。

两条硬约束:
1. 所有输出路径均为相对扫描根的 POSIX 路径, 不出现根目录绝对前缀;
2. 行内容在写出前经过脱敏, 命中片段统一替换为 ***REDACTED***,
   凭据原文不会进入终端或报告文件。
"""

from __future__ import annotations

import json

from .baseline import BaselineDiff, BaselineEntry
from .models import Finding, Warning_, severity_rank, sort_warnings
from .redaction import redact_line


def _finding_to_dict(finding: Finding, context: str | None) -> dict:
    return {
        "path": finding.path,
        "line": finding.line,
        "column": finding.column,
        "rule_id": finding.rule_id,
        "severity": finding.severity,
        "reason": finding.reason,
        "match_length": finding.match_length,
        "fingerprint": finding.fingerprint,
        "context_redacted": context,
    }


def _entry_to_dict(entry: BaselineEntry) -> dict:
    return {
        "fingerprint": entry.fingerprint,
        "path": entry.path,
        "rule_id": entry.rule_id,
        "severity": entry.severity,
        "reason": entry.reason,
        "match_length": entry.match_length,
        "first_seen": entry.first_seen,
        "expires_on": entry.expires_on,
        "note": entry.note,
    }


class Reporter:
    """按需重新读取被命中的文件, 生成脱敏后的行上下文。"""

    def __init__(self, root: str):
        self._root = root
        self._line_cache: dict[str, list[str] | None] = {}

    def _lines(self, relative_path: str) -> list[str] | None:
        if relative_path not in self._line_cache:
            absolute = self._root + "/" + relative_path
            try:
                with open(absolute, "rb") as handle:
                    raw = handle.read()
            except OSError:
                self._line_cache[relative_path] = None
                return None
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("latin-1")
            self._line_cache[relative_path] = text.splitlines()
        return self._line_cache[relative_path]

    def redacted_context(self, finding: Finding) -> str | None:
        lines = self._lines(finding.path)
        if lines is None or finding.line > len(lines):
            return None
        line_text = lines[finding.line - 1]
        # 同一行若有多个命中, 全部脱敏; 这里只处理当前发现所在区间,
        # render_text 会按行汇总区间后再统一脱敏。
        return redact_line(
            line_text, [(finding.column - 1, finding.column - 1 + finding.match_length)]
        )

    def _line_spans(
        self, findings: list[Finding]
    ) -> dict[tuple[str, int], list[tuple[int, int]]]:
        spans: dict[tuple[str, int], list[tuple[int, int]]] = {}
        for finding in findings:
            key = (finding.path, finding.line)
            spans.setdefault(key, []).append(
                (finding.column - 1, finding.column - 1 + finding.match_length)
            )
        return spans

    # ------------------------------------------------------------------
    # JSON
    # ------------------------------------------------------------------

    def render_json(
        self,
        all_findings: list[Finding],
        new_findings: list[Finding],
        warnings: list[Warning_],
        diff: BaselineDiff | None,
        stats: dict,
    ) -> str:
        payload: dict = {
            "summary": stats,
            "findings": [
                _finding_to_dict(item, self.redacted_context(item))
                for item in all_findings
            ],
            "new_findings": [
                _finding_to_dict(item, self.redacted_context(item))
                for item in new_findings
            ],
            "warnings": [
                {"path": item.path, "kind": item.kind, "message": item.message}
                for item in sort_warnings(warnings)
            ],
        }
        if diff is not None:
            payload["baseline"] = {
                "acknowledged_count": len(diff.acknowledged),
                "expired": [
                    {
                        "finding": _finding_to_dict(
                            finding, self.redacted_context(finding)
                        ),
                        "expires_on": entry.expires_on,
                    }
                    for finding, entry in sorted(
                        diff.expired, key=lambda pair: pair[0].sort_key()
                    )
                ],
                "missing": [
                    _entry_to_dict(entry)
                    for entry in sorted(diff.missing, key=lambda item: item.fingerprint)
                ],
            }
        return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)

    # ------------------------------------------------------------------
    # 文本
    # ------------------------------------------------------------------

    def render_text(
        self,
        all_findings: list[Finding],
        new_findings: list[Finding],
        warnings: list[Warning_],
        diff: BaselineDiff | None,
        stats: dict,
    ) -> str:
        lines: list[str] = []
        new_keys = {
            (item.path, item.line, item.column, item.rule_id)
            for item in new_findings
        }
        spans_by_line = self._line_spans(all_findings)

        lines.append("secretscan 扫描报告")
        lines.append("=" * 60)
        lines.append(
            f"扫描文件数: {stats['scanned_files']}  "
            f"发现总数: {stats['finding_count']}  "
            f"新增: {stats['new_count']}"
        )
        lines.append(
            f"跳过(二进制): {stats['skipped_binary']}  "
            f"跳过(超大): {stats['skipped_oversized']}  "
            f"跳过(VCS目录): {stats['skipped_vcs']}  "
            f"过程告警: {stats['warning_count']}"
        )
        lines.append("")

        if not all_findings:
            lines.append("未发现疑似凭据。")
        else:
            lines.append("发现明细 (按路径/位置排序, 命中内容已脱敏):")
            for finding in all_findings:
                marker = "[新增]" if (
                    finding.path,
                    finding.line,
                    finding.column,
                    finding.rule_id,
                ) in new_keys else "[基线]"
                lines.append(
                    f"- {marker} {finding.severity.upper():<8} "
                    f"{finding.path}:{finding.line}:{finding.column} "
                    f"规则={finding.rule_id}"
                )
                lines.append(f"    原因: {finding.reason}")
                lines.append(f"    指纹: {finding.fingerprint}")
                context = self._redacted_line_for(finding, spans_by_line)
                if context is not None:
                    lines.append(f"    上下文: {context.strip()}")
            lines.append("")

        if diff is not None:
            if diff.expired:
                lines.append("已过期的基线条目 (按新问题处理):")
                for finding, entry in sorted(
                    diff.expired, key=lambda pair: pair[0].sort_key()
                ):
                    lines.append(
                        f"- {finding.path}:{finding.line}:{finding.column} "
                        f"{finding.rule_id} 基线已于 {entry.expires_on} 过期"
                    )
                lines.append("")
            if diff.missing:
                lines.append("基线中已消失的条目 (不再视为有效):")
                for entry in sorted(diff.missing, key=lambda item: item.fingerprint):
                    lines.append(
                        f"- 指纹={entry.fingerprint} 路径={entry.path} "
                        f"规则={entry.rule_id} 首次记录={entry.first_seen}"
                    )
                lines.append("")

        if warnings:
            lines.append("过程告警:")
            for item in sort_warnings(warnings):
                lines.append(f"- [{item.kind}] {item.path}: {item.message}")
            lines.append("")

        lines.append(
            "结论: "
            + (
                f"存在 {stats['new_count']} 条新增发现。"
                if stats["new_count"]
                else "没有超出基线的新发现。"
            )
        )
        return "\n".join(lines) + "\n"

    def _redacted_line_for(self, finding: Finding, spans_by_line) -> str | None:
        lines = self._lines(finding.path)
        if lines is None or finding.line > len(lines):
            return None
        return redact_line(lines[finding.line - 1], spans_by_line[(finding.path, finding.line)])
