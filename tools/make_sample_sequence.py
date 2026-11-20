#!/usr/bin/env python3
"""生成合成测试序列：包含缓慢渐变、突然变亮和场景切换。

用法：
    python3 tools/make_sample_sequence.py [输出目录]   # 默认 sample_sequence/

序列设计（64 帧，320x180 PNG）：
    帧  0-23  场景A（白天风景），亮度 0.80 -> 1.00 缓慢渐变
    帧 24     突然变亮 +18%（单帧闪烁）
    帧 26-27  突然变亮 +12%（双帧闪烁）
    帧 28-39  场景A 稳定
    帧 40     场景切换 -> 场景B（夜晚城市）
    帧 40-63  场景B，带 ±8% 的轻微亮度抖动
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

W, H = 320, 180
TOTAL = 64
CUT_AT = 40


def brightness_factor(i: int) -> float:
    if i < CUT_AT:
        if i <= 23:
            return 0.80 + (1.00 - 0.80) * i / 23  # 缓慢渐变到正常亮度
        if i == 24:
            return 1.18                            # 突然变亮（单帧）
        if i in (26, 27):
            return 1.12                            # 突然变亮（双帧）
        return 1.0
    # 场景B：确定的轻微抖动
    return 1.0 + 0.08 * (1 if i % 4 in (1, 2) else -1)


def draw_scene_a() -> Image.Image:
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):  # 天空渐变
        t = y / H
        d.line([(0, y), (W, y)], fill=(int(90 + 60 * t), int(150 + 40 * t), int(230 - 60 * t)))
    d.ellipse([W - 90, 20, W - 40, 70], fill=(255, 240, 160))          # 太阳
    d.rectangle([0, H - 40, W, H], fill=(70, 130, 60))                 # 地面
    d.polygon([(40, H - 40), (90, 70), (140, H - 40)], fill=(110, 90, 80))  # 山
    return img


def draw_scene_b() -> Image.Image:
    img = Image.new("RGB", (W, H), (12, 14, 30))
    d = ImageDraw.Draw(img)
    d.ellipse([30, 18, 62, 50], fill=(230, 230, 210))                  # 月亮
    for b in range(6):  # 楼与窗
        x0 = 10 + b * 52
        bh = 60 + (b * 37) % 70
        d.rectangle([x0, H - bh, x0 + 40, H], fill=(30, 32, 48))
        for wy in range(H - bh + 8, H - 8, 16):
            for wx in range(x0 + 6, x0 + 34, 12):
                if (wx * 7 + wy * 13) % 5 < 2:
                    d.rectangle([wx, wy, wx + 6, wy + 8], fill=(250, 210, 110))
    return img


def scale_brightness(img: Image.Image, factor: float) -> Image.Image:
    lut = [min(255, round(v * factor)) for v in range(256)]
    return img.point(lut * 3)


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("sample_sequence")
    out_dir.mkdir(parents=True, exist_ok=True)
    scene_a, scene_b = draw_scene_a(), draw_scene_b()
    for i in range(TOTAL):
        base = scene_a if i < CUT_AT else scene_b
        frame = scale_brightness(base, brightness_factor(i))
        frame.save(out_dir / f"frame_{i:04d}.png")
    print(f"已生成 {TOTAL} 帧 -> {out_dir}/")
    print(f"  缓慢渐变: 帧 0-23 | 突然变亮: 帧 24, 26-27 | 场景切换: 帧 {CUT_AT}")


if __name__ == "__main__":
    main()
