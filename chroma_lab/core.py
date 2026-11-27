"""核心管线: RGB <-> YCbCr, 4:2:0 色度抽样与还原.

关键概念
--------
压缩时把 Cb/Cr 压成 1/2 分辨率 (4:2:0)。每个色度样本覆盖一个 2x2 亮度块,
但"这个样本被认为位于块内哪个位置"有不同约定 (siting):
  center  : 块正中央 (JPEG / MPEG-1 风格), 偏移 (0.5, 0.5)
  left    : 水平靠左与亮度对齐、垂直居中 (MPEG-2 风格), 偏移 (0.0, 0.5)
  topleft : 完全与左上角亮度对齐, 偏移 (0.0, 0.0)

压缩端和还原端约定不一致时, 色度会整体错半格 —— 红边偏半格就是这么来的。
本模块把"颜色损失"(低通滤波丢失细节) 和"错位"(位置约定不一致) 分开建模:
  - 颜色损失: 压缩时以样本位置为中心的低通滤波 (盒式或三角), 约定一致即无系统偏移
  - 错位    : 还原时按不同位置插值, 由 down/up 约定之差决定
"""
from __future__ import annotations

import numpy as np

# 取样位置约定: 色度样本相对其 2x2 亮度块左上角的偏移 (dx, dy), 单位 = 亮度像素
SITINGS = {
    "center": (0.5, 0.5),
    "left": (0.0, 0.5),
    "topleft": (0.0, 0.0),
}

SITING_ORDER = ["center", "left", "topleft"]


def chroma_size(w: int, h: int) -> tuple[int, int]:
    """4:2:0 色度阵列尺寸。奇数宽高向上取整, 最后一行/列不丢。"""
    return (w + 1) // 2, (h + 1) // 2


def sample_positions(cw: int, ch: int, siting: str):
    """返回色度样本在亮度坐标系中的位置 (xs, ys)。样本 (i, j) 位于 (2i+dx, 2j+dy)。"""
    dx, dy = SITINGS[siting]
    return 2.0 * np.arange(cw) + dx, 2.0 * np.arange(ch) + dy


# ---------------------------------------------------------------- 色彩空间

def rgb_to_ycbcr(rgb: np.ndarray):
    """BT.601 全范围。rgb: (H, W, 3) float 0..255 -> (Y, Cb, Cr) 各 (H, W)。"""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = 128.0 + (b - y) * (0.5 / 0.886)
    cr = 128.0 + (r - y) * (0.5 / 0.702)
    return y, cb, cr


def ycbcr_to_rgb(y, cb, cr) -> np.ndarray:
    """BT.601 全范围反变换, 结果裁剪到 0..255。"""
    r = y + (cr - 128.0) * (0.702 / 0.5)
    b = y + (cb - 128.0) * (0.886 / 0.5)
    g = (y - 0.299 * r - 0.114 * b) / 0.587
    return np.clip(np.stack([r, g, b], axis=-1), 0.0, 255.0)


# ---------------------------------------------------------------- 抽样 / 还原

def _axis_downsample(a: np.ndarray, axis: int, offset: float) -> np.ndarray:
    """单轴 2:1 抽样。offset=0.5 用盒式 [0.5,0.5], offset=0.0 用以样本
    为中心的三角 [0.25,0.5,0.25] —— 两种滤波器都以各自约定的样本位置为中心,
    这样约定一致时还原不会引入系统性偏移。边缘按复制补齐, 奇数长度不丢。"""
    n = a.shape[axis]
    if offset == 0.5:
        pad = [(0, 0)] * a.ndim
        pad[axis] = (0, n & 1)
        a = np.pad(a, pad, mode="edge")
        even = np.take(a, range(0, a.shape[axis], 2), axis=axis)
        odd = np.take(a, range(1, a.shape[axis], 2), axis=axis)
        return 0.5 * (even + odd)
    pad = [(0, 0)] * a.ndim
    pad[axis] = (1, 1)
    ap = np.pad(a, pad, mode="edge")
    left = np.take(ap, range(0, n, 2), axis=axis)
    mid = np.take(ap, range(1, n + 1, 2), axis=axis)
    right = np.take(ap, range(2, n + 2, 2), axis=axis)
    return 0.25 * left + 0.5 * mid + 0.25 * right


def downsample420(plane: np.ndarray, siting: str = "center") -> np.ndarray:
    """按取样位置约定做 4:2:0 色度抽样 (可分离滤波 + 2:1 抽取)。

    奇数行/列按边缘复制补齐, 保证最后一行/列不丢。
    """
    dx, dy = SITINGS[siting]
    a = _axis_downsample(plane.astype(float), 1, dx)
    a = _axis_downsample(a, 0, dy)
    return a


def upsample420(small: np.ndarray, w: int, h: int, siting: str,
                method: str = "bilinear") -> np.ndarray:
    """按给定取样位置约定把色度阵列还原到 w x h。

    输出像素 (x, y) 在样本索引空间中的坐标为 ((x-dx)/2, (y-dy)/2),
    对该位置做双线性 (或最近邻) 插值, 边缘处钳位。约定不同 <=> 坐标系平移,
    这就是错半格的来源。
    """
    dx, dy = SITINGS[siting]
    ch, cw = small.shape
    xs = (np.arange(w, dtype=float) - dx) / 2.0
    ys = (np.arange(h, dtype=float) - dy) / 2.0
    if method == "nearest":
        xi = np.clip(np.round(xs).astype(int), 0, cw - 1)
        yi = np.clip(np.round(ys).astype(int), 0, ch - 1)
        return small[np.ix_(yi, xi)].astype(float)
    x0 = np.floor(xs).astype(int)
    tx = xs - x0
    y0 = np.floor(ys).astype(int)
    ty = ys - y0
    x0c = np.clip(x0, 0, cw - 1)
    x1c = np.clip(x0 + 1, 0, cw - 1)
    y0c = np.clip(y0, 0, ch - 1)
    y1c = np.clip(y0 + 1, 0, ch - 1)
    wa = (1 - ty)[:, None] * (1 - tx)[None, :]
    wb = (1 - ty)[:, None] * tx[None, :]
    wc = ty[:, None] * (1 - tx)[None, :]
    wd = ty[:, None] * tx[None, :]
    return (small[np.ix_(y0c, x0c)] * wa + small[np.ix_(y0c, x1c)] * wb
            + small[np.ix_(y1c, x0c)] * wc + small[np.ix_(y1c, x1c)] * wd)


def pixel_sources(x: int, y: int, siting: str, cw: int, ch: int,
                  method: str = "bilinear"):
    """输出像素 (x, y) 引用了哪些色度样本: 返回 [(ci, cj, weight), ...]。"""
    dx, dy = SITINGS[siting]
    sx, sy = (x - dx) / 2.0, (y - dy) / 2.0
    if method == "nearest":
        i = int(np.clip(round(sx), 0, cw - 1))
        j = int(np.clip(round(sy), 0, ch - 1))
        return [(i, j, 1.0)]
    i0, tx = int(np.floor(sx)), sx - np.floor(sx)
    j0, ty = int(np.floor(sy)), sy - np.floor(sy)
    weights: dict[tuple[int, int], float] = {}
    for ci, wx in ((i0, 1 - tx), (i0 + 1, tx)):
        for cj, wy in ((j0, 1 - ty), (j0 + 1, ty)):
            ci_c = min(max(ci, 0), cw - 1)
            cj_c = min(max(cj, 0), ch - 1)
            key = (ci_c, cj_c)
            weights[key] = weights.get(key, 0.0) + wx * wy
    return sorted((i, j, w) for (i, j), w in weights.items() if w > 1e-9)


# ---------------------------------------------------------------- 完整管线

def pipeline(rgb: np.ndarray, down_siting: str, up_siting: str,
             method: str = "bilinear") -> dict:
    """压缩 -> 还原整条链路。

    返回字典含:
      Y, Cb, Cr        亮度全分辨率阵列 + 两路 1/2 分辨率色度阵列
      Cb_up, Cr_up     按 up_siting 还原的全分辨率色度
      recon            最终还原图
      recon_matched    还原约定与压缩一致时的参考图 (只有颜色损失, 无错位)
    """
    h, w = rgb.shape[:2]
    y, cb, cr = rgb_to_ycbcr(rgb)
    cb_s = downsample420(cb, down_siting)
    cr_s = downsample420(cr, down_siting)
    cb_up = upsample420(cb_s, w, h, up_siting, method)
    cr_up = upsample420(cr_s, w, h, up_siting, method)
    recon = ycbcr_to_rgb(y, cb_up, cr_up)
    cb_ref = upsample420(cb_s, w, h, down_siting, method)
    cr_ref = upsample420(cr_s, w, h, down_siting, method)
    recon_matched = ycbcr_to_rgb(y, cb_ref, cr_ref)
    return {
        "Y": y, "Cb": cb_s, "Cr": cr_s,
        "Cb_up": cb_up, "Cr_up": cr_up,
        "recon": recon, "recon_matched": recon_matched,
    }
