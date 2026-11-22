"""proxylink 统一异常类型。"""


class ProxyLinkError(Exception):
    """所有可预期业务错误的基类。"""


class MediaNotFoundError(ProxyLinkError):
    """素材记录不存在或文件已丢失。"""


class DuplicateMediaError(ProxyLinkError):
    """同一路径被重复登记。"""


class LinkError(ProxyLinkError):
    """挂接关系相关错误。"""


class CalibrationError(ProxyLinkError):
    """标定参数非法（点越界、帧率比异常等）。"""


class OutOfRangeError(ProxyLinkError):
    """换算结果超出目标素材的可用区间，播放/切换必须停止。"""


class SignatureMismatchError(ProxyLinkError):
    """重挂接候选文件与原特征不符。

    details 中保存逐项比对结果，便于向用户给出明确信号。
    """

    def __init__(self, message, details=None):
        super().__init__(message)
        self.details = details or []


class ProbeError(ProxyLinkError):
    """ffprobe 无法解析该文件。"""
