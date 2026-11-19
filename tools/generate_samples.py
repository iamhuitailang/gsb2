#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_samples.py — 生成示例精灵 PNG 到 public/samples/

与 public/js/samples.js 中内置的 Canvas 样例一一对应（文件名、尺寸、
透明边距、重名结构一致），用于：
  1. 通过「导入 PNG」走真实文件管线演示；
  2. 验证工具对不同长宽比、透明边距、重名素材的处理。

运行：npm run generate:samples   （或 python3 tools/generate_samples.py）
依赖：Pillow（pip install pillow）。完全离线运行，不访问网络。
"""

import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.stderr.write(
        "缺少 Pillow，请先安装：pip install pillow\n"
        "（应用本身不依赖 Pillow；仅生成示例 PNG 时需要。\n"
        " 也可以直接在网页里点「载入内置示例」，无需任何依赖。）\n"
    )
    sys.exit(1)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "samples")


def rounded_rect(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def get_font(size):
    for name in ("Arial.ttf", "Helvetica.ttc", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def vgrad(size, top, bottom):
    """竖向线性渐变（返回 RGBA Image）。"""
    w, h = size
    img = Image.new("RGBA", size)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(w):
            px[x, y] = (r, g, b, 255)
    return img


def diamond(draw, cx, cy, rx, ry, fill, outline=None, width=1):
    pts = [(cx, cy - ry), (cx + rx, cy), (cx, cy + ry), (cx - rx, cy)]
    draw.polygon(pts, fill=fill)
    if outline:
        draw.line(pts + [pts[0]], fill=outline, width=width)


def new_canvas(w, h):
    return Image.new("RGBA", (w, h), (0, 0, 0, 0))


# ---- 各样例绘制函数：签名 (img, draw) ----


def draw_hero_wide(img, d):
    # 横向胶囊，四周约 18-22px 透明边距
    grad = vgrad((196, 72), (91, 140, 255), (122, 91, 255))
    mask = Image.new("L", (196, 72), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 195, 71), radius=36, fill=255)
    img.paste(grad, (22, 34), mask)
    d.rounded_rectangle((22, 34, 217, 105), radius=36, outline=(255, 255, 255, 217), width=4)


def draw_hero_tall(img, d):
    # 竖条药水瓶，上下留透明边距
    rounded_rect(d, (26, 30, 69, 189), 18, fill=(255, 122, 89, 255))
    rounded_rect(d, (34, 12, 61, 37), 6, fill=(201, 79, 51, 255))
    rounded_rect(d, (34, 48, 43, 167), 5, fill=(255, 255, 255, 115))


def draw_gem(img, d, color_inner=(184, 245, 255), color_outer=(24, 182, 214),
             edge=(13, 111, 134)):
    # 菱形宝石，大量透明边距（内容约 72x80）
    cx, cy = 64, 64
    for i in range(40, 0, -1):
        t = i / 40
        col = tuple(int(color_inner[k] * (1 - t) + color_outer[k] * t) for k in range(3))
        diamond(d, cx, cy, int(36 * i / 40) + 1, int(40 * i / 40) + 1,
                fill=col + (255,))
    diamond(d, cx, cy, 36, 40, fill=None, outline=edge + (255,), width=3)


def draw_particle(img, d):
    # 圆形软边粒子，alpha 从中心向外衰减
    cx = cy = 32
    px = img.load()
    for y in range(8, 56):
        for x in range(8, 56):
            dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if dist <= 22:
                t = max(0.0, min(1.0, (dist - 2) / 20))
                alpha = int(255 * (1 - t) ** 1.4 * 0.95 + 60 * t * 0.2)
                px[x, y] = (255, int(236 - 46 * t), int(150 - 90 * t), min(255, alpha))


def draw_title_banner(img, d):
    # 超宽横幅，上下透明边距较大
    rounded_rect(d, (10, 26, 349, 63), 12, fill=(61, 220, 151, 255))
    font = get_font(22)
    d.text((180, 45), "LEVEL  CLEAR", fill=(18, 59, 44, 255), font=font, anchor="mm")


def draw_icon_square(img, d):
    # 方形图标，仅 6px 透明边距
    rounded_rect(d, (6, 6, 89, 89), 14, fill=(255, 209, 102, 255),
                 outline=(138, 90, 0, 255), width=4)
    font = get_font(44)
    d.text((48, 49), "★", fill=(138, 90, 0, 255), font=font, anchor="mm")


def draw_chars_hero(img, d):
    # 同名文件之一：蓝色小人
    d.ellipse((44, 22, 95, 73), fill=(77, 124, 255, 255))
    rounded_rect(d, (40, 78, 99, 143), 16, fill=(77, 124, 255, 255))
    d.rectangle((48, 140, 63, 153), fill=(30, 58, 138, 255))
    d.rectangle((76, 140, 91, 153), fill=(30, 58, 138, 255))


def draw_items_hero(img, d):
    # 同名文件之二：绿色徽章
    d.ellipse((40, 16, 119, 95), fill=(52, 211, 153, 255),
              outline=(6, 95, 70, 255), width=6)
    font = get_font(40)
    d.text((80, 57), "H", fill=(6, 95, 70, 255), font=font, anchor="mm")


def draw_almost_blank(img, d):
    # 极端样例：80x80 中只有中心 4x4 不透明
    d.rectangle((38, 38, 41, 41), fill=(255, 255, 255, 255))


SPECS = [
    ("hero_wide.png", 240, 140, draw_hero_wide),
    ("hero_tall.png", 96, 220, draw_hero_tall),
    ("gem.png", 128, 128, draw_gem),
    ("particle.png", 64, 64, draw_particle),
    ("title_banner.png", 360, 90, draw_title_banner),
    ("icon_square.png", 96, 96, draw_icon_square),
    ("chars/hero.png", 140, 160, draw_chars_hero),
    ("items/hero.png", 160, 120, draw_items_hero),
    ("items/gem.png", 128, 128,
     lambda img, d: draw_gem(img, d, (255, 214, 245), (224, 69, 181), (134, 20, 106))),
    ("almost_blank.png", 80, 80, draw_almost_blank),
]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for rel, w, h, fn in SPECS:
        path = os.path.join(OUT_DIR, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        img = new_canvas(w, h)
        fn(img, ImageDraw.Draw(img))
        img.save(path, "PNG")
        print("  写出 %s (%dx%d)" % (os.path.relpath(path), w, h))
    print("\n完成：%d 张示例图 -> %s" % (len(SPECS), os.path.relpath(OUT_DIR)))
    print("重名素材：chars/hero.png 与 items/hero.png；gem.png 与 items/gem.png")


if __name__ == "__main__":
    main()
