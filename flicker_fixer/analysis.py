"""亮度分析与突变/镜头切换检测。

核心概念：
- luminance: 每帧整体亮度（Rec.709 加权均值，0-255）
- scene cut: 相邻帧内容差异巨大（低分辨率灰度平均绝对差超过阈值），
  视为镜头切换，不参与闪烁判定，稳定处理时也会在此处断开平滑。
- spike: 某帧亮度相对前后邻帧的局部趋势偏离超过阈值，且两侧都不是
  镜头切换，视为亮度突变（闪烁）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from PIL import Image

LUMA_WEIGHTS = (0.2126, 0.7152, 0.0722)
SIGNATURE_SIZE = (64, 36)  # 用于内容差异比较的低分辨率签名


def frame_luminance(img: Image.Image) -> float:
    """整帧加权平均亮度（忽略 alpha，按 RGB 计算）。"""
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    r, g, b = LUMA_WEIGHTS
    return float((a[..., 0] * r + a[..., 1] * g + a[..., 2] * b).mean())


def frame_signature(img: Image.Image) -> np.ndarray:
    """低分辨率灰度签名，用于相邻帧内容差异比较。"""
    g = img.convert("L").resize(SIGNATURE_SIZE, Image.BILINEAR)
    return np.asarray(g, dtype=np.float32)


@dataclass
class AnalysisResult:
    luminance: list[float] = field(default_factory=list)
    cuts: list[bool] = field(default_factory=list)      # cuts[i]: i 与 i-1 之间是镜头切换
    cut_scores: list[float] = field(default_factory=list)  # 相邻帧内容差异（0-255）
    spikes: list[int] = field(default_factory=list)     # 亮度突变帧下标
    spike_dev: list[float] = field(default_factory=list)  # 每帧相对局部趋势的偏离量


def detect_cuts(signatures: list[np.ndarray], cut_threshold: float) -> tuple[list[bool], list[float]]:
    n = len(signatures)
    cuts = [False] * n
    scores = [0.0] * n
    for i in range(1, n):
        mad = float(np.abs(signatures[i] - signatures[i - 1]).mean())
        scores[i] = mad
        if mad > cut_threshold:
            cuts[i] = True
    return cuts, scores


def detect_spikes(
    luminance: list[float],
    cuts: list[bool],
    spike_threshold: float,
    window: int = 4,
    iterations: int = 3,
) -> tuple[list[int], list[float]]:
    """亮度相对同镜头内 ±window 邻域中值的偏离超过阈值即为突变。

    用中值而不是前后两帧均值，并做迭代细化：每轮把已判出的突变帧从
    邻域中剔除再重算，这样连续两三帧的闪烁不会互相抬高基准而误伤
    中间的正常帧；缓慢渐变在局部窗口内近似对称，中值≈当前值，不会误报。
    """
    n = len(luminance)
    excluded: set[int] = set()
    dev = [0.0] * n
    spikes: list[int] = []
    for _ in range(iterations):
        new_dev = [0.0] * n
        new_spikes: list[int] = []
        for i in range(n):
            neighbors = []
            for j in range(max(0, i - window), min(n, i + window + 1)):
                if j == i or j in excluded:
                    continue
                # j 与 i 之间不能隔着镜头切换
                lo, hi = (j, i) if j < i else (i, j)
                if any(cuts[lo + 1 : hi + 1]):
                    continue
                neighbors.append(luminance[j])
            if not neighbors:
                continue
            neighbors.sort()
            m = len(neighbors)
            median = neighbors[m // 2] if m % 2 else (neighbors[m // 2 - 1] + neighbors[m // 2]) / 2
            new_dev[i] = luminance[i] - median
            if abs(new_dev[i]) > spike_threshold:
                new_spikes.append(i)
        dev = new_dev
        if sorted(new_spikes) == sorted(spikes):
            break
        spikes = new_spikes
        excluded = set(spikes)
    return spikes, dev


def analyze(images: list[Image.Image], spike_threshold: float = 6.0, cut_threshold: float = 25.0) -> AnalysisResult:
    result = AnalysisResult()
    result.luminance = [frame_luminance(im) for im in images]
    signatures = [frame_signature(im) for im in images]
    result.cuts, result.cut_scores = detect_cuts(signatures, cut_threshold)
    result.spikes, result.spike_dev = detect_spikes(result.luminance, result.cuts, spike_threshold)
    return result
