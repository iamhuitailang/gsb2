"""时间换算工具。

素材里存在两套时间：
1. 容器/轨道绝对时间（pts_time）：可能带一个非零起点 start_time，
   例如整体延后 1.3s 的素材，第一帧的 pts_time 就是 1.3 而不是 0。
2. 显示时间（display）：播放器时间线上看到的时间，第一帧永远从 0 开始，
   display = pts_time - start_time。

用户在页面上看到、输入的全部是显示时间；调用 ffmpeg 时才换算回绝对时间。
全程显式换算，避免把源轨起点偏差当成用户又加了一次偏移。
"""

from __future__ import annotations

EPS = 1e-6


def to_display(pts_time: float, start_time: float) -> float:
    """容器绝对时间 -> 显示时间。"""
    return pts_time - start_time


def to_pts(display_time: float, start_time: float) -> float:
    """显示时间 -> 容器绝对时间。"""
    return display_time + start_time


def hms(value: float | None) -> str:
    """格式化为 HH:MM:SS.mmm，None 显示为 N/A。"""
    if value is None:
        return "N/A"
    sign = "-" if value < -EPS else ""
    value = abs(value)
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    seconds = value % 60
    return f"{sign}{hours:02d}:{minutes:02d}:{seconds:06.3f}"


def ms(value: float | None) -> str:
    """毫秒差展示，带正负号。"""
    if value is None:
        return "N/A"
    return f"{value * 1000:+.1f} ms"


def nearly_equal(a: float, b: float, tol: float = EPS) -> bool:
    return abs(a - b) <= tol
