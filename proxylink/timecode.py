"""时间码解析、格式化与帧吸附。

支持三种输入格式：
- 秒数：``12.5``
- 秒时间码：``00:00:12.5`` / ``1:12.5``
- 帧时间码：``00:00:12:12``（末段是帧号，按给定 fps 换算）

所有换算结果都可吸附到最近帧边界，避免剪辑点落在两帧之间导致
原片与代理指向不同画面。
"""

import re

from .errors import CalibrationError

_TC_RE = re.compile(r"^\d{1,2}(?::\d{1,2}){1,3}(?:\.\d+)?$")


def parse_timecode(text, fps=None):
    """把用户输入解析为秒（float）。

    参数:
        text: 时间字符串或数字。``HH:MM:SS:FF`` 形式需要 fps。
        fps:  帧率，帧时间码必填。
    返回:
        浮点秒数。
    """
    if text is None:
        raise CalibrationError("时间值为空")
    if isinstance(text, (int, float)):
        value = float(text)
        if value < 0:
            raise CalibrationError(f"时间不能为负: {text}")
        return value

    s = str(text).strip()
    if not s:
        raise CalibrationError("时间值为空")

    # 纯数字按秒处理
    try:
        value = float(s)
        if value < 0:
            raise CalibrationError(f"时间不能为负: {s}")
        return value
    except ValueError:
        pass

    if not _TC_RE.match(s):
        raise CalibrationError(f"无法识别的时间码: {s!r}")

    head, dot, frac = s.partition(".")
    parts = head.split(":")
    if len(parts) < 2 or len(parts) > 4:
        raise CalibrationError(f"无法识别的时间码: {s!r}")

    if len(parts) == 4:
        # HH:MM:SS:FF 帧时间码
        if not fps or fps <= 0:
            raise CalibrationError(f"解析帧时间码 {s!r} 需要 fps")
        hh, mm, ss, ff = (int(p) for p in parts)
        if ff >= round(fps):
            raise CalibrationError(
                f"帧号 {ff} 超出一帧周期（fps={fps:g}，合法帧号 0..{round(fps) - 1}）"
            )
        seconds = hh * 3600 + mm * 60 + ss + ff / fps
    else:
        # MM:SS[.frac] 或 HH:MM:SS[.frac]
        nums = [float(p) for p in parts]
        if len(nums) == 2:
            mm, ss = nums
            seconds = mm * 60 + ss
        else:
            hh, mm, ss = nums
            seconds = hh * 3600 + mm * 60 + ss
        if dot:
            seconds += float("0." + frac)

    if seconds < 0:
        raise CalibrationError(f"时间不能为负: {s}")
    return seconds


def snap_to_frame(seconds, fps):
    """把秒数吸附到最近的帧边界（第 n 帧起点 = n / fps）。"""
    if not fps or fps <= 0:
        return float(seconds)
    return round(seconds * fps) / fps


def frame_index(seconds, fps):
    """秒数 -> 帧序号（从 0 开始）。"""
    return round(seconds * fps)


def format_smpte(seconds, fps):
    """格式化为 ``HH:MM:SS:FF`` 帧时间码。"""
    if fps is None or fps <= 0:
        return f"{seconds:.3f}s"
    total_frames = max(0, round(seconds * fps))
    frames_per = round(fps)
    ff = total_frames % frames_per
    total_secs = total_frames // frames_per
    ss = total_secs % 60
    mm = (total_secs // 60) % 60
    hh = total_secs // 3600
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def format_clock(seconds):
    """格式化为 ``HH:MM:SS.mmm``。"""
    if seconds < 0:
        seconds = 0.0
    hh = int(seconds // 3600)
    mm = int((seconds % 3600) // 60)
    ss = seconds % 60
    return f"{hh:02d}:{mm:02d}:{ss:06.3f}"


def format_time(seconds, fps=None):
    """带 fps 时同时给出帧时间码，否则给时钟格式。"""
    if fps and fps > 0:
        return f"{format_smpte(seconds, fps)} ({seconds:.3f}s)"
    return f"{format_clock(seconds)} ({seconds:.3f}s)"
