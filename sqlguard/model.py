"""数据模型：污点、传播步骤、扫描发现。"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass


@dataclass(frozen=True)
class Step:
    """传播路径中的一步。"""

    text: str
    file: str
    line: int

    def to_dict(self):
        return {"text": self.text, "file": self.file, "line": self.line}


class Taint:
    """一个值的污点状态。

    steps:      来自外部输入的传播步骤（非空即视为被污染）
    param_deps: 对所在函数参数的符号依赖，用于跨函数返回值的汇总分析
    certain:    证据是否充分（经过无法分析的调用或分支合并时为 False）
    """

    __slots__ = ("steps", "param_deps", "certain")

    def __init__(self, steps=(), param_deps=frozenset(), certain=True):
        self.steps = tuple(steps)
        self.param_deps = frozenset(param_deps)
        self.certain = certain

    @property
    def tainted(self):
        return bool(self.steps)

    def merge(self, other):
        if other is None:
            return self
        steps = list(self.steps)
        for s in other.steps:
            if s not in steps:
                steps.append(s)
        return Taint(steps, self.param_deps | other.param_deps,
                     self.certain and other.certain)

    def uncertain(self):
        return Taint(self.steps, self.param_deps, False)

    def add_step(self, text, file, line):
        step = Step(text, file, line)
        if self.steps and self.steps[-1] == step:
            return self
        return Taint(self.steps + (step,), self.param_deps, self.certain)


EMPTY = Taint()


@dataclass
class ScopeVal:
    """作用域中一个名字的状态：污点 + 定义它的表达式（用于结构分析）。"""

    taint: Taint
    expr: object = None  # ast.AST | None


@dataclass
class Finding:
    rule: str
    severity: str
    confidence: str
    file: str
    line: int
    snippet: str
    message: str
    path: list  # list[Step]

    @property
    def id(self):
        """稳定的发现编号：同一处问题多次扫描编号不变。"""
        digest = hashlib.sha1(
            f"{self.rule}|{self.file}|{self.line}|{self.snippet}".encode("utf-8")
        ).hexdigest()[:10]
        return f"{self.rule}-{digest}"

    def sort_key(self):
        return (self.file, self.line, self.rule)

    def to_dict(self):
        return {
            "id": self.id,
            "rule": self.rule,
            "severity": self.severity,
            "confidence": self.confidence,
            "file": self.file,
            "line": self.line,
            "snippet": self.snippet,
            "message": self.message,
            "path": [s.to_dict() for s in self.path],
        }


@dataclass
class ScanResult:
    files_scanned: int
    findings: list  # list[Finding]
    errors: list    # list[dict] 无法解析/读取的文件
