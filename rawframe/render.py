"""把 RawFile 读出的平面渲染成 RGB 图像，支持裁剪、整数倍放大、缺数据标记。"""
from __future__ import annotations

import numpy as np

from .model import FrameParams
from .color import yuv_to_rgb


def _upsample_chroma(c: np.ndarray, w: int, h: int) -> np.ndarray:
    """最近邻上采样色度到亮度分辨率；奇数宽高时边缘采样只复制自身。"""
    cols = np.minimum(np.arange(w) // 2, c.shape[1] - 1)
    rows = np.minimum(np.arange(h) // 2, c.shape[0] - 1)
    return c[np.ix_(rows, cols)]


def _luma_mask(mask: np.ndarray, w: int, h: int) -> np.ndarray:
    cols = np.minimum(np.arange(w) // 2, mask.shape[1] - 1)
    rows = np.minimum(np.arange(h) // 2, mask.shape[0] - 1)
    return mask[np.ix_(rows, cols)]


def render_frame(params: FrameParams, planes: dict) -> np.ndarray:
    """平面字典 → HxWx3 uint8 RGB（全帧）。"""
    if params.fmt == "rgba":
        return planes["RGBA"][:, :, :3].copy()

    y = planes["Y"]
    h, w = y.shape
    if params.fmt == "i420":
        u, v = planes["U"], planes["V"]
    else:  # nv12
        u = planes["UV"][:, :, 0]
        v = planes["UV"][:, :, 1]
    u = _upsample_chroma(u, w, h)
    v = _upsample_chroma(v, w, h)
    return yuv_to_rgb(y, u, v, params.color_range)


def missing_mask(params: FrameParams, planes: dict) -> np.ndarray:
    """返回 HxW bool，True 表示该亮度像素的某个来源字节在文件中缺失。"""
    present = planes["_present"]
    h, w = planes["Y"].shape if params.fmt != "rgba" else planes["RGBA"].shape[:2]

    if params.fmt == "rgba":
        return ~present["RGBA"].any(axis=2)  # 四字节全缺才算缺
    if params.fmt == "i420":
        m = (~present["Y"]) | (~_luma_mask(present["U"], w, h)) | \
            (~_luma_mask(present["V"], w, h))
    else:
        m = (~present["Y"]) | (~_luma_mask(present["UV"].all(axis=2), w, h))
    return m


def crop_params(params: FrameParams, x0: int, y0: int, x1: int, y1: int) -> None:
    if not (0 <= x0 < x1 <= params.width and 0 <= y0 < y1 <= params.height):
        raise ValueError(
            f"裁剪区域 ({x0},{y0})-({x1},{y1}) 超出画面 {params.width}x{params.height}")


def render_crop(params: FrameParams, planes: dict,
                box: tuple[int, int, int, int] | None = None,
                zoom: int = 1) -> tuple[np.ndarray, np.ndarray, tuple[int, int]]:
    """渲染裁剪区域并整数倍放大。

    返回 (rgb H'xW'x3, missing H'xW' bool, (crop_w, crop_h))。
    """
    rgb = render_frame(params, planes)
    miss = missing_mask(params, planes)
    if box is None:
        box = (0, 0, params.width, params.height)
    x0, y0, x1, y1 = box
    crop_params(params, x0, y0, x1, y1)
    rgb = rgb[y0:y1, x0:x1]
    miss = miss[y0:y1, x0:x1]
    if zoom > 1:
        rgb = np.repeat(np.repeat(rgb, zoom, axis=0), zoom, axis=1)
        miss = np.repeat(np.repeat(miss, zoom, axis=0), zoom, axis=1)
    return rgb, miss, (x1 - x0, y1 - y0)


def overlay_missing(rgb: np.ndarray, miss: np.ndarray) -> np.ndarray:
    """缺数据像素覆盖青色色块（仅用于显示，不改变溯源数据）。"""
    out = rgb.copy()
    if miss.any():
        out[miss] = (0, 255, 255)
    return out


def mean_abs_diff(rgb_a: np.ndarray, rgb_b: np.ndarray) -> float:
    """两组解释下同一帧的平均绝对色差（0=完全一致）。"""
    if rgb_a.shape != rgb_b.shape:
        h = min(rgb_a.shape[0], rgb_b.shape[0])
        w = min(rgb_a.shape[1], rgb_b.shape[1])
        rgb_a, rgb_b = rgb_a[:h, :w], rgb_b[:h, :w]
    return float(np.abs(rgb_a.astype(int) - rgb_b.astype(int)).mean())


def to_ppm(rgb: np.ndarray) -> bytes:
    """编码为 PPM(P6)，供 tkinter PhotoImage 直接显示。"""
    h, w, _ = rgb.shape
    header = f"P6\n{w} {h}\n255\n".encode()
    return header + rgb.tobytes()
