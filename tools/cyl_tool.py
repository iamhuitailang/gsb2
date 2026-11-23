#!/usr/bin/env python3
"""
圆柱标签展开 —— 合成数据生成 + 端到端验证（与浏览器端 js/geometry.js 同式）。

子命令：
  generate   生成规则等距标记的罐体环绕纹理、两个有重叠的视角、真值与控制点配置
  verify     用 numpy 复刻 js/geometry.js 的展开，量标记间距、验证留空、验证双视角覆盖

全程只依赖 numpy + Pillow。用 `python3 -I tools/cyl_tool.py ...` 运行。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

PI = math.pi
DEG = PI / 180.0

# 与 js/synthetic.js 一致的演示参数
TEX_W, TEX_H = 1440, 720
R, L = 260, 300
FOV_DEG = 80
CENTER_A, CENTER_B = 0, 140
BRIGHT_B = 0.85
PAD = 40


# ---------------------------------------------------------------- 纹理生成

def make_texture(path: str) -> None:
    """每 10° 细刻度、30° 粗刻度+角度数字；相邻细刻度在纹理上间隔 TEX_W/36 像素。"""
    img = Image.new("RGB", (TEX_W, TEX_H), (232, 220, 194))
    d = ImageDraw.Draw(img)
    try:
        font_big = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 64)
    except OSError:
        font_big = ImageFont.load_default()

    d.rectangle([0, TEX_H * 0.06, TEX_W, TEX_H * 0.06 + 6], fill=(28, 61, 110))
    d.rectangle([0, TEX_H * 0.94 - 6, TEX_W, TEX_H * 0.94], fill=(28, 61, 110))

    for a in range(0, 360, 10):
        x = int(round(a / 360.0 * TEX_W))
        major = (a % 30 == 0)
        color = (179, 38, 30) if major else (85, 85, 85)
        w = 4 if major else 2
        d.rectangle([x - w // 2, TEX_H * 0.42, x + w // 2, TEX_H * 0.58], fill=color)
        if major:
            label = str(a)
            d.text((x, TEX_H * 0.20), label, fill=(28, 61, 110), font=font_big, anchor="mm")
            d.text((x, TEX_H * 0.78), "LABEL", fill=(28, 61, 110), font=font_big, anchor="mm")
    img.save(path)


# ---------------------------------------------------------------- 正交投影渲染

def render_view(tex: np.ndarray, center_deg: float, brightness: float, tilt_deg: float = 0.0) -> np.ndarray:
    """正交投影 + cosθ 光照，与 js/synthetic.js renderView 对应。"""
    th, tw, _ = tex.shape
    half_w = R * math.sin(FOV_DEG * DEG)
    w = int(round(2 * half_w + 2 * PAD))
    h = int(round(2 * L + 2 * PAD))
    cx, cy = w / 2.0, h / 2.0
    out = np.full((h, w, 3), 32, dtype=np.uint8)  # 深灰背景

    xs = np.arange(w) - cx
    ys = np.arange(h) - cy
    xn = xs / R
    valid_x = np.abs(xn) <= 1.0
    theta = np.where(valid_x, np.arcsin(np.clip(xn, -1, 1)), 0.0)
    visible = valid_x & (np.abs(theta) <= FOV_DEG * DEG)
    valid_y = np.abs(ys) <= L

    world = center_deg * DEG + theta
    tx = ((world % (2 * PI)) + 2 * PI) % (2 * PI) / (2 * PI) * tw
    ty = (ys / L + 1.0) / 2.0 * th
    tx_i = np.clip(np.floor(tx).astype(int), 0, tw - 1)
    ty_i = np.clip(np.floor(ty).astype(int), 0, th - 1)
    shade = (0.35 + 0.65 * np.cos(theta)) * brightness  # 每行（列）一个光照系数

    for iy in range(h):
        if not valid_y[iy]:
            continue
        cols = np.where(visible)[0]
        sampled = tex[ty_i[iy], tx_i[cols]].astype(np.float64)
        out[iy, cols] = np.clip(sampled * shade[cols, None], 0, 255).astype(np.uint8)

    img = Image.fromarray(out, "RGB")
    if tilt_deg:
        canvas = Image.new("RGB", (w, h), (32, 36, 43))
        rotated = img.rotate(tilt_deg, resample=Image.BICUBIC, expand=False)
        canvas.paste(rotated, (0, 0))
        img = canvas
    return np.asarray(img)


def demo_controls(width: int, height: int) -> dict:
    """与 app.js demoControls 同式：根据已知几何给出贴合罐身的 6 控制点。"""
    cx, cy = width / 2.0, height / 2.0
    half_w = R * math.sin(FOV_DEG * DEG)
    bulge = R * (1 - math.cos(FOV_DEG * DEG)) * 0.5
    return {
        "LT": [cx - half_w, cy - L], "RT": [cx + half_w, cy - L],
        "LB": [cx - half_w, cy + L], "RB": [cx + half_w, cy + L],
        "TM": [cx, cy - L + bulge], "BM": [cx, cy + L - bulge],
    }


# ---------------------------------------------------------------- numpy 复刻展开（与 geometry.js 同式）

def bezier2(p0, p1, p2, t):
    a = 1 - t
    return a * a * p0 + 2 * a * t * p1 + t * t * p2


def edge_point(ctrl, which, s):
    if which == "top":
        return bezier2(ctrl["LT"], ctrl["TM"], ctrl["RT"], s)
    return bezier2(ctrl["LB"], ctrl["BM"], ctrl["RB"], s)


def build_warp(ctrl, W, H, theta_limit, img_w, img_h):
    """逐列构造源坐标/状态，返回 dict（与 CylGeo.buildWarp 对应）。"""
    sx = np.zeros((H, W), dtype=np.float64)
    sy = np.zeros_like(sx)
    theta = np.zeros((H, W))
    stretch = np.zeros((H, W))
    status = np.zeros((H, W), dtype=np.uint8)
    px_per_rad = (W - 1) / PI
    d_col = PI / (W - 1)

    for x in range(W):
        th = -PI / 2 + PI * x / (W - 1)
        s = (math.sin(th) + 1) / 2
        top = edge_point(ctrl, "top", s)
        bot = edge_point(ctrl, "bot", s)

        if x == 0:
            s_next = (math.sin(th + d_col) + 1) / 2
            mid_prev = (edge_point(ctrl, "top", s) + edge_point(ctrl, "bot", s)) / 2
            mid_next = (edge_point(ctrl, "top", s_next) + edge_point(ctrl, "bot", s_next)) / 2
            d_eff = d_col
        elif x == W - 1:
            s_prev = (math.sin(th - d_col) + 1) / 2
            mid_prev = (edge_point(ctrl, "top", s_prev) + edge_point(ctrl, "bot", s_prev)) / 2
            mid_next = (edge_point(ctrl, "top", s) + edge_point(ctrl, "bot", s)) / 2
            d_eff = d_col
        else:
            s_prev = (math.sin(th - d_col) + 1) / 2
            s_next = (math.sin(th + d_col) + 1) / 2
            mid_prev = (edge_point(ctrl, "top", s_prev) + edge_point(ctrl, "bot", s_prev)) / 2
            mid_next = (edge_point(ctrl, "top", s_next) + edge_point(ctrl, "bot", s_next)) / 2
            d_eff = 2 * d_col
        speed = np.linalg.norm(mid_next - mid_prev) / d_eff
        st = px_per_rad / speed

        for y in range(H):
            t = 0 if H == 1 else y / (H - 1)
            p = (1 - t) * top + t * bot
            sx[y, x], sy[y, x] = p
            theta[y, x] = th
            stretch[y, x] = st
            if abs(th) > theta_limit:
                status[y, x] = 1
            elif p[0] < 0 or p[1] < 0 or p[0] > img_w - 1 or p[1] > img_h - 1:
                status[y, x] = 2
    return {"sx": sx, "sy": sy, "theta": theta, "stretch": stretch, "status": status,
            "W": W, "H": H, "px_per_rad": px_per_rad}


def bilinear(img, x, y):
    h, w = img.shape[:2]
    x0, y0 = int(math.floor(x)), int(math.floor(y))
    x1, y1 = min(x0 + 1, w - 1), min(y0 + 1, h - 1)
    fx, fy = x - x0, y - y0
    top = img[y0, x0] * (1 - fx) + img[y0, x1] * fx
    bot = img[y1, x0] * (1 - fx) + img[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def render_warp(warp, src):
    H, W = warp["status"].shape
    out = np.zeros((H, W, 4), dtype=np.uint8)
    for y in range(H):
        for x in range(W):
            if warp["status"][y, x] != 0:
                continue
            px = bilinear(src, warp["sx"][y, x], warp["sy"][y, x])
            out[y, x, :3] = np.clip(px, 0, 255)
            out[y, x, 3] = 255
    return out


# ---------------------------------------------------------------- 生成

def cmd_generate(outdir: str) -> None:
    os.makedirs(outdir, exist_ok=True)
    tex_path = os.path.join(outdir, "texture_truth.png")
    make_texture(tex_path)
    tex = np.asarray(Image.open(tex_path).convert("RGB"))

    view_a = render_view(tex, CENTER_A, 1.0)
    view_b = render_view(tex, CENTER_B, BRIGHT_B)
    pa = os.path.join(outdir, "view_A.png")
    pb = os.path.join(outdir, "view_B.png")
    Image.fromarray(view_a).save(pa)
    Image.fromarray(view_b).save(pb)

    truth = {
        "texture": os.path.basename(tex_path),
        "texture_size": [TEX_W, TEX_H],
        "tick_spacing_px": TEX_W // 36,          # 每 10° 的纹理像素数
        "R": R, "L": L, "fov_deg": FOV_DEG,
        "views": {
            "A": {"file": os.path.basename(pa), "center_deg": CENTER_A, "brightness": 1.0,
                  "controls": demo_controls(view_a.shape[1], view_a.shape[0])},
            "B": {"file": os.path.basename(pb), "center_deg": CENTER_B, "brightness": BRIGHT_B,
                  "controls": demo_controls(view_b.shape[1], view_b.shape[0])},
        },
        "overlap_deg": 2 * FOV_DEG - (CENTER_B - CENTER_A),   # 20°
        "unphotographed_deg": 360 - (CENTER_B + FOV_DEG - (CENTER_A - FOV_DEG)),  # 60°
    }
    with open(os.path.join(outdir, "truth.json"), "w", encoding="utf-8") as f:
        json.dump(truth, f, ensure_ascii=False, indent=2)
    print(f"已生成: {tex_path}\n        {pa}\n        {pb}\n        truth.json")
    print(f"重合区 {truth['overlap_deg']}°，未拍到背面 {truth['unphotographed_deg']}°，"
          f"真值刻度间距 {truth['tick_spacing_px']}px/10°")


# ---------------------------------------------------------------- 验证

def find_tick_columns(unwarp_rgba, row_frac=0.5):
    """在展开图刻度带内扫描红色粗刻度（R 显著大于 G/B），返回连通段中心列。
    边缘大拉伸会把一条刻度裂成相邻两段，由 measure_ticks 负责按理论间距聚类。"""
    H, W = unwarp_rgba.shape[:2]
    y = int(H * row_frac)
    r = unwarp_rgba[y, :, 0].astype(int)
    g = unwarp_rgba[y, :, 1].astype(int)
    b = unwarp_rgba[y, :, 2].astype(int)
    a = unwarp_rgba[y, :, 3]
    mask = (a > 0) & (r > 120) & (r - g > 60) & (r - b > 60)
    cols, run = [], []
    for x in range(W):
        if mask[x]:
            run.append(x)
        elif run:
            cols.append(int(round(sum(run) / len(run))))
            run = []
    if run:
        cols.append(int(round(sum(run) / len(run))))
    return cols


def measure_ticks(unwarp_rgba, px_per_deg):
    """量粗刻度（每 30°）间距：先把裂成两段的同一条刻度合并（间距 < 15°），
    再只取中心 ±50° 区间（拉伸 <1.6×）统计，避免边缘拉伸污染。"""
    raw = find_tick_columns(unwarp_rgba)
    merged = []
    for c in raw:
        if merged and c - merged[-1] < 15 * px_per_deg:
            merged[-1] = int(round((merged[-1] + c) / 2))
        else:
            merged.append(c)
    center = unwarp_rgba.shape[1] / 2
    inner = [c for c in merged if abs(c - center) < 50 * px_per_deg]
    gaps = np.diff(inner)
    return inner, gaps


def cmd_verify(datadir: str, out_w: int, out_h: int) -> int:
    with open(os.path.join(datadir, "truth.json"), encoding="utf-8") as f:
        truth = json.load(f)
    failures = []
    px_per_deg = out_w / 180.0

    # --- 视角 A 展开，量刻度间距 ---
    src_a = np.asarray(Image.open(os.path.join(datadir, truth["views"]["A"]["file"])).convert("RGB"))
    ctrl_a = {k: np.array(v, dtype=float) for k, v in truth["views"]["A"]["controls"].items()}
    warp_a = build_warp(ctrl_a, out_w, out_h, FOV_DEG * DEG, src_a.shape[1], src_a.shape[0])
    unw_a = render_warp(warp_a, src_a)
    Image.fromarray(unw_a, "RGBA").save(os.path.join(datadir, "verify_unwarp_A.png"))

    ticks, gaps = measure_ticks(unw_a, px_per_deg)
    expected_gap = 30.0 * px_per_deg   # 粗刻度每 30°    print(f"[A] 合并裂段后粗刻度 {len(ticks)} 条，中心区间列={ticks}")
    print(f"[A] 相邻粗刻度间距: 均值={gaps.mean():.2f}px 标准差={gaps.std():.2f}px，"
          f"理论(30°×{px_per_deg:.2f}px/°)={expected_gap:.2f}px")
    if len(ticks) < 3:
        failures.append(f"粗刻度检出过少: {len(ticks)}")
    if gaps.size and (abs(gaps.mean() - expected_gap) > 0.05 * expected_gap or gaps.std() > 2.0):
        failures.append("刻度间距不均匀或偏离理论值（等角展开失败）")

    # --- 留空验证：θ 取用角限制后，超出列必须全部 NO-DATA ---
    limit = 60 * DEG
    warp_lim = build_warp(ctrl_a, out_w, out_h, limit, src_a.shape[1], src_a.shape[0])
    limited_cols = np.where(np.abs(warp_lim["theta"][0]) > limit)[0]
    ok_limit = np.all(warp_lim["status"][:, limited_cols] == 1)
    print(f"[限制] |θ|>60° 共 {len(limited_cols)} 列，全部标记 NO-DATA: {ok_limit}")
    if not ok_limit:
        failures.append("取用角限制未生效")

    # --- 双视角覆盖：合并后未拍到的背面角度必须留空，不能被补成有效数据 ---
    src_b = np.asarray(Image.open(os.path.join(datadir, truth["views"]["B"]["file"])).convert("RGB"))
    ctrl_b = {k: np.array(v, dtype=float) for k, v in truth["views"]["B"]["controls"].items()}
    warp_b = build_warp(ctrl_b, out_w, out_h, FOV_DEG * DEG, src_b.shape[1], src_b.shape[0])
    unw_b = render_warp(warp_b, src_b)

    # B 局部列 xB 对应世界角 centerB + θ(xB)；A 列 xA 对应世界角 centerA + θ(xA)。
    # 同一世界角：xA = xB + (centerB-centerA)·px/deg（centerA=0 时即直接右移 140°）。
    shift_px = (CENTER_B - CENTER_A) * px_per_deg
    coverage = np.zeros(out_w, dtype=np.uint8)  # 0=无数据 1=A 2=B 3=both
    valid_a = np.any(warp_a["status"] == 0, axis=0)
    valid_b = np.any(warp_b["status"] == 0, axis=0)
    coverage[valid_a] |= 1
    b_cols = np.round(np.where(valid_b)[0].astype(float) + shift_px).astype(int)
    b_cols = b_cols[(b_cols >= 0) & (b_cols < out_w)]
    coverage[b_cols] |= 2

    none_cols = np.where(coverage == 0)[0]
    # A 局部列 x 对应世界角 centerA + theta(x)，theta∈[-90,90]：世界角 = x/px_per_deg - 90
    none_world = none_cols / px_per_deg - 90.0
    # 期望留空世界角：两视角覆盖 [-80,220]，背面 (220,280) 没拍到
    expected_lo, expected_hi = CENTER_B + FOV_DEG, 360 - FOV_DEG  # 220°, 280°
    sample = np.array([int((d + 90) * px_per_deg) for d in range(expected_lo + 2, expected_hi - 2)])
    sample = sample[(sample >= 0) & (sample < out_w)]
    blank_ok = bool(np.all(coverage[sample] == 0))
    print(f"[覆盖] 无数据列 {len(none_cols)} / {out_w}，留空世界角 "
          f"{none_world.min():.0f}°~{none_world.max():.0f}°（期望 {expected_lo}°~{expected_hi}° 留空）: {blank_ok}")
    if not blank_ok:
        failures.append("未拍到的背面被补成了有效数据")

    # 重合区应当两侧都有效
    overlap_cols = np.where(coverage == 3)[0]
    overlap_deg = len(overlap_cols) / px_per_deg
    print(f"[覆盖] 重合列 {len(overlap_cols)}，对应 {overlap_deg:.1f}°（真值 {truth['overlap_deg']}°）")
    if abs(overlap_deg - truth["overlap_deg"]) > 3:
        failures.append("重合区角度与真值偏差过大")

    # 亮度分歧：重合列上 B 平均亮度应明显低于 A
    if len(overlap_cols):
        ya = unw_a[:, overlap_cols, :3].astype(float)
        b_local = (overlap_cols - shift_px).astype(int)
        yb = unw_b[:, b_local, :3].astype(float)
        valid = (unw_a[:, overlap_cols, 3] > 0) & (unw_b[:, b_local, 3] > 0)
        la = np.mean(0.2126 * ya[..., 0] + 0.7152 * ya[..., 1] + 0.0722 * ya[..., 2], where=valid)
        lb = np.mean(0.2126 * yb[..., 0] + 0.7152 * yb[..., 1] + 0.0722 * yb[..., 2], where=valid)
        print(f"[亮度] 重合区 A 均值 {la:.1f} vs B 均值 {lb:.1f}（B 被压暗 {int((1-BRIGHT_B)*100)}%）")
        if not (lb < la * 0.95):
            failures.append("亮度分歧未体现")

    print("\n" + ("全部验证通过 ✅" if not failures else "验证失败 ❌:\n  - " + "\n  - ".join(failures)))
    return 0 if not failures else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="圆柱标签展开合成/验证工具")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate", help="生成纹理、两个视角与 truth.json")
    g.add_argument("outdir", help="输出目录（新建）")
    v = sub.add_parser("verify", help="对 generate 的产物做端到端验证")
    v.add_argument("datadir", help="generate 的输出目录")
    v.add_argument("--out-w", type=int, default=1440)
    v.add_argument("--out-h", type=int, default=720)
    args = ap.parse_args()
    if args.cmd == "generate":
        cmd_generate(args.outdir)
        return 0
    return cmd_verify(args.datadir, args.out_w, args.out_h)


if __name__ == "__main__":
    sys.exit(main())
