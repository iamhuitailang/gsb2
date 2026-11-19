"""regex_risk — 静态分析 Python 正则表达式中潜在的灾难性回溯风险。

该包只做语法层面的静态分析，不会对任何输入实际执行匹配，
因此分析具有嵌套量词的危险表达式本身也不会让进程卡住。
"""

from .analyzer import analyze_pattern, Finding, RISK_LEVELS
from .checker import check_file, CheckResult

__all__ = [
    "analyze_pattern",
    "Finding",
    "RISK_LEVELS",
    "check_file",
    "CheckResult",
]

__version__ = "1.0.0"
