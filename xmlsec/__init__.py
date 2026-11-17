"""本机 XML 安全检查台。

只使用 Python 标准库：
- 不发起任何网络请求
- 不读取样例目录之外的文件
"""

from .inspector import LIMITS, inspect_xml

__all__ = ["LIMITS", "inspect_xml"]
