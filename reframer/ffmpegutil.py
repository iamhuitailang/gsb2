"""ffmpeg / ffprobe 进程封装与 JSON 读写。"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any


class FFmpegError(RuntimeError):
    pass


def ensure_tools() -> None:
    missing = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    if missing:
        raise FFmpegError(f"找不到可执行文件: {', '.join(missing)}")


def probe(path: str | Path) -> dict[str, Any]:
    """返回视频流参数 + 时长 / 帧率 / 是否有音频。"""
    ensure_tools()
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if out.returncode != 0:
        raise FFmpegError(f"ffprobe 失败: {out.stderr.strip()}")
    data = json.loads(out.stdout)
    vstreams = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
    astreams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
    if not vstreams:
        raise FFmpegError(f"文件没有视频流: {path}")
    vs = vstreams[0]

    num, den = vs.get("r_frame_rate", "30/1").split("/")
    fps = float(num) / float(den or 1)
    duration = float(data.get("format", {}).get("duration", 0.0))
    if "duration" in vs:
        duration = float(vs["duration"])
    return {
        "width": int(vs["width"]),
        "height": int(vs["height"]),
        "fps": fps,
        "duration": duration,
        "nb_frames": int(vs.get("nb_frames", 0) or round(duration * fps)),
        "has_audio": bool(astreams),
        "sar": vs.get("sample_aspect_ratio", "1:1"),
    }


def run_ffmpeg(cmd: list[str]) -> None:
    ensure_tools()
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-40:])
        raise FFmpegError(f"ffmpeg 执行失败:\n{' '.join(cmd[:8])} ...\n{tail}")


def load_json(path: str | Path) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def dump_json(data: dict[str, Any], path: str | Path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def fmt_float(v: float) -> str:
    """表达式里使用的紧凑浮点格式。"""
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s if s else "0"
