"""解析工作流文件中的行内例外注释。

语法（写在被发现问题的那一行末尾，或它的上一行）：

    # gha-audit: disable=GHA010 expires=2026-12-31 reason="等待上游发布"

例外只对同一文件、同一行（或下一行）的同编号规则生效，
不会影响其他文件或其他行的同类发现。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from .model import Finding

_MARKER = re.compile(r"#\s*gha-audit\s*:\s*(?P<body>.*)$")
_DISABLE = re.compile(
    r"^disable\s*=\s*(?P<rules>[A-Za-z0-9_,\s]+?)"
    r"\s*(expires=\S+)?\s*(reason=.*)?$"
)
_EXPIRES = re.compile(r"expires=(?P<date>\d{4}-\d{2}-\d{2})")
_REASON = re.compile(r"reason=(?:\"(?P<quoted>[^\"]*)\"|(?P<bare>\S+))")


@dataclass
class Suppression:
    line: int
    rules: list[str]
    expires: date | None = None
    reason: str = ""
    active: bool = True


def parse_suppressions(path, text, known_rules, today):
    """解析文件文本中的例外注释，返回 (有效/无效例外列表, 例外相关问题列表)。"""
    suppressions, findings = [], []
    for lineno, line in enumerate(text.splitlines(), 1):
        marker = _MARKER.search(line)
        if not marker:
            continue
        body = marker.group("body").strip()
        disable = _DISABLE.match(body)
        if not disable:
            findings.append(Finding(
                "GHA901", "low", path, lineno,
                "例外注释格式无法解析（应为 disable=规则编号 [expires=YYYY-MM-DD] "
                "[reason=\"...\"]）"))
            continue
        rules = [r.strip() for r in disable.group("rules").split(",") if r.strip()]
        unknown = [r for r in rules if r not in known_rules]
        if unknown:
            findings.append(Finding(
                "GHA901", "low", path, lineno,
                f"例外引用了不存在的规则编号: {', '.join(sorted(unknown))}"))
            continue
        expires = None
        expires_match = _EXPIRES.search(body)
        if expires_match:
            try:
                expires = date.fromisoformat(expires_match.group("date"))
            except ValueError:
                findings.append(Finding(
                    "GHA901", "low", path, lineno,
                    f"例外的过期时间不是有效日期: {expires_match.group('date')}"))
                continue
        reason_match = _REASON.search(body)
        reason = ""
        if reason_match:
            reason = reason_match.group("quoted") or reason_match.group("bare") or ""
        suppression = Suppression(lineno, rules, expires, reason)
        if expires is not None and expires < today:
            findings.append(Finding(
                "GHA902", "low", path, lineno,
                f"例外已于 {expires.isoformat()} 过期（规则 {', '.join(rules)}），"
                "对应发现不再被豁免"))
            suppression.active = False
        suppressions.append(suppression)
    return suppressions, findings


def apply_suppressions(findings, suppressions):
    """就地标记被例外覆盖的发现；例外相关规则（GHA9xx）不可被豁免。"""
    active = [s for s in suppressions if s.active]
    for finding in findings:
        if finding.rule_id.startswith("GHA9"):
            continue
        for sup in active:
            if finding.rule_id in sup.rules and finding.line in (sup.line, sup.line + 1):
                finding.suppressed = True
                break
