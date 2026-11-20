"""程序生成示例像素图：透明背景、半透明抗锯齿边缘、多个颜色块。

生成方式：以 4 倍分辨率绘制矢量形状，再 LANCZOS 降采样，
边缘自然产生半透明过渡像素，可用于验证换色工具的抗锯齿处理。
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

SCALE = 4  # 超采样倍数
SIZE = 64  # 输出尺寸（像素）


# 每个角色的调色板（多个颜色块，便于测试按色换色）
PALETTES = {
    "knight": {
        "armor": "#8a9ba8",
        "armor_dark": "#5c6b78",
        "plume": "#c0392b",
        "skin": "#e8b88a",
        "sword": "#d9dee3",
        "shield": "#2e5fa3",
    },
    "mage": {
        "robe": "#6c3fa0",
        "robe_dark": "#4a2a70",
        "hat": "#6c3fa0",
        "skin": "#e8b88a",
        "staff": "#7a4a21",
        "orb": "#39c0c8",
    },
    "slime": {
        "body": "#4CAF50",
        "body_dark": "#38853c",
        "eye": "#1a1a1a",
        "mouth": "#2c5e2e",
    },
}


def _hex(value: str) -> tuple[int, int, int, 255]:
    s = value.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), 255)


def _new_canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def _r(draw: ImageDraw.ImageDraw, x, y, w, h, color):
    s = SCALE
    draw.rectangle([x * s, y * s, (x + w) * s - 1, (y + h) * s - 1], fill=_hex(color))


def _e(draw: ImageDraw.ImageDraw, x, y, w, h, color):
    s = SCALE
    draw.ellipse([x * s, y * s, (x + w) * s - 1, (y + h) * s - 1], fill=_hex(color))


def _p(draw: ImageDraw.ImageDraw, points, color):
    s = SCALE
    draw.polygon([(x * s, y * s) for x, y in points], fill=_hex(color))


def draw_knight(p: dict) -> Image.Image:
    img, d = _new_canvas()
    _r(d, 26, 8, 12, 4, p["plume"])          # 头盔羽饰
    _e(d, 22, 10, 20, 18, p["armor"])        # 头盔
    _r(d, 24, 20, 16, 4, p["armor_dark"])   # 面甲缝
    _r(d, 26, 24, 12, 6, p["skin"])         # 面部
    _r(d, 22, 30, 20, 20, p["armor"])       # 身体甲
    _r(d, 22, 42, 20, 4, p["armor_dark"])   # 甲下摆
    _r(d, 24, 50, 6, 10, p["armor_dark"])   # 左腿
    _r(d, 34, 50, 6, 10, p["armor_dark"])   # 右腿
    _r(d, 10, 28, 4, 22, p["sword"])        # 剑身
    _p(d, [(8, 28), (16, 28), (12, 22)], p["sword"])  # 剑尖
    _r(d, 8, 50, 8, 3, p["armor_dark"])     # 剑格
    _e(d, 44, 30, 14, 18, p["shield"])      # 盾牌
    _e(d, 47, 34, 8, 10, p["plume"])        # 盾徽
    return img


def draw_mage(p: dict) -> Image.Image:
    img, d = _new_canvas()
    _p(d, [(32, 2), (18, 24), (46, 24)], p["hat"])   # 尖帽
    _r(d, 16, 24, 32, 4, p["robe_dark"])             # 帽檐
    _e(d, 24, 26, 16, 12, p["skin"])                 # 脸
    _p(d, [(32, 36), (16, 58), (48, 58)], p["robe"])  # 长袍
    _r(d, 28, 44, 8, 14, p["robe_dark"])             # 袍襟
    _r(d, 50, 20, 3, 34, p["staff"])                 # 法杖
    _e(d, 47, 12, 9, 9, p["orb"])                    # 法球
    return img


def draw_slime(p: dict) -> Image.Image:
    img, d = _new_canvas()
    _e(d, 12, 22, 40, 34, p["body"])        # 身体
    _e(d, 20, 14, 10, 12, p["body"])        # 头顶突起
    _e(d, 16, 44, 32, 10, p["body_dark"])   # 底部阴影
    _e(d, 22, 32, 6, 8, p["eye"])           # 左眼
    _e(d, 36, 32, 6, 8, p["eye"])           # 右眼
    _r(d, 26, 46, 12, 3, p["mouth"])        # 嘴
    return img


DRAWERS = {"knight": draw_knight, "mage": draw_mage, "slime": draw_slime}


def generate(output_dir: str) -> list[str]:
    """生成全部示例图，返回文件路径列表。"""
    os.makedirs(output_dir, exist_ok=True)
    paths = []
    for name, drawer in DRAWERS.items():
        big = drawer(PALETTES[name])
        small = big.resize((SIZE, SIZE), Image.LANCZOS)  # 产生半透明抗锯齿边缘
        path = os.path.join(output_dir, f"{name}.png")
        small.save(path)
        paths.append(path)
    return paths


if __name__ == "__main__":
    for p in generate(os.path.join(os.path.dirname(__file__), "..", "samples")):
        print(p)
