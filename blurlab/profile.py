"""沿法向采样边剖面、局部边缘方向修正，供估计与指标共用。

屏幕坐标约定：角度以 +x 为 0°、逆时针为正；数组 y 向下，因此方向向量
``(cos θ, -sin θ)``。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .image_io import luma


def normal_vector(angle_deg: float) -> tuple[float, float]:
    a = math.radians(float(angle_deg))
    return math.cos(a), -math.sin(a)


def screen_angle(dx: float, dy: float) -> float:
    """数组坐标下的向量 -> 屏幕角度（度）。"""
    return math.degrees(math.atan2(-dy, dx))


def bilinear(img: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """双线性采样，边界按镜像处理。"""
    a = np.asarray(img, dtype=np.float32)
    if a.ndim == 3:
        a = luma(a)
    h, w = a.shape
    xs = np.asarray(xs, dtype=np.float64)
    ys = np.asarray(ys, dtype=np.float64)

    x = np.clip(xs, 0, w - 1)
    y = np.clip(ys, 0, h - 1)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = x - x0
    fy = y - y0

    v00 = a[y0, x0]
    v10 = a[y0, x1]
    v01 = a[y1, x0]
    v11 = a[y1, x1]
    return (
        v00 * (1 - fx) * (1 - fy)
        + v10 * fx * (1 - fy)
        + v01 * (1 - fx) * fy
        + v11 * fx * fy
    )


def refine_normal(
    img: np.ndarray,
    center: tuple[float, float],
    guess_deg: float,
    radius: int = 7,
) -> float:
    """用结构张量在局部修正边的法向。

    用户只需要大致跨过一条边；真实法向由局部梯度主导方向给出。若局部没有
    明确方向（平坦区），退回用户拖拽方向。
    """
    lum = luma(img) if np.asarray(img).ndim == 3 else np.asarray(img, dtype=np.float32)
    h, w = lum.shape
    cx, cy = int(round(center[0])), int(round(center[1]))
    r = int(max(2, radius))
    x0, x1 = max(1, cx - r), min(w - 1, cx + r + 1)
    y0, y1 = max(1, cy - r), min(h - 1, cy + r + 1)
    patch = lum[y0:y1, x0:x1]
    if patch.shape[0] < 3 or patch.shape[1] < 3:
        return float(guess_deg) % 180.0

    gy, gx = np.gradient(patch.astype(np.float64))
    jxx = float((gx * gx).sum())
    jyy = float((gy * gy).sum())
    jxy = float((gx * gy).sum())
    tr = jxx + jyy
    if tr <= 1e-12:
        return float(guess_deg) % 180.0
    # 结构张量的主方向 theta = 0.5·atan2(2Jxy, Jxx-Jyy) 是**梯度**方向，
    # 即边的法向。在数组坐标中梯度向量为 (cosθ, sinθ)。
    theta = 0.5 * math.atan2(2.0 * jxy, jxx - jyy)
    gx_dir = math.cos(theta)
    gy_dir = math.sin(theta)
    ang = screen_angle(gx_dir, gy_dir) % 180.0
    coherence = math.hypot(jxx - jyy, 2 * jxy) / tr
    if coherence < 0.25:
        return float(guess_deg) % 180.0
    # 与用户拖拽方向的轴夹角超过 40° 时，认为用户选的边不清楚，保留用户方向
    d = abs(((ang - guess_deg + 90.0) % 180.0) - 90.0)
    if d > 40.0:
        return float(guess_deg) % 180.0
    return ang


@dataclass
class Profile:
    """一条边的平均法向剖面。"""

    u: np.ndarray
    v: np.ndarray
    normal_deg: float
    center: tuple[float, float]
    window_half: float
    n_lines: int
    line_span: float
    per_line: np.ndarray = field(repr=False, default=None)

    def to_dict(self) -> dict:
        return {
            "normal_deg": float(self.normal_deg),
            "center": [float(self.center[0]), float(self.center[1])],
            "window_half_px": float(self.window_half),
            "n_lines": int(self.n_lines),
            "line_span_px": float(self.line_span),
            "samples": int(self.u.size),
        }


def sample_edge_profile(
    img: np.ndarray,
    center: tuple[float, float],
    normal_deg: float,
    window_half: float = 24.0,
    step: float = 1.0,
    edge_extent: float = 40.0,
    max_lines: int = 16,
) -> Profile:
    """以 center 为中心，沿法向取平均剖面。

    沿边方向展开的线数由 edge_extent 决定（最多 max_lines 条），用于压噪声；
    每条线都沿法向采样 ±window_half。
    """
    nx, ny = normal_vector(normal_deg)
    # 边的切向（法向旋转 90°）
    tx, ty = -ny, nx

    n_u = int(math.floor(2 * window_half / max(1e-6, step))) + 1
    u = np.linspace(-window_half, window_half, n_u)

    half_span = max(0.0, float(edge_extent))
    if half_span <= step:
        offsets = np.array([0.0])
    else:
        # 每像素取一条线，最多 max_lines 条，用于压噪声
        n_lines = int(min(max_lines, max(2, round(2.0 * half_span))))
        offsets = np.linspace(-half_span, half_span, n_lines)

    cx, cy = float(center[0]), float(center[1])
    per_line = np.empty((offsets.size, u.size), dtype=np.float32)
    for i, off in enumerate(offsets):
        xs = cx + off * tx + u * nx
        ys = cy + off * ty + u * ny
        per_line[i] = bilinear(img, xs, ys)

    v = per_line.mean(axis=0).astype(np.float32)
    return Profile(
        u=u.astype(np.float32),
        v=v,
        normal_deg=float(normal_deg) % 180.0,
        center=(cx, cy),
        window_half=float(window_half),
        n_lines=int(offsets.size),
        line_span=float(2 * half_span),
        per_line=per_line,
    )


def edge_profile_from_segment(
    img: np.ndarray,
    p0: tuple[float, float],
    p1: tuple[float, float],
    window_half: float | None = None,
    step: float = 1.0,
) -> Profile:
    """由用户拖出的跨边线段生成剖面。

    线段方向是法向的初值，中心是线段中点；随后用局部结构张量修正法向。

    ``window_half=None`` 时把采样窗收到约拖动长度的一半：用户拖出的线段本来
    就是他判断"这一段是清楚的边"的范围，采太宽会把临近的其它边缘带进拟合
    剖面。显式传入数值则按用户指定。
    """
    dx = float(p1[0]) - float(p0[0])
    dy = float(p1[1]) - float(p0[1])
    guess = screen_angle(dx, dy) % 180.0
    center = ((float(p0[0]) + float(p1[0])) / 2.0, (float(p0[1]) + float(p1[1])) / 2.0)
    normal = refine_normal(img, center, guess)
    seg_len = math.hypot(dx, dy)
    if window_half is None:
        # 单侧采样窗 ≈ 0.45·拖动长度，限制在 [4, 48] px
        window_half = float(min(48.0, max(4.0, seg_len * 0.45)))
    else:
        window_half = float(window_half)
    # 沿边方向的可平均范围：不短于 8 px、不长于 80 px
    extent = min(40.0, max(8.0, seg_len * 1.5))
    prof = sample_edge_profile(
        img, center, normal, window_half=window_half, step=step, edge_extent=extent
    )
    return prof
