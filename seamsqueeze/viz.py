"""可视化辅助：蒙版高亮、拟抽缝叠加、缩减位置说明图、对照拼图。

所有绘制都在图像副本上进行，绝不修改引擎帧或源图。
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw, ImageFont

_PROTECT_COLOR = (255, 64, 64)
_SHRINK_COLOR = (64, 160, 255)
_SEAM_COLOR = (255, 215, 0)
_REMOVED_COLOR = (255, 90, 90)


def _font(size: int = 15) -> ImageFont.ImageFont:
    # 中文字形回退链：macOS 优先 PingFang / Hiragino，找不到再退回 Arial。
    candidates = (
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    )
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_masks(
    image: np.ndarray,
    protect: np.ndarray,
    shrink: np.ndarray,
    alpha: int = 70,
) -> np.ndarray:
    """在当前帧上叠加保护（红）/ 优先缩减（蓝）蒙版。"""
    base = Image.fromarray(image).convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.bitmap((0, 0), Image.fromarray((protect * 255).astype(np.uint8)),
              fill=_PROTECT_COLOR + (alpha,))
    od.bitmap((0, 0), Image.fromarray((shrink * 255).astype(np.uint8)),
              fill=_SHRINK_COLOR + (alpha,))
    return np.asarray(Image.alpha_composite(base, overlay).convert("RGB"))


def draw_seam(
    image: np.ndarray,
    path: list[tuple[int, int]],
    protect: np.ndarray | None = None,
) -> np.ndarray:
    """高亮拟抽走的缝；与保护像素相交的点用红色警示。"""
    pil = Image.fromarray(image).convert("RGB")
    draw = ImageDraw.Draw(pil)
    for y, x in path:
        draw.point((x, y), fill=_SEAM_COLOR)
        # 加粗为 3px 十字，确保缩图上仍可见。
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            px, py = x + dx, y + dy
            if 0 <= px < pil.width and 0 <= py < pil.height:
                draw.point((px, py), fill=_SEAM_COLOR)
    if protect is not None:
        for y, x in path:
            if protect[y, x]:
                draw.ellipse([x - 3, y - 3, x + 3, y + 3],
                             outline=(255, 0, 0), width=2)
    return np.asarray(pil)


def draw_removed_on_source(
    source: np.ndarray,
    removed_pixels: list[tuple[int, int]],
) -> np.ndarray:
    """在源图上标出所有被缩减掉的像素位置（红色）。"""
    pil = Image.fromarray(source).convert("RGB")
    draw = ImageDraw.Draw(pil)
    for y, x in removed_pixels:
        draw.point((x, y), fill=_REMOVED_COLOR)
        draw.point((x + 1, y), fill=_REMOVED_COLOR)
        draw.point((x - 1, y), fill=_REMOVED_COLOR)
    return np.asarray(pil)


def contact_sheet(
    panels: list[tuple[str, np.ndarray]],
    pad: int = 12,
    label_h: int = 30,
) -> np.ndarray:
    """把多张（标题, 图）横向拼成一张对照图，标题写在每格上方。"""
    if not panels:
        raise ValueError("至少需要一个面板")
    height = max(img.shape[0] for _, img in panels)
    font = _font(16)
    rendered = []
    for title, img in panels:
        pil = Image.fromarray(img).convert("RGB")
        canvas = Image.new(
            "RGB", (pil.width, height + label_h + pad), (255, 255, 255)
        )
        d = ImageDraw.Draw(canvas)
        d.text((6, 6), title, fill=(20, 20, 20), font=font)
        canvas.paste(pil, (0, label_h))
        rendered.append(canvas)

    total_w = sum(c.width for c in rendered) + pad * (len(rendered) + 1)
    total_h = max(c.height for c in rendered) + pad * 2
    sheet = Image.new("RGB", (total_w, total_h), (232, 232, 232))
    x = pad
    for c in rendered:
        sheet.paste(c, (x, pad))
        x += c.width + pad
    return np.asarray(sheet)
