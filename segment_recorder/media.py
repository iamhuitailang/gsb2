from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path


class MediaUnavailable(RuntimeError):
    pass


def ffmpeg_path() -> str | None:
    return shutil.which("ffmpeg")


def ffprobe_path() -> str | None:
    return shutil.which("ffprobe")


def have_real_media_tools() -> bool:
    return bool(ffmpeg_path() and ffprobe_path())


def fake_clip_bytes(label: str, duration: float, target_size: int = 128 * 1024) -> bytes:
    """无 ffmpeg/自动化测试时使用的确定性伪短片。

    它不是可播放媒体，但能完整验证身份、去重、断点续收、重启和导出文件完整性。
    """
    header = (
        "SEGMENT-RECORDER-FAKE-MEDIA\n"
        f"label={label}\n"
        f"duration={duration:.3f}\n"
        "sha256-after-final-write-is-the-real-identity\n"
    ).encode("utf-8")
    block = (label + "-0123456789ABCDEF\n").encode("utf-8")
    if len(block) == 0:
        block = b"0"
    pieces = [header]
    size = len(header)
    counter = 0
    while size < target_size:
        chunk = block + f"{counter:08d}\n".encode("ascii")
        pieces.append(chunk)
        size += len(chunk)
        counter += 1
    return b"".join(pieces)[:target_size]


def _font_file() -> str | None:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return candidate
    return None


def generate_clip(
    output_path: Path | str,
    *,
    label: str,
    sequence: int = 0,
    duration: float = 1.0,
    fake: bool = False,
) -> Path:
    """生成一个真实 MPEG-TS 短片；fake=True 时写确定性测试字节。"""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if fake:
        output_path.write_bytes(fake_clip_bytes(label, duration))
        return output_path

    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        raise MediaUnavailable("未找到 ffmpeg；可使用 --fake-media 跑逻辑演示")

    safe_label = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in label)
    freq = 320 + (int(sequence) % 12) * 35
    font = _font_file()

    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"testsrc2=size=640x360:rate=25",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency={freq}:sample_rate=44100",
        "-t",
        f"{duration:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-g",
        str(max(1, int(25 * duration))),
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-f",
        "mpegts",
    ]

    if font:
        drawtext = (
            f"drawtext=fontfile='{font}':text='{safe_label}':"
            "fontcolor=white:fontsize=34:box=1:boxcolor=black@0.68:"
            "x=24:y=24"
        )
        command.extend(["-vf", drawtext])

    command.append(str(output_path))
    result = subprocess.run(command, capture_output=True, text=True, timeout=90)
    if result.returncode != 0 and font:
        # 某些 ffmpeg 构建的 drawtext/fontconfig 不可用；去掉文字后重试。
        command = [part for part in command if part != "-vf"]
        # 上一种调用中 "-vf" 与其后滤镜是两个参数；列表推导只删掉了 "-vf"。
        # 重新构造更稳妥。
        command = [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=25",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={freq}:sample_rate=44100",
            "-t",
            f"{duration:.3f}",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            "-f",
            "mpegts",
            str(output_path),
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=90)

    if result.returncode != 0:
        tail = (result.stderr or "").strip()[-1200:]
        raise RuntimeError(f"ffmpeg 生成短片失败：{tail}")
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError(f"ffmpeg 未生成有效短片：{output_path}")
    return output_path


def probe_duration(path: Path | str) -> float | None:
    ffprobe = ffprobe_path()
    if not ffprobe:
        return None
    path = Path(path)
    try:
        result = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout or "{}")
        duration = float(data.get("format", {}).get("duration"))
        return duration if duration > 0 else None
    except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError):
        return None


def concat_to_mp4(
    segment_paths: list[Path],
    output_mp4: Path,
    *,
    expected_duration: float | None = None,
) -> tuple[bool, str]:
    """把同参数 TS 区间 remux 成 MP4；时间戳异常或失败时重编码一次。"""
    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        return False, "未找到 ffmpeg"
    if not segment_paths:
        return False, "区间为空"

    output_mp4 = Path(output_mp4)
    output_mp4.parent.mkdir(parents=True, exist_ok=True)
    list_path = output_mp4.parent / "concat.txt"

    lines = []
    for segment in segment_paths:
        # concat 列表中的单引号需要 shell 风格转义。
        escaped = segment.name.replace("'", "'\\''")
        lines.append(f"file 'segments/{escaped}'")
    list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    base_command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
    ]
    copy_command = base_command + [
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(output_mp4),
    ]
    result = subprocess.run(copy_command, capture_output=True, text=True, timeout=120)
    copy_ok = result.returncode == 0 and output_mp4.exists() and output_mp4.stat().st_size > 0
    if copy_ok and expected_duration is not None and expected_duration > 0:
        copied_duration = probe_duration(output_mp4)
        # TS 分段的 PCR/PTS 归零偶尔会让 -c copy 后的总时长异常；发现明显偏差就重编码。
        if copied_duration is None or abs(copied_duration - expected_duration) > max(
            0.45, expected_duration * 0.12
        ):
            copy_ok = False

    if copy_ok:
        return True, "stream-copy"

    if output_mp4.exists():
        output_mp4.unlink()
    reencode_command = base_command + [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        str(output_mp4),
    ]
    result = subprocess.run(
        reencode_command, capture_output=True, text=True, timeout=240
    )
    if result.returncode != 0:
        tail = (result.stderr or "").strip()[-1200:]
        return False, tail or "ffmpeg concat/reencode failed"
    return True, "re-encode"


def decode_check(path: Path | str) -> tuple[bool, str]:
    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        return False, "未找到 ffmpeg"
    try:
        result = subprocess.run(
            [
                ffmpeg,
                "-v",
                "error",
                "-i",
                str(path),
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if result.returncode == 0:
            return True, "decode ok"
        return False, (result.stderr or "").strip()[-1000:]
    except subprocess.SubprocessError as exc:
        return False, str(exc)
