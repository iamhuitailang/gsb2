"""工具内部使用的异常类型。

CLI 层捕获这些异常并转换为对应的退出码, 其余意外异常统一按
扫描失败处理, 避免输出未受控的堆栈或敏感内容。
"""


class SecretScanError(Exception):
    """所有受控错误的基类。"""


class ConfigError(SecretScanError):
    """配置文件缺失字段、取值非法或无法解析。"""


class BaselineError(SecretScanError):
    """基线文件结构损坏、格式不符或无法解析。"""


class ScanRootError(SecretScanError):
    """扫描根目录不存在或不是目录。"""
