"""同一时间点逐帧比较输入与输出。

输入侧取"正常显示方向"的帧 (应用旋转/SAR 后播放器所见),
输出侧取实际帧; 两者都缩放到统一比较尺寸后计算差异, 并生成拼图。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from . import ffmpeg
from .annotate import side_by_side
from .probe import VideoInfo, probe


@dataclass
class FrameDiff:
    index: int
    time_sec: float
    mean_abs_diff: float
    max_diff: int
    nonblack_ratio_in: float
    nonblack_ratio_out: float
    size_in: tuple[int, int]
    size_out: tuple[int, int]


def _load_gray(path: str, size: tuple[int, int]) -> np.ndarray:
    im = Image.open(path).convert("L").resize(size, Image.BILINEAR)
    return np.asarray(im, dtype=np.float32)


def _nonblack_ratio(path: str) -> float:
    im = np.asarray(Image.open(path).convert("L"), dtype=np.float32)
    return float((im > 16).mean())


def compare_at(
    input_path: str,
    output_path: str,
    frame_index: int,
    work_dir: str,
) -> FrameDiff:
    """抽取同一帧序号的输入(显示方向)与输出帧并比较。"""
    wd = Path(work_dir)
    wd.mkdir(parents=True, exist_ok=True)
    in_png = str(wd / f"cmp_{frame_index:04d}_in.png")
    out_png = str(wd / f"cmp_{frame_index:04d}_out.png")

    # 输入: autorotate 得到播放器显示方向, 并对纯 SAR 方形化;
    # 输出: 已是真实方形像素帧, 不再旋转/缩放
    in_info = probe(input_path)
    ffmpeg.frame_at_index(input_path, frame_index, in_png, autorotate=True,
                          square_sar=in_info.sar != 1)
    ffmpeg.frame_at_index(output_path, frame_index, out_png, autorotate=True)

    in_im = Image.open(in_png)
    out_im = Image.open(out_png)
    cmp_size = (320, max(2, round(320 * in_im.height / in_im.width)))
    a = _load_gray(in_png, cmp_size)
    b = _load_gray(out_png, cmp_size)

    diff = np.abs(a - b)
    return FrameDiff(
        index=frame_index,
        time_sec=frame_index / float(probe(input_path).frame_rate),
        mean_abs_diff=float(diff.mean()),
        max_diff=int(diff.max()),
        nonblack_ratio_in=_nonblack_ratio(in_png),
        nonblack_ratio_out=_nonblack_ratio(out_png),
        size_in=in_im.size,
        size_out=out_im.size,
    )


def compare_montage(
    input_path: str,
    output_path: str,
    frame_index: int,
    work_dir: str,
    out_png: str,
) -> str:
    """生成输入/输出同时间点拼图, 返回路径。"""
    wd = Path(work_dir)
    in_png = str(wd / f"cmp_{frame_index:04d}_in.png")
    out_png_ = str(wd / f"cmp_{frame_index:04d}_out.png")
    if not Path(in_png).exists():
        compare_at(input_path, output_path, frame_index, work_dir)
    side_by_side(
        in_png, out_png_, out_png,
        f"input frame {frame_index} (display orientation)",
        f"output frame {frame_index} (real pixels)",
    )
    return out_png


def compare_sampled(
    input_path: str,
    output_path: str,
    work_dir: str,
    samples: int = 5,
) -> list[FrameDiff]:
    """在整段时间轴上均匀抽样若干帧做比较。"""
    info = probe(input_path)
    n = info.nb_frames or ffmpeg.count_frames(input_path)
    if n <= 0:
        return []
    idxs = sorted({min(n - 1, round(i * (n - 1) / max(1, samples - 1)))
                   for i in range(samples)})
    return [compare_at(input_path, output_path, i, work_dir) for i in idxs]
