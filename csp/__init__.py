"""本地网页资源安全策略（CSP）分析台核心引擎。

纯标准库实现，不发起任何网络请求。
- parser:  策略文本解析与语法校验（带位置信息）
- matcher: 来源表达式与 URL 匹配
- engine:  单请求在一份或多份策略下的判定
- storage: 策略与历史记录的本地 JSON 持久化
- samples: 内置可重复运行的本地样例
"""

from .parser import (
    ParseIssue,
    ParsedPolicy,
    Directive,
    SourceExpression,
    parse_policy,
)
from .engine import evaluate_all, evaluate_one, ResourceRequest
from .matcher import match_source

__all__ = [
    "ParseIssue",
    "ParsedPolicy",
    "Directive",
    "SourceExpression",
    "parse_policy",
    "evaluate_all",
    "evaluate_one",
    "ResourceRequest",
    "match_source",
]
