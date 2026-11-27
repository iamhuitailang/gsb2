"""程序生成的测试图: 专门暴露 4:2:0 色度抽样的问题。"""
from __future__ import annotations

import numpy as np


def vlines(w: int = 64, h: int = 48) -> np.ndarray:
    """1 像素宽红/蓝竖线交替 —— 4:2:0 水平方向最苛刻的输入。"""
    img = np.full((h, w, 3), 128.0)
    img[:, 0::2] = (255, 0, 0)
    img[:, 1::2] = (0, 0, 255)
    return img


def hlines(w: int = 64, h: int = 48) -> np.ndarray:
    """1 像素宽红/蓝横线交替 —— 考验垂直方向。"""
    img = np.full((h, w, 3), 128.0)
    img[0::2] = (255, 0, 0)
    img[1::2] = (0, 0, 255)
    return img


def diagonal(w: int = 64, h: int = 48) -> np.ndarray:
    """锐利斜边: 左下红、右上蓝, 边界斜率非整数, 用来放大看边缘偏移。"""
    yy, xx = np.mgrid[0:h, 0:w]
    mask = (xx - 1.7 * yy) < (w / 3.0)
    img = np.empty((h, w, 3))
    img[mask] = (255, 0, 0)
    img[~mask] = (0, 0, 255)
    return img


def equal_luma_boundary(w: int = 64, h: int = 48) -> np.ndarray:
    """同亮度红|蓝竖直交界: 亮度完全平坦, 差异全在色度里。

    (97,0,0) 与 (0,0,255) 的 BT.601 亮度都约等于 29,
    任何还原误差都纯粹来自色度通道, 方便把颜色损失和错位分开看。
    """
    img = np.empty((h, w, 3))
    img[:, : w // 2] = (97, 0, 0)
    img[:, w // 2:] = (0, 0, 255)
    return img


def demo(w: int = 127, h: int = 95) -> np.ndarray:
    """四象限演示图 (默认奇数尺寸 127x95): 竖线 / 横线 / 斜边 / 同亮度交界。"""
    img = np.full((h, w, 3), 128.0)
    hw, hh = w // 2, h // 2
    q = vlines(hw, hh)
    img[:hh, :hw] = q
    q = hlines(w - hw, hh)
    img[:hh, hw:] = q
    q = diagonal(hw, h - hh)
    img[hh:, :hw] = q
    q = equal_luma_boundary(w - hw, h - hh)
    img[hh:, hw:] = q
    return img


def make_set() -> dict[str, np.ndarray]:
    """批量对比用的整套测试图, 每种图案出偶数和奇数尺寸各一份。"""
    patterns = {
        "vlines": vlines,
        "diagonal": diagonal,
        "equal_luma": equal_luma_boundary,
    }
    out = {}
    for name, fn in patterns.items():
        out[f"{name}_64x48"] = fn(64, 48)
        out[f"{name}_63x47"] = fn(63, 47)  # 奇数宽高: 检查最后一行/列
    return out


def load_or_default(path: str | None) -> np.ndarray:
    """有路径就读图 (转 RGB float), 否则用内置演示图。"""
    if path is None:
        return demo()
    from PIL import Image

    with Image.open(path) as im:
        return np.asarray(im.convert("RGB"), dtype=float)
