"""逐源清晰度（focus measure）。

经典做法：拉普拉斯响应的局部方差（variance of Laplacian）。
对一张对齐后的灰度图 I：
    L = Laplacian(I)
    score(x,y) = 窗口内 Var(L)
窗口均值用 cv2.boxFilter（滑动求和，等价于积分图，O(n) 复杂度）。

纯色/低纹理区域 L 处处接近 0，所有源的 score 都很小且接近，
selection 模块靠“固定顺序的平局规则 + 空间平滑”保证这些区域选取稳定。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class SharpnessConfig:
    window: int = 21            # 局部窗口边长（奇数）
    laplacian_ksize: int = 3
    smooth_sigma: float = 2.0   # 对 score 图再做一次高斯平滑，抑制椒盐式跳变
    eps: float = 1e-6


def _gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 3:
        return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return image


def laplacian_variance_map(image: np.ndarray,
                           cfg: SharpnessConfig | None = None) -> np.ndarray:
    """单张图的逐像素清晰度图，float32，值越大越清晰。"""
    cfg = cfg or SharpnessConfig()
    gray = _gray(image).astype(np.float32)
    lap = cv2.Laplacian(gray, cv2.CV_32F, ksize=cfg.laplacian_ksize)
    k = cfg.window
    mean = cv2.boxFilter(lap, cv2.CV_32F, (k, k), normalize=True,
                         borderType=cv2.BORDER_REPLICATE)
    mean_sq = cv2.boxFilter(lap * lap, cv2.CV_32F, (k, k), normalize=True,
                            borderType=cv2.BORDER_REPLICATE)
    var = cv2.max(mean_sq - mean * mean, 0.0)
    if cfg.smooth_sigma > 0:
        var = cv2.GaussianBlur(var, (0, 0), cfg.smooth_sigma)
    return var.astype(np.float32)


def sharpness_maps(aligned_images: list[np.ndarray],
                   cfg: SharpnessConfig | None = None) -> np.ndarray:
    """返回 (N, H, W) 的清晰度栈，顺序与输入一致。"""
    maps = [laplacian_variance_map(img, cfg) for img in aligned_images]
    return np.stack(maps, axis=0)


def margin_map(scores: np.ndarray) -> np.ndarray:
    """最佳与次佳清晰度的差值（H,W），用于判断选取的可信程度。"""
    s = np.sort(scores, axis=0)
    return (s[-1] - s[-2]).astype(np.float32)


def relative_scores(scores: np.ndarray) -> np.ndarray:
    """把每个像素处各源的清晰度归一化到 [0,1]，供点击查看差异。

    返回 (N,H,W)：(score - min) / (max - min)；全相等时为 0。
    """
    smax = scores.max(axis=0, keepdims=True)
    smin = scores.min(axis=0, keepdims=True)
    span = np.maximum(smax - smin, 1e-12)
    return ((scores - smin) / span).astype(np.float32)
