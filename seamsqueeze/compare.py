"""同尺寸对照：seam carving vs 普通缩放 vs 直接裁边。

三种方法输出严格相同的 (target_w, target_h)，便于并排比较：

* ``seam``   本工具结果（保护物件不被穿过，背景非均匀变形）；
* ``scale``  PIL 双线性等比 / 拉伸缩放，所有内容均匀压缩；
* ``crop``   直接裁边（居中裁剪），超出目标尺寸的两侧内容直接丢失。
"""

from __future__ import annotations

import numpy as np
from PIL import Image


def normal_scale(image: np.ndarray, target_w: int, target_h: int) -> np.ndarray:
    """普通缩放到精确目标尺寸（双线性）。"""
    pil = Image.fromarray(image)
    return np.asarray(pil.resize((target_w, target_h), Image.BILINEAR))


def center_crop(image: np.ndarray, target_w: int, target_h: int) -> np.ndarray:
    """居中直接裁边，输出精确目标尺寸。"""
    h, w = image.shape[:2]
    if target_w > w or target_h > h:
        raise ValueError("裁边只能得到不大于原图的尺寸")
    x0 = (w - target_w) // 2
    y0 = (h - target_h) // 2
    return np.asarray(
        Image.fromarray(image).crop((x0, y0, x0 + target_w, y0 + target_h))
    )


def build_comparison(
    source: np.ndarray,
    seam_result: np.ndarray,
    target_w: int,
    target_h: int,
) -> dict[str, np.ndarray]:
    """返回三张同尺寸结果图。"""
    return {
        "seam": np.asarray(seam_result),
        "scale": normal_scale(source, target_w, target_h),
        "crop": center_crop(source, target_w, target_h),
    }
