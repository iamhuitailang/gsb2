"""工具内部统一的异常类型。"""


class ToolError(Exception):
    """所有可预期失败的基类；CLI 捕获后打印消息并返回非零退出码。"""


class ManifestError(ToolError):
    """清单缺项、格式错误、路径冲突等。"""


class ArchiveError(ToolError):
    """归档不安全或无法安全处理。"""


class VerifyError(ToolError):
    """签名、信任、摘要、内容核对失败。"""


class StoreError(ToolError):
    """安装状态层面的失败（版本回退、无试装内容等）。"""


class LockedError(StoreError):
    """另一个更新操作正在进行。"""
