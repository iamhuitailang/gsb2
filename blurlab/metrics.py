"""恢复质量指标。

- ``gradient_recovery``：处理前后梯度能量相对干净参考的恢复比例；
- ``measure_bar_widths`` / ``bar_width_report``：亚像素测条宽并与真值比对；
- ``edge_position`` / ``edge_error_report``：同一法向上的边缘位置与 10–90% 过渡宽；
- ``unchanged_stats``：无拖影区域的 RMS / 最大偏差 / 超容差比例；
- ``residual_stats``：残差 RMS、最大绝对值，以及残差是否集中在边缘。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .image_io import luma
from .profile import bilinear, normal_vector


def _lum(img: np.ndarray) -> np.ndarray:
    return luma(img) if np.asarray(img).ndim == 3 else np.asarray(img, dtype=np.float32)


def gradient_energy(img: np.ndarray, rect: tuple[int, int, int, int] | None = None) -> float:
    lum = _lum(img)
    if rect is not None:
        x0, y0, x1, y1 = rect
        lum = lum[y0:y1, x0:x1]
    if lum.size < 4:
        return 0.0
    gy, gx = np.gradient(lum.astype(np.float64))
    return float(np.mean(gx * gx + gy * gy))


def gradient_recovery(blurred: np.ndarray, result: np.ndarray, clean: np.ndarray) -> float:
    """(处理后 - 模糊) / (干净 - 模糊) 的梯度能量比；1≈完全恢复，>1 可能过锐。"""
    gb = gradient_energy(blurred)
    gr = gradient_energy(result)
    gc = gradient_energy(clean)
    denom = gc - gb
    if abs(denom) < 1e-12:
        return float("nan")
    return float((gr - gb) / denom)


@dataclass
class BarWidthResult:
    label: str
    true_width_px: float
    measured_px: float
    error_px: float
    measured_blurred_px: float = float("nan")
    measured_clean_px: float = float("nan")

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "true_width_px": float(self.true_width_px),
            "measured_blurred_px": float(self.measured_blurred_px),
            "measured_result_px": float(self.measured_px),
            "measured_clean_px": float(self.measured_clean_px),
            "error_px": float(self.error_px),
            "error_rel": float(self.error_px / max(1e-9, self.true_width_px)),
        }


def measure_bar_widths(
    img: np.ndarray,
    bars: list[dict],
    background: float | None = None,
) -> list[float]:
    """测深色条在水平方向的宽度（亚像素）。

    在条中部高度取平均行剖面，用 50% 交叉阈值定位两侧边。取样范围限制在当前
    条与**相邻条中点**之间，避免把旁边另一条暗线误当背景（那样阈值会偏高、测
    出的宽度虚大）。
    """
    lum = _lum(img)
    xs_all = sorted(int(b["x0"]) for b in bars) + [lum.shape[1]]
    widths = []
    for bar in bars:
        x0, x1 = int(bar["x0"]), int(bar["x1"])
        y0, y1 = int(bar["y0"]), int(bar["y1"])
        # 左邻条的中点 / 右邻条的中点做取样边界
        left_prev = [v for v in xs_all if v + 1 < x0]
        right_next = [v for v in xs_all if v > x1 + 1]
        left_bound = (left_prev[-1] + x0) // 2 if left_prev else max(0, x0 - max(8, (x1 - x0) * 3))
        right_bound = (x1 + right_next[0]) // 2 if right_next else min(lum.shape[1], x1 + max(8, (x1 - x0) * 3))
        xs0 = max(0, left_bound)
        xs1 = min(lum.shape[1], max(right_bound, x1 + 3))
        ys0 = y0 + max(1, (y1 - y0) // 3)
        ys1 = y1 - max(1, (y1 - y0) // 3)
        if ys1 <= ys0 or xs1 <= xs0 + 2:
            widths.append(float(x1 - x0))
            continue

        prof = lum[ys0:ys1, xs0:xs1].mean(axis=0).astype(np.float64)
        inner_slice = prof[max(0, x0 - xs0) : max(1, x1 - xs0)]
        inner = float(inner_slice.min()) if inner_slice.size else float(prof.min())
        # 背景取两侧各 2 px（离条最近、但已在条外）的均值
        left_bg = prof[max(0, x0 - xs0 - 2) : max(1, x0 - xs0)]
        right_bg = prof[x1 - xs0 : min(len(prof), x1 - xs0 + 2)]
        bg_vals = np.concatenate([left_bg, right_bg])
        if bg_vals.size:
            outer = float(bg_vals.mean())
        elif background is not None:
            outer = float(background)
        else:
            outer = float(np.percentile(prof, 90))
        if outer - inner < 1e-4:
            widths.append(float(x1 - x0))
            continue

        thresh = 0.5 * (inner + outer)
        below = prof < thresh
        center_idx = int(np.clip((x0 + x1) / 2 - xs0, 0, len(prof) - 1))
        if not below[center_idx]:
            widths.append(float(x1 - x0))
            continue
        left = center_idx
        while left > 0 and below[left - 1]:
            left -= 1
        right = center_idx
        while right < len(prof) - 1 and below[right + 1]:
            right += 1

        def cross(i_in: int, i_out: int) -> float:
            if i_out < 0 or i_out >= len(prof):
                return float(i_in)
            v_in, v_out = prof[i_in], prof[i_out]
            if abs(v_out - v_in) < 1e-12:
                return float(i_in)
            t = (thresh - v_in) / (v_out - v_in)
            return float(i_in + t * (i_out - i_in))

        # 亚像素位置，再换算回原图坐标（相对 xs0 偏移）
        xl = xs0 + cross(left, left - 1)
        xr = xs0 + cross(right, right + 1)
        widths.append(float(xr - xl))
    return widths


def bar_width_report(
    blurred: np.ndarray,
    result: np.ndarray,
    clean: np.ndarray,
    bars: list[dict],
) -> list[BarWidthResult]:
    true_w = [float(b["width_px"]) for b in bars]
    res = measure_bar_widths(result, bars)
    bl = measure_bar_widths(blurred, bars)
    cl = measure_bar_widths(clean, bars)
    out = []
    for i, (bar, tw) in enumerate(zip(bars, true_w)):
        m = res[i] if i < len(res) else float("nan")
        out.append(
            BarWidthResult(
                label=f"bar@{bar['x0']}",
                true_width_px=tw,
                measured_px=float(m),
                error_px=float(m - tw) if math.isfinite(m) else float("nan"),
                measured_blurred_px=float(bl[i]) if i < len(bl) else float("nan"),
                measured_clean_px=float(cl[i]) if i < len(cl) else float("nan"),
            )
        )
    return out


def edge_position(
    img: np.ndarray,
    center: tuple[float, float],
    normal_deg: float,
    half: float = 20.0,
    step: float = 0.25,
) -> tuple[float, float]:
    """沿法向找 50% 交叉位置，返回 (位置 u*, 10-90% 过渡宽度)。

    u* 是相对 center 的法向偏移，正方向为 (cos φ, -sin φ)。
    """
    nx, ny = normal_vector(normal_deg)
    u = np.arange(-half, half + step, step)
    xs = center[0] + u * nx
    ys = center[1] + u * ny
    prof = bilinear(img, xs, ys).astype(np.float64)

    lo = float(np.percentile(prof, 5))
    hi = float(np.percentile(prof, 95))
    if hi - lo < 1e-6:
        return float("nan"), float("nan")
    norm = (prof - lo) / (hi - lo)
    if norm[-1] < norm[0]:
        norm = norm[::-1]
        u = u[::-1]

    i50 = np.where(norm >= 0.5)[0]
    i10 = np.where(norm >= 0.1)[0]
    i90 = np.where(norm >= 0.9)[0]
    if i50.size == 0 or i10.size == 0 or i90.size == 0:
        return float("nan"), float("nan")

    def interp(i: int, level: float) -> float:
        if i == 0:
            return float(u[0])
        v0, v1 = norm[i - 1], norm[i]
        if abs(v1 - v0) < 1e-12:
            return float(u[i])
        t = (level - v0) / (v1 - v0)
        return float(u[i - 1] + t * (u[i] - u[i - 1]))

    p50 = interp(int(i50[0]), 0.5)
    p10 = interp(int(i10[0]), 0.1)
    p90 = interp(int(i90[0]), 0.9)
    return p50, abs(p90 - p10)


@dataclass
class EdgeErrorResult:
    label: str
    position_error_px: float
    width_10_90_px: float
    clean_width_10_90_px: float
    blurred_width_10_90_px: float

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "position_error_px": float(self.position_error_px),
            "result_transition_10_90_px": float(self.width_10_90_px),
            "clean_transition_10_90_px": float(self.clean_width_10_90_px),
            "blurred_transition_10_90_px": float(self.blurred_width_10_90_px),
        }


def edge_error_report(
    blurred: np.ndarray,
    result: np.ndarray,
    clean: np.ndarray,
    edges: list[dict],
) -> list[EdgeErrorResult]:
    out = []
    for e in edges:
        center = tuple(float(v) for v in e.get("center", [0, 0]))
        normal = float(e.get("normal_deg", 0.0))
        pc, wc = edge_position(clean, center, normal)
        pr, wr = edge_position(result, center, normal)
        pb, wb = edge_position(blurred, center, normal)
        err = float(pr - pc) if math.isfinite(pr) and math.isfinite(pc) else float("nan")
        out.append(
            EdgeErrorResult(
                label=e.get("label", "edge"),
                position_error_px=err,
                width_10_90_px=float(wr),
                clean_width_10_90_px=float(wc),
                blurred_width_10_90_px=float(wb),
            )
        )
    return out


def unchanged_stats(
    original: np.ndarray,
    result: np.ndarray,
    rect: tuple[int, int, int, int] | None,
    tol: float = 0.01,
) -> dict:
    """无拖影区域应该几乎不变：统计 RMS 与超过容差的像素比例。"""
    a = _lum(original)
    b = _lum(result)
    if rect is not None:
        x0, y0, x1, y1 = rect
        a = a[y0:y1, x0:x1]
        b = b[y0:y1, x0:x1]
    d = (b - a).astype(np.float64)
    if d.size == 0:
        return {"rms": float("nan"), "max_abs": float("nan"), "frac_over_tol": float("nan")}
    return {
        "rms": float(np.sqrt(np.mean(d * d))),
        "max_abs": float(np.max(np.abs(d))),
        "frac_over_tol": float(np.mean(np.abs(d) > tol)),
        "tol": float(tol),
    }


@dataclass
class ResidualStats:
    rms: float
    max_abs: float
    edge_concentration: float
    total_rms: float = float("nan")

    def to_dict(self) -> dict:
        return {
            "rms": float(self.rms),
            "max_abs": float(self.max_abs),
            "edge_concentration": float(self.edge_concentration),
        }


def residual_stats(
    original: np.ndarray,
    result: np.ndarray,
    rect: tuple[int, int, int, int] | None = None,
) -> ResidualStats:
    """残差 = 原图 - 结果。edge_concentration 是残差能量在高梯度区的占比。"""
    a = _lum(original)
    b = _lum(result)
    if rect is not None:
        x0, y0, x1, y1 = rect
        a = a[y0:y1, x0:x1]
        b = b[y0:y1, x0:x1]
    r = (a - b).astype(np.float64)
    if r.size == 0:
        return ResidualStats(float("nan"), float("nan"), float("nan"))
    gy, gx = np.gradient(a.astype(np.float64))
    g = np.hypot(gx, gy)
    thresh = np.percentile(g, 90) if g.size else 0.0
    edge_mask = g >= thresh
    energy = r * r
    total = float(energy.sum())
    conc = float(energy[edge_mask].sum() / total) if total > 1e-12 else float("nan")
    return ResidualStats(
        rms=float(np.sqrt(np.mean(energy))),
        max_abs=float(np.max(np.abs(r))),
        edge_concentration=conc,
        total_rms=float(np.sqrt(np.mean((a - b) ** 2))),
    )


@dataclass
class RegionMetrics:
    label: str
    rect: tuple[int, int, int, int]
    gradient_recovery: float | None = None
    residual: ResidualStats | None = None
    unchanged: dict | None = None
    bars: list[BarWidthResult] = field(default_factory=list)
    edges: list[EdgeErrorResult] = field(default_factory=list)
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "rect": [int(v) for v in self.rect],
            "gradient_recovery": self.gradient_recovery,
            "residual": self.residual.to_dict() if self.residual else None,
            "unchanged": self.unchanged,
            "bar_widths": [b.to_dict() for b in self.bars],
            "edges": [e.to_dict() for e in self.edges],
            "extra": self.extra,
        }


def summarize_recovery(
    blurred: np.ndarray,
    result: np.ndarray,
    clean: np.ndarray | None,
    rect: tuple[int, int, int, int],
) -> dict:
    """给参数扫描用的轻量摘要：梯度恢复率 + 残差。"""
    out = {"residual": residual_stats(blurred, result, rect).to_dict()}
    if clean is not None:
        out["gradient_recovery"] = gradient_recovery(
            _crop(blurred, rect), _crop(result, rect), _crop(clean, rect)
        )
    return out


def _crop(img: np.ndarray, rect: tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = rect
    return img[y0:y1, x0:x1]
