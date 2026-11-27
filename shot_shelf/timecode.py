"""Timecode helpers.

All timeline values are integer milliseconds so that project files never
accumulate floating point drift.  Display code additionally exposes frame
numbers derived from the source frame rate.
"""

from __future__ import annotations


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def ms_to_timecode(ms: int, with_millis: bool = True) -> str:
    """Format milliseconds as HH:MM:SS.mmm (or HH:MM:SS)."""
    ms = int(round(ms))
    negative = ms < 0
    ms = abs(ms)
    hours, rem = divmod(ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, millis = divmod(rem, 1000)
    if with_millis:
        body = f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"
    else:
        body = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return ("-" if negative else "") + body


def timecode_to_ms(text: str) -> int:
    """Parse ``HH:MM:SS.mmm``, ``MM:SS.mmm``, ``SS.mmm`` or raw seconds.

    Raises ValueError for malformed input.  A trailing frame component
    (``HH:MM:SS:FF``) is accepted when the last component is an integer and
    ``fps`` is supplied by the caller through :func:`parse_timecode`.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("时间码为空")
    negative = text.startswith("-")
    if negative:
        text = text[1:]
    text = text.replace("：", ":")
    parts = text.split(":")
    if len(parts) > 4:
        raise ValueError("时间码格式不正确")
    try:
        numbers = [float(p.replace(",", ".")) for p in parts]
    except ValueError as exc:
        raise ValueError("时间码格式不正确") from exc
    if any(n < 0 for n in numbers):
        raise ValueError("时间码不能为负数")
    total = 0.0
    for number in numbers:
        total = total * 60 + number
    ms = int(round(total * 1000))
    return -ms if negative else ms


def parse_timecode(text: str, fps: float | None = None) -> int:
    """Parse a user supplied timecode, supporting HH:MM:SS:FF."""
    text = (text or "").strip()
    if text.count(":") == 3 and ":" in text:
        head, frame_text = text.rsplit(":", 1)
        if frame_text and "." not in frame_text and "," not in frame_text:
            if fps is None or fps <= 0:
                raise ValueError("解析帧号需要先知道视频帧率")
            base = parse_timecode(head)
            frame = int(frame_text)
            if frame < 0:
                raise ValueError("帧号不能为负数")
            return base + int(round(frame * 1000 / fps))
    return timecode_to_ms(text)


def ms_to_frame(ms: int, fps: float) -> int:
    if not fps or fps <= 0:
        return 0
    return int(round(ms * fps / 1000.0))


def frame_to_ms(frame: int, fps: float) -> int:
    if not fps or fps <= 0:
        return int(frame)
    return int(round(frame * 1000.0 / fps))


def frame_duration_ms(fps: float) -> int:
    if not fps or fps <= 0:
        return 40
    return max(1, int(round(1000.0 / fps)))


def snap_to_frame(ms: int, fps: float) -> int:
    return frame_to_ms(ms_to_frame(ms, fps), fps)


def format_tc_frames(ms: int, fps: float) -> str:
    """``HH:MM:SS:FF`` style, useful in exports and evidence panels."""
    ms = max(0, int(ms))
    frame = ms_to_frame(ms, fps)
    base_ms = frame_to_ms(frame, fps)
    base = ms_to_timecode(base_ms, with_millis=False)
    per_second = max(1, int(round(fps)))
    return f"{base}:{frame % per_second:02d}"


def format_duration(ms: int) -> str:
    seconds = max(0, ms) / 1000.0
    if seconds < 10:
        return f"{seconds:.2f}s"
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, sec = divmod(int(round(seconds)), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {sec:02d}s"
    return f"{minutes}m {sec:02d}s"
