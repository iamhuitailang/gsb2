#!/usr/bin/env python3
"""生成边缘去底色工具的测试样本（纯标准库，无第三方依赖）。

输出三张 128x128 RGBA PNG 到脚本同级的 samples/ 目录：
  1_icon_clean.png        普通浅色图标：半透明抗锯齿边缘为真实颜色，含不透明纯白高光
  2_icon_white_mixed.png  同一图标“贴白底导出再抠出”的混白边版本
  3_no_fix_needed.png     硬边全不透明图形（无半透明像素），工具应原样输出

混白边的模拟方式与真实事故一致：
  观测色 = 真实色 * a + 白底 * (1 - a)，alpha 保持不变。
因此 2 号样本可由去混色算法近似还原回 1 号的颜色，便于定量验证。
"""

import math
import os
import struct
import zlib

W = H = 128
SS = 4  # 每像素 4x4 超采样

# 图标真实颜色（浅钢蓝色）与纯白高光
TRUE_COLOR = (96, 130, 165)
HIGHLIGHT = (255, 255, 255)
# 第三张样本：深色硬边星形 + 不透明白点
STAR_COLOR = (44, 48, 58)


def write_png(path, width, height, rgba):
    """写入 8-bit RGBA、非交错 PNG。rgba 为长度 w*h*4 的 bytes。"""

    def chunk(typ, data):
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    scanlines = b"".join(
        b"\x00" + rgba[y * width * 4 : (y + 1) * width * 4] for y in range(height)
    )
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    blob = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(scanlines, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(blob)


def inside_rounded_rect(x, y):
    """圆角矩形：中心 (64,64)，半边长 42，圆角 16。"""
    half = 42.0
    radius = 16.0
    qx = max(abs(x - 64.0) - (half - radius), 0.0)
    qy = max(abs(y - 64.0) - (half - radius), 0.0)
    return math.hypot(qx, qy) <= radius


def inside_highlight(x, y):
    """图标左上区域的纯白高光圈。"""
    return math.hypot(x - 46.0, y - 46.0) <= 10.0


def star_vertices():
    outer, inner = 42.0, 17.0
    pts = []
    for k in range(10):
        r = outer if k % 2 == 0 else inner
        ang = -math.pi / 2 + k * math.pi / 5
        pts.append((64.0 + r * math.cos(ang), 64.0 + r * math.sin(ang)))
    return pts


STAR = star_vertices()


def inside_star(x, y):
    """射线法判断点是否在五角星内。"""
    inside = False
    j = len(STAR) - 1
    for i in range(len(STAR)):
        xi, yi = STAR[i]
        xj, yj = STAR[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def supersampled_alpha(inside_fn, px, py):
    hit = 0
    for sy in range(SS):
        for sx in range(SS):
            x = px + (sx + 0.5) / SS
            y = py + (sy + 0.5) / SS
            if inside_fn(x, y):
                hit += 1
    return round(255 * hit / (SS * SS))


def build_clean_icon():
    """样本 1：干净的直 alpha 图标，边缘 RGB 始终是真实颜色。"""
    buf = bytearray(W * H * 4)
    for py in range(H):
        for px in range(W):
            a = supersampled_alpha(inside_rounded_rect, px, py)
            idx = (py * W + px) * 4
            if a == 0:
                continue
            color = HIGHLIGHT if inside_highlight(px + 0.5, py + 0.5) else TRUE_COLOR
            buf[idx : idx + 4] = bytes((*color, a))
    return bytes(buf)


def mix_onto_white(clean):
    """样本 2：把干净图标合成到白底后再按原 alpha 抠出（混白边事故模型）。"""
    out = bytearray(len(clean))
    for i in range(0, len(clean), 4):
        r, g, b, a = clean[i : i + 4]
        if a == 0:
            continue
        af = a / 255.0
        out[i] = round(r * af + 255.0 * (1.0 - af))
        out[i + 1] = round(g * af + 255.0 * (1.0 - af))
        out[i + 2] = round(b * af + 255.0 * (1.0 - af))
        out[i + 3] = a
    return bytes(out)


def build_hard_star():
    """样本 3：像素中心硬判定，alpha 只有 0/255，不含任何半透明像素。"""
    buf = bytearray(W * H * 4)
    for py in range(H):
        for px in range(W):
            x, y = px + 0.5, py + 0.5
            if not inside_star(x, y):
                continue
            idx = (py * W + px) * 4
            # 星形内再放一个不透明白点，顺带验证纯白细节保留
            color = HIGHLIGHT if math.hypot(x - 50.0, y - 50.0) <= 8.0 else STAR_COLOR
            buf[idx : idx + 4] = bytes((*color, 255))
    return bytes(buf)


def alpha_stats(buf):
    semis = lows = 0
    for i in range(3, len(buf), 4):
        a = buf[i]
        if 0 < a < 255:
            semis += 1
            if a < 25:
                lows += 1
    return semis, lows


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")
    os.makedirs(out_dir, exist_ok=True)

    clean = build_clean_icon()
    mixed = mix_onto_white(clean)
    star = build_hard_star()

    targets = [
        ("1_icon_clean.png", clean),
        ("2_icon_white_mixed.png", mixed),
        ("3_no_fix_needed.png", star),
    ]
    for name, buf in targets:
        write_png(os.path.join(out_dir, name), W, H, buf)
        semis, lows = alpha_stats(buf)
        print(f"{name}: 半透明像素 {semis} 个（其中低透明度 {lows} 个）")


if __name__ == "__main__":
    main()
