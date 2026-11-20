"""亮度稳定处理。

思路：在用户选定的范围 [lo, hi] 内，按镜头切换把范围切成若干段，
对每段的亮度曲线做滑动平均得到目标亮度，再按
    gain[i] = 1 + (target[i] / actual[i] - 1) * strength
得到每帧增益。strength=0 不处理，strength=1 完全贴合平滑曲线；
中间的强度只做"适度"稳定，保留原有的缓慢渐变趋势的一部分。
"""

from __future__ import annotations

import numpy as np
from PIL import Image


def moving_average(values: list[float], window: int) -> list[float]:
    """边缘反射填充的滑动平均，window 自动取奇数且不超过序列长度。"""
    n = len(values)
    if n == 0:
        return []
    window = max(1, int(window))
    if window % 2 == 0:
        window += 1
    window = min(window, n if n % 2 == 1 else n - 1)
    if window <= 1:
        return list(values)
    pad = window // 2
    arr = np.asarray(values, dtype=np.float64)
    padded = np.pad(arr, pad, mode="reflect")
    kernel = np.ones(window, dtype=np.float64) / window
    smoothed = np.convolve(padded, kernel, mode="valid")
    return smoothed.tolist()


def compute_gains(
    luminance: list[float],
    cuts: list[bool],
    lo: int,
    hi: int,
    window: int = 9,
    strength: float = 1.0,
) -> list[float]:
    """返回整序列每帧增益，范围外恒为 1.0。镜头切换处断开分段平滑。"""
    n = len(luminance)
    gains = [1.0] * n
    lo = max(0, lo)
    hi = min(n - 1, hi)
    if lo > hi:
        return gains

    # 按切镜把 [lo, hi] 切成若干段
    segments: list[tuple[int, int]] = []
    seg_start = lo
    for i in range(lo + 1, hi + 1):
        if cuts[i]:
            segments.append((seg_start, i - 1))
            seg_start = i
    segments.append((seg_start, hi))

    strength = min(1.0, max(0.0, strength))
    for a, b in segments:
        seg_lum = luminance[a : b + 1]
        target = moving_average(seg_lum, window)
        for k, i in enumerate(range(a, b + 1)):
            actual = seg_lum[k]
            if actual < 1e-3:  # 接近全黑的帧不做增益，避免放大噪声
                continue
            full_gain = target[k] / actual
            gains[i] = 1.0 + (full_gain - 1.0) * strength
    return gains


def apply_gain(img: Image.Image, gain: float) -> Image.Image:
    """对 RGB 通道乘以增益，保留 alpha 与原始模式。"""
    if abs(gain - 1.0) < 1e-6:
        return img.copy()
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    rgba = img.convert("RGBA") if has_alpha else None
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32) * gain
    rgb_img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")
    if rgba is not None:
        rgb_img.putalpha(rgba.getchannel("A"))
        return rgb_img
    return rgb_img
