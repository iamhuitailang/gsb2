"""数据模型：发现、文件错误与扫描结果。"""
from __future__ import annotations

from dataclasses import dataclass, field

# 风险级别，按严重程度排序
LEVELS = ("high", "medium", "low", "notice")

# 置信度：confirmed = 可确认的问题；undetermined = 无法可靠判断，需人工复核
CONFIRMED = "confirmed"
UNDETERMINED = "undetermined"


@dataclass
class Finding:
    rule_id: str
    level: str
    file: str
    line: int
    message: str
    confidence: str = CONFIRMED
    job: str | None = None
    step: str | None = None
    evidence: list[str] = field(default_factory=list)
    suppressed: bool = False


@dataclass
class FileError:
    file: str
    reason: str


@dataclass
class ScanResult:
    scanned: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    errors: list[FileError] = field(default_factory=list)

    @property
    def active_findings(self) -> list[Finding]:
        return [f for f in self.findings if not f.suppressed]

    @property
    def suppressed_findings(self) -> list[Finding]:
        return [f for f in self.findings if f.suppressed]
