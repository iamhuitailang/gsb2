"""纯逻辑单元测试，不依赖 FFmpeg 与数据库：pytest backend/tests。"""
from __future__ import annotations

import pytest

from app import ffmpeg_ops, storage


# ---- 毫秒时间换算 -----------------------------------------------------------

@pytest.mark.parametrize(
    "ms,expected",
    [
        (0, "00:00:00.000"),
        (1, "00:00:00.001"),
        (999, "00:00:00.999"),
        (1000, "00:00:01.000"),
        (61_500, "00:01:01.500"),
        (3_723_456, "01:02:03.456"),
    ],
)
def test_ms_to_ffmpeg_time(ms, expected):
    assert ffmpeg_ops.ms_to_ffmpeg_time(ms) == expected


def test_negative_time_rejected():
    with pytest.raises(ValueError):
        ffmpeg_ops.ms_to_ffmpeg_time(-1)


# ---- 参数校验白名单 ---------------------------------------------------------

def _valid_kwargs(**overrides):
    base = dict(
        start_ms=1000,
        end_ms=5000,
        fmt="mp4",
        video_codec="h264",
        audio_codec="aac",
        crf=23,
        preset="medium",
        video_bitrate=None,
        audio_bitrate=None,
        source_duration_ms=10_000,
    )
    base.update(overrides)
    return base


def test_validate_params_ok():
    p = ffmpeg_ops.validate_params(**_valid_kwargs())
    assert p.duration_ms == 4000


def test_end_must_be_after_start():
    with pytest.raises(ValueError, match="结束时间"):
        ffmpeg_ops.validate_params(**_valid_kwargs(end_ms=1000))


def test_start_negative_rejected():
    with pytest.raises(ValueError, match="起始时间"):
        ffmpeg_ops.validate_params(**_valid_kwargs(start_ms=-1))


def test_end_beyond_duration_rejected():
    with pytest.raises(ValueError, match="超出视频时长"):
        ffmpeg_ops.validate_params(**_valid_kwargs(end_ms=99_999))


def test_unknown_format_rejected():
    with pytest.raises(ValueError, match="输出格式"):
        ffmpeg_ops.validate_params(**_valid_kwargs(fmt="exe"))


def test_codec_not_allowed_in_container():
    # webm 不支持 aac
    with pytest.raises(ValueError, match="音频编码"):
        ffmpeg_ops.validate_params(
            **_valid_kwargs(fmt="webm", video_codec="vp9", audio_codec="aac", crf=30)
        )


def test_copy_codec_skips_crf():
    p = ffmpeg_ops.validate_params(
        **_valid_kwargs(video_codec="copy", audio_codec="copy", crf=None, preset=None)
    )
    assert p.video_codec == "copy"


def test_crf_required_for_h264():
    with pytest.raises(ValueError, match="CRF"):
        ffmpeg_ops.validate_params(**_valid_kwargs(crf=None))


def test_crf_range_enforced():
    with pytest.raises(ValueError, match="CRF"):
        ffmpeg_ops.validate_params(**_valid_kwargs(crf=999))


def test_preset_whitelist():
    with pytest.raises(ValueError, match="preset"):
        ffmpeg_ops.validate_params(**_valid_kwargs(preset="rm-rf"))


def test_bitrate_format():
    with pytest.raises(ValueError, match="码率"):
        ffmpeg_ops.validate_params(**_valid_kwargs(video_bitrate="2000; rm -rf /"))


def test_mp3_audio_only():
    p = ffmpeg_ops.validate_params(
        **_valid_kwargs(
            fmt="mp3",
            video_codec="none",
            audio_codec="mp3",
            crf=None,
            preset=None,
        )
    )
    assert p.format == "mp3"


def test_none_video_only_for_mp3():
    with pytest.raises(ValueError, match="不支持视频编码"):
        ffmpeg_ops.validate_params(
            **_valid_kwargs(fmt="mp4", video_codec="none", crf=None, preset=None)
        )


# ---- FFmpeg 命令构建 --------------------------------------------------------

def _params(**overrides):
    return ffmpeg_ops.validate_params(**_valid_kwargs(**overrides))


def test_command_uses_array_and_progress():
    cmd = ffmpeg_ops.build_ffmpeg_command(
        ffmpeg_bin="ffmpeg",
        source="/data/uploads/abc.mp4",
        params=_params(),
        output_file="/data/temp/x/out.mp4",
    )
    assert cmd[0] == "ffmpeg"
    # 精确到毫秒的时间参数
    assert "-ss" in cmd and cmd[cmd.index("-ss") + 1] == "00:00:01.000"
    assert "-t" in cmd and cmd[cmd.index("-t") + 1] == "00:00:04.000"
    assert "-c:v" in cmd and "libx264" in cmd
    assert "-crf" in cmd and "23" in cmd
    assert "-progress" in cmd and "pipe:1" in cmd
    # 不经 shell：全部为独立参数，没有注入拼接
    assert all(isinstance(part, str) for part in cmd)


def test_command_copy_mode():
    cmd = ffmpeg_ops.build_ffmpeg_command(
        ffmpeg_bin="ffmpeg",
        source="s.mp4",
        params=_params(video_codec="copy", audio_codec="copy", crf=None, preset=None),
        output_file="o.mp4",
    )
    assert "-c:v" in cmd and cmd[cmd.index("-c:v") + 1] == "copy"
    assert "-crf" not in cmd


def test_command_mp3_has_vn():
    cmd = ffmpeg_ops.build_ffmpeg_command(
        ffmpeg_bin="ffmpeg",
        source="s.mp4",
        params=_params(
            fmt="mp3", video_codec="none", audio_codec="mp3", crf=None, preset=None
        ),
        output_file="o.mp3",
    )
    assert "-vn" in cmd
    assert "libmp3lame" in cmd


# ---- 文件名安全 -------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,expected",
    [
        ("movie.mp4", "movie.mp4"),
        ("../../etc/passwd", "passwd"),
        (".hidden.mov", "hidden.mov"),
        ("我的视频  (1).mkv", "1.mkv"),  # 非 ASCII 与空格被替换为下划线后去除
        ("a/b\\c.avi", "bc.avi"),       # POSIX 下反斜杠不是分隔符，按危险字符剔除
        ("", "file"),
        ("..", "file"),
    ],
)
def test_sanitize_filename(raw, expected):
    assert storage.sanitize_filename(raw) == expected


def test_temp_dir_rejects_bad_id():
    with pytest.raises(ValueError):
        storage.temp_dir("../etc")
    with pytest.raises(ValueError):
        storage.temp_dir("not-a-uuid")


def test_temp_dir_hex_id_ok():
    p = storage.temp_dir("a" * 32)
    assert p.name == "a" * 32


def test_remove_refuses_outside_data(tmp_path):
    with pytest.raises(ValueError):
        storage.remove_path(tmp_path / "outside.txt")
