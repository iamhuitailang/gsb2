#!/usr/bin/env python3
"""生成两张测试纹理（纯标准库，输出到 public/samples/）。

1. cloth_tileable.png   —— 本身平滑可平铺的布纹：所有成分以边长为周期，
                           纵横接缝处电平差与走势差均接近 0。
2. floor_vertical_seam.png —— 只在竖向露缝的地砖：周期网格 + 周期云纹，
                           但整体亮度沿 x 单向倾斜，平铺后仅竖向接缝跳变；
                           y 方向全部周期连续，横向不露缝。

与 public/js/samples.js 中的浏览器端生成器使用同一套数学定义
（周期 value-noise / fBm），便于离线核对。
"""
from __future__ import annotations

import math
import os
import struct
import zlib

SIZE = 256
TWO_PI = 6.283185307179586
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "samples")


# ---------------- 纯标准库 PNG 编码 ----------------

def write_png(path: str, width: int, height: int, rgba: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0
        raw.extend(rgba[y * stride:(y + 1) * stride])

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


# ---------------- 周期 value-noise / fBm ----------------

def _u32(x: int) -> int:
    return x & 0xFFFFFFFF


def hash2(ix: int, iy: int, seed: int) -> float:
    h = _u32(ix * 374761393) ^ _u32(iy * 668265263) ^ _u32(seed * 1442695041)
    h = _u32(h ^ (h >> 13))
    h = _u32(h * 1274126177)
    h = _u32(h ^ (h >> 16))
    return h / 4294967296.0


def fade(t: float) -> float:
    return t * t * (3.0 - 2.0 * t)


def value_noise(x: float, y: float, period: int, seed: int) -> float:
    xi, yi = int(x // 1), int(y // 1)
    fx, fy = fade(x - xi), fade(y - yi)
    x0 = xi % period
    y0 = yi % period
    x1 = (x0 + 1) % period
    y1 = (y0 + 1) % period
    v00 = hash2(x0, y0, seed)
    v10 = hash2(x1, y0, seed)
    v01 = hash2(x0, y1, seed)
    v11 = hash2(x1, y1, seed)
    a = v00 + (v10 - v00) * fx
    b = v01 + (v11 - v01) * fx
    return a + (b - a) * fy


def fbm(x: float, y: float, size: int, octaves: int, seed: int) -> float:
    amp, freq, total, norm = 0.5, 1, 0.0, 0.0
    for o in range(octaves):
        period = size // freq
        total += amp * value_noise(x * freq, y * freq, period, seed + o * 101)
        norm += amp
        amp *= 0.5
        freq *= 2
    return total / norm


# ---------------- 两张纹理 ----------------

def generate_cloth(size: int = SIZE) -> bytes:
    rgba = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            cloud = fbm(x / 8.0, y / 8.0, size // 8, 4, 11)
            fiber = fbm(x / 2.0, y / 2.0, size // 2, 3, 23)
            warp = 0.5 + 0.5 * math.sin(TWO_PI * x / 7.0)
            weft = 0.5 + 0.5 * math.sin(TWO_PI * y / 7.0)
            weave = warp * 0.5 + weft * 0.5
            v = (cloud - 0.5) * 26 + (fiber - 0.5) * 10 + (weave - 0.5) * 14
            i = (y * size + x) * 4
            rgba[i] = max(0, min(255, int(196 + v + (warp - 0.5) * 6)))
            rgba[i + 1] = max(0, min(255, int(188 + v)))
            rgba[i + 2] = max(0, min(255, int(172 + v - (weft - 0.5) * 4)))
            rgba[i + 3] = 255
    return bytes(rgba)


def generate_floor(size: int = SIZE) -> bytes:
    rgba = bytearray(size * size * 4)
    cell = size // 4
    grout = max(4, round(size / 64))  # 偶数：可在周期边界两侧均分
    tiles_per_axis = 4
    for y in range(size):
        for x in range(size):
            gx, gy = x % cell, y % cell
            half = grout / 2
            # 砖缝对称跨在格子的周期边界上（边界两侧各 grout/2），
            # 平铺时接缝两边都是砖缝 → 横向/纵向均连续
            in_grout = (
                gx < half or gx >= cell - half
                or gy < half or gy >= cell - half
            )
            # 环绕索引：砖块明暗表按 4×4 环绕，平铺时跨边缘仍是同一张表
            tx = (x // cell) % tiles_per_axis
            ty = (y // cell) % tiles_per_axis
            tile_shade = hash2(tx, ty, 7) - 0.5
            cloud = fbm(x / 10.0, y / 10.0, size // 10, 4, 47)
            grain = fbm(x / 2.0, y / 2.0, size // 2, 2, 59)
            ramp = 0.86 + 0.28 * (x / (size - 1))

            r = g = b = 0
            base_r, base_g, base_b = 178, 166, 148
            v = (cloud - 0.5) * 22 + (grain - 0.5) * 8 + tile_shade * 16
            r = base_r + v + math.sin(TWO_PI * y / 13.0) * 3
            g = base_g + v + math.sin(TWO_PI * y / 13.0) * 3
            b = base_b + v
            if in_grout:
                r, g, b = 96, 92, 86
            i = (y * size + x) * 4
            rgba[i] = max(0, min(255, int(r * ramp)))
            rgba[i + 1] = max(0, min(255, int(g * ramp)))
            rgba[i + 2] = max(0, min(255, int(b * ramp)))
            rgba[i + 3] = 255
    return bytes(rgba)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = [
        ("cloth_tileable.png", generate_cloth()),
        ("floor_vertical_seam.png", generate_floor()),
    ]
    for name, data in targets:
        path = os.path.abspath(os.path.join(OUT_DIR, name))
        write_png(path, SIZE, SIZE, data)
        print(f"wrote {path} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
