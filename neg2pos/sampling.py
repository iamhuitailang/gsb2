"""区域取样: 片底/灰块多点取样, 查看各点数值并剔除异常(如片边污点)。"""
from __future__ import annotations

import numpy as np


def parse_rect(s: str) -> tuple[int, int, int, int]:
    """解析 'x,y,w,h' 形式的矩形。"""
    parts = [int(v) for v in s.split(",")]
    if len(parts) != 4:
        raise ValueError(f"矩形格式应为 x,y,w,h, 收到: {s!r}")
    x, y, w, h = parts
    if w <= 0 or h <= 0:
        raise ValueError(f"矩形宽高必须为正: {s!r}")
    return x, y, w, h


def sample_rects(img: np.ndarray, rects: list[tuple[int, int, int, int]]) -> list[dict]:
    """对每个矩形给出中位数/MAD/像素数, 供人工检查污点等异常。"""
    h_img, w_img = img.shape[:2]
    stats = []
    for i, (x, y, w, h) in enumerate(rects):
        x2, y2 = min(x + w, w_img), min(y + h, h_img)
        if x >= x2 or y >= y2 or x < 0 or y < 0:
            raise ValueError(f"矩形 #{i} ({x},{y},{w},{h}) 超出图像范围 {w_img}x{h_img}")
        px = img[y:y2, x:x2].reshape(-1, img.shape[2])
        med = np.median(px, axis=0)
        mad = np.median(np.abs(px - med), axis=0)
        stats.append({
            "index": i,
            "rect": [x, y, w, h],
            "median": [round(float(v), 5) for v in med],
            "mad": [round(float(v), 5) for v in mad],
            "n_pixels": int(px.shape[0]),
        })
    return stats


def flag_outliers(stats: list[dict], k: float = 3.5) -> list[bool]:
    """按各取样点中位数之间的稳健距离自动标记可疑点(供参考, 不强制)。"""
    meds = np.array([s["median"] for s in stats])
    if len(meds) < 3:
        return [False] * len(meds)
    center = np.median(meds, axis=0)
    dist = np.linalg.norm(meds - center, axis=1)
    mad = np.median(np.abs(dist - np.median(dist)))
    thresh = np.median(dist) + k * max(mad, 1e-6)
    return [bool(d > thresh) for d in dist]


def combine(stats: list[dict], exclude: set[int] | None = None) -> np.ndarray:
    """剔除指定序号后, 取各点中位数的中位数作为估计值。"""
    exclude = exclude or set()
    kept = [s for s in stats if s["index"] not in exclude]
    if not kept:
        raise ValueError("所有取样点都被剔除了, 无法估计")
    return np.median(np.array([s["median"] for s in kept]), axis=0)


def format_stats(stats: list[dict], flags: list[bool], exclude: set[int] | None = None) -> str:
    exclude = exclude or set()
    lines = [" idx  rect(x,y,w,h)        median R/G/B              MAD R/G/B              备注"]
    for s, f in zip(stats, flags):
        notes = []
        if f:
            notes.append("疑似异常")
        if s["index"] in exclude:
            notes.append("已剔除")
        lines.append(
            f" #{s['index']:<3d} {str(s['rect']):<22s} "
            f"{s['median'][0]:.4f}/{s['median'][1]:.4f}/{s['median'][2]:.4f}  "
            f"{s['mad'][0]:.4f}/{s['mad'][1]:.4f}/{s['mad'][2]:.4f}  {'; '.join(notes)}"
        )
    return "\n".join(lines)
