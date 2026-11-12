"""通过 ffprobe 读取视频时长、分辨率、编码等元数据。"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from . import config

logger = logging.getLogger("video_tool.media")


class ProbeError(Exception):
    pass


async def probe_media(path: str) -> dict[str, Any]:
    """返回媒体信息；文件无法被识别时抛 ProbeError。"""
    cmd = [
        config.FFPROBE_BIN,
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        path,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise ProbeError("未找到 ffprobe，请确认 FFmpeg 已正确安装") from exc

    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise ProbeError(
            f"ffprobe 无法识别该文件（退出码 {proc.returncode}）: "
            f"{stderr.decode('utf-8', 'ignore')[:300]}"
        )

    try:
        data = json.loads(stdout.decode("utf-8", "ignore"))
    except json.JSONDecodeError as exc:
        raise ProbeError("ffprobe 输出解析失败") from exc

    streams = data.get("streams", [])
    fmt = data.get("format", {})
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = 0.0
    for candidate in (fmt.get("duration"), video_stream and video_stream.get("duration")):
        try:
            if candidate:
                duration = float(candidate)
                break
        except (TypeError, ValueError):
            continue

    return {
        "duration_ms": int(round(duration * 1000)),
        "width": video_stream.get("width") if video_stream else None,
        "height": video_stream.get("height") if video_stream else None,
        "video_codec": video_stream.get("codec_name") if video_stream else None,
        "audio_codec": audio_stream.get("codec_name") if audio_stream else None,
        "format_name": fmt.get("format_name"),
        "bit_rate": _to_int(fmt.get("bit_rate")),
        "streams": [
            {
                "codec_type": s.get("codec_type"),
                "codec_name": s.get("codec_name"),
                "width": s.get("width"),
                "height": s.get("height"),
            }
            for s in streams
        ],
    }


def _to_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
