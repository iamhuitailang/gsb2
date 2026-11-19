"""Offline, static taint analysis for Python source code."""

from .analyzer import Scanner, ScanResult
from .baseline import Baseline, BaselineError, Comparison, compare
from .models import Finding, Severity, Warning
from .rules import RULES, rule_by_id

__version__ = "0.1.0"
BASELINE_VERSION = 1

__all__ = [
    "Scanner",
    "ScanResult",
    "Baseline",
    "BaselineError",
    "Comparison",
    "compare",
    "Finding",
    "Severity",
    "Warning",
    "RULES",
    "rule_by_id",
    "__version__",
    "BASELINE_VERSION",
]
