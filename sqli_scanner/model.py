"""核心数据模型：污点、传播路径、发现项、扫描结果。"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, asdict
from typing import List, Optional


# 风险等级
SEVERITY_VULNERABILITY = "vulnerability"  # 能确认外部输入进入了动态 SQL
SEVERITY_REVIEW = "review"                # 调用链无法完全确认，需要人工复核

# 规则编号
RULE_TAINTED_SQL = "tainted-dynamic-sql"
RULE_UNCONFIRMED_SQL = "unconfirmed-dynamic-sql"


@dataclass(frozen=True)
class TaintOrigin:
    """污点的最初来源。"""

    kind: str          # "source"：识别出的外部输入；"unknown"：无法确认的调用
    name: str          # 来源描述，如 request.args.get / unresolved:fetch_user_input
    path: str          # 所在文件（相对扫描根目录）
    lineno: int
    col: int


@dataclass(frozen=True)
class TraceStep:
    """污点传播路径上的一步，方便维护者顺着查回代码。"""

    lineno: int
    kind: str          # source / assign / concat / fstring / format / percent-format / call / sink ...
    detail: str        # 这一步做了什么
    code: str          # 对应源码片段（单行、去缩进）


@dataclass
class Taint:
    """一个表达式上的污点信息。

    origins 为空表示干净；unknown=True 表示污点来自无法确认的调用，
    这类数据进入 SQL 时只能给出“待复核”而不是确定漏洞。
    """

    origins: List[TaintOrigin] = field(default_factory=list)
    steps: List[TraceStep] = field(default_factory=list)
    unknown: bool = False

    @property
    def tainted(self) -> bool:
        return bool(self.origins)

    def clone(self) -> "Taint":
        return Taint(
            origins=list(self.origins),
            steps=list(self.steps),
            unknown=self.unknown,
        )


def _normalize(code: str) -> str:
    return " ".join(code.split())


@dataclass
class Finding:
    """一条检查发现。"""

    path: str
    rule: str
    severity: str
    source_kind: str
    source_name: str
    source_lineno: int
    sink_name: str
    sink_lineno: int
    reason: str
    trace: List[TraceStep]
    fingerprint: str = ""
    finding_id: str = ""

    def compute_fingerprint(self) -> str:
        """计算稳定标识。

        刻意不包含行号：只要涉及的源码文本不变，即使代码上下移动、
        行号变化，标识仍保持稳定；代码改动后标识自然改变。
        """
        parts = [
            self.path,
            self.rule,
            self.source_kind,
            self.source_name,
            self.sink_name,
        ]
        # 路径按行号排序后参与哈希，保证合并传播路径时结果确定
        for step in sorted(self.trace, key=lambda s: (s.lineno, s.kind, s.detail)):
            parts.append(f"{step.kind}:{step.detail}:{_normalize(step.code)}")
        raw = "|".join(parts)
        self.fingerprint = hashlib.sha1(raw.encode("utf-8")).hexdigest()
        self.finding_id = "SQL-" + self.fingerprint[:10]
        return self.fingerprint

    def to_dict(self) -> dict:
        data = asdict(self)
        data["id"] = self.finding_id
        data.pop("finding_id")
        return data

    @classmethod
    def from_dict(cls, data: dict) -> "Finding":
        trace = [TraceStep(**s) for s in data.get("trace", [])]
        finding = cls(
            path=data["path"],
            rule=data["rule"],
            severity=data["severity"],
            source_kind=data["source_kind"],
            source_name=data["source_name"],
            source_lineno=data["source_lineno"],
            sink_name=data["sink_name"],
            sink_lineno=data["sink_lineno"],
            reason=data["reason"],
            trace=trace,
            fingerprint=data.get("fingerprint", ""),
            finding_id=data.get("id", data.get("finding_id", "")),
        )
        if not finding.fingerprint:
            finding.compute_fingerprint()
        return finding


@dataclass
class ScanResult:
    """一次完整扫描的结果。"""

    root: str
    findings: List[Finding]
    files_scanned: List[str]
    warnings: List[str]
    extra_sources: List[str] = field(default_factory=list)

    def sort_findings(self) -> None:
        """统一排序，保证重复扫描输出顺序一致。"""
        self.findings.sort(
            key=lambda f: (f.path, f.sink_lineno, f.source_lineno, f.finding_id)
        )
        self.files_scanned.sort()
        self.warnings.sort()
