"""合成扫描表样生成器。

生成带以下"缺陷"的表格图，用于联调和自检（需求 1、5）：
- 合并格（跨行/跨列），合并处本来就不印分隔线；
- 浅框线（低对比度灰度）；
- 红色印章压在框线上；
- 框线短缺口（模拟扫描不全）；
- 轻微整体旋转 + 扫描噪声。

同时输出 ground_truth.json：行列数、每条线坐标、合并关系，
供 verify 模块核对检测结果与裁切偏差。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np


@dataclass
class SynthSpec:
    n_rows: int = 5
    n_cols: int = 4
    merges: list[tuple[int, int, int, int]] = field(default_factory=list)  # r0,r1,c0,c1
    faint_segments: list[tuple[str, int, int]] = field(default_factory=list)
    gaps: list[tuple[str, int, int, float]] = field(default_factory=list)  # 方向,线,段,缺口占比
    rotation_deg: float = 1.6
    stamp: bool = True
    seed: int = 0
    cell_w: int = 180
    cell_h: int = 96
    margin: int = 70


def default_spec() -> SynthSpec:
    return SynthSpec(
        n_rows=5,
        n_cols=4,
        # 表头横向合并、左侧纵向合并、中部 2x2 合并
        merges=[(0, 0, 1, 2), (1, 2, 0, 0), (2, 3, 2, 3)],
        # (orientation, line index, segment index)
        faint_segments=[("h", 4, 1), ("v", 0, 3), ("h", 1, 0)],
        # 外框上的短缺口
        gaps=[("h", 0, 2, 0.18), ("v", 4, 0, 0.15)],
        rotation_deg=1.8,
        stamp=True,
        seed=42,
    )


def _merged_inner_edges(spec: SynthSpec) -> set[tuple[str, int, int]]:
    """合并格内部本来就不印的边：(h, iy, j) / (v, i, jx)。"""
    edges: set[tuple[str, int, int]] = set()
    for r0, r1, c0, c1 in spec.merges:
        for r in range(r0, r1 + 1):
            for c in range(c0, c1):
                edges.add(("v", r, c + 1))
        for r in range(r0, r1):
            for c in range(c0, c1 + 1):
                edges.add(("h", r + 1, c))
    return edges


def generate(spec: SynthSpec, out_path: str | Path) -> dict:
    rng = np.random.default_rng(spec.seed)
    table_w = spec.n_cols * spec.cell_w
    table_h = spec.n_rows * spec.cell_h
    W = table_w + 2 * spec.margin + 80
    H = table_h + 2 * spec.margin + 80
    ox, oy = spec.margin + 40, spec.margin + 40

    img = np.full((H, W, 3), 255, np.uint8)
    xs = [ox + c * spec.cell_w for c in range(spec.n_cols + 1)]
    ys = [oy + r * spec.cell_h for r in range(spec.n_rows + 1)]
    missing = _merged_inner_edges(spec)
    faint = set(spec.faint_segments)
    gap_map = {(o, li, seg): frac for o, li, seg, frac in spec.gaps}

    def draw_segment(p0: tuple[int, int], p1: tuple[int, int],
                     color: tuple[int, int, int], thickness: int = 2) -> None:
        cv2.line(img, p0, p1, color, thickness, lineType=cv2.LINE_AA)

    def seg_endpoints(orientation: str, line: int, seg: int
                      ) -> tuple[tuple[int, int], tuple[int, int]]:
        if orientation == "h":
            y = ys[line]
            return (xs[seg], y), (xs[seg + 1], y)
        x = xs[line]
        return (x, ys[seg]), (x, ys[seg + 1])

    # 所有外框和内部分隔；合并格内部边跳过
    for iy in range(spec.n_rows + 1):
        for j in range(spec.n_cols):
            if ("h", iy, j) in missing:
                continue
            p0, p1 = seg_endpoints("h", iy, j)
            color = (150, 150, 150) if ("h", iy, j) in faint else (40, 40, 40)
            gap_frac = gap_map.get(("h", iy, j))
            _draw_with_gap(draw_segment, p0, p1, color, gap_frac, rng)
    for jx in range(spec.n_cols + 1):
        for i in range(spec.n_rows):
            if ("v", i, jx) in missing:
                continue
            p0, p1 = seg_endpoints("v", jx, i)
            color = (150, 150, 150) if ("v", i, jx) in faint else (40, 40, 40)
            gap_frac = gap_map.get(("v", i, jx))
            _draw_with_gap(draw_segment, p0, p1, color, gap_frac, rng)

    # 一些占位文字（不识别，只为增加真实感）
    for r in range(spec.n_rows):
        for c in range(spec.n_cols):
            x = xs[c] + 14
            y = ys[r] + spec.cell_h // 2 + int(rng.integers(-6, 7))
            n_chars = int(rng.integers(2, 6))
            for k in range(n_chars):
                px = x + k * 16
                cv2.putText(img, str(int(rng.integers(0, 10))), (px, y),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (90, 90, 90), 1,
                            cv2.LINE_AA)

    # 红色印章，压在右下区域的框线上
    if spec.stamp:
        cx, cy = xs[spec.n_cols - 1] - 10, ys[spec.n_rows - 1] - 10
        red = (40, 40, 200)
        cv2.circle(img, (cx, cy), 52, red, 4, cv2.LINE_AA)
        cv2.putText(img, "OK", (cx - 26, cy + 12), cv2.FONT_HERSHEY_SIMPLEX,
                    1.4, red, 3, cv2.LINE_AA)

    # 扫描噪声
    noise = rng.normal(0, 5, img.shape).astype(np.int16)
    img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)

    # 轻微旋转（白边填充）
    if abs(spec.rotation_deg) > 1e-6:
        m = cv2.getRotationMatrix2D((W / 2, H / 2), spec.rotation_deg, 1.0)
        img = cv2.warpAffine(img, m, (W, H), borderValue=(255, 255, 255))

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), img)

    truth = {
        "image": out_path.name,
        "n_rows": spec.n_rows,
        "n_cols": spec.n_cols,
        "xs_pre_rotation": xs,
        "ys_pre_rotation": ys,
        "origin_pre_rotation": [ox, oy],
        "cell_size": [spec.cell_w, spec.cell_h],
        "rotation_deg": spec.rotation_deg,
        "merges": [list(m) for m in spec.merges],
        "missing_edges": [list(e) for e in sorted(missing)],
        "faint_segments": [list(e) for e in sorted(faint)],
        "gaps": [list(g) for g in spec.gaps],
        # 真值格子：锚点 + 跨度，检测后应与之一致
        "cells": _truth_cells(spec),
    }
    with open(out_path.with_name(out_path.stem + ".truth.json"), "w",
              encoding="utf-8") as f:
        json.dump(truth, f, ensure_ascii=False, indent=2)
    return truth


def _draw_with_gap(draw, p0: tuple[int, int], p1: tuple[int, int],
                   color: tuple[int, int, int], gap_frac: float | None,
                   rng: np.random.Generator) -> None:
    if not gap_frac:
        draw(p0, p1, color)
        return
    x0, y0 = p0
    x1, y1 = p1
    length = math.hypot(x1 - x0, y1 - y0)
    gap_len = length * gap_frac
    start = rng.uniform(0.25, 0.75 - gap_frac) * length
    ux, uy = (x1 - x0) / length, (y1 - y0) / length
    gap0 = (round(x0 + ux * start), round(y0 + uy * start))
    gap1 = (round(x0 + ux * (start + gap_len)),
            round(y0 + uy * (start + gap_len)))
    draw(p0, gap0, color)
    draw(gap1, p1, color)


def _truth_cells(spec: SynthSpec) -> list[dict]:
    covered = [[None] * spec.n_cols for _ in range(spec.n_rows)]
    cells: list[dict] = []
    for r0, r1, c0, c1 in spec.merges:
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                covered[r][c] = (r0, c0)
        cells.append({"anchor": [r0, c0], "span": [r1 - r0 + 1, c1 - c0 + 1]})
    for r in range(spec.n_rows):
        for c in range(spec.n_cols):
            if covered[r][c] is None:
                cells.append({"anchor": [r, c], "span": [1, 1]})
    cells.sort(key=lambda d: (d["anchor"][0], d["anchor"][1]))
    return cells
