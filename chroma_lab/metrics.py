"""指标: 整体色偏、平均误差、边缘亚像素偏移。"""
from __future__ import annotations

import numpy as np


def compare(orig: np.ndarray, recon: np.ndarray) -> dict:
    """对比原图与还原图, 返回一组标量指标。"""
    diff = recon - orig
    return {
        "mae": float(np.abs(diff).mean()),
        "max_err": float(np.abs(diff).max()),
        "bias_rgb": [float(v) for v in diff.mean(axis=(0, 1))],
        "shift_x": _estimate_shift(orig, recon, axis=0),
        "shift_y": _estimate_shift(orig, recon, axis=1),
    }


def _profile(img: np.ndarray, axis: int) -> np.ndarray:
    """红-蓝对立度投影: axis=0 得到列剖面 (用于水平偏移), axis=1 得到行剖面。"""
    opp = img[..., 0] - img[..., 2]
    p = opp.mean(axis=axis)
    return p - p.mean()


def _estimate_shift(orig: np.ndarray, recon: np.ndarray, axis: int) -> float:
    """梯度质心法估计还原图相对原图的亚像素偏移 (正值 = 沿轴正方向移动)。

    对 R-B 对立度剖面求梯度, 比较梯度质心位置。对阶跃边缘即边缘位置差。
    两端各裁掉 2 像素以排除边缘钳位伪影; 若还原后梯度能量不足原图的 10%
    (信号已被色度低通摧毁, 如细线图案), 偏移无从定义, 返回 nan。
    """
    po = _profile(orig, axis)
    pr = _profile(recon, axis)
    go = np.abs(np.diff(po))[2:-2]
    gr = np.abs(np.diff(pr))[2:-2]
    if go.sum() < 1e-9 or gr.sum() < 0.1 * go.sum():
        return float("nan")
    x = np.arange(go.size, dtype=float) + 2.5
    return float((gr * x).sum() / gr.sum() - (go * x).sum() / go.sum())
