"""两张几何演示图：稀疏图样与密集条纹，全部由 PIL 程序生成。

* 稀疏图样：大片留白 + 左右各一个完整物件 + 顶部坐标尺，
  用来证明接缝只吃留白、物件不被穿过；
* 密集条纹：满版细密竖条纹 + 左右保护圆，用来证明背景被
  非均匀挤压（条纹疏密变化、坐标尺弯曲）而保护区完好。

每张图同时返回推荐的 :class:`MaskSet`，便于一键复现实验。
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

from .masks import MaskSet, Rect

# 统一配色（RGB）
_BG = (245, 244, 238)
_INK = (38, 38, 38)
_GRID = (214, 210, 200)
_RULER = (120, 116, 108)
_RED = (200, 64, 52)
_BLUE = (46, 96, 178)
_GREEN = (58, 142, 92)
_ORANGE = (222, 144, 38)
_PURPLE = (126, 78, 178)

RULER_H = 26  # 顶部坐标尺高度


def _new_canvas(w: int, h: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (w, h), _BG)
    draw = ImageDraw.Draw(img)
    # 细网格，变形后能直观看出像素被挤压。
    for x in range(0, w, 40):
        draw.line([(x, RULER_H), (x, h)], fill=_GRID, width=1)
    for y in range(RULER_H, h, 40):
        draw.line([(0, y), (w, y)], fill=_GRID, width=1)
    # 顶部坐标尺：每 20px 一刻度，每 100px 标数字。
    draw.rectangle([0, 0, w, RULER_H], fill=(236, 233, 224))
    for x in range(0, w, 20):
        tick = 10 if x % 100 == 0 else 5
        draw.line([(x, RULER_H), (x, RULER_H - tick)], fill=_RULER, width=1)
    for x in range(0, w, 100):
        draw.text((x + 2, 2), str(x), fill=_RULER)
    draw.line([(0, RULER_H), (w, RULER_H)], fill=_RULER, width=1)
    return img, draw


def make_sparse(w: int = 720, h: int = 300) -> tuple[np.ndarray, MaskSet]:
    """稀疏图样：左右两个物件夹着大片留白。"""
    img, draw = _new_canvas(w, h)
    mid_y0, mid_y1 = RULER_H + 30, h - 30

    # 左侧「物件」：红底圆 + 深色描边，外接矩形将被圈为保护区。
    lc = (90, (RULER_H + h) // 2)
    r = 62
    draw.ellipse([lc[0] - r, lc[1] - r, lc[0] + r, lc[1] + r],
                 fill=_RED, outline=_INK, width=3)
    draw.ellipse([lc[0] - 18, lc[1] - 18, lc[0] + 18, lc[1] + 18],
                 fill=_BG, outline=_INK, width=2)
    left_box = Rect(lc[0] - r - 4, lc[1] - r - 4,
                    lc[0] + r + 4, lc[1] + r + 4, name="左圆")

    # 右侧「物件」：蓝色圆角方 + 内部分块，同样整体保护。
    rc_x = w - 90
    s = 120
    x0, y0 = rc_x - s // 2, (RULER_H + h) // 2 - s // 2
    draw.rounded_rectangle([x0, y0, x0 + s, y0 + s], radius=16,
                           fill=_BLUE, outline=_INK, width=3)
    draw.line([(x0, y0 + s // 2), (x0 + s, y0 + s // 2)], fill=_INK, width=2)
    draw.line([(x0 + s // 2, y0), (x0 + s // 2, y0 + s // 2)], fill=_INK, width=2)
    right_box = Rect(x0 - 4, y0 - 4, x0 + s + 4, y0 + s + 4, name="右方块")

    # 中部留白里放两个「可牺牲」的小标记，并把留白圈成优先缩减区。
    for fx in (w // 2 - 90, w // 2 + 90):
        draw.polygon(
            [(fx, mid_y0 + 10), (fx + 12, mid_y0 + 34),
             (fx - 12, mid_y0 + 34)], fill=_ORANGE, outline=_INK
        )
    shrink = Rect(w // 2 - 170, RULER_H + 6, w // 2 + 170, h - 6,
                  name="中部留白")

    masks = MaskSet(protect=[left_box, right_box], shrink=[shrink])
    return np.asarray(img), masks


def make_dense(w: int = 720, h: int = 300) -> tuple[np.ndarray, MaskSet]:
    """密集条纹：满版细竖条纹 + 左右两个保护圆。"""
    img, draw = _new_canvas(w, h)
    palette = [_RED, _ORANGE, _GREEN, _BLUE, _PURPLE]
    stripe = 8
    # 在网格之上铺满条纹（跳过坐标尺）。
    for i, x in enumerate(range(0, w, stripe)):
        color = palette[i % len(palette)]
        draw.rectangle([x, RULER_H, min(x + stripe - 1, w - 1), h - 1],
                       fill=color)
    # 条纹上再叠一层细暗线，让疏密变化更明显。
    for x in range(0, w, stripe):
        draw.line([(x, RULER_H), (x, h)], fill=(20, 20, 20), width=1)

    cy = (RULER_H + h) // 2
    r = 52
    circles = []
    for cx, fill in ((95, _GREEN), (w - 95, _ORANGE)):
        draw.ellipse([cx - r, cy - r, cx + r, cy + r],
                     fill=fill, outline=_INK, width=3)
        draw.ellipse([cx - 16, cy - 16, cx + 16, cy + 16],
                     fill=(255, 255, 255), outline=_INK, width=2)
        circles.append(Rect(cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3,
                            name="保护圆"))

    # 中部条纹区允许优先缩减（没有任何完整物件）。
    shrink = Rect(190, RULER_H + 2, w - 190, h - 2, name="中部条纹")
    masks = MaskSet(protect=circles, shrink=[shrink])
    return np.asarray(img), masks


def build_demo_images(
    out_dir: str,
    w: int = 720,
    h: int = 300,
) -> dict[str, str]:
    """生成两张演示图并保存为 PNG，返回路径字典。"""
    import os

    os.makedirs(out_dir, exist_ok=True)
    paths: dict[str, str] = {}
    for name, builder in (("sparse", make_sparse), ("dense", make_dense)):
        arr, _ = builder(w, h)
        path = os.path.join(out_dir, f"{name}.png")
        Image.fromarray(arr).save(path)
        paths[name] = path
    return paths
