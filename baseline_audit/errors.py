"""错误类型与错误分类常量。

页面与报告中把问题分成三类分别呈现：
- READ_ERROR  被核查文件/目录读取失败（权限、IO 等）
- PARSE_ERROR 配置解析失败（编码、语法、过大、二进制等）
- TOOL_ERROR  核查工具自身或其状态数据出错（基线损坏等）
"""

READ_ERROR = "read_error"
PARSE_ERROR = "parse_error"
TOOL_ERROR = "tool_error"


class AuditError(Exception):
    """核查工具相关错误的基类。"""


class RootNotAccessible(AuditError):
    """用户选定的根目录不存在或不是目录。"""


class StoreCorruptError(AuditError):
    """工具状态文件（基线/例外/历史）损坏或无法解析。"""

    def __init__(self, kind: str, path: str, message: str = ""):
        self.kind = kind
        self.path = path
        super().__init__(f"{kind} 状态文件损坏: {path} {message}".rstrip())
