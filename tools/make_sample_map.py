#!/usr/bin/env python3
"""生成示例地图 assets/sample_map.png：非整倍数尺寸、带透明区域。

用法: python3 tools/make_sample_map.py [输出路径]
"""

import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1531, 1129  # 故意取非 256 整数倍的尺寸


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / "assets" / "sample_map.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    random.seed(42)

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))  # 全透明底
    d = ImageDraw.Draw(img)

    # 主大陆：不规则多边形（草地绿）
    cx, cy = W * 0.48, H * 0.52
    pts = []
    for i in range(28):
        a = i / 28 * 2 * math.pi
        r = 1 + 0.22 * math.sin(a * 3 + 1) + 0.12 * math.sin(a * 7)
        pts.append((cx + math.cos(a) * W * 0.40 * r, cy + math.sin(a) * H * 0.42 * r))
    d.polygon(pts, fill=(96, 158, 84, 255))

    # 湖泊（半透明蓝）
    for _ in range(6):
        x, y = random.uniform(W * 0.2, W * 0.8), random.uniform(H * 0.25, H * 0.8)
        rx, ry = random.uniform(40, 110), random.uniform(30, 80)
        d.ellipse([x - rx, y - ry, x + rx, y + ry], fill=(64, 120, 200, 200))

    # 山脉（棕色三角群）
    for _ in range(9):
        x, y = random.uniform(W * 0.15, W * 0.85), random.uniform(H * 0.2, H * 0.85)
        s = random.uniform(30, 70)
        d.polygon([(x - s, y + s * 0.7), (x, y - s * 0.7), (x + s, y + s * 0.7)],
                  fill=(140, 110, 80, 255))

    # 道路（米字网格，便于检查接缝是否对齐）
    for x in range(0, W, 128):
        d.line([(x, 0), (x, H)], fill=(220, 200, 160, 255), width=3)
    for y in range(0, H, 128):
        d.line([(0, y), (W, y)], fill=(220, 200, 160, 255), width=3)

    # 坐标标注（每 256px 一个十字+坐标，便于核对瓦片换算）
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Monaco.ttf", 18)
    except OSError:
        font = ImageFont.load_default()
    for x in range(0, W, 256):
        for y in range(0, H, 256):
            d.line([(x - 10, y), (x + 10, y)], fill=(255, 60, 60, 255), width=2)
            d.line([(x, y - 10), (x, y + 10)], fill=(255, 60, 60, 255), width=2)
            d.text((x + 6, y + 6), f"{x},{y}", fill=(255, 255, 255, 255), font=font,
                   stroke_width=2, stroke_fill=(0, 0, 0, 255))

    # 透明区域 1：左下角挖一个洞（云朵状）
    hole = Image.new("L", (W, H), 0)
    hd = ImageDraw.Draw(hole)
    for _ in range(7):
        x, y = random.uniform(60, 420), random.uniform(H - 380, H - 60)
        r = random.uniform(40, 90)
        hd.ellipse([x - r, y - r, x + r, y + r], fill=255)
    alpha = img.getchannel("A").point(lambda a: a)
    from PIL import ImageChops
    img.putalpha(ImageChops.subtract(alpha, hole))

    # 透明区域 2：右上角一片完全透明（什么都不画，底即透明）
    # —— 主大陆没覆盖到右上角，天然留空。

    img.save(out, "PNG")
    print(f"已生成 {out}  {W}x{H}（非整倍数尺寸，含透明区域）")


if __name__ == "__main__":
    main()
