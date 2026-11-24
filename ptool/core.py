"""核心算法:FFT 周期纹理抑制。

峰值统一用分数频率 (fy, fx) 表示,单位 cycles/pixel,取值 [-0.5, 0.5)。
这样从参考区域估计到的峰可以直接用于整图或任意局部区域。
"""
from __future__ import annotations

import numpy as np


# ---------------------------------------------------------------- 基础工具

def to_float(img: np.ndarray) -> np.ndarray:
    """uint8/uint16/float 图像统一转 [0,1] float32。"""
    img = np.asarray(img)
    if img.dtype == np.uint8:
        return img.astype(np.float32) / 255.0
    if img.dtype == np.uint16:
        return img.astype(np.float32) / 65535.0
    return img.astype(np.float32)


def to_uint8(img: np.ndarray) -> np.ndarray:
    return (np.clip(img, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def _fit_plane(ch: np.ndarray) -> np.ndarray:
    """最小二乘拟合平面 a*y + b*x + c,用于去趋势,避免边缘不连续污染频谱。"""
    h, w = ch.shape
    yy, xx = np.mgrid[0:h, 0:w]
    y = yy.ravel() / max(h - 1, 1)
    x = xx.ravel() / max(w - 1, 1)
    A = np.stack([y, x, np.ones_like(x)], axis=1)
    coef, *_ = np.linalg.lstsq(A, ch.ravel(), rcond=None)
    return (coef[0] * yy / max(h - 1, 1) + coef[1] * xx / max(w - 1, 1) + coef[2]).astype(np.float32)


def detrend(ch: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """返回 (去趋势后的通道, 趋势面)。不填充、不裁边,奇数尺寸同样适用。"""
    plane = _fit_plane(ch)
    return (ch - plane).astype(np.float32), plane


def hann2d(shape: tuple[int, int]) -> np.ndarray:
    h, w = shape
    wy = np.hanning(h) if h > 2 else np.ones(h)
    wx = np.hanning(w) if w > 2 else np.ones(w)
    return (wy[:, None] * wx[None, :]).astype(np.float32)


# ---------------------------------------------------------------- 频谱与峰值

def spectrum(ch: np.ndarray, window: bool = True) -> np.ndarray:
    """去趋势后的中心化频谱(复数)。"""
    res, _ = detrend(ch)
    if window:
        res = res * hann2d(ch.shape)
    return np.fft.fftshift(np.fft.fft2(res))


def log_magnitude(ch: np.ndarray) -> np.ndarray:
    return np.log1p(np.abs(spectrum(ch)))


def detect_peaks(
    ch: np.ndarray,
    n_peaks: int = 16,
    min_dist_frac: float = 0.012,
    dc_exclude_frac: float = 0.02,
    thresh_rel: float = 0.25,
) -> list[dict]:
    """贪心检测频谱峰。每取一个峰,同时屏蔽它和它的共轭邻域。

    返回列表,每项: fy, fx (cycles/pixel), angle_deg (波矢方向, 即条纹法向),
    period_px (条纹间距), mag (相对强度 0~1)。
    """
    h, w = ch.shape
    mag = np.abs(spectrum(ch))
    cy, cx = h // 2, w // 2
    work = mag.copy()

    yy, xx = np.mgrid[0:h, 0:w]
    fy_grid = (yy - cy) / h
    fx_grid = (xx - cx) / w
    r = np.hypot(fy_grid, fx_grid)
    work[r < dc_exclude_frac] = 0.0  # 排除直流/缓变背景

    peak_mag_ref = work.max() if work.max() > 0 else 1.0
    peaks: list[dict] = []
    for _ in range(n_peaks):
        idx = int(np.argmax(work))
        m = float(work.flat[idx])
        if m < thresh_rel * peak_mag_ref or m <= 0:
            break
        py, px = np.unravel_index(idx, work.shape)
        fy, fx = (py - cy) / h, (px - cx) / w
        freq = float(np.hypot(fy, fx))
        peaks.append(dict(
            fy=fy, fx=fx,
            angle_deg=float(np.degrees(np.arctan2(fy, fx))),
            period_px=1.0 / freq if freq > 0 else float("inf"),
            mag=m / peak_mag_ref,
        ))
        # 屏蔽该峰及其共轭的邻域
        for sy, sx in ((fy, fx), (-fy, -fx)):
            d = np.hypot(_wrap(fy_grid - sy, 1.0), _wrap(fx_grid - sx, 1.0))
            work[d < min_dist_frac] = 0.0
    return peaks


def _wrap(d: np.ndarray, period: float) -> np.ndarray:
    """周期边界距离(频谱在 Nyquist 处回绕)。"""
    return np.minimum(np.abs(d), period - np.abs(d))


# ---------------------------------------------------------------- 陷波滤波

def build_notch_mask(
    shape: tuple[int, int],
    peaks: list[dict],
    radius_frac: float = 0.008,
    depth: float = 1.0,
) -> np.ndarray:
    """对每个峰及其共轭生成高斯陷波,返回乘性掩膜(1=保留, 0=完全压掉)。"""
    h, w = shape
    cy, cx = h // 2, w // 2
    yy, xx = np.mgrid[0:h, 0:w]
    fy_grid = (yy - cy) / h
    fx_grid = (xx - cx) / w
    mask = np.ones(shape, dtype=np.float32)
    for p in peaks:
        for sy, sx in ((p["fy"], p["fx"]), (-p["fy"], -p["fx"])):
            d2 = _wrap(fy_grid - sy, 1.0) ** 2 + _wrap(fx_grid - sx, 1.0) ** 2
            mask *= 1.0 - depth * np.exp(-d2 / (2.0 * radius_frac ** 2))
    return mask


def _filter_channel(ch: np.ndarray, mask: np.ndarray) -> np.ndarray:
    res, plane = detrend(ch)
    F = np.fft.fftshift(np.fft.fft2(res))
    out = np.real(np.fft.ifft2(np.fft.ifftshift(F * mask)))
    return (out + plane).astype(np.float32)


def _feather_alpha(shape: tuple[int, int], feather: int) -> np.ndarray:
    """边缘余弦渐变的混合权重,局部处理时避免边界出现明显的框。"""
    h, w = shape
    ay = np.ones(h, dtype=np.float32)
    ax = np.ones(w, dtype=np.float32)
    f = max(1, min(feather, h // 2, w // 2))
    t = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, f))
    ay[:f] = t; ay[-f:] = t[::-1]
    ax[:f] = t; ax[-f:] = t[::-1]
    return ay[:, None] * ax[None, :]


def suppress(
    img: np.ndarray,
    peaks: list[dict],
    radius_frac: float = 0.008,
    depth: float = 1.0,
    region: tuple[int, int, int, int] | None = None,
    feather: int = 32,
) -> np.ndarray:
    """对灰度(H,W)或彩色(H,W,3)图像做陷波抑制。

    region=(y0,x0,y1,x1) 时只处理该区域,边缘用余弦渐变混合,不产生硬边界。
    不填充、不加黑边,任意尺寸(含奇数)直接 FFT。
    """
    img = to_float(img)
    if region is not None:
        y0, x0, y1, x1 = [int(v) for v in region]
        y0, x0 = max(0, y0), max(0, x0)
        y1, x1 = min(img.shape[0], y1), min(img.shape[1], x1)
        if y1 - y0 < 8 or x1 - x0 < 8:
            return img
        out = img.copy()
        sub = img[y0:y1, x0:x1]
        mask = build_notch_mask(sub.shape[:2], peaks, radius_frac, depth)
        alpha = _feather_alpha(sub.shape[:2], feather)
        if sub.ndim == 2:
            filt = _filter_channel(sub, mask)
            out[y0:y1, x0:x1] = sub * (1 - alpha) + filt * alpha
        else:
            alpha3 = alpha[..., None]
            filt = np.stack([_filter_channel(sub[..., c], mask) for c in range(sub.shape[2])], axis=-1)
            out[y0:y1, x0:x1] = sub * (1 - alpha3) + filt * alpha3
        return out

    mask = build_notch_mask(img.shape[:2], peaks, radius_frac, depth)
    if img.ndim == 2:
        return _filter_channel(img, mask)
    return np.stack([_filter_channel(img[..., c], mask) for c in range(img.shape[2])], axis=-1)


# ---------------------------------------------------------------- 参考区域估计

def estimate_peaks_from_region(
    img: np.ndarray,
    rect: tuple[int, int, int, int],
    n_peaks: int = 8,
    thresh_rel: float = 0.2,
) -> list[dict]:
    """圈出一块参考区域(尽量只含干扰),从中检测周期峰。

    返回的峰用分数频率表示,可直接用于整图或局部抑制。
    """
    img = to_float(img)
    y0, x0, y1, x1 = [int(v) for v in rect]
    sub = img[y0:y1, x0:x1]
    if sub.ndim == 3:
        sub = sub.mean(axis=2)
    return detect_peaks(sub, n_peaks=n_peaks, thresh_rel=thresh_rel)
