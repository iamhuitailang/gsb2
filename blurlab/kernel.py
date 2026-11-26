"""拖影点扩散函数（PSF）与同尺寸卷积。

约定
----
- 角度：以图像 x 轴（向右）为 0°，屏幕上逆时针为正，取值按 180° 取模
  （PSF 是对称线段，θ 与 θ+180° 等价）。数组坐标 y 向下，所以方向向量是
  ``(cos θ, -sin θ)``。
- 长度：``length_px`` 是拖影线段的物理长度（像素）。核在 [-L/2, L/2] 上等间隔
  采样 ``ceil(L)+1`` 个点，再做双线性撒点，因此核中心严格在几何中心。
"""

from __future__ import annotations

import math

import numpy as np


def unit_vector(angle_deg: float) -> tuple[float, float]:
    """屏幕坐标下的单位方向向量 (dx, dy)，dy 以数组行方向为正。"""
    a = math.radians(float(angle_deg))
    return math.cos(a), -math.sin(a)


def wrap_angle(angle_deg: float) -> float:
    """把角度归一到 [0, 180)。"""
    return float(angle_deg) % 180.0


def angle_difference(a_deg: float, b_deg: float) -> float:
    """两个无向轴之间的最小夹角（0..90）。"""
    d = abs(wrap_angle(a_deg) - wrap_angle(b_deg)) % 180.0
    return min(d, 180.0 - d)


def motion_psf(length_px: float, angle_deg: float, samples_per_px: int = 4) -> np.ndarray:
    """生成归一化的运动拖影 PSF。长度 < 1 时退化为 1x1 单位核。

    线段按约 ``samples_per_px`` 个采样/像素均匀取点，再做双线性撒点。采样
    比"每像素一个点"密，能避免端点落在半像素时被撒成两个整数像素而把线段
    额外展宽；同时点数只随长度线性增长（L=21 → 约 85 点），参数扫描不会慢。
    """
    length = float(length_px)
    if length < 1e-6:
        return np.ones((1, 1), dtype=np.float64)

    radius = int(math.ceil(length / 2.0)) + 1
    size = 2 * radius + 1
    psf = np.zeros((size, size), dtype=np.float64)

    n = max(2, int(math.ceil(length * max(1, samples_per_px))) + 1)
    ts = np.linspace(-length / 2.0, length / 2.0, n)
    ux, uy = unit_vector(angle_deg)

    for t in ts:
        x = radius + t * ux
        y = radius + t * uy
        x0 = int(math.floor(x))
        y0 = int(math.floor(y))
        fx = x - x0
        fy = y - y0
        # 双线性撒点，保证亚像素角度下能量守恒
        psf[y0, x0] += (1.0 - fx) * (1.0 - fy)
        psf[y0, x0 + 1] += fx * (1.0 - fy)
        psf[y0 + 1, x0] += (1.0 - fx) * fy
        psf[y0 + 1, x0 + 1] += fx * fy

    total = psf.sum()
    if total <= 0:
        psf[radius, radius] = 1.0
        return psf
    return psf / total


def psf_radius(psf: np.ndarray) -> int:
    """PSF 半宽（用于计算处理余量）。"""
    return max(psf.shape) // 2


def projected_length(length_px: float, blur_angle_deg: float, normal_angle_deg: float) -> float:
    """长度为 L 的线状 PSF 在法线方向上的投影长度：L * |cos(θ_u - φ_n)|。

    一条均匀线段在任意轴上的投影仍是均匀分布，长度按夹角余弦缩短。
    这是"单条边只能测到投影"的物理依据。
    """
    a = math.radians(wrap_angle(blur_angle_deg) - wrap_angle(normal_angle_deg))
    return abs(float(length_px) * math.cos(a))


# ---------------------------------------------------------------------------
# 卷积（NumPy 实现，缺失 SciPy 也能跑）
# ---------------------------------------------------------------------------


def next_fast_len(n: int) -> int:
    """返回 >= n 的最小 5-smooth 整数，给 FFT 用。"""
    if n <= 16:
        return max(1, int(n))
    best = 1 << max(0, (int(n) - 1).bit_length())
    p5 = 1
    while p5 < best:
        p35 = p5
        while p35 < best:
            p = p35
            while p < n:
                p *= 2
            best = min(best, p)
            p35 *= 3
        p5 *= 5
    return best


def _full_convolution(a: np.ndarray, psf: np.ndarray) -> np.ndarray:
    """线性卷积的 full 结果，用 FFT 计算。a 可为 (H,W) 或 (H,W,C)。"""
    ah, aw = a.shape[:2]
    kh, kw = psf.shape
    nh = next_fast_len(ah + kh - 1)
    nw = next_fast_len(aw + kw - 1)

    if a.ndim == 2:
        buf = np.zeros((nh, nw), dtype=np.float64)
        buf[:ah, :aw] = a
        kb = np.zeros((nh, nw), dtype=np.float64)
        kb[:kh, :kw] = psf
        out = np.fft.irfft2(np.fft.rfft2(buf) * np.fft.rfft2(kb), s=(nh, nw))
        return out[: ah + kh - 1, : aw + kw - 1]

    channels = a.shape[2]
    buf = np.zeros((nh, nw, channels), dtype=np.float64)
    buf[:ah, :aw, :] = a
    kb = np.zeros((nh, nw), dtype=np.float64)
    kb[:kh, :kw] = psf
    fk = np.fft.rfft2(kb)[..., None]
    out = np.fft.irfft2(np.fft.rfft2(buf, axes=(0, 1)) * fk, s=(nh, nw), axes=(0, 1))
    return out[: ah + kh - 1, : aw + kw - 1, :]


def convolve_same(img: np.ndarray, psf: np.ndarray) -> np.ndarray:
    """同尺寸卷积，边界用镜像延拓，返回与输入同形状的 float32。"""
    a = np.asarray(img, dtype=np.float64)
    psf = np.asarray(psf, dtype=np.float64)
    if psf.ndim != 2:
        raise ValueError("psf 必须是二维数组")
    if psf.size == 1:
        return (a * float(psf.reshape(-1)[0])).astype(np.float32)

    kh, kw = psf.shape
    py, px = kh // 2, kw // 2
    pad_spec = ((py, py), (px, px)) + ((0, 0),) * (a.ndim - 2)
    padded = np.pad(a, pad_spec, mode="symmetric")
    full = _full_convolution(padded, psf)
    out = full[2 * py : 2 * py + a.shape[0], 2 * px : 2 * px + a.shape[1]]
    if a.ndim == 3:
        out = out[..., : a.shape[2]]
    return out.astype(np.float32)


def gaussian_psf(sigma: float, radius: int | None = None) -> np.ndarray:
    """各向同性高斯 PSF，用于模拟镜头/传感器模糊。"""
    sigma = float(sigma)
    if sigma <= 1e-6:
        return np.ones((1, 1), dtype=np.float64)
    r = int(math.ceil(3 * sigma)) if radius is None else int(radius)
    r = max(1, r)
    ys, xs = np.mgrid[-r : r + 1, -r : r + 1]
    psf = np.exp(-(xs * xs + ys * ys) / (2.0 * sigma * sigma))
    return psf / psf.sum()


def compose_psf(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """两个 PSF 的二维线性卷积（full），用于叠加拖影与传感器模糊。"""
    out = _full_convolution(np.asarray(a, float), np.asarray(b, float))
    total = out.sum()
    return out / total if total > 0 else out


def blur_image(
    img: np.ndarray, length_px: float, angle_deg: float, sigma: float = 0.0
) -> np.ndarray:
    """按给定长度/方向做拖影，可选叠加各向同性高斯（镜头/传感器模糊）。"""
    psf = motion_psf(length_px, angle_deg)
    if sigma > 0:
        psf = compose_psf(psf, gaussian_psf(sigma))
    return convolve_same(img, psf)
