"""LUT 应用引擎：一维逐通道插值、三维三线性插值、双表串联与范围标记。

约定（全工具统一的颜色约定）
----------------------------
* 所有像素在内部都用 **float64、RGB 通道顺序、线性无关的归一化值** 表示，
  常见视频帧读入后先经 :func:`lut_tool.video.bgr_to_rgb_float` 转到该约定；
* 输入适用范围由表的 ``DOMAIN_MIN/MAX`` 决定，范围外的像素仍然求值
  （按边界外推/钳位），但会在掩码里被明确标出；
* 输出不做隐式钳位，调用方需要时用 :func:`clipped_mask` 检查越界。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .cube import CubeLUT

# 范围外像素的醒目标记色（品红，与正常画面区分度高）。
OOR_MARKER = np.array([1.0, 0.0, 1.0], dtype=np.float64)
# 输出被钳位（clip）像素的标记色（橙红）。
CLIP_MARKER = np.array([1.0, 0.35, 0.0], dtype=np.float64)


def _normalize_domain(rgb: np.ndarray, lut: CubeLUT) -> np.ndarray:
    """把像素按表的 domain 归一化到 [0, 1] 轴坐标（可超出 [0,1]）。"""
    span = lut.domain_max - lut.domain_min
    return (rgb - lut.domain_min) / span


def apply_3d(lut: CubeLUT, rgb: np.ndarray) -> np.ndarray:
    """向量化三线性插值。``rgb`` 形状 ``(..., 3)``，返回同形状 float64。"""
    if lut.kind != "3D":
        raise ValueError("apply_3d 只能用于 3D LUT")
    u = np.clip(_normalize_domain(rgb, lut), 0.0, 1.0)
    n = lut.size
    coord = u * (n - 1)
    lo = np.floor(coord).astype(np.int64)
    hi = np.minimum(lo + 1, n - 1)
    frac = coord - lo

    r0, g0, b0 = lo[..., 0], lo[..., 1], lo[..., 2]
    r1, g1, b1 = hi[..., 0], hi[..., 1], hi[..., 2]
    fr, fg, fb = frac[..., 0], frac[..., 1], frac[..., 2]

    t = lut.table

    def gather(r, g, b):
        return t[r, g, b]

    c000 = gather(r0, g0, b0)
    c100 = gather(r1, g0, b0)
    c010 = gather(r0, g1, b0)
    c110 = gather(r1, g1, b0)
    c001 = gather(r0, g0, b1)
    c101 = gather(r1, g0, b1)
    c011 = gather(r0, g1, b1)
    c111 = gather(r1, g1, b1)

    w000 = (1 - fr) * (1 - fg) * (1 - fb)
    w100 = fr * (1 - fg) * (1 - fb)
    w010 = (1 - fr) * fg * (1 - fb)
    w110 = fr * fg * (1 - fb)
    w001 = (1 - fr) * (1 - fg) * fb
    w101 = fr * (1 - fg) * fb
    w011 = (1 - fr) * fg * fb
    w111 = fr * fg * fb

    out = (
        c000 * w000[..., None]
        + c100 * w100[..., None]
        + c010 * w010[..., None]
        + c110 * w110[..., None]
        + c001 * w001[..., None]
        + c101 * w101[..., None]
        + c011 * w011[..., None]
        + c111 * w111[..., None]
    )
    return out


def apply_1d(lut: CubeLUT, rgb: np.ndarray) -> np.ndarray:
    """逐通道线性插值（R/G/B 共用同一条 1D 曲线，按各自值查表）。"""
    if lut.kind != "1D":
        raise ValueError("apply_1d 只能用于 1D LUT")
    u = np.clip(_normalize_domain(rgb, lut), 0.0, 1.0)
    n = lut.size
    coord = u * (n - 1)
    lo = np.floor(coord).astype(np.int64)
    hi = np.minimum(lo + 1, n - 1)
    frac = coord - lo

    # table[k, c]：第 k 个采样点的 c 通道输出。
    lo_vals = lut.table[lo, np.arange(3)]
    hi_vals = lut.table[hi, np.arange(3)]
    return lo_vals + (hi_vals - lo_vals) * frac


def apply_lut(lut: CubeLUT, rgb: np.ndarray) -> np.ndarray:
    """应用单张表，输入输出均为 float64 RGB（不钳位）。"""
    rgb = np.asarray(rgb, dtype=np.float64)
    if lut.kind == "1D":
        return apply_1d(lut, rgb)
    return apply_3d(lut, rgb)


def clipped_mask(rgb: np.ndarray, low: float = 0.0, high: float = 1.0) -> np.ndarray:
    """输出超出显示可表示范围、将被钳位的像素掩码。"""
    return np.any((rgb < low) | (rgb > high), axis=-1)


@dataclass
class ChainResult:
    """双表串联结果。

    out:
        最终输出（float64 RGB，未钳位）。
    oor_mask:
        在 **任一级** 超出该级表输入适用范围的像素。
    clip_mask:
        最终输出超出 [0,1] 的像素。
    stage1:
        第一张表的输出（探针与分步查看用）。
    oor_stage:
        形状 ``(H, W)``，取值 0=范围内，1=第一级越界，2=第二级越界，
        3=两级都越界。
    """

    out: np.ndarray
    oor_mask: np.ndarray
    clip_mask: np.ndarray
    stage1: np.ndarray
    oor_stage: np.ndarray


def apply_chain(
    rgb: np.ndarray,
    first: CubeLUT | None,
    second: CubeLUT | None,
) -> ChainResult:
    """按 ``first -> second`` 顺序串联两张表；``None`` 表示该级直通。

    换序只需交换两个参数。第二级的适用范围按第一级的 *输出* 判断。
    """
    rgb = np.asarray(rgb, dtype=np.float64)
    oor_stage = np.zeros(rgb.shape[:2], dtype=np.uint8)

    if first is not None:
        m1 = ~first.is_in_domain(rgb)
        stage1 = apply_lut(first, rgb)
    else:
        m1 = np.zeros(rgb.shape[:2], dtype=bool)
        stage1 = rgb.copy()
    oor_stage[m1] |= 1

    if second is not None:
        m2 = ~second.is_in_domain(stage1)
        out = apply_lut(second, stage1)
    else:
        m2 = np.zeros(rgb.shape[:2], dtype=bool)
        out = stage1.copy()
    oor_stage[m2] |= 2

    return ChainResult(
        out=out,
        oor_mask=m1 | m2,
        clip_mask=clipped_mask(out),
        stage1=stage1,
        oor_stage=oor_stage,
    )


# ---------------------------------------------------------------- 可视化
# 差值热力图配色（0 -> 蓝青 -> 黄 -> 红）。
_HEAT_STOPS = np.array(
    [
        [0.00, 0.08, 0.35],
        [0.10, 0.55, 0.85],
        [0.55, 0.90, 0.55],
        [0.95, 0.75, 0.20],
        [0.90, 0.10, 0.10],
    ],
    dtype=np.float64,
)


def diff_heatmap(reference: np.ndarray, rendered: np.ndarray) -> np.ndarray:
    """两帧的逐通道平均绝对差 -> 固定量程 [0,1] 的彩色热力图。"""
    reference = np.asarray(reference, dtype=np.float64)
    rendered = np.asarray(rendered, dtype=np.float64)
    d = np.mean(np.abs(reference - rendered), axis=-1)
    d = np.clip(d, 0.0, 1.0)
    x = d * (len(_HEAT_STOPS) - 1)
    lo = np.floor(x).astype(np.int64)
    hi = np.minimum(lo + 1, len(_HEAT_STOPS) - 1)
    frac = (x - lo)[..., None]
    colors = _HEAT_STOPS[lo] * (1 - frac) + _HEAT_STOPS[hi] * frac
    return colors


def diff_stats(reference: np.ndarray, rendered: np.ndarray) -> dict:
    """一帧差值的汇总统计（探针/状态栏用）。"""
    reference = np.asarray(reference, dtype=np.float64)
    rendered = np.asarray(rendered, dtype=np.float64)
    per_pixel = np.abs(reference - rendered)
    per_channel = per_pixel.reshape(-1, 3).mean(axis=0)
    return {
        "mean_abs": float(per_pixel.mean()),
        "max_abs": float(per_pixel.max()),
        "mean_per_channel": per_channel,
        "changed_ratio": float(np.mean(np.any(per_pixel > 1e-6, axis=-1))),
    }


def mark_pixels(
    image: np.ndarray,
    mask: np.ndarray,
    color: np.ndarray = OOR_MARKER,
) -> np.ndarray:
    """把掩码为真的像素替换成醒目标记色，返回新数组。"""
    out = np.array(image, dtype=np.float64, copy=True)
    out[mask] = color
    return out
