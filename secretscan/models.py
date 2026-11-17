"""核心数据模型: 发现 (Finding) 与过程告警 (Warning)。

设计约束:
- Finding 中绝不保存凭据原文, 只保存定位信息、规则信息和一个
  由原文哈希得到的稳定指纹, 因此序列化到终端、JSON、基线文件
  都不会泄露密钥内容。
- 路径统一保存为相对扫描根目录的 POSIX 风格相对路径, 不携带
  扫描根目录的绝对前缀。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

# 严重级别由低到高; 数值仅用于内部比较与稳定排序, 对外只输出名称。
SEVERITIES = ("low", "medium", "high", "critical")
_SEVERITY_RANK = {name: index for index, name in enumerate(SEVERITIES)}


def severity_rank(severity: str) -> int:
    return _SEVERITY_RANK[severity]


def make_fingerprint(path: str, rule_id: str, secret_text: str) -> str:
    """计算与行号无关的稳定指纹。

    指纹只依赖相对路径、规则标识和命中原文的 SHA-256 摘要,
    文件前后增加无关行 (行号变化) 不会改变指纹。
    """
    digest = hashlib.sha256(secret_text.encode("utf-8")).hexdigest()
    material = f"{path}\n{rule_id}\n{digest}\n"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class Finding:
    """单条已去重的检测结果, 不含凭据原文。"""

    path: str  # 相对扫描根的 POSIX 路径
    line: int  # 1 起始行号
    column: int  # 1 起始列号 (按字符计)
    rule_id: str
    severity: str
    reason: str
    match_length: int  # 命中片段长度, 供脱敏与基线核对, 不保存内容
    fingerprint: str

    def sort_key(self) -> tuple:
        return (
            self.path,
            self.line,
            self.column,
            -severity_rank(self.severity),
            self.rule_id,
        )


def sort_findings(findings: list[Finding]) -> list[Finding]:
    return sorted(findings, key=lambda item: item.sort_key())


@dataclass(frozen=True)
class Warning_:
    """扫描过程中的非致命问题 (不可读文件、越界链接等)。

    单个文件失败只产生一条告警, 不影响其他文件的结果。
    """

    path: str
    kind: str  # 机器可读的告警类型
    message: str  # 面向用户的说明, 同样不得包含凭据原文

    def sort_key(self) -> tuple:
        return (self.path, self.kind, self.message)


def sort_warnings(warnings: list[Warning_]) -> list[Warning_]:
    return sorted(warnings, key=lambda item: item.sort_key())
