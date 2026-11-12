"""输出格式与编码参数的白名单定义，以及 FFmpeg 命令构建。

前端通过 /api/options 获取这里的同一份配置，保证页面展示的参数与
实际传给 FFmpeg 的参数完全一致。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# 容器格式 -> 扩展名 / muxer / 允许的音视频编码
FORMATS: dict[str, dict[str, Any]] = {
    "mp4": {
        "label": "MP4 (H.264/AAC 通用容器)",
        "ext": ".mp4",
        "video_codecs": ["h264", "hevc", "copy"],
        "audio_codecs": ["aac", "copy"],
    },
    "mkv": {
        "label": "MKV (Matroska)",
        "ext": ".mkv",
        "video_codecs": ["h264", "hevc", "vp9", "copy"],
        "audio_codecs": ["aac", "opus", "mp3", "copy"],
    },
    "webm": {
        "label": "WebM",
        "ext": ".webm",
        "video_codecs": ["vp9", "vp8", "copy"],
        "audio_codecs": ["opus", "vorbis", "copy"],
    },
    "mov": {
        "label": "MOV",
        "ext": ".mov",
        "video_codecs": ["h264", "hevc", "prores", "copy"],
        "audio_codecs": ["aac", "pcm_s16le", "copy"],
    },
    "avi": {
        "label": "AVI",
        "ext": ".avi",
        "video_codecs": ["mpeg4", "copy"],
        "audio_codecs": ["mp3", "copy"],
    },
    "mp3": {
        "label": "MP3 (仅音频)",
        "ext": ".mp3",
        "video_codecs": ["none"],
        "audio_codecs": ["mp3"],
    },
}

# 编码预设（x264/x265 通用语义）
VIDEO_PRESETS = [
    {"value": "ultrafast", "label": "ultrafast（最快，文件最大）"},
    {"value": "superfast", "label": "superfast"},
    {"value": "veryfast", "label": "veryfast"},
    {"value": "faster", "label": "faster"},
    {"value": "fast", "label": "fast"},
    {"value": "medium", "label": "medium（默认，平衡）"},
    {"value": "slow", "label": "slow"},
    {"value": "slower", "label": "slower"},
    {"value": "veryslow", "label": "veryslow（最慢，压缩最好）"},
]

# 编码器 -> 使用的 FFmpeg 编码器名称
ENCODER_NAMES = {
    "h264": "libx264",
    "hevc": "libx265",
    "vp9": "libvpx-vp9",
    "vp8": "libvpx",
    "mpeg4": "mpeg4",
    "prores": "prores_ks",
    "aac": "aac",
    "opus": "libopus",
    "mp3": "libmp3lame",
    "vorbis": "libvorbis",
    "pcm_s16le": "pcm_s16le",
}

# 支持 CRF 模式的编码器
CRF_ENCODERS = {"h264", "hevc", "vp9", "vp8"}
# 支持 -preset 的编码器
PRESET_ENCODERS = {"h264", "hevc"}
# 合理范围，防止页面/请求传入极端值
CRF_RANGE = (0, 63)
BITRATE_RE = __import__("re").compile(r"^\d{1,5}[kKmM]$")


@dataclass(frozen=True)
class TrimParams:
    """一次裁切/转码任务的全部参数（已校验）。"""

    start_ms: int
    end_ms: int
    format: str
    video_codec: str
    audio_codec: str
    crf: int | None
    preset: str | None
    video_bitrate: str | None
    audio_bitrate: str | None

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


def validate_params(
    *,
    start_ms: int,
    end_ms: int,
    fmt: str,
    video_codec: str,
    audio_codec: str,
    crf: int | None,
    preset: str | None,
    video_bitrate: str | None,
    audio_bitrate: str | None,
    source_duration_ms: int,
) -> TrimParams:
    """对请求参数做白名单与范围校验，非法值直接抛 ValueError。"""
    if not isinstance(start_ms, int) or not isinstance(end_ms, int):
        raise ValueError("起止时间必须是整数毫秒")
    if start_ms < 0:
        raise ValueError("起始时间不能为负")
    if end_ms <= start_ms:
        raise ValueError("结束时间必须晚于起始时间")
    if source_duration_ms and end_ms > source_duration_ms:
        raise ValueError("结束时间超出视频时长")

    if fmt not in FORMATS:
        raise ValueError(f"不支持的输出格式: {fmt}")
    spec = FORMATS[fmt]
    if video_codec not in spec["video_codecs"]:
        raise ValueError(f"格式 {fmt} 不支持视频编码 {video_codec}")
    if audio_codec not in spec["audio_codecs"]:
        raise ValueError(f"格式 {fmt} 不支持音频编码 {audio_codec}")

    if video_bitrate is not None and not BITRATE_RE.fullmatch(video_bitrate):
        raise ValueError("视频码率格式非法，示例：2000k / 2M")
    if audio_bitrate is not None and not BITRATE_RE.fullmatch(audio_bitrate):
        raise ValueError("音频码率格式非法，示例：128k")

    if video_codec in CRF_ENCODERS:
        if crf is None:
            raise ValueError("该编码器需要 CRF 值")
        if not (CRF_RANGE[0] <= crf <= CRF_RANGE[1]):
            raise ValueError(f"CRF 必须在 {CRF_RANGE[0]}-{CRF_RANGE[1]} 之间")
    if video_codec in PRESET_ENCODERS:
        valid_presets = {p["value"] for p in VIDEO_PRESETS}
        if preset not in valid_presets:
            raise ValueError("preset 非法")
    elif preset is not None:
        raise ValueError("当前编码器不支持 preset")

    # 纯音频输出不能同时“去掉视频”之外的组合
    if video_codec == "none" and fmt != "mp3":
        raise ValueError("仅 MP3 支持无视频输出")

    return TrimParams(
        start_ms=start_ms,
        end_ms=end_ms,
        format=fmt,
        video_codec=video_codec,
        audio_codec=audio_codec,
        crf=crf,
        preset=preset,
        video_bitrate=video_bitrate,
        audio_bitrate=audio_bitrate,
    )


def ms_to_ffmpeg_time(value_ms: int) -> str:
    """毫秒 -> FFmpeg 的 HH:MM:SS.mmm 时间字符串，精确到毫秒。"""
    if value_ms < 0:
        raise ValueError("negative time")
    ms = value_ms % 1000
    total_seconds = value_ms // 1000
    seconds = total_seconds % 60
    minutes = (total_seconds // 60) % 60
    hours = total_seconds // 3600
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{ms:03d}"


def build_ffmpeg_command(
    *,
    ffmpeg_bin: str,
    source: str,
    params: TrimParams,
    output_file: str,
) -> list[str]:
    """构建 FFmpeg 参数数组（不经过 shell，杜绝命令注入）。

    采用 -ss 放在 -i 前的快速定位方式，配合重新编码可精确到毫秒；
    -to 在输出端表示“相对起始点的持续时长”，因此用 -t 传时长。
    """
    cmd: list[str] = [
        ffmpeg_bin,
        "-hide_banner",
        "-nostdin",
        "-y",
        "-ss", ms_to_ffmpeg_time(params.start_ms),
        "-i", source,
        "-t", ms_to_ffmpeg_time(params.duration_ms),
    ]

    vcodec, acodec = params.video_codec, params.audio_codec

    if vcodec == "none":
        # 纯音频
        cmd += ["-vn"]
    elif vcodec == "copy":
        cmd += ["-c:v", "copy"]
    else:
        cmd += ["-c:v", ENCODER_NAMES[vcodec]]
        if vcodec in PRESET_ENCODERS and params.preset:
            cmd += ["-preset", params.preset]
        if vcodec in CRF_ENCODERS and params.crf is not None:
            cmd += ["-crf", str(params.crf)]
        if params.video_bitrate:
            cmd += ["-b:v", params.video_bitrate]
        if vcodec in {"h264", "hevc", "mpeg4"}:
            # 兼容 QuickTime / 浏览器播放
            cmd += ["-pix_fmt", "yuv420p"]

    if acodec == "copy":
        cmd += ["-c:a", "copy"]
    else:
        cmd += ["-c:a", ENCODER_NAMES[acodec]]
        if params.audio_bitrate:
            cmd += ["-b:a", params.audio_bitrate]

    if params.format == "mp4":
        # faststart 便于浏览器边下边播
        cmd += ["-movflags", "+faststart"]

    # 机器可读进度写到 stdout（key=value），日志仍在 stderr
    cmd += ["-progress", "pipe:1", "-nostats", output_file]
    return cmd


def options_payload() -> dict[str, Any]:
    """返回给前端的格式/编码配置。"""
    return {
        "formats": FORMATS,
        "presets": VIDEO_PRESETS,
        "crf_range": list(CRF_RANGE),
    }
