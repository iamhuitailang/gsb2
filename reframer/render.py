"""渲染: 横版预览、横竖对照、竖版导出、抽帧。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .expr import (
    build_crop_filter,
    crop_px,
    drawbox_preview_filter,
    safe_zone_expressions,
    track_box_expressions,
)
from .ffmpegutil import probe, run_ffmpeg

# 预览关注框用与样例方块(黄/绿)拉开色差的描边色
TRACK_COLORS = {"p1": "magenta@0.95", "p2": "cyan@0.95"}


def _preview_chain(schedule: dict[str, Any], tracks_doc: dict[str, Any]) -> str:
    parts = []
    parts.extend(safe_zone_expressions(
        tracks_doc.get("safe_zones", []),
        int(tracks_doc["width"]), int(tracks_doc["height"]),
    ))
    parts.extend(track_box_expressions(tracks_doc, TRACK_COLORS))
    parts.append(drawbox_preview_filter(schedule, color="0xff2d55@0.95", thickness=5))
    return ",".join(parts)


def render_preview(
    video: str | Path,
    schedule: dict[str, Any],
    tracks_doc: dict[str, Any],
    out_path: str | Path,
    work_dir: str | Path,
) -> None:
    """横版预览: 关注框 + 安全区 + 竖版取景框移动轨迹。"""
    chain = _preview_chain(schedule, tracks_doc)
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(video), "-vf", chain,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-c:a", "copy", str(out_path),
    ]
    run_ffmpeg(cmd)


def render_compare(
    video: str | Path,
    schedule: dict[str, Any],
    tracks_doc: dict[str, Any],
    out_path: str | Path,
    work_dir: str | Path,
) -> None:
    """横竖对照: 左边带取景框的横版, 右边竖版成片, 共用同一 crop 表达式。"""
    crop_filter, _ = build_crop_filter(schedule, work_dir)
    preview = _preview_chain(schedule, tracks_doc)
    # 右侧竖版缩放到与横版同高后再 hstack
    crop_w, crop_h = crop_px(schedule)
    scale_h = int(tracks_doc["height"])
    scale_w = even_scale_w(crop_w, crop_h, scale_h)
    fc = (
        f"[0:v]{preview}[left];"
        f"[0:v]{crop_filter},scale={scale_w}:{scale_h}[right];"
        f"[left][right]hstack=inputs=2[out]"
    )
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(video), "-filter_complex", fc, "-map", "[out]",
        "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", str(out_path),
    ]
    run_ffmpeg(cmd)


def even_scale_w(src_w: int, src_h: int, target_h: int) -> int:
    w = int(round(src_w * target_h / src_h))
    return w if w % 2 == 0 else w + 1


def duration_of(video: str | Path) -> float:
    return probe(video)["duration"]


def export_vertical(
    video: str | Path,
    schedule: dict[str, Any],
    out_path: str | Path,
    work_dir: str | Path,
) -> None:
    """导出竖版: 保留原音与完整时长, 裁框逐帧由时间表驱动。"""
    crop_filter, cmd_file = build_crop_filter(schedule, work_dir)
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(video),
        "-vf", f"{crop_filter},setsar=1",
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", str(out_path),
    ]
    run_ffmpeg(cmd)


def contact_sheet(
    video: str | Path,
    times: list[float],
    out_path: str | Path,
    tile_h: int = 320,
    cols: int = 3,
) -> None:
    """把若干时刻抽帧拼成联系表 (供报告嵌入和人工核对)。

    xstack 的 grid 要求格数恰好等于输入数, 因此按帧数调整列数保证填满。
    """
    n = len(times)
    # 选不超过 cols 且能整除 n 的列数, 否则退化为单行
    use_cols = next((c for c in range(min(cols, n), 0, -1) if n % c == 0), 1)
    rows = n // use_cols
    # 末尾帧 seek 可能越界 (t 贴近 duration 时抽不到帧), 钳到安全范围
    safe_times = [min(max(0.0, float(t)), max(0.0, duration_of(video)) - 0.15) for t in times]
    inputs: list[str] = []
    for t in safe_times:
        inputs += ["-ss", f"{t:.3f}", "-i", str(video)]
    labels = "".join(f"[{i}:v]scale=-2:{tile_h}[v{i}];" for i in range(n))
    stack = "".join(f"[v{i}]" for i in range(n))
    fc = (
        labels.rstrip(";")
        + f";{stack}xstack=inputs={n}:grid={use_cols}x{rows}:fill=white,"
        f"scale=in_range=tv:out_range=full[out]"
    )
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs,
        "-filter_complex", fc, "-map", "[out]", "-frames:v", "1",
        "-pix_fmt", "yuvj420p", str(out_path),
    ]
    run_ffmpeg(cmd)
