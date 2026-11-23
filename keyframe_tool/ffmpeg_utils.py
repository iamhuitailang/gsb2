"""ffmpeg / ffprobe 子进程封装。"""

from __future__ import annotations

import json
import shutil
import subprocess


class FFmpegError(RuntimeError):
    """ffmpeg / ffprobe 执行失败，或源文件读不全。"""


def ensure_tools() -> None:
    """确认 ffmpeg / ffprobe 在 PATH 中，缺了直接给出明确提示。"""
    missing = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    if missing:
        raise FFmpegError(f"找不到可执行文件: {', '.join(missing)}，请先安装 ffmpeg 并加入 PATH")


def ffprobe_json(path: str, *args: str) -> dict:
    """跑 ffprobe -of json 并解析结果。

    文件不存在、容器损坏、读不全时 ffprobe 会以非零码退出，
    统一转成 FFmpegError，由上层转成页面反馈。
    """
    cmd = ["ffprobe", "-v", "error", *args, "-of", "json", path]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FFmpegError(
            f"ffprobe 读取失败（源文件可能读不全）: {path}\n{proc.stderr.strip()[:800]}"
        )
    try:
        return json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise FFmpegError(f"ffprobe 输出无法解析: {exc}") from exc


def run_ffmpeg(args: list[str], timeout: int = 600) -> tuple[bool, str]:
    """执行 ffmpeg，返回 (是否成功, 日志尾部)。不抛异常，由调用方决定如何反馈。"""
    cmd = ["ffmpeg", "-hide_banner", "-y", *args]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, "ffmpeg 执行超时"
    log = (proc.stderr or "")[-2000:]
    return proc.returncode == 0, log


def ffmpeg_capture(args: list[str], timeout: int = 600) -> tuple[int, bytes, str]:
    """执行 ffmpeg 并捕获 stdout（framemd5、image2pipe 等场景）。"""
    cmd = ["ffmpeg", "-hide_banner", *args]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise FFmpegError("ffmpeg 执行超时")
    if proc.returncode != 0:
        raise FFmpegError(proc.stderr.decode("utf-8", "replace")[-800:])
    return proc.returncode, proc.stdout, proc.stderr.decode("utf-8", "replace")
