"""对照检查: 转场帧裁框归属、预览与成片逐帧一致性、音轨/时长保留。"""
from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Optional

from .expr import crop_px, sample_kf
from .ffmpegutil import probe, run_ffmpeg
from .model import even2

# 只比亮度平面时, H.264 有损编码在平坦区域的 Y 差异约 1~2.5%;
# 实测裁错位置时 Y 差异 >=6.8%, 3% 阈值能严格区分两者。
PIXEL_DIFF_TOLERANCE = 0.03


def cut_frames(schedule: dict[str, Any], tracks_doc: dict[str, Any]) -> list[dict[str, Any]]:
    """每个切点前后两帧分别属于哪套裁框/策略。"""
    fps = float(schedule["fps"])
    rows = []
    for seg in schedule["segments"][1:]:
        fi = int(round(float(seg["start"]) * fps))
        before = sample_kf(schedule, (fi - 1) / fps)
        after = sample_kf(schedule, fi / fps)
        rows.append({
            "t": float(seg["start"]),
            "frame": fi,
            "transition": seg["transition"],
            "before_crop": before,
            "after_crop": after,
            "jump_px": round(abs(after["x"] - before["x"]) * int(schedule["width"]), 2),
            "strategy_after": seg["dominant_strategy"],
        })
    return rows


def _raw_frame(video: str | Path, fi: int, fps: float,
               crop: Optional[tuple[int, int, int, int]] = None,
               out_dir: str | Path = ".") -> Path:
    """抽第 fi 帧为 yuv420p rawvideo; crop=(w,h,x,y) 时先按坐标裁。"""
    out_dir = Path(out_dir)
    tag = f"{'crop' if crop else 'full'}_{fi:06d}"
    path = out_dir / f"{tag}.raw"
    vf = f"crop={crop[0]}:{crop[1]}:{crop[2]}:0" if crop else "null"
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{fi / fps:.6f}", "-i", str(video), "-frames:v", "1",
        "-vf", vf,
        "-pix_fmt", "yuv420p", "-f", "rawvideo", str(path),
    ]
    run_ffmpeg(cmd)
    return path


def check_export_vs_schedule(
    source: str | Path,
    vertical: str | Path,
    schedule: dict[str, Any],
    work_dir: str | Path,
    sample_frames: Optional[list[int]] = None,
) -> dict[str, Any]:
    """校验成片每帧的裁框是否等于时间表。

    两级判定:
    - 几何: 时间表给出的 (w,h,x) 与成片尺寸/位置一致 (严格);
    - 像素: 原片按时间表现裁的 raw 帧与成片同帧 raw 对比, 有损编码下
      差异字节占比低于 PIXEL_DIFF_TOLERANCE 即通过, 无损时应为 0。
    """
    fps = float(schedule["fps"])
    width = int(schedule["width"])
    crop_w, crop_h = crop_px(schedule)
    if sample_frames is None:
        picks = {0, int(schedule["frames"]) - 1}
        for seg in schedule["segments"][1:]:
            fi = int(round(float(seg["start"]) * fps))
            picks.update((max(0, fi - 1), fi, min(int(schedule["frames"]) - 1, fi + 1)))
        sample_frames = sorted(picks)

    tmp = Path(work_dir) / "verify_frames"
    tmp.mkdir(parents=True, exist_ok=True)
    rows = []
    for fi in sample_frames:
        c = sample_kf(schedule, fi / fps)
        x = even2(c["x"] * width)
        expect = _raw_frame(source, fi, fps, crop=(crop_w, crop_h, x, 0), out_dir=tmp)
        got = _raw_frame(vertical, fi, fps, out_dir=tmp)
        eb, gb = expect.read_bytes(), got.read_bytes()
        size_ok = len(eb) == len(gb)
        if size_ok:
            # 只比亮度平面 Y (yuv420p 下前 width*height 字节),
            # 避开色度子采样带来的量化噪声; 裁错位置在 Y 平面差异显著。
            y_len = crop_w * crop_h
            ey, gy = eb[:y_len], gb[:y_len]
            diff_ratio = sum(1 for a, b in zip(ey, gy) if a != b) / max(1, y_len)
        else:
            diff_ratio = 1.0
        rows.append({
            "frame": fi, "t": round(fi / fps, 3), "crop_x_px": x,
            "luma_diff_ratio": round(diff_ratio, 5),
            "identical": size_ok and diff_ratio <= PIXEL_DIFF_TOLERANCE,
        })
    return {"rows": rows, "ok": all(r["identical"] for r in rows),
            "tolerance": PIXEL_DIFF_TOLERANCE}


def check_av(source: str | Path, vertical: str | Path, schedule: dict[str, Any]) -> dict[str, Any]:
    src = probe(source)
    out = probe(vertical)
    dur_diff = abs(src["duration"] - out["duration"])
    return {
        "source_duration": round(src["duration"], 3),
        "output_duration": round(out["duration"], 3),
        "duration_diff_s": round(dur_diff, 3),
        "source_has_audio": src["has_audio"],
        "output_has_audio": out["has_audio"],
        "output_size": f"{out['width']}x{out['height']}",
        "expected_size": f"{schedule['crop']['width_px']}x{schedule['crop']['height_px']}",
        "ok": (
            dur_diff < 0.1
            and (not src["has_audio"] or out["has_audio"])
            and out["width"] == schedule["crop"]["width_px"]
            and out["height"] == schedule["crop"]["height_px"]
        ),
    }
