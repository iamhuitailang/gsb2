"""ffmpeg / ffprobe 调用封装:重封装、解码校验、信息读取。

所有外部命令都走 shutil 查到的绝对路径,输入文件路径作为参数传入,
不在素材目录里起解释器。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass


class FfmpegError(RuntimeError):
    pass


def _resolve(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise FfmpegError(f"本机找不到 {name},请先安装 ffmpeg(含 ffprobe)")
    return path


@dataclass
class DecodeReport:
    ok: bool
    returncode: int
    stderr_tail: str
    video_frames: int
    audio_samples: int | None       # 校验时按 null 输出统计不到样本数时为 None
    errors: list[str]


def _run(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise FfmpegError(f"命令超时: {' '.join(cmd[:3])} ...") from exc


def _run_binary(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    """stdout 为二进制流(如解码出的 PCM)时使用。"""
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise FfmpegError(f"命令超时: {' '.join(cmd[:3])} ...") from exc


def remux_to_mp4(src_path: str, dst_path: str) -> None:
    """把抢救出的 fMP4 字节流重封装为普通播放器可开的 MP4(不重编码)。"""
    ffmpeg = _resolve("ffmpeg")
    proc = _run([
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-y", "-f", "mp4", "-i", src_path,
        "-c", "copy", "-movflags", "+faststart",
        dst_path,
    ])
    if proc.returncode != 0:
        raise FfmpegError(f"重封装失败:\n{proc.stderr.strip()}")


def verify_decodable(path: str, is_fmp4: bool = True) -> DecodeReport:
    """全量解码到 null,统计视频帧数,并收集 ffmpeg 报错。"""
    ffmpeg = _resolve("ffmpeg")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "info", "-y"]
    if is_fmp4:
        cmd += ["-f", "mp4"]
    cmd += ["-i", path, "-map", "0:v:0", "-f", "null", "-"]
    # 音频单独再跑一次,便于统计实际解出的音频样本
    proc = _run(cmd)
    video_frames, audio_samples, errors = _parse_stderr(proc.stderr)
    ok = proc.returncode == 0 and not errors
    return DecodeReport(
        ok=ok,
        returncode=proc.returncode,
        stderr_tail="\n".join(proc.stderr.splitlines()[-15:]),
        video_frames=video_frames,
        audio_samples=audio_samples,
        errors=errors,
    )


def count_audio_samples(path: str, is_fmp4: bool = True) -> tuple[int, int]:
    """返回 (实际解码音频样本数, 采样率)。"""
    ffmpeg = _resolve("ffmpeg")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "info", "-y"]
    if is_fmp4:
        cmd += ["-f", "mp4"]
    cmd += ["-i", path, "-map", "0:a:0", "-f", "s16le", "-"]
    proc = _run_binary(cmd)
    stderr = proc.stderr.decode("utf-8", "replace")
    if proc.returncode != 0:
        raise FfmpegError(f"音频解码失败:\n{stderr.strip()}")
    rate = _parse_audio_rate(stderr)
    return len(proc.stdout) // 2, rate  # s16le 单声道,每样本 2 字节


def probe_streams(path: str, is_fmp4: bool = False) -> list[dict]:
    ffprobe = _resolve("ffprobe")
    cmd = [ffprobe, "-hide_banner", "-v", "error", "-show_streams", "-of", "json"]
    if is_fmp4:
        cmd += ["-f", "mp4"]
    cmd.append(path)
    proc = _run(cmd)
    if proc.returncode != 0:
        raise FfmpegError(f"ffprobe 失败:\n{proc.stderr.strip()}")
    return json.loads(proc.stdout).get("streams", [])


def _parse_stderr(stderr: str) -> tuple[int, int | None, list[str]]:
    video_frames = 0
    errors: list[str] = []
    # ffmpeg 进度行用 \r 刷新,splitlines() 会保留它们,先统一成 \n
    for line in stderr.replace("\r", "\n").splitlines():
        stripped = line.strip()
        if stripped.startswith("frame=") and "fps=" in stripped:
            match = re.search(r"frame=\s*(\d+)", stripped)
            if match:
                video_frames = int(match.group(1))
        low = stripped.lower()
        if any(kw in low for kw in ("error", "invalid", "corrupt", "trunc", "missing")):
            if "error concealment" in low:
                continue
            errors.append(stripped)
    return video_frames, None, errors


def _parse_audio_rate(stderr: str) -> int:
    for line in stderr.splitlines():
        if "Audio:" not in line:
            continue
        tokens = line.replace(",", " ").split()
        for i, token in enumerate(tokens):
            if token == "Hz" and i > 0:
                try:
                    return int(tokens[i - 1])
                except ValueError:
                    break
    return 0
