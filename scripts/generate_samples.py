#!/usr/bin/env python3
"""生成三种本地测试样片（全部由 ffmpeg 滤镜合成，无外部素材下载）。

样片清单
--------
sample_hfr_120fps.mp4   120fps 高帧率：移动彩球 + 帧号烧录，3 秒
sample_lfr_15fps.mp4    15fps 低帧率：同场景慢速版，4 秒
sample_audio_30fps.mp4  30fps 带音频：彩球 + 440Hz 正弦波语音轨，4 秒

用法: python3 scripts/generate_samples.py [输出目录]
"""

from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_OUT = os.path.join(ROOT, "public", "samples")


def _run(cmd: list[str]) -> None:
    print("+", " ".join(cmd))
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write(p.stderr)
        raise SystemExit(f"样片生成失败: {' '.join(cmd)}")


def moving_ball_vf(fps: int, duration: int, w: int = 640, h: int = 360) -> str:
    """testsrc2 自带时钟、彩条与移动色块（不依赖 drawtext 等外部库），
    再叠加一个水平往返运动的黄球强化运动轨迹，便于观察卡顿/拖影。"""
    speed = w / duration
    return (
        f"testsrc2=size={w}x{h}:rate={fps}:duration={duration},"
        f"drawbox=x='mod(t*{speed:.1f},{w})':y=120:w=60:h=60:"
        f"color=yellow:t=fill"
    )


def main(out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)

    # 1) 高帧率 120fps，3 秒，无音频
    hfr = os.path.join(out_dir, "sample_hfr_120fps.mp4")
    _run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", moving_ball_vf(120, 3),
        "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
        "-pix_fmt", "yuv420p", hfr,
    ])

    # 2) 低帧率 15fps，4 秒，无音频
    lfr = os.path.join(out_dir, "sample_lfr_15fps.mp4")
    _run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", moving_ball_vf(15, 4),
        "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
        "-pix_fmt", "yuv420p", lfr,
    ])

    # 3) 30fps 带音频：440Hz 正弦波 + 轻微颤音，4 秒
    aud = os.path.join(out_dir, "sample_audio_30fps.mp4")
    _run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", moving_ball_vf(30, 4),
        "-f", "lavfi", "-i",
        "sine=frequency=440:duration=4:sample_rate=48000",
        "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-shortest", aud,
    ])

    print(f"\n样片已生成到 {out_dir}")
    for name in sorted(os.listdir(out_dir)):
        if name.endswith(".mp4"):
            size = os.path.getsize(os.path.join(out_dir, name))
            print(f"  {name}  ({size // 1024} KB)")


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    main(os.path.abspath(target))
