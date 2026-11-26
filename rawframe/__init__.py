"""rawframe — 原始视频帧布局检查工具。

只依赖标准库 + numpy；GUI 使用标准库 tkinter，PNG 编码使用标准库 zlib。
"""

__version__ = "1.0.0"

FORMATS = ("i420", "nv12", "rgba")
COLOR_RANGES = ("limited", "full")
