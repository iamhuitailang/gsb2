#!/usr/bin/env python3
"""生成一组合成的重叠扫描样例（含颜色、噪声与离群点）。

输出到 samples/：
  scan_a.xyz  — 扫描 A，约 2 万点
  scan_b.xyz  — 扫描 B，与 A 部分重叠，经过已知刚体变换，含少量坏行用于演示
  transform_ground_truth.txt — B 相对 A 的真实变换（用于验证配准结果）

仅使用标准库，可离线运行：python3 tools/generate_samples.py
"""
import math
import os
import random

random.seed(42)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "samples")

# B 相对 A 的真实变换：先绕 Z 转 20°，再绕 X 转 4°，最后平移
GT_ROT_Z = math.radians(20.0)
GT_ROT_X = math.radians(4.0)
GT_TRANS = (0.6, -0.4, 0.25)

NOISE = 0.01          # 测距噪声标准差
N_OUTLIERS = 40       # 每份扫描的离群点数量


def scene_height(x, y):
    """合成场景：倾斜起伏地形 + 方块凸起 + 圆丘（非对称布局）。"""
    z = 0.08 * x                                    # 整体倾斜
    z += 0.25 * math.sin(1.2 * x) * math.cos(1.5 * y)
    z += 0.12 * math.sin(2.1 * x + 0.5)
    if -1.3 < x < -0.5 and -0.6 < y < 0.0:          # 方块（偏左）
        z += 0.5
    dx, dy = x - 1.4, y - 0.5                       # 圆丘（偏右上）
    r2 = dx * dx + dy * dy
    if r2 < 0.36:
        z += 0.45 * math.sqrt(0.36 - r2)
    return z


def color_for(z):
    """按高度着色：低处蓝绿，高处暖色。"""
    t = max(0.0, min(1.0, (z + 0.4) / 1.2))
    r = int(40 + 200 * t)
    g = int(180 - 80 * t)
    b = int(220 - 180 * t)
    return r, g, b


def sample_scene(x_range, y_range, step):
    pts = []
    x = x_range[0]
    while x <= x_range[1]:
        y = y_range[0]
        while y <= y_range[1]:
            # 抖动采样避免规则网格
            jx = x + random.uniform(-0.4, 0.4) * step
            jy = y + random.uniform(-0.4, 0.4) * step
            z = scene_height(jx, jy) + random.gauss(0, NOISE)
            pts.append((jx, jy, z))
            y += step
        x += step
    return pts


def add_outliers(pts, n):
    out = list(pts)
    for _ in range(n):
        out.append((random.uniform(-2, 2),
                    random.uniform(-2, 2),
                    random.uniform(2.0, 4.0)))   # 明显飘离场景
    return out


def transform(pts):
    cz, sz = math.cos(GT_ROT_Z), math.sin(GT_ROT_Z)
    cx, sx = math.cos(GT_ROT_X), math.sin(GT_ROT_X)
    out = []
    for x, y, z in pts:
        x, y = cz * x - sz * y, sz * x + cz * y      # 绕 Z
        y, z = cx * y - sx * z, sx * y + cx * z      # 绕 X
        out.append((x + GT_TRANS[0], y + GT_TRANS[1], z + GT_TRANS[2]))
    return out


def write_xyz(path, pts, bad_lines=0):
    with open(path, "w") as f:
        f.write("# synthetic scan, format: x y z r g b\n")
        bad_at = set(random.sample(range(len(pts)), bad_lines)) if bad_lines else set()
        for i, (x, y, z) in enumerate(pts):
            r, g, b = color_for(z)
            if i in bad_at:
                f.write("CORRUPTED_LINE not-a-number\n")
            f.write(f"{x:.5f} {y:.5f} {z:.5f} {r} {g} {b}\n")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # 扫描 A：覆盖整个场景（矩形，非对称）
    a = add_outliers(sample_scene((-2.5, 2.5), (-1.5, 1.5), 0.02), N_OUTLIERS)
    # 扫描 B：只覆盖部分重叠区域，再施加刚体变换
    b = sample_scene((-1.2, 2.5), (-1.0, 1.5), 0.02)
    b = transform(add_outliers(b, N_OUTLIERS))

    write_xyz(os.path.join(OUT_DIR, "scan_a.xyz"), a)
    write_xyz(os.path.join(OUT_DIR, "scan_b.xyz"), b, bad_lines=3)

    with open(os.path.join(OUT_DIR, "transform_ground_truth.txt"), "w") as f:
        f.write("# B 相对 A 的真实变换（先绕Z后绕X，欧拉角XYZ序）\n")
        f.write(f"rotation_deg_x = {math.degrees(GT_ROT_X):.4f}\n")
        f.write(f"rotation_deg_y = 0.0000\n")
        f.write(f"rotation_deg_z = {math.degrees(GT_ROT_Z):.4f}\n")
        f.write(f"translation = {GT_TRANS[0]}, {GT_TRANS[1]}, {GT_TRANS[2]}\n")
        f.write("# 注意：在工具中对 B 施加其逆变换（或将 A 配准到 B）即可对齐\n")

    print(f"scan_a.xyz: {len(a)} 点（含 {N_OUTLIERS} 个离群点）")
    print(f"scan_b.xyz: {len(b)} 点（含 {N_OUTLIERS} 个离群点、3 个坏行）")


if __name__ == "__main__":
    main()
