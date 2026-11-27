"""渲染: 二值 mask、差异图、编号标注、约束/违规定位, 全部走 Pillow。"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# 差异叠加配色
COLOR_CLEARED = (255, 80, 80)     # 墨迹被清掉 -> 红
COLOR_FILLED = (60, 140, 255)     # 白纸被填上 -> 蓝
COLOR_NOMERGE = (255, 165, 0)     # 禁并锚点 -> 橙
COLOR_HOLE_KEEP = (0, 180, 90)    # 保留孔框 -> 绿
COLOR_VIOLATION = (255, 0, 255)   # 违规高亮 -> 品红


def load_gray(path: str) -> np.ndarray:
    """读图转 uint8 灰度。"""
    img = Image.open(path).convert("L")
    return np.asarray(img, dtype=np.uint8)


def mask_to_image(mask: np.ndarray) -> Image.Image:
    """bool mask -> 黑白 PIL 图 (墨迹黑, 纸张白)。"""
    arr = np.where(mask, 0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="L").convert("RGB")


def gray_to_image(gray: np.ndarray) -> Image.Image:
    return Image.fromarray(gray.astype(np.uint8), mode="L").convert("RGB")


def render_diff(base_mask: np.ndarray, new_mask: np.ndarray) -> Image.Image:
    """原图与结果的变化像素叠加图:
    黑=保留墨迹, 白=保持纸张, 红=被清掉的墨迹, 蓝=新填的墨迹。"""
    img = mask_to_image(new_mask)
    cleared = base_mask & ~new_mask
    filled = new_mask & ~base_mask
    arr = np.asarray(img).copy()
    arr[cleared] = COLOR_CLEARED
    arr[filled] = COLOR_FILLED
    return Image.fromarray(arr)


def render_triple(gray: np.ndarray, base_mask: np.ndarray,
                  new_mask: np.ndarray) -> Image.Image:
    """原图 | 处理结果 | 变化像素, 横向三联图。"""
    a = gray_to_image(gray)
    b = mask_to_image(new_mask)
    c = render_diff(base_mask, new_mask)
    gap = 8
    w = a.width * 3 + gap * 2
    h = a.height
    canvas = Image.new("RGB", (w, h), (200, 200, 200))
    canvas.paste(a, (0, 0))
    canvas.paste(b, (a.width + gap, 0))
    canvas.paste(c, (a.width * 2 + gap * 2, 0))
    d = ImageDraw.Draw(canvas)
    for i, title in enumerate(("原图", "处理结果", "变化像素(红清/蓝填)")):
        x = i * (a.width + gap) + 4
        d.rectangle([x, 2, x + 150, 16], fill=(255, 255, 255))
        d.text((x + 2, 3), title, fill=(0, 0, 0))
    return canvas


def _font(size: int = 13) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    # macOS 中文字体优先, 回退到常见 Linux 字体和 PIL 内置字体
    for name in (
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "Arial.ttf",
        "DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_labels(mask: np.ndarray, labels: np.ndarray, n: int,
                  stats: list[dict], hole_labels: np.ndarray | None = None,
                  hole_stats: list[dict] | None = None) -> Image.Image:
    """在黑白图上给每个连通块标编号(前景块红色编号, 孔洞蓝色 Hn)。

    前景编号画在质心; 孔洞编号画在孔内左上角并带白底色块,
    避免与可能落在同一区域的前景标注互相遮挡。
    """
    img = mask_to_image(mask)
    draw = ImageDraw.Draw(img)
    font = _font(13)
    for st in stats[1:]:
        cy, cx = st["centroid"]
        _outlined_text(draw, (cx, cy), str(st["label"]), font,
                       fill=(220, 0, 0))
    if hole_labels is not None and hole_stats:
        for st in hole_stats[1:]:
            cy, cx = st["centroid"]
            text = f"H{st['hole']}"
            bbox = draw.textbbox((0, 0), text, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            # 孔内左上角(相对质心偏移), 垫白底保证蓝字可读
            x = max(2, int(cx - tw / 2 - 6))
            y = max(2, int(cy - th / 2 - 6))
            draw.rectangle([x - 2, y - 2, x + tw + 2, y + th + 2],
                           fill=(255, 255, 255))
            draw.text((x, y), text, font=font, fill=(0, 70, 220))
    return img


def _outlined_text(draw: ImageDraw.ImageDraw, pos, text, font, fill) -> None:
    x, y = pos
    try:
        bbox = draw.textbbox((x, y), text, font=font)
        tx = (bbox[0] + bbox[2]) / 2
        ty = (bbox[1] + bbox[3]) / 2
        x -= tx - x
        y -= ty - y
    except AttributeError:  # pragma: no cover
        pass
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        draw.text((x + dx, y + dy), text, font=font, fill=(255, 255, 255))
    draw.text((x, y), text, font=font, fill=fill)


def render_constraints(img: Image.Image, constraints, violations=None) -> Image.Image:
    """把约束和违规位置画到图上。"""
    img = img.copy()
    draw = ImageDraw.Draw(img)
    violations = violations or []
    violated_ids = {id(v.constraint) for v in violations}

    for c in constraints:
        if getattr(c, "kind", "") == "no_merge":
            for anchor in (c.anchor_a, c.anchor_b):
                y, x = anchor
                r = 5
                color = COLOR_VIOLATION if id(c) in violated_ids else COLOR_NOMERGE
                draw.ellipse([x - r, y - r, x + r, y + r], outline=color, width=2)
            ya, xa = c.anchor_a
            yb, xb = c.anchor_b
            draw.line([(xa, ya), (xb, yb)], fill=COLOR_NOMERGE, width=1)
        elif getattr(c, "kind", "") == "preserve_hole":
            y0, x0, y1, x1 = c.rect
            color = COLOR_VIOLATION if id(c) in violated_ids else COLOR_HOLE_KEEP
            draw.rectangle([x0, y0, x1, y1], outline=color, width=2)

    for v in violations:
        for y, x in v.locations[:200]:
            draw.point((x, y), fill=COLOR_VIOLATION)
            r = 2
            draw.ellipse([x - r, y - r, x + r, y + r],
                         outline=COLOR_VIOLATION)
    return img


def save_image(img: Image.Image, path: str) -> None:
    img.save(path)
