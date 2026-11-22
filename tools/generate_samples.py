#!/usr/bin/env python3
"""生成两张测试样例（仅使用 Python 标准库，无第三方依赖、不联网）。

输出：
  public/samples/sample1_checker_scratch.png   棋盘纹理 + 划线 + 需保护的文字
  public/samples/sample2_transparent_edge.png  透明背景 + 靠近透明边缘的擦痕

运行：python3 tools/generate_samples.py   （或 npm run generate:samples）
"""

import os
import struct
import zlib

# ---------------- 极简 RGBA 画布与 PNG 编码器 ----------------

class RGBA:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.buf = bytearray(w * h * 4)  # 初始全透明

    def px(self, x, y):
        return y * self.w * 4 + x * 4

    def set(self, x, y, r, g, b, a=255):
        if 0 <= x < self.w and 0 <= y < self.h:
            i = self.px(x, y)
            self.buf[i:i + 4] = bytes((r, g, b, a))

    def blend(self, x, y, r, g, b, a):
        """straight-alpha 覆盖一个半透明像素。"""
        if not (0 <= x < self.w and 0 <= y < self.h) or a <= 0:
            return
        i = self.px(x, y)
        da = self.buf[i + 3] / 255.0
        sa = a / 255.0
        out_a = sa + da * (1 - sa)
        if out_a <= 1e-6:
            return
        for k, c in enumerate((r, g, b)):
            num = c * sa + self.buf[i + k] * da * (1 - sa)
            self.buf[i + k] = max(0, min(255, round(num / out_a)))
        self.buf[i + 3] = max(0, min(255, round(out_a * 255)))

    def line(self, x0, y0, x1, y1, r, g, b, a=255, width=1):
        """Bresenham 直线，width 为直径。"""
        x0, y0, x1, y1 = map(round, (x0, y0, x1, y1))
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        err = dx + dy
        rad = width / 2.0
        while True:
            for ox in range(int(-rad), int(rad) + 1):
                for oy in range(int(-rad), int(rad) + 1):
                    if ox * ox + oy * oy <= rad * rad:
                        self.blend(x0 + ox, y0 + oy, r, g, b, a)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def fill_rect(self, x, y, w, h, r, g, b, a=255):
        for yy in range(max(0, y), min(self.h, y + h)):
            for xx in range(max(0, x), min(self.w, x + w)):
                self.blend(xx, yy, r, g, b, a)

    def to_png(self, path):
        def chunk(tag, data):
            return (struct.pack(">I", len(data)) + tag + data +
                    struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

        raw = bytearray()
        stride = self.w * 4
        for y in range(self.h):
            raw.append(0)  # filter type 0
            raw.extend(self.buf[y * stride:(y + 1) * stride])
        png = (b"\x89PNG\r\n\x1a\n"
               + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 6, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
               + chunk(b"IEND", b""))
        with open(path, "wb") as f:
            f.write(png)


# ---------------- 5x7 点阵字（仅需用到的字符） ----------------

FONT = {
    "A": (".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
    "C": (".####", "#....", "#....", "#....", "#....", "#....", ".####"),
    "E": ("#####", "#....", "#....", "####.", "#....", "#....", "#####"),
    "H": ("#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"),
    "I": ("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"),
    "L": ("#....", "#....", "#....", "#....", "#....", "#....", "#####"),
    "O": (".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."),
    "P": ("####.", "#...#", "#...#", "####.", "#....", "#....", "#...."),
    "R": ("####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"),
    "S": (".####", "#....", "#....", ".###.", "....#", "....#", "####."),
    "T": ("#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."),
    "0": (".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."),
    "1": ("..##.", ".#.#.", "..#..", "..#..", "..#..", "..#..", "#####"),
    "2": (".###.", "#...#", "....#", "..##.", ".#...", "#....", "#####"),
    "4": ("...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."),
    "8": (".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."),
    " ": (".....",) * 7,
}


def draw_text(img, text, x, y, scale, r, g, b, a=255):
    cx = x
    for ch in text:
        glyph = FONT.get(ch, FONT[" "])
        for row, line in enumerate(glyph):
            for col, on in enumerate(line):
                if on == "#":
                    img.fill_rect(cx + col * scale, y + row * scale, scale, scale, r, g, b, a)
        cx += 6 * scale


# ---------------- 确定性随机数（LCG，保证样例可复现） ----------------

class Rng:
    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF

    def next(self):
        self.s = (1103515245 * self.s + 12345) & 0x7FFFFFFF
        return self.s / 0x7FFFFFFF

    def range(self, lo, hi):
        return lo + (hi - lo) * self.next()


def scratch_polyline(img, rng, x, y, angle, length, color, width=1, alpha=200):
    """带轻微抖动的折线，模拟老贴图上的孤立划痕。"""
    steps = max(3, int(length / 14))
    px, py = x, y
    for _ in range(steps):
        angle += rng.range(-0.25, 0.25)
        nx = px + (length / steps) * _cos(angle)
        ny = py + (length / steps) * _sin(angle)
        img.line(px, py, nx, ny, *color, a=alpha, width=width)
        px, py = nx, ny


def _cos(a):
    import math
    return math.cos(a)


def _sin(a):
    import math
    return math.sin(a)


# ---------------- 样例 1：棋盘 + 划线 + 文字 ----------------

def make_sample1(path):
    W = H = 512
    img = RGBA(W, H)
    rng = Rng(20261122)
    cell = 32

    # 棋盘底纹，每格带一点确定性色差，更接近真实贴图
    for gy in range(H // cell):
        for gx in range(W // cell):
            base = (196, 196, 202) if (gx + gy) % 2 == 0 else (148, 148, 156)
            jitter = int(rng.range(-10, 10))
            color = tuple(max(0, min(255, c + jitter)) for c in base)
            img.fill_rect(gx * cell, gy * cell, cell, cell, *color)

    # 先放需要保持的文字，再让一条划痕穿过它，测试保护区
    draw_text(img, "SCRATCH 01", 48, 56, scale=3, r=40, g=44, b=52)

    # 浅色孤立划痕（多方向、长短不一）
    for _ in range(9):
        x = rng.range(30, W - 60)
        y = rng.range(120, H - 40)
        scratch_polyline(img, rng, x, y, rng.range(0, 6.28),
                         rng.range(45, 150), (232, 232, 238), width=int(rng.range(1, 2.6)), alpha=int(rng.range(150, 220)))
    # 两条深色划线，其中一条刻意穿过文字
    scratch_polyline(img, rng, 30, 90, 0.05, 300, (70, 72, 80), width=2, alpha=210)
    scratch_polyline(img, rng, 120, 260, -0.9, 220, (86, 88, 96), width=1, alpha=190)
    # 文字区再来一道浅痕（涂保护后修补必须原样保留文字）
    scratch_polyline(img, rng, 60, 78, 0.22, 260, (238, 238, 244), width=1, alpha=220)

    img.to_png(path)
    print("wrote", path)


# ---------------- 样例 2：透明背景 + 边缘擦痕 ----------------

def make_sample2(path):
    W = H = 512
    img = RGBA(W, H)
    rng = Rng(14763)

    # 中央菱形瓷砖（不透明），外部保持全透明
    cx, cy, rad = 256, 256, 200
    for y in range(H):
        for x in range(W):
            if abs(x - cx) + abs(y - cy) <= rad:
                j = int(rng.range(-8, 8))
                img.set(x, y, 126 + j, 150 + j, 120 + j, 255)

    # 瓷砖内的纹理横线与文字
    for yy in range(cy - rad + 24, cy + rad - 10, 26):
        half = rad - abs(yy - cy)
        img.line(cx - half + 8, yy, cx + half - 8, yy, 108, 130, 104, a=120)
    draw_text(img, "TILE 2048", cx - 75, cy - 14, scale=3, r=238, g=242, b=232)

    # 上边缘内侧的一组平行擦痕
    edge_y = cy - rad
    for i in range(6):
        x0 = cx - 120 + i * 26
        scratch_polyline(img, rng, x0, edge_y + 26, 1.25, 70,
                         (228, 232, 222), width=1, alpha=200)

    # 两条跨越透明边界的擦痕：一半在瓷砖上、一半落在透明区
    scratch_polyline(img, rng, cx + 90, edge_y + 40, -0.85, 150,
                     (240, 240, 236), width=2, alpha=215)
    scratch_polyline(img, rng, cx - 150, edge_y + 70, -0.6, 120,
                     (235, 238, 230), width=1, alpha=190)
    # 透明区里的孤立小点状划痕（透明像素保护后必须维持透明）
    for _ in range(14):
        img.blend(int(rng.range(40, W - 40)), int(rng.range(40, H - 40)),
                  240, 240, 240, int(rng.range(60, 140)))

    img.to_png(path)
    print("wrote", path)


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "samples")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    make_sample1(os.path.join(out_dir, "sample1_checker_scratch.png"))
    make_sample2(os.path.join(out_dir, "sample2_transparent_edge.png"))


if __name__ == "__main__":
    main()
