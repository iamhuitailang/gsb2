"""Data structures shared by the scanner, reporter and baseline code."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Iterable, Optional

from .rules import ALL_SINK_KINDS, Severity


SOURCE_KIND = "source"
PARAM_KIND = "param"

MAX_HOPS = 48


@dataclass(frozen=True)
class Origin:
    """Where a tainted value entered the analysed code."""

    kind: str  # "source" or "param"
    label: str
    file: str
    line: int
    function: Optional[str] = None
    param: Optional[str] = None
    param_index: Optional[int] = None
    code: str = ""

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "kind": self.kind,
            "label": self.label,
            "file": self.file,
            "line": self.line,
        }
        if self.function:
            data["function"] = self.function
        if self.param:
            data["param"] = self.param
        if self.param_index is not None:
            data["param_index"] = self.param_index
        if self.code:
            data["code"] = self.code
        return data

    def signature(self) -> str:
        if self.kind == PARAM_KIND:
            return f"param:{self.function}:{self.param_index}"
        return f"source:{self.label}"


@dataclass(frozen=True)
class Hop:
    """One step on the data-flow path: call, return, indexing, sanitiser."""

    kind: str  # "call", "return", "index", "sanitize"
    label: str
    file: str
    line: int
    function: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "label": self.label,
            "file": self.file,
            "line": self.line,
            "function": self.function,
        }


@dataclass(frozen=True)
class Taint:
    """An abstract tainted value with provenance."""

    origin: Origin
    via: tuple[Hop, ...] = ()
    sanitized_for: frozenset[str] = frozenset()

    def is_effective(self, sink_kind: str) -> bool:
        return sink_kind not in self.sanitized_for

    def sanitize(self, kinds: Iterable[str]) -> "Taint":
        return Taint(self.origin, self.via, self.sanitized_for | frozenset(kinds))

    def with_hop(self, hop: Hop) -> "Taint":
        # Repeating a hop means a recursive/cyclic path; stop growing.
        if hop in self.via or len(self.via) >= MAX_HOPS:
            return self
        return Taint(self.origin, self.via + (hop,), self.sanitized_for)

    def is_clean(self) -> bool:
        return ALL_SINK_KINDS <= self.sanitized_for

    def flow(self, sink: Optional[dict[str, Any]] = None) -> list[dict[str, Any]]:
        steps = [self.origin.to_dict()]
        steps.extend(hop.to_dict() for hop in self.via)
        if sink is not None:
            steps.append(sink)
        return steps

    def flow_label(self, sink_label: Optional[str] = None) -> str:
        parts = [f"{self.origin.label} ({self.origin.file}:{self.origin.line})"]
        for hop in self.via:
            if hop.kind == "sanitize":
                parts.append(f"{hop.label}()")
            elif hop.kind == "call":
                parts.append(f"{hop.label}")
            elif hop.kind == "return":
                parts.append(f"return {hop.function}")
            else:
                parts.append(f"[{hop.label}]")
        if sink_label:
            parts.append(f"!! {sink_label}")
        return " -> ".join(parts)


def sanitize_set(taints: Iterable[Taint], kinds: Iterable[str]) -> frozenset[Taint]:
    """Apply a sanitiser that is *effective only for* ``kinds``."""

    kinds = frozenset(kinds)
    if not kinds:
        return frozenset(taints)
    out: set[Taint] = set()
    for taint in taints:
        updated = taint.sanitize(kinds)
        if not updated.is_clean():
            out.add(updated)
    return frozenset(out)


def merge_taints(*groups: Iterable[Taint]) -> frozenset[Taint]:
    result: set[Taint] = set()
    for group in groups:
        result.update(group)
    return frozenset(result)


@dataclass
class Finding:
    rule_id: str
    rule_title: str
    severity: Severity
    message: str
    advice: str
    file: str
    line: int
    column: int
    sink: str
    source: str
    source_file: str
    source_line: int
    flow: list[dict[str, Any]]
    fingerprint: str = ""
    status: str = "new"
    flow_label: str = ""

    def sort_key(self) -> tuple:
        return (self.file, self.line, self.column, self.rule_id, self.fingerprint)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "rule_title": self.rule_title,
            "severity": self.severity.name,
            "severity_rank": int(self.severity),
            "message": self.message,
            "advice": self.advice,
            "file": self.file,
            "line": self.line,
            "column": self.column,
            "sink": self.sink,
            "source": self.source,
            "source_file": self.source_file,
            "source_line": self.source_line,
            "flow": self.flow,
            "flow_label": self.flow_label,
            "fingerprint": self.fingerprint,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Finding":
        severity = Severity.parse(data["severity"])
        return cls(
            rule_id=data["rule_id"],
            rule_title=data.get("rule_title", ""),
            severity=severity,
            message=data.get("message", ""),
            advice=data.get("advice", ""),
            file=data["file"],
            line=int(data["line"]),
            column=int(data.get("column", 0)),
            sink=data.get("sink", ""),
            source=data.get("source", ""),
            source_file=data.get("source_file", data["file"]),
            source_line=int(data.get("source_line", data["line"])),
            flow=list(data.get("flow", [])),
            fingerprint=data.get("fingerprint", ""),
            status=data.get("status", "new"),
            flow_label=data.get("flow_label", ""),
        )


def fingerprint(
    file: str,
    rule_id: str,
    sink: str,
    sink_code: str,
    functions: tuple[str, ...],
    source_signature: str,
    source_code: str,
    source_file: str = "",
) -> str:
    """Stable identity for a finding across line-number shifts.

    Deliberately excludes line/column numbers: unrelated edits above a finding
    must not mark it as new in a baseline comparison.  The source *file* is
    included so that two different entry points feeding the same sink remain
    distinct findings.
    """

    payload = "\x1f".join(
        [
            file,
            rule_id,
            sink,
            sink_code,
            "/".join(functions),
            source_signature,
            source_code,
            source_file,
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


@dataclass
class Warning:
    file: str
    line: Optional[int]
    column: Optional[int]
    kind: str
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "file": self.file,
            "line": self.line,
            "column": self.column,
            "kind": self.kind,
            "message": self.message,
        }

    def sort_key(self) -> tuple:
        return (self.file, self.line or 0, self.column or 0, self.message)
