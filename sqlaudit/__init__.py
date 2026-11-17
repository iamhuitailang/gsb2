"""sqlaudit —— 本地 Python 项目 SQL 注入静态审查工具。

只读取源码做 AST 污点分析：
- 不执行被扫描项目中的任何代码
- 不依赖真实数据库、外部账号或网络服务
- 除 Python 标准库外无第三方依赖
"""

from .model import Severity
from .scanner import ScanResult, scan_project

__all__ = ["scan_project", "ScanResult", "Severity"]
__version__ = "0.1.0"
