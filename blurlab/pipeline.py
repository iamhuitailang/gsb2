"""端到端处理管线：多区域分别去模糊 -> 按次序合成 -> 指标 -> 结果包。

这一层不含 GUI，CLI、验证脚本和界面共用。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from .deblur import DeblurParams, DeblurStats, deblur_image_region, suggested_padding
from .metrics import (
    RegionMetrics,
    ResidualStats,
    bar_width_report,
    edge_error_report,
    gradient_recovery,
    residual_stats,
    summarize_recovery,
    unchanged_stats,
)
from .regions import Region, RegionSet


@dataclass
class RegionRun:
    label: str
    rect: tuple[int, int, int, int]
    params: dict
    stats: dict
    elapsed_ms: float
    processed: np.ndarray = field(repr=False, default=None)

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "rect": [int(v) for v in self.rect],
            "params": self.params,
            "stats": self.stats,
            "elapsed_ms": float(self.elapsed_ms),
        }


@dataclass
class PipelineResult:
    original: np.ndarray
    result: np.ndarray
    residual: np.ndarray
    region_runs: list[RegionRun]
    region_metrics: list[RegionMetrics]
    coverage_owner: np.ndarray
    coverage_count: np.ndarray
    elapsed_ms: float
    notes: list[str] = field(default_factory=list)

    def metrics_dict(self) -> dict:
        return {
            "regions": [m.to_dict() for m in self.region_metrics],
            "order": [r.label for r in self.region_runs],
            "notes": list(self.notes),
            "elapsed_ms": float(self.elapsed_ms),
        }


def process_regions(
    original: np.ndarray,
    region_set: RegionSet,
    clean: np.ndarray | None = None,
    margin: int | None = None,
    compute_metrics: bool = True,
    bars: list[dict] | None = None,
    edges: list[dict] | None = None,
    unchanged_rect: tuple[int, int, int, int] | None = None,
) -> PipelineResult:
    """对所有启用的区域分别处理并按确定次序合成。

    每个区域的处理块 = 区域外扩 margin 像素，这样选区边界附近的去模糊也有
    足够上下文（"在边沿附近也能预览"），最后只把区域内（羽化）结果贴回。
    """
    t0 = time.perf_counter()
    img = np.asarray(original, dtype=np.float32)
    h, w = img.shape[:2]
    notes: list[str] = []

    processed_full: dict[str, np.ndarray] = {}
    runs: list[RegionRun] = []
    metrics: list[RegionMetrics] = []

    for region in region_set.ordered():
        x0, y0, x1, y1 = region.rect
        m = suggested_padding(region.params.length_px) if margin is None else int(margin)
        bx0 = max(0, x0 - m)
        by0 = max(0, y0 - m)
        bx1 = min(w, x1 + m)
        by1 = min(h, y1 + m)
        block = img[by0:by1, bx0:bx1]

        t_region = time.perf_counter()
        out_block, stats = deblur_image_region(block, region.params)
        elapsed = (time.perf_counter() - t_region) * 1000.0

        full = img.copy()
        full[y0:y1, x0:x1] = out_block[y0 - by0 : y0 - by0 + (y1 - y0), x0 - bx0 : x0 - bx0 + (x1 - x0)]
        processed_full[region.label] = full

        run = RegionRun(
            label=region.label,
            rect=region.rect,
            params=region.params.to_dict(),
            stats=stats.to_dict(),
            elapsed_ms=elapsed,
        )
        runs.append(run)
        region.last_stats = run.stats

        if compute_metrics:
            bm = RegionMetrics(label=region.label, rect=region.rect)
            blurred_crop = img[y0:y1, x0:x1]
            result_crop = full[y0:y1, x0:x1]
            bm.residual = residual_stats(blurred_crop, result_crop)
            clean_crop = clean[y0:y1, x0:x1] if clean is not None else None
            if clean_crop is not None:
                bm.gradient_recovery = gradient_recovery(blurred_crop, result_crop, clean_crop)
                bm.extra["residual_vs_clean_rms"] = float(
                    np.sqrt(np.mean((result_crop - clean_crop) ** 2))
                )
                bm.extra["blurred_vs_clean_rms"] = float(
                    np.sqrt(np.mean((blurred_crop - clean_crop) ** 2))
                )
            if bars and clean_crop is not None:
                in_region = [
                    b
                    for b in bars
                    if b["x0"] >= x0 and b["x1"] <= x1 and b["y0"] >= y0 and b["y1"] <= y1
                ]
                if in_region:
                    bm.bars = bar_width_report(
                        blurred_crop, result_crop, clean_crop, _shift_bars(in_region, x0, y0)
                    )
            if edges and clean_crop is not None:
                in_edges = [
                    e
                    for e in edges
                    if x0 <= e["center"][0] <= x1 and y0 <= e["center"][1] <= y1
                ]
                if in_edges:
                    bm.edges = edge_error_report(
                        blurred_crop, result_crop, clean_crop, _shift_edges(in_edges, x0, y0)
                    )
            metrics.append(bm)

    composed = region_set.blend(img, processed_full)
    if not region_set.ordered():
        notes.append("没有启用的区域：结果等于原图")

    if compute_metrics and unchanged_rect is not None:
        stats_u = unchanged_stats(img, composed, unchanged_rect)
        notes.append(
            "无拖影对照区变化 RMS={:.4f}，超容差比例={:.2%}".format(
                stats_u["rms"], stats_u["frac_over_tol"]
            )
        )

    owner, count = region_set.coverage_map()
    overlap = region_set.overlap_report()
    for o in overlap:
        notes.append(
            f"重叠 {o['overlap_px']} px（{o['earlier']} ∩ {o['later']}），生效次序后者优先：{o['winner']}"
        )

    residual = (img - composed).astype(np.float32)
    elapsed = (time.perf_counter() - t0) * 1000.0
    return PipelineResult(
        original=img,
        result=composed,
        residual=residual,
        region_runs=runs,
        region_metrics=metrics,
        coverage_owner=owner,
        coverage_count=count,
        elapsed_ms=elapsed,
        notes=notes,
    )


def _shift_bars(bars: list[dict], dx: int, dy: int) -> list[dict]:
    out = []
    for b in bars:
        c = dict(b)
        for k in ("x0", "x1"):
            c[k] = int(b[k]) - dx
        for k in ("y0", "y1"):
            c[k] = int(b[k]) - dy
        out.append(c)
    return out


def _shift_edges(edges: list[dict], dx: int, dy: int) -> list[dict]:
    out = []
    for e in edges:
        c = dict(e)
        c["center"] = [float(e["center"][0]) - dx, float(e["center"][1]) - dy]
        if "p0" in e:
            c["p0"] = [float(e["p0"][0]) - dx, float(e["p0"][1]) - dy]
            c["p1"] = [float(e["p1"][0]) - dx, float(e["p1"][1]) - dy]
        out.append(c)
    return out


def sweep_parameters(
    original: np.ndarray,
    rect: tuple[int, int, int, int],
    angle_deg: float,
    lengths: list[float],
    noise_gains: list[float] | None = None,
    clean: np.ndarray | None = None,
) -> list[dict]:
    """参数扫描：不同长度/噪声上限下能恢复多少（梯度恢复率 + 残差）。"""
    noise_gains = noise_gains or [4.0]
    x0, y0, x1, y1 = rect
    img = np.asarray(original, dtype=np.float32)
    rows = []
    for L in lengths:
        for g in noise_gains:
            params = DeblurParams(length_px=float(L), angle_deg=float(angle_deg), noise_gain=float(g))
            out, stats = deblur_image_region(img[y0:y1, x0:x1], params)
            crop_b = img[y0:y1, x0:x1]
            crop_c = clean[y0:y1, x0:x1] if clean is not None else None
            row = {
                "length_px": float(L),
                "angle_deg": float(angle_deg),
                "noise_gain": float(g),
                "effective_noise_gain": float(stats.effective_noise_gain),
                "residual_rms": float(residual_stats(crop_b, out).rms),
            }
            if crop_c is not None:
                row["gradient_recovery"] = gradient_recovery(crop_b, out, crop_c)
                row["rms_to_clean"] = float(np.sqrt(np.mean((out - crop_c) ** 2)))
            rows.append(row)
    return rows


def best_by(rows: list[dict], key: str, minimize: bool = False) -> dict | None:
    vals = [r for r in rows if r.get(key) is not None and np.isfinite(r[key])]
    if not vals:
        return None
    return min(vals, key=lambda r: r[key]) if minimize else max(vals, key=lambda r: r[key])
