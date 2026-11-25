#!/usr/bin/env python3
"""生成内置样例贴图（纯标准库，确定性输出）。

用法:
    python3 -I tools/generate_samples.py [输出目录]

产物:
    <out>/brick_*.png / wood_*.png          颜色/法线/灰度三类样例
    <out>/mismatch/brick_albedo_small.png   尺寸不一致样例（演示缩放/裁切/留边）
    <out>/MANIFEST.json                      样例清单
    <out>/sample-data.js                     base64 内嵌副本，支持 file:// 直接打开页面
"""
import base64
import json
import math
import os
import struct
import sys
import zlib

# --------------------------------------------------------------------------- #
# 极简 PNG 编码器（RGBA8，标准 zlib）
# --------------------------------------------------------------------------- #

def write_png(path, width, height, rgba):
    """rgba: 长度 width*height*4 的 bytearray/bytes。"""
    assert len(rgba) == width * height * 4
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0: None
        raw.extend(rgba[y * stride:(y + 1) * stride])
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8bit RGBA
    blob = b"\x89PNG\r\n\x1a\n"
    blob += chunk(b"IHDR", ihdr)
    blob += chunk(b"IDAT", compressed)
    blob += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(blob)


# --------------------------------------------------------------------------- #
# 确定性随机数（LCG）
# --------------------------------------------------------------------------- #

class Rng:
    def __init__(self, seed=13903):
        self.state = seed & 0xFFFFFFFF

    def nextf(self):
        # Numerical Recipes LCG
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state / 4294967296.0

    def range(self, lo, hi):
        return lo + (hi - lo) * self.nextf()


# --------------------------------------------------------------------------- #
# 贴图图案
# --------------------------------------------------------------------------- #

BRICK_H, BRICK_W = 256, 256
ROW_H = 32          # 砖行高（含灰缝）
MORTAR = 4          # 灰缝厚度
BRICK_W_UNIT = 80   # 单块砖宽（偶数行错开半块）


def brick_mask(x, y):
    """返回 (是否在砖内, 到灰缝的归一化距离 0..1)。"""
    row = y // ROW_H
    local_y = y % ROW_H
    offset = (BRICK_W_UNIT // 2) if (row % 2) else 0
    local_x = (x + offset) % BRICK_W_UNIT
    d = min(local_y, ROW_H - 1 - local_y, local_x, BRICK_W_UNIT - 1 - local_x)
    return d >= MORTAR, max(0.0, (d - MORTAR) / max(1, BRICK_W_UNIT // 2 - MORTAR))


def make_brick(rng):
    albedo = bytearray(BRICK_W * BRICK_H * 4)
    height = [0.0] * (BRICK_W * BRICK_H)
    # 每块砖一个固定色差
    brick_tint = {}
    for y in range(BRICK_H):
        row = y // ROW_H
        for x in range(BRICK_W):
            inside, edge = brick_mask(x, y)
            i = y * BRICK_W + x
            n = rng.nextf()
            if inside:
                key = (row, (x + ((BRICK_W_UNIT // 2) if row % 2 else 0)) // BRICK_W_UNIT)
                if key not in brick_tint:
                    brick_tint[key] = (rng.range(-18, 18), rng.range(-12, 12), rng.range(-10, 10))
                tr, tg, tb = brick_tint[key]
                r = 178 + tr + (n - 0.5) * 22
                g = 90 + tg + (n - 0.5) * 16
                b = 70 + tb + (n - 0.5) * 14
                height[i] = 0.85 + (n - 0.5) * 0.06 + edge * 0.08
            else:
                r, g, b = 96 + (n - 0.5) * 14, 92 + (n - 0.5) * 12, 84 + (n - 0.5) * 12
                height[i] = 0.15 + n * 0.03
            o = i * 4
            albedo[o:o + 4] = bytes((clamp8(r), clamp8(g), clamp8(b), 255))
    return albedo, height


def make_wood(rng, size=256):
    albedo = bytearray(size * size * 4)
    height = [0.0] * (size * size)
    # 木纹沿 x 方向延伸，y 方向由若干正弦叠加形成年轮
    for y in range(size):
        wobble = 0.0
        for k, (amp, freq, phase) in enumerate(
            [(10.0, 0.09, 0.3), (4.5, 0.23, 2.1), (1.8, 0.61, 4.7)]
        ):
            wobble += amp * math.sin(freq * y + phase)
        for x in range(size):
            i = y * size + x
            grain = 0.5 + 0.5 * math.sin((y + wobble + 2.0 * math.sin(x * 0.05)) * 0.55)
            fine = rng.nextf()
            # 深色年轮纹 + 暖棕基底
            r = 138 + grain * 52 + (fine - 0.5) * 12
            g = 86 + grain * 38 + (fine - 0.5) * 9
            b = 45 + grain * 22 + (fine - 0.5) * 7
            o = i * 4
            albedo[o:o + 4] = bytes((clamp8(r), clamp8(g), clamp8(b), 255))
            height[i] = 0.35 + grain * 0.5 + (fine - 0.5) * 0.04
    return albedo, height


def height_to_normal(height, w, h, strength=2.0):
    """高度场 -> 切线空间法线（OpenGL 约定：+Y 向上），输出 8bit RGBA。"""
    out = bytearray(w * h * 4)
    for y in range(h):
        y0, y1 = max(0, y - 1), min(h - 1, y + 1)
        for x in range(w):
            x0, x1 = max(0, x - 1), min(w - 1, x + 1)
            gx = (height[y * w + x1] - height[y * w + x0]) / max(1, (x1 - x0))
            gy = (height[y1 * w + x] - height[y0 * w + x]) / max(1, (y1 - y0))
            # 切线空间：梯度沿 +x/+y 时法线朝对应负方向
            nx, ny, nz = -gx * strength, -gy * strength, 1.0
            inv = 1.0 / math.sqrt(nx * nx + ny * ny + nz * nz)
            o = (y * w + x) * 4
            # [-1,1] -> [0,255]
            out[o] = clamp8(nx * inv * 127.5 + 127.5)
            out[o + 1] = clamp8(ny * inv * 127.5 + 127.5)
            out[o + 2] = clamp8(nz * inv * 127.5 + 127.5)
            out[o + 3] = 255
    return out


def grayscale(values):
    out = bytearray(len(values) * 4)
    for i, v in enumerate(values):
        c = clamp8(v * 255.0)
        o = i * 4
        out[o:o + 4] = bytes((c, c, c, 255))
    return out


def make_brick_channels(rng):
    albedo, height = make_brick(rng)
    normal = height_to_normal(height, BRICK_W, BRICK_H, strength=2.2)
    rough, ao, metal = [], [], []
    for y in range(BRICK_H):
        for x in range(BRICK_W):
            i = y * BRICK_W + x
            inside, edge = brick_mask(x, y)
            n = rng.nextf()
            if inside:
                rough.append(clamp01(0.55 + (n - 0.5) * 0.12 - edge * 0.05))
                ao.append(clamp01(0.86 + edge * 0.12 + (n - 0.5) * 0.04))
                metal.append(clamp01(0.02 + n * 0.02))
            else:
                rough.append(clamp01(0.9 + (n - 0.5) * 0.06))
                ao.append(clamp01(0.55 + (n - 0.5) * 0.08))
                metal.append(0.0)
    return albedo, normal, grayscale(rough), grayscale(ao), grayscale(metal)


def make_wood_channels(rng):
    albedo, height = make_wood(rng)
    w = h = 256
    normal = height_to_normal(height, w, h, strength=1.6)
    rough, ao, metal = [], [], []
    for y in range(h):
        for x in range(w):
            i = y * w + x
            grain = height[i]
            n = rng.nextf()
            rough.append(clamp01(0.72 - grain * 0.28 + (n - 0.5) * 0.06))
            ao.append(clamp01(0.9 + grain * 0.08 + (n - 0.5) * 0.03))
            metal.append(0.0)
    return albedo, normal, grayscale(rough), grayscale(ao), grayscale(metal)


def box_downscale(rgba, sw, sh, factor):
    """整数倍盒式缩放（RGBA）。"""
    tw, th = sw // factor, sh // factor
    out = bytearray(tw * th * 4)
    for ty in range(th):
        for tx in range(tw):
            acc = [0, 0, 0, 0]
            for dy in range(factor):
                for dx in range(factor):
                    o = ((ty * factor + dy) * sw + (tx * factor + dx)) * 4
                    for c in range(4):
                        acc[c] += rgba[o + c]
            o = (ty * tw + tx) * 4
            for c in range(4):
                out[o + c] = acc[c] // (factor * factor)
    return out, tw, th


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #

def clamp8(v):
    return 0 if v < 0 else 255 if v > 255 else int(round(v))


def clamp01(v):
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "public/samples"
    mismatch_dir = os.path.join(out_dir, "mismatch")
    os.makedirs(mismatch_dir, exist_ok=True)

    files = {}

    def save(name, w, h, data):
        path = os.path.join(out_dir, name)
        write_png(path, w, h, data)
        files[name] = {"width": w, "height": h, "bytes": os.path.getsize(path)}

    brick = make_brick_channels(Rng(101))
    save("brick_albedo.png", 256, 256, brick[0])
    save("brick_normal.png", 256, 256, brick[1])
    save("brick_roughness.png", 256, 256, brick[2])
    save("brick_ao.png", 256, 256, brick[3])
    save("brick_metallic.png", 256, 256, brick[4])

    wood = make_wood_channels(Rng(202))
    save("wood_albedo.png", 256, 256, wood[0])
    save("wood_normal.png", 256, 256, wood[1])
    save("wood_roughness.png", 256, 256, wood[2])
    save("wood_ao.png", 256, 256, wood[3])

    # 尺寸不一致样例：128x128 的颜色图，和同组 256 贴图混用
    small, sw, sh = box_downscale(brick[0], 256, 256, 2)
    path = os.path.join(mismatch_dir, "brick_albedo_small.png")
    write_png(path, sw, sh, small)
    files["mismatch/brick_albedo_small.png"] = {
        "width": sw, "height": sh, "bytes": os.path.getsize(path)
    }

    with open(os.path.join(out_dir, "MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "note": "由 tools/generate_samples.py 生成，可运行 npm run generate:samples 复现",
                "files": files,
            },
            f, ensure_ascii=False, indent=2,
        )

    # base64 内嵌副本：file:// 直接打开 index.html 时也能加载样例
    data = {}
    for rel in files:
        with open(os.path.join(out_dir, rel), "rb") as f:
            data[rel] = "data:image/png;base64," + base64.b64encode(f.read()).decode("ascii")
    with open(os.path.join(out_dir, "sample-data.js"), "w", encoding="utf-8") as f:
        f.write("// 由 tools/generate_samples.py 自动生成，请勿手改\n")
        f.write("window.MT_SAMPLE_DATA = ")
        json.dump(data, f, ensure_ascii=False)
        f.write(";\n")

    print("生成 %d 个文件 -> %s" % (len(files) + 2, out_dir))
    for rel, meta in files.items():
        print("  %-36s %4dx%-4d %6d B" % (rel, meta["width"], meta["height"], meta["bytes"]))


if __name__ == "__main__":
    main()
