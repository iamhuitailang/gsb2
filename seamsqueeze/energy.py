"""接缝能量与 8 连通最小代价路径（动态规划）。

能量 = Sobel 梯度幅值；保护区叠加巨额正罚，优先留白减去固定偏置，
这样接缝天然绕开完整物件、优先穿过留白。DP 全程使用有限大整数，
避免 ``inf`` 相加产生 ``NaN`` 的边界问题。
"""

from __future__ import annotations

import numpy as np

# 保护区单像素罚值。取 10**9 量级：任何包含保护像素的路径，
# 其代价都远高于纯自由路径（普通路径代价通常只有 10**4~10**6），
# 同时即使上千行累加也远不到 float64 上限。
PROTECT_PENALTY = 10**9
# 优先缩减留白的能量偏置（从基础能量中减去，保持为正）。
# 取较大值确保标记留白在累计路径代价上始终显著低于未标记背景。
SHRINK_BOOST = 1000.0


def base_energy(image: np.ndarray) -> np.ndarray:
    """Sobel 梯度幅值，float64，形状与 image 前两维相同。"""
    if image.dtype != np.float64:
        gray = image.astype(np.float64)
    else:
        gray = image.copy()
    if gray.ndim == 3:
        gray = gray.mean(axis=2)

    h, w = gray.shape
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    if w >= 2:
        gx[:, 1:-1] = gray[:, 2:] - gray[:, :-2]
        # 边界用前向 / 后向差分补上，避免边缘恒为低能量缝。
        gx[:, 0] = gray[:, 1] - gray[:, 0]
        gx[:, -1] = gray[:, -1] - gray[:, -2]
    if h >= 2:
        gy[1:-1, :] = gray[2:, :] - gray[:-2, :]
        gy[0, :] = gray[1, :] - gray[0, :]
        gy[-1, :] = gray[-1, :] - gray[-2, :]
    return np.hypot(gx, gy)


def seam_energy(
    image: np.ndarray,
    protect: np.ndarray,
    shrink: np.ndarray,
) -> np.ndarray:
    """当前帧上的逐像素代价（H, W）float64。"""
    energy = base_energy(image)
    energy -= SHRINK_BOOST * shrink.astype(np.float64)
    # 极端情况下基础能量可能被减成负数，抬回一个小正数保持单调性。
    np.maximum(energy, 1.0, out=energy)
    energy[protect] = PROTECT_PENALTY
    return energy


def vertical_seam(energy: np.ndarray) -> np.ndarray:
    """自顶向下的最小代价竖直缝，返回每行一列号，形状 (H,) int64。"""
    h, w = energy.shape
    if w < 2:
        return np.zeros(h, dtype=np.int64)

    cum = np.empty((h, w), dtype=np.float64)
    back = np.zeros((h, w), dtype=np.int64)
    cum[0] = energy[0]

    for r in range(1, h):
        prev = cum[r - 1]
        left = np.empty(w)
        right = np.empty(w)
        left[0] = np.inf
        left[1:] = prev[:-1]
        right[-1] = np.inf
        right[:-1] = prev[1:]
        choices = np.stack((left, prev, right), axis=0)
        back[r] = np.argmin(choices, axis=0) - 1  # -1 / 0 / +1
        cum[r] = choices[back[r] + 1, np.arange(w)] + energy[r]

    seam = np.empty(h, dtype=np.int64)
    seam[-1] = int(np.argmin(cum[-1]))
    for r in range(h - 1, 0, -1):
        seam[r - 1] = seam[r] + back[r, seam[r]]
    return seam


def horizontal_seam(energy: np.ndarray) -> np.ndarray:
    """最小代价水平缝，返回每列一行号，形状 (W,) int64。"""
    # 转置后竖直缝即等价于原图的水平缝；坐标也随之转回。
    return vertical_seam(energy.T)
