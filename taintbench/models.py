"""核心数据模型：污点流、检查发现、安全调用、文件错误。

设计要点：
- 一个变量的污点由若干条 TaintFlow 组成，每条流记录唯一的输入来源、
  传播步骤和是否经过安全引用，保证传播路径可复查。
- Taint/TaintFlow 均为不可变对象，传播时生成新对象，避免分支间互相污染。
"""

from __future__ import annotations

from dataclasses import dataclass, field

# 单条传播路径保留的最大步骤数，超出后保留最早的来源标记并截断中间步骤
MAX_PATH_STEPS = 12

# 污点状态：TAINTED 表示在当前分析范围内可确认的数据流；
# POSSIBLE 表示经过无法解析的函数/参数等环节，按可能风险保守处理
STATE_TAINTED = "TAINTED"
STATE_POSSIBLE = "POSSIBLE"

SEVERITY_HIGH = "high"
SEVERITY_MEDIUM = "medium"


@dataclass(frozen=True)
class Origin:
    """不可信输入来源。"""

    kind: str  # input | flask | django
    label: str  # 给开发者看的来源描述
    line: int  # 来源所在行号

    @property
    def key(self) -> tuple:
        return self.kind, self.label, self.line


@dataclass(frozen=True)
class TaintFlow:
    """从某个来源出发的一条传播流。"""

    origin: Origin
    steps: tuple[str, ...] = ()
    # 非 None 表示该流经过了规则认可的安全处理（如 shlex.quote）
    sanitizer_rule: str | None = None

    def with_step(self, step: str) -> "TaintFlow":
        steps = self.steps + (step,)
        if len(steps) > MAX_PATH_STEPS:
            steps = steps[:1] + ("……（中间传播步骤已折叠）",) + steps[-MAX_PATH_STEPS + 2:]
        # 安全引用标记跟随整条流，普通传播步骤不会把它抹掉
        return TaintFlow(self.origin, steps, self.sanitizer_rule)

    def with_sanitizer(self, rule_id: str) -> "TaintFlow":
        return TaintFlow(self.origin, self.steps, rule_id)


@dataclass(frozen=True)
class Taint:
    """一个表达式/变量当前携带的全部污点流。"""

    state: str
    flows: tuple[TaintFlow, ...]

    @staticmethod
    def from_origin(origin: Origin, first_step: str | None = None) -> "Taint":
        flow = TaintFlow(origin)
        if first_step:
            flow = flow.with_step(first_step)
        return Taint(STATE_TAINTED, (flow,))

    def with_step(self, step: str) -> "Taint":
        return Taint(self.state, tuple(f.with_step(step) for f in self.flows))

    def with_sanitizer(self, rule_id: str) -> "Taint":
        return Taint(self.state, tuple(f.with_sanitizer(rule_id) for f in self.flows))

    def downgraded(self) -> "Taint":
        """降级为可能风险（用于无法解析的跨函数传播等场景）。"""
        return Taint(STATE_POSSIBLE, self.flows)


def _dedup_flows(flows: tuple[TaintFlow, ...]) -> tuple[TaintFlow, ...]:
    seen: dict[tuple, TaintFlow] = {}
    for flow in flows:
        key = (flow.origin.key, flow.steps, flow.sanitizer_rule)
        if key not in seen:
            seen[key] = flow
    return tuple(seen.values())


def merge_taints(*taints: "Taint | None") -> "Taint | None":
    """合并多条污点；None 表示干净，不会抵消其他污点。"""
    valid = [t for t in taints if t is not None]
    if not valid:
        return None
    state = STATE_TAINTED if any(t.state == STATE_TAINTED for t in valid) else STATE_POSSIBLE
    flows = _dedup_flows(tuple(f for t in valid for f in t.flows))
    return Taint(state, flows)


@dataclass
class Finding:
    """一条命令注入风险发现。"""

    rule_id: str
    file: str
    line: int
    severity: str  # high | medium
    certainty: str  # 确定 | 可能
    source_labels: list[str]
    source_lines: list[int]
    sink_label: str
    sink_rule: str
    sink_kind: str  # shell-string | subprocess
    propagation: str
    paths: list[list[str]] = field(default_factory=list)
    rule_basis: str = ""

    @property
    def stable_id(self) -> str:
        """相同源码下保持稳定的标识。"""
        return f"{self.rule_id}:{self.file}:{self.line}"

    def to_dict(self) -> dict:
        return {
            "id": self.stable_id,
            "rule_id": self.rule_id,
            "file": self.file,
            "line": self.line,
            "severity": self.severity,
            "certainty": self.certainty,
            "source_labels": self.source_labels,
            "source_lines": self.source_lines,
            "sink_label": self.sink_label,
            "sink_rule": self.sink_rule,
            "sink_kind": self.sink_kind,
            "propagation": self.propagation,
            "paths": self.paths,
            "rule_basis": self.rule_basis,
        }


@dataclass
class SafeCall:
    """命中了命令执行函数但规则判断为安全的调用，同样展示规则依据以便复查。"""

    file: str
    line: int
    sink_label: str
    sink_rule: str
    reason: str
    rule_id: str

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "line": self.line,
            "sink_label": self.sink_label,
            "sink_rule": self.sink_rule,
            "reason": self.reason,
            "rule_id": self.rule_id,
        }


@dataclass
class FileError:
    """单个文件无法分析时的失败位置与原因，不影响其他文件。"""

    file: str
    line: int  # 0 表示没有具体行号
    kind: str  # syntax | encoding | analysis
    message: str

    def to_dict(self) -> dict:
        return {"file": self.file, "line": self.line, "kind": self.kind, "message": self.message}


@dataclass
class FileResult:
    file: str
    findings: list[Finding] = field(default_factory=list)
    safe_calls: list[SafeCall] = field(default_factory=list)
    errors: list[FileError] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "findings": [f.to_dict() for f in self.findings],
            "safe_calls": [s.to_dict() for s in self.safe_calls],
            "errors": [e.to_dict() for e in self.errors],
        }
