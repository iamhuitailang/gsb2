"""静态分析过程中使用的核心数据模型。

设计要点：
- TaintLabel（污点标签）不只是一个"是否可控"的布尔值，它携带：
  * 源头（Origin：哪个文件哪一行的什么用户输入）
  * 逐跳传播路径（Hop：经过哪个函数的哪一行）
  这样最终每条发现都能还原完整的传递链。
- Finding 是可去重、可稳定排序的，保证同一份代码多次扫描结果一致。
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Optional


class Severity(enum.IntEnum):
    """风险等级。数值越大越严重，--min-level 直接按数值比较。"""

    LOW = 1
    MEDIUM = 2
    HIGH = 3

    @property
    def label(self) -> str:
        return {1: "LOW", 2: "MEDIUM", 3: "HIGH"}[int(self)]

    @classmethod
    def from_name(cls, name: str) -> "Severity":
        try:
            return cls[name.upper()]
        except KeyError as exc:
            raise ValueError(
                f"未知风险等级: {name!r}，可选值为 low / medium / high"
            ) from exc


@dataclass(frozen=True)
class Origin:
    """污点源头：用户可控输入进入程序的位置。"""

    file: str
    line: int
    source_kind: str  # 例如 request.args、input()
    code: str  # 源头所在行的代码文本（去首尾空白）

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "line": self.line,
            "source_kind": self.source_kind,
            "code": self.code,
        }


@dataclass(frozen=True)
class Hop:
    """传播路径上的一跳：数据在某个函数里经过的一次处理/传递。"""

    file: str
    line: int
    function: str  # 函数的限定名，例如 pkg/dao.py::UserDAO.find
    code: str

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "line": self.line,
            "function": self.function,
            "code": self.code,
        }


@dataclass(frozen=True)
class TaintLabel:
    """一个污点标签 = 一个源头 + 一条到达当前位置的传播路径。"""

    origin: Origin
    hops: tuple[Hop, ...] = field(default_factory=tuple)
    # 形参来源标记：当标签来自某个被调函数的形参时，记录
    # (函数键, 参数名, 参数位置)。调用点用实参标签替换它，
    # 从而把跨函数的路径在调用点拼接起来。
    param_origin: Optional[tuple[str, str, int]] = None

    def extended(self, hop: Hop) -> "TaintLabel":
        """追加一跳。重复路径直接返回自身，用于递归调用场景下收敛。"""
        if hop in self.hops:
            return self
        return TaintLabel(
            origin=self.origin,
            hops=self.hops + (hop,),
            param_origin=self.param_origin,
        )

    @property
    def depth(self) -> int:
        return len(self.hops)

    def to_path(self) -> list[dict]:
        return [h.to_dict() for h in self.hops]


@dataclass
class Finding:
    """一条 SQL 注入风险发现。"""

    rule_id: str  # SQLI-001 已知执行接口 / SQLI-002 启发式接口
    severity: Severity
    file: str
    line: int
    sink_function: str  # 触发规则的调用名，例如 cursor.execute
    code: str
    origin: Origin
    hops: tuple[Hop, ...]
    reason: str
    has_params: bool  # 该执行调用是否同时提供了参数化实参

    def dedup_key(self) -> tuple:
        """去重键：同一源头到同一危险调用位置、同一规则只报一次。

        路径长短不同不构成新发现；排序时优先保留最短路径（见 dedup_findings）。
        """
        return (self.rule_id, self.file, self.line, self.origin.file,
                self.origin.line, self.origin.source_kind)

    def sort_key(self) -> tuple:
        """稳定排序：文件、行号、等级、规则、源头。"""
        return (self.file, self.line, -int(self.severity), self.rule_id,
                self.origin.file, self.origin.line)

    def to_dict(self) -> dict:
        return {
            "rule_id": self.rule_id,
            "severity": self.severity.label,
            "severity_level": int(self.severity),
            "file": self.file,
            "line": self.line,
            "sink_function": self.sink_function,
            "code": self.code,
            "has_params": self.has_params,
            "reason": self.reason,
            "origin": self.origin.to_dict(),
            "flow_path": self.to_path(),
        }

    def to_path(self) -> list[dict]:
        return [h.to_dict() for h in self.hops]


@dataclass
class AnalysisError:
    """无法分析的文件（语法错误等），必须显式报告，不允许静默跳过。"""

    file: str
    line: int  # 语法错误可定位时给出，否则为 0
    error_type: str
    message: str

    def sort_key(self) -> tuple:
        return (self.file, self.line)

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "line": self.line,
            "error_type": self.error_type,
            "message": self.message,
        }
