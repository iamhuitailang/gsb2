"""候选匹配：数据结构、局部峰值提取与 NMS 合并。"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Match:
    """一个模板候选命中。

    坐标均在目标图像素系下；角度为度、逆时针为正（见 :mod:`markfinder.geometry`）。
    """

    id: str
    x: float
    y: float
    angle: float
    scale: float
    flipped: bool
    score: float
    robust_score: float
    bbox: np.ndarray  # (4,2) 模板四角映射到目标图的位置
    cell_scores: np.ndarray  # 每个网格单元的局部 NCC，形状 (rows, cols)
    cell_rows: int
    cell_cols: int
    decision: str = "candidate"  # candidate / confirmed / false_positive
    note: str = ""
    hidden: bool = False  # 阈值滑块临时隐藏（已确认项不隐藏）
    coverage: float = 0.0  # 反向边缘覆盖率，用于挡部分匹配式误报

    def position_key(self, ndigits: int = 1) -> tuple[int, int, int]:
        """按位置生成稳定键，用于跨阈值重算时认出同一个标记。"""
        return (round(self.x, ndigits), round(self.y, ndigits), 1 if self.flipped else 0)

    def to_record(self) -> dict:
        """转成可 JSON/CSV 序列化的字典（不含图像）。"""
        return {
            "id": self.id,
            "x": round(float(self.x), 3),
            "y": round(float(self.y), 3),
            "angle": round(float(self.angle), 2),
            "scale": round(float(self.scale), 4),
            "flipped": bool(self.flipped),
            "score": round(float(self.score), 4),
            "robust_score": round(float(self.robust_score), 4),
            "decision": self.decision,
            "note": self.note,
            "bbox": [[round(float(px), 2), round(float(py), 2)] for px, py in self.bbox],
            "cell_scores": [
                [round(float(v), 3) for v in row] for row in self.cell_scores
            ],
        }


def local_maxima(
    score_map: np.ndarray,
    threshold: float,
    max_peaks: int,
    min_distance: int,
) -> list[tuple[int, int, float]]:
    """提取局部极大值 (col, row, 亚像素前分数)。

    用 3x3 膨胀取极大值，再按分数排序、做简单的像素距 NMS。
    """
    if score_map.size == 0:
        return []
    dilated = cv2.dilate(score_map, np.ones((3, 3), np.uint8))
    peaks_mask = (score_map == dilated) & (score_map >= threshold) & np.isfinite(score_map)
    ys, xs = np.where(peaks_mask)
    if len(xs) == 0:
        return []
    scores = score_map[ys, xs]
    order = np.argsort(-scores)
    ys, xs, scores = ys[order], xs[order], scores[order]

    picked: list[tuple[int, int, float]] = []
    min_d2 = min_distance * min_distance
    for row, col, val in zip(ys.tolist(), xs.tolist(), scores.tolist()):
        if all((col - px) ** 2 + (row - py) ** 2 >= min_d2 for px, py, _ in picked):
            picked.append((col, row, float(val)))
            if len(picked) >= max_peaks:
                break
    return picked


def subpixel_refine(
    score_map: np.ndarray, col: int, row: int
) -> tuple[float, float, float]:
    """对峰值做抛物线插值，返回 (亚像素 col, row, 插值分数)。"""
    h, w = score_map.shape
    if 1 <= row < h - 1 and 1 <= col < w - 1:
        dx = 0.5 * (score_map[row, col - 1] - score_map[row, col + 1]) / max(
            score_map[row, col - 1] - 2 * score_map[row, col] + score_map[row, col + 1],
            1e-9,
        )
        dy = 0.5 * (score_map[row - 1, col] - score_map[row + 1, col]) / max(
            score_map[row - 1, col] - 2 * score_map[row, col] + score_map[row + 1, col],
            1e-9,
        )
        dx = float(np.clip(dx, -1.0, 1.0))
        dy = float(np.clip(dy, -1.0, 1.0))
    else:
        dx = dy = 0.0
    return col + dx, row + dy, float(score_map[row, col])


def merge_candidates(
    matches: list[Match],
    merge_radius_px: float,
    angle_tol_deg: float = 12.0,
    scale_tol: float = 0.1,
) -> list[Match]:
    """合并同一标记在相近位置的重复命中。

    规则：
    - 翻面与不翻面的候选绝不互相合并；
    - 按全局分数从高到低贪心：距任一已保留候选小于 ``merge_radius_px``
      且角度差 < ``angle_tol_deg``、缩放差 < ``scale_tol`` 时并入，
      保留高分候选的位姿；
    - 距离超过半径的两个候选（贴得近的两个真标记）都会留下。
    """
    if not matches:
        return []
    ordered = sorted(matches, key=lambda m: m.score, reverse=True)
    kept: list[Match] = []
    r2 = merge_radius_px ** 2
    for cand in ordered:
        absorbed = False
        for owner in kept:
            if cand.flipped != owner.flipped:
                continue
            if (cand.x - owner.x) ** 2 + (cand.y - owner.y) ** 2 > r2:
                continue
            if abs(_angle_diff(cand.angle, owner.angle)) > angle_tol_deg:
                continue
            if abs(cand.scale - owner.scale) > scale_tol:
                continue
            absorbed = True
            break
        if not absorbed:
            kept.append(cand)
    kept.sort(key=lambda m: (m.y, m.x))
    return kept


def _angle_diff(a: float, b: float) -> float:
    d = (a - b + 180.0) % 360.0 - 180.0
    return d if d != -180.0 else 180.0


def default_merge_radius(template_w: int, template_h: int) -> float:
    """默认合并半径：模板短边的 0.35 倍。"""
    return max(6.0, 0.35 * min(template_w, template_h))


def angle_span(count: int) -> float:
    """角度网格步距。"""
    return 360.0 / max(1, count)


def scale_grid(min_scale: float, max_scale: float, num_scales: int) -> np.ndarray:
    """对数均匀的缩放网格。"""
    if num_scales <= 1 or min_scale == max_scale:
        return np.array([float(np.clip(min_scale, 0.05, 8.0))], dtype=np.float64)
    lo = math.log(max(min_scale, 0.05))
    hi = math.log(max(max_scale, min_scale + 1e-6))
    return np.exp(np.linspace(lo, hi, num_scales))
