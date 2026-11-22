"""诊断预览: 原始像素方向 vs 正常显示方向, 以及圆度测量。"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image

from . import ffmpeg
from .annotate import side_by_side
from .geometry import GeometryPipeline
from .probe import VideoInfo, probe


def diagnose_preview(
    path: str,
    out_dir: str,
    at_sec: float = 0.0,
    pipe: GeometryPipeline | None = None,
    points_s: list[tuple[float, float]] | None = None,
) -> dict:
    """生成原始像素方向与正常显示方向的对比预览。

    返回各 PNG 路径与基本说明。若提供 pipe/points, 额外在显示帧上标注规划。
    """
    od = Path(out_dir)
    od.mkdir(parents=True, exist_ok=True)
    info = probe(path)
    stem = Path(path).stem

    raw_png = str(od / f"{stem}_raw.png")
    disp_png = str(od / f"{stem}_display.png")
    # 原始存储像素: 不旋转、不缩放, 保留非方形像素的真实存储样子
    ffmpeg.extract_frame(path, at_sec, raw_png, autorotate=False)
    # 播放器显示方向: 应用旋转矩阵, 并对纯 SAR 做方形化 (autorotate 本身
    # 不处理 SAR), 缩放到几何模块计算的显示面整数尺寸 dw x dh
    ffmpeg.extract_frame(path, at_sec, disp_png, autorotate=True,
                         square_sar=info.sar != 1)
    # 统一到几何规划的显示面尺寸, 保证后续标注坐标对齐
    from PIL import Image as _Image
    if _Image.open(disp_png).size != (info.display_width, info.display_height):
        _Image.open(disp_png).convert("RGB").resize(
            (info.display_width, info.display_height),
            _Image.Resampling.LANCZOS).save(disp_png)

    montage = str(od / f"{stem}_diagnosis.png")
    side_by_side(
        raw_png, disp_png, montage,
        f"stored pixels {info.stored_width}x{info.stored_height} "
        f"(SAR={info.sar.numerator}:{info.sar.denominator})",
        f"player display {info.display_width}x{info.display_height} "
        f"(cw {info.display.cw_deg} deg)",
    )

    result = {"raw": raw_png, "display": disp_png, "montage": montage}

    if pipe is not None:
        from .annotate import annotate_plan
        plan_png = str(od / f"{stem}_plan.png")
        annotate_plan(disp_png, pipe, plan_png, points_s=points_s)
        result["plan"] = plan_png

    return result


# ---------------------------------------------------------------------------
# 圆度测量: 用于验证非方形像素方形化后圆仍是圆
# ---------------------------------------------------------------------------

def measure_circularity(png_path: str, *,
                        threshold: int = 40) -> dict:
    """测量图中最显著亮斑的圆度 (等面积等效圆直径 / 主轴长度)。

    返回 1.0 表示完美正圆; 椭圆会给出 <1 的值, 并返回宽高轴长度比。
    采用图像二阶矩 (covariance eigen-values) 估计等效椭圆轴。
    """
    im = Image.open(png_path).convert("L")
    arr = np.asarray(im, dtype=np.float32)
    mask = arr > threshold
    if mask.sum() < 20:
        return {"found": False, "circularity": None, "axis_ratio": None}

    ys, xs = np.nonzero(mask)
    area = len(xs)
    cx, cy = xs.mean(), ys.mean()
    cov = np.cov(np.vstack([xs - cx, ys - cy]))
    eig = np.linalg.eigvalsh(cov)
    eig = np.clip(eig, 0, None)
    # 二阶矩 -> 等效均匀椭圆半轴: a=2*sqrt(lambda)
    a_axis = 2.0 * math.sqrt(eig[1])
    b_axis = 2.0 * math.sqrt(eig[0])
    axis_ratio = float(b_axis / a_axis) if a_axis > 0 else 0.0
    # 圆度: 等面积圆周长 / 实际轮廓周长 的近似, 这里用轴比作为稳定指标
    circularity = axis_ratio
    return {
        "found": True,
        "area_px": int(area),
        "centroid": (float(cx), float(cy)),
        "major_axis": float(a_axis),
        "minor_axis": float(b_axis),
        "axis_ratio": axis_ratio,
        "circularity": circularity,
    }
