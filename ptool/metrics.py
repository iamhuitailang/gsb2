"""定量指标:周期强度变化、干扰下降、有用线条损失、颜色条纹检查。"""
from __future__ import annotations

import numpy as np

from .core import to_float, detrend


def _gray(img: np.ndarray) -> np.ndarray:
    img = to_float(img)
    return img if img.ndim == 2 else img.mean(axis=2)


def periodic_strength(img: np.ndarray, peaks: list[dict]) -> float:
    """指定峰位置(含共轭)的谱能量占非直流总能量的比例。"""
    ch = _gray(img)
    res, _ = detrend(ch)
    F = np.fft.fftshift(np.fft.fft2(res))
    power = np.abs(F) ** 2
    h, w = ch.shape
    cy, cx = h // 2, w // 2
    total = power.sum()
    total -= power[cy, cx]
    if total <= 0:
        return 0.0
    s = 0.0
    for p in peaks:
        for sy, sx in ((p["fy"], p["fx"]), (-p["fy"], -p["fx"])):
            # fftshift 后直流在 (cy, cx),峰索引要相对中心偏移
            iy = (cy + int(round(sy * h))) % h
            ix = (cx + int(round(sx * w))) % w
            # 3x3 邻域取能量,容忍取整误差
            ys = [(iy + d) % h for d in (-1, 0, 1)]
            xs = [(ix + d) % w for d in (-1, 0, 1)]
            s += power[np.ix_(ys, xs)].sum()
    return float(s / total)


def interference_residual(result: np.ndarray, clean: np.ndarray, interference: np.ndarray) -> float:
    """结果中残留的干扰投影系数:1.0=完全没去掉, 0.0=干扰全部去除。"""
    r = _gray(result) - _gray(clean)
    i = _gray(interference)
    denom = float((i ** 2).sum())
    if denom <= 0:
        return 0.0
    coef = float((r * i).sum()) / denom
    return coef


def signal_loss(result: np.ndarray, clean: np.ndarray, grid_mask: np.ndarray) -> float:
    """有用线条(格线)位置上的能量损失比例。"""
    r = _gray(result)
    c = _gray(clean)
    m = to_float(grid_mask) > 1e-6
    if m.sum() == 0:
        return 0.0
    lost = float(np.abs(r - c)[m].mean())
    strength = float(np.abs(c[m] - c[~m].mean()).mean())
    return lost / max(strength, 1e-9)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    a, b = _gray(a), _gray(b)
    mse = float(((a - b) ** 2).mean())
    return 99.0 if mse <= 1e-12 else float(10 * np.log10(1.0 / mse))


def color_fringe(result: np.ndarray, clean: np.ndarray) -> dict:
    """彩色图检查:残差在各通道间的差异(>0 说明引入了颜色条纹)。"""
    r, c = to_float(result), to_float(clean)
    if r.ndim != 3:
        return dict(max_channel_dev=0.0, mean_channel_dev=0.0)
    resid = r - c
    gray_resid = resid.mean(axis=2, keepdims=True)
    dev = np.abs(resid - gray_resid).max(axis=2)
    return dict(max_channel_dev=float(dev.max()), mean_channel_dev=float(dev.mean()))
