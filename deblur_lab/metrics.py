"""Objective checks against the preserved sharp sample.

Everything here takes a *reference* (sharp / clean) image and a *test* image
(restored) and reports the quantities the task cares about:

* edge 10-90 width and edge-position error,
* character/stroke line width for known stems and bars,
* noise level in flat areas (so noise amplification is visible),
* amplification of faint dark edges (dark-edge gain),
* change in areas that were never blurred (the "should not change" check),
* PSNR / SSIM (SSIM is implemented locally to avoid extra dependencies).

Edges and lines are measured by sampling the image, so the same code can be
pointed at real photos; targets come from ``targets.json`` or are detected.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

from . import estimate, ops


# ---------------------------------------------------------------------------
# Basic metrics
# ---------------------------------------------------------------------------

def psnr(ref: np.ndarray, test: np.ndarray, data_range: float = 1.0) -> float:
    mse = float(np.mean((np.asarray(ref, dtype=np.float64) - np.asarray(test, dtype=np.float64)) ** 2))
    if mse <= 1e-15:
        return 99.0
    return float(10.0 * math.log10(data_range ** 2 / mse))


def _ssim_single(ref: np.ndarray, test: np.ndarray) -> float:
    ref = np.asarray(ref, dtype=np.float64)
    test = np.asarray(test, dtype=np.float64)
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    mu1 = ops.box_blur(ref.astype(np.float32), 4).astype(np.float64)
    mu2 = ops.box_blur(test.astype(np.float32), 4).astype(np.float64)
    s11 = ops.box_blur((ref * ref).astype(np.float32), 4).astype(np.float64) - mu1 * mu1
    s22 = ops.box_blur((test * test).astype(np.float32), 4).astype(np.float64) - mu2 * mu2
    s12 = ops.box_blur((ref * test).astype(np.float32), 4).astype(np.float64) - mu1 * mu2
    num = (2 * mu1 * mu2 + c1) * (2 * s12 + c2)
    den = (mu1 * mu1 + mu2 * mu2 + c1) * (s11 + s22 + c2)
    return float(np.mean(num / den))


def ssim(ref: np.ndarray, test: np.ndarray) -> float:
    ref = np.asarray(ref, dtype=np.float32)
    test = np.asarray(test, dtype=np.float32)
    if ref.ndim == 3:
        vals = [_ssim_single(ref[..., c], test[..., c]) for c in range(ref.shape[2])]
        return float(np.mean(vals))
    return _ssim_single(ref, test)


def noise_sigma(gray: np.ndarray, mask: np.ndarray | None = None) -> float:
    """Robust noise estimate from the median absolute Laplacian.

    For i.i.d. noise of std ``sigma`` the discrete Laplacian
    ``4c - up - down - left - right`` has std ``sigma * sqrt(20)`` (variance 16
    from the centre plus 4 from each neighbour).  Dividing the MAD-based
    standard deviation by ``sqrt(20)`` recovers ``sigma``.
    """
    g = np.asarray(gray, dtype=np.float32)
    lap = (
        4.0 * g[1:-1, 1:-1]
        - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    )
    if mask is not None:
        m = mask[1:-1, 1:-1] > 0.5
        if m.sum() < 32:
            return float("nan")
        vals = lap[m]
    else:
        vals = lap
    mad = float(np.median(np.abs(vals)))
    return mad * 1.4826 / math.sqrt(20.0)


def flat_mask(gray: np.ndarray, radius: int = 4, threshold: float = 0.006) -> np.ndarray:
    """Pixels where the local standard deviation is very low."""
    std = ops.local_std(np.asarray(gray, dtype=np.float32), radius)
    return (std <= threshold).astype(bool)


# ---------------------------------------------------------------------------
# Edge / line measurement
# ---------------------------------------------------------------------------

@dataclass
class EdgeMeasure:
    width_10_90: float
    position: float
    contrast: float
    ok: bool

    def to_dict(self) -> dict:
        return {
            "width_10_90": round(float(self.width_10_90), 3),
            "position": round(float(self.position), 3),
            "contrast": round(float(self.contrast), 3),
            "ok": bool(self.ok),
        }


def measure_edge_at(
    gray: np.ndarray,
    point: tuple[float, float],
    normal_deg: float,
    *,
    halfwidth: float = 20.0,
    n_profiles: int = 9,
    spacing: float = 2.0,
    fixed_normal: bool = True,
) -> EdgeMeasure:
    """Measure width and sub-pixel 10-90 midpoint at a known edge."""
    phi = float(normal_deg)
    s, mean, _ = ops.sample_band_profiles(
        gray, point, phi, halfwidth, step=0.2, n_profiles=n_profiles, spacing=spacing
    )
    res = estimate._profile_crossings(s, mean)
    if res is None:
        return EdgeMeasure(float("nan"), float("nan"), float("nan"), False)
    s10, s50, s90, contrast, _ = res
    return EdgeMeasure(abs(s90 - s10), 0.5 * (s10 + s90), contrast, True)


def measure_line_width(
    gray: np.ndarray,
    point: tuple[float, float],
    direction_deg: float,
    *,
    halfwidth: float = 8.0,
) -> float:
    """Measure a dark line's FWHM-ish width across its direction."""
    normal = (float(direction_deg) + 90.0) % 180.0
    s, mean, _ = ops.sample_band_profiles(
        gray, point, normal, halfwidth, step=0.1, n_profiles=7, spacing=1.0
    )
    base = float(np.median(np.r_[mean[:4], mean[-4:]]))
    dip = base - mean
    peak = float(np.max(dip))
    if peak < 0.03:
        return float("nan")
    half = peak / 2.0
    above = dip >= half
    peak_idx = int(np.argmax(dip))
    l = peak_idx
    r = peak_idx
    while l > 0 and above[l - 1]:
        l -= 1
    while r < len(above) - 1 and above[r + 1]:
        r += 1
    if r == l:
        return float("nan")
    # Linear interpolation at the half-maximum crossings.
    def _cross(i_in: int, i_out: int) -> float:
        y1, y2 = dip[i_in], dip[i_out]
        if abs(y2 - y1) < 1e-9:
            return float(s[i_in])
        t = (half - y1) / (y2 - y1)
        return float(s[i_in] + t * (s[i_out] - s[i_in]))

    left = _cross(l, max(0, l - 1)) if l > 0 else float(s[0])
    right = _cross(r, min(len(s) - 1, r + 1)) if r < len(s) - 1 else float(s[-1])
    return abs(right - left)


def dark_edge_gain(ref_gray: np.ndarray, test_gray: np.ndarray, region: np.ndarray) -> float:
    """How much faint dark structure the test image amplifies inside a region.

    ``ref_gray`` should be the *input* the restoration started from, so this
    measures amplification the restoration introduced, not blur.
    """
    ref = ops.gaussian_blur(ref_gray, 0.6)
    test = ops.gaussian_blur(test_gray, 0.6)
    g_ref = ops.gradient_magnitude(ref)
    g_test = ops.gradient_magnitude(test)
    m = np.asarray(region).astype(bool)
    if m.sum() == 0:
        return float("nan")
    vals = g_ref[m]
    thr = float(np.percentile(vals, 65))
    faint = m & (g_ref <= thr)
    if faint.sum() < 32:
        return float("nan")
    return float(np.median(g_test[faint]) / (np.median(g_ref[faint]) + 1e-6))


# ---------------------------------------------------------------------------
# Target checks
# ---------------------------------------------------------------------------

def _target_normal(t: dict) -> float:
    if t.get("kind") == "line":
        return (float(t.get("direction_deg", 0.0)) + 90.0) % 180.0
    return float(t.get("normal_deg", 0.0))


def _target_width(t: dict) -> float | None:
    if "width" in t:
        return float(t["width"])
    if "true_width" in t:
        return float(t["true_width"])
    return None


def check_targets(
    ref_gray: np.ndarray,
    test_gray: np.ndarray,
    targets: Sequence[dict],
    *,
    heldout_only: bool = True,
    region_mask: np.ndarray | None = None,
    inside_regions_only: bool = False,
) -> dict:
    """Compare edge widths, positions and line widths against the sharp sample.

    ``region_mask`` (bool/float array) selects the blurred/restored regions.  If
    ``inside_regions_only`` is True only targets inside it are evaluated, which
    is the right set to judge *improvement* (targets in untouched bands never
    change and trivially "pass"). If False, inside-region targets are tagged in
    the row so callers can split them out.
    """
    rows = []
    for t in targets:
        if heldout_only and not t.get("heldout", True):
            continue
        px, py = float(t["point"][0]), float(t["point"][1])
        h, w = ref_gray.shape
        inside = False
        if region_mask is not None and 0 <= int(py) < h and 0 <= int(px) < w:
            inside = bool(region_mask[int(py), int(px)] > 0.5)
        if inside_regions_only and not inside:
            continue
        if t.get("kind") == "line":
            nominal = _target_width(t)
            # Keep the sampling band tight for thin strokes so neighbouring
            # strokes of the same glyph do not contaminate the profile.
            hw = float(np.clip(2.5 * nominal + 2.0, 3.0, 10.0)) if nominal else 6.0
            ref_w = measure_line_width(
                ref_gray, tuple(t["point"]), float(t.get("direction_deg", 0.0)), halfwidth=hw
            )
            test_w = measure_line_width(
                test_gray, tuple(t["point"]), float(t.get("direction_deg", 0.0)), halfwidth=hw
            )
            row = {
                "id": t["id"],
                "kind": "line",
                "region": t.get("region"),
                "inside_region": inside,
                "nominal_width_px": nominal,
                "ref_width_px": _round(ref_w),
                "test_width_px": _round(test_w),
                "width_error_ref": _round(ref_w - nominal if nominal is not None else None),
                "width_error_test": _round(test_w - nominal if nominal is not None else None),
                "ok": bool(
                    nominal is not None and np.isfinite(test_w)
                    and abs(test_w - nominal) <= max(0.35, 0.22 * nominal)
                ),
            }
        else:
            normal = _target_normal(t)
            ref_m = measure_edge_at(ref_gray, tuple(t["point"]), normal)
            test_m = measure_edge_at(test_gray, tuple(t["point"]), normal)
            nominal = _target_width(t)
            row = {
                "id": t["id"],
                "kind": "edge",
                "region": t.get("region"),
                "inside_region": inside,
                "normal_deg": round(normal, 2),
                "ref_width_px": _round(ref_m.width_10_90),
                "test_width_px": _round(test_m.width_10_90),
                "width_delta_px": _round(test_m.width_10_90 - ref_m.width_10_90),
                "position_ref_px": _round(ref_m.position),
                "position_test_px": _round(test_m.position),
                "position_error_px": _round(abs(test_m.position - ref_m.position)),
                "contrast": _round(test_m.contrast),
                "ok": bool(
                    ref_m.ok and test_m.ok
                    and abs(test_m.width_10_90 - ref_m.width_10_90) <= 0.6
                    and abs(test_m.position - ref_m.position) <= 0.8
                ),
            }
        rows.append(row)
    summary = _summarise(rows)
    inside_rows = [r for r in rows if r.get("inside_region")]
    outside_rows = [r for r in rows if not r.get("inside_region")]
    summary["inside_region"] = _summarise(inside_rows)
    summary["outside_regions"] = _summarise(outside_rows)
    return {"rows": rows, "summary": summary}


def _round(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, 3) if np.isfinite(f) else None


def _summarise(rows: list[dict]) -> dict:
    if not rows:
        return {"count": 0}
    ok = [r for r in rows if r.get("ok")]
    width_deltas = [
        abs(r["width_delta_px"]) for r in rows
        if r.get("kind") == "edge" and r.get("width_delta_px") is not None
    ]
    pos_errors = [
        abs(r["position_error_px"]) for r in rows
        if r.get("kind") == "edge" and r.get("position_error_px") is not None
    ]
    line_errs = [
        abs(r["width_error_test"]) for r in rows
        if r.get("kind") == "line" and r.get("width_error_test") is not None
    ]
    out = {
        "count": len(rows),
        "passed": len(ok),
        "pass_rate": round(len(ok) / len(rows), 3),
    }
    if width_deltas:
        out["edge_width_abs_error_mean_px"] = round(float(np.mean(width_deltas)), 3)
        out["edge_width_abs_error_max_px"] = round(float(np.max(width_deltas)), 3)
    if pos_errors:
        out["edge_position_error_mean_px"] = round(float(np.mean(pos_errors)), 3)
        out["edge_position_error_max_px"] = round(float(np.max(pos_errors)), 3)
    if line_errs:
        out["line_width_abs_error_mean_px"] = round(float(np.mean(line_errs)), 3)
        out["line_width_abs_error_max_px"] = round(float(np.max(line_errs)), 3)
    return out


# ---------------------------------------------------------------------------
# Whole-image checks
# ---------------------------------------------------------------------------

def untouched_change(
    ref: np.ndarray,
    test: np.ndarray,
    region_mask: np.ndarray,
    *,
    tolerance: float = 1.0 / 255.0,
) -> dict:
    """How much the areas outside the restored regions changed."""
    if region_mask.sum() == 0:
        return {"mean_abs": 0.0, "max_abs": 0.0, "fraction_changed": 0.0}
    outside = region_mask <= 0.001
    diff = np.abs(np.asarray(ref, dtype=np.float32) - np.asarray(test, dtype=np.float32))
    if diff.ndim == 3:
        diff = diff.mean(axis=2)
    vals = diff[outside]
    if vals.size == 0:
        return {"mean_abs": 0.0, "max_abs": 0.0, "fraction_changed": 0.0}
    return {
        "mean_abs": round(float(np.mean(vals)), 6),
        "max_abs": round(float(np.max(vals)), 6),
        "fraction_changed": round(float(np.mean(vals > tolerance)), 6),
    }


def region_report(
    ref: np.ndarray,
    test: np.ndarray,
    mask: np.ndarray,
    *,
    dark_gain: float | None = None,
) -> dict:
    m = mask > 0.5
    if m.sum() < 16:
        return {"pixels": int(m.sum())}
    flat = flat_mask(ref) & m
    n_ref = noise_sigma(ref, flat) if flat.sum() > 64 else float("nan")
    n_test = noise_sigma(test, flat) if flat.sum() > 64 else float("nan")
    gain = dark_edge_gain(ref, test, m)
    return {
        "pixels": int(m.sum()),
        "flat_pixels": int(flat.sum()),
        "noise_ref": _round(n_ref),
        "noise_test": _round(n_test),
        "noise_amplification": _round(
            n_test / n_ref if np.isfinite(n_ref) and np.isfinite(n_test) and n_ref > 1e-6 else None
        ),
        "dark_edge_gain": _round(dark_gain if dark_gain is not None else gain),
        "psnr_db": round(psnr(ref, test), 2),
    }


def _gray_float(arr: np.ndarray) -> np.ndarray:
    a = np.asarray(arr, dtype=np.float32)
    if a.dtype == np.uint8:
        a = a / 255.0
    if a.ndim == 3:
        return (0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]).astype(np.float32)
    return a.astype(np.float32)


def full_report(
    ref: np.ndarray,
    test: np.ndarray,
    *,
    base: np.ndarray,
    regions: Sequence[Sequence[float]],
    effective_masks: Sequence[np.ndarray] | None = None,
    targets: Sequence[dict] | None = None,
) -> dict:
    """Assemble the full verification dict for one (ref, test) pair.

    ``ref`` is the sharp sample, ``test`` the restored image, and ``base`` the
    blurred input.  "Untouched" compares test vs base *outside* the applied
    mask, which is the correct invariance check (the rest of the image should
    still look like the input, not like a sharp reference it never was).
    """
    ref_g = _gray_float(ref)
    test_g = _gray_float(test)
    base_g = _gray_float(base)
    h, w = ref_g.shape
    if effective_masks:
        union = np.clip(np.max(np.stack(list(effective_masks), axis=0), axis=0), 0, 1).astype(np.float32)
        if union.shape != (h, w):
            union = np.zeros((h, w), dtype=np.float32)
    else:
        union = np.zeros((h, w), dtype=np.float32)
        for r in regions:
            union = np.maximum(union, ops.rect_mask((h, w), r, feather=0.0))
    report = {
        "psnr_db": round(psnr(ref_g, test_g), 2),
        "ssim": round(ssim(ref_g, test_g), 4),
        "noise_ref": _round(noise_sigma(ref_g)),
        "noise_test": _round(noise_sigma(test_g)),
        "untouched": untouched_change(base_g, test_g, union),
        "regions": [],
    }
    if targets:
        report["targets"] = check_targets(ref_g, test_g, targets, heldout_only=True)
    for i, r in enumerate(regions):
        m = ops.rect_mask((h, w), r, feather=0.0)
        report["regions"].append({"index": i, "rect": list(r), **region_report(ref_g, test_g, m)})
    return report


# ---------------------------------------------------------------------------
# Recovery curves across parameter settings (for the UI / CLI)
# ---------------------------------------------------------------------------

def recovery_curve(
    ref: np.ndarray,
    tests: Iterable[tuple[str, np.ndarray]],
    masks: Sequence[np.ndarray],
    targets: Sequence[dict] | None = None,
    *,
    base: np.ndarray | None = None,
) -> list[dict]:
    union = np.clip(np.max(np.stack(list(masks), axis=0), axis=0), 0, 1)
    base = ref if base is None else base
    base_g = _gray_float(base)
    rows = []
    for label, img in tests:
        row = {
            "label": label,
            "psnr_db": round(psnr(_gray_float(ref), _gray_float(img)), 2),
            "ssim": round(ssim(_gray_float(ref), _gray_float(img)), 4),
            "untouched_mean_abs": untouched_change(
                _gray_float(base), _gray_float(img), union
            )["mean_abs"],
        }
        if targets:
            checks = check_targets(_gray_float(ref), _gray_float(img), targets, heldout_only=True)
            row.update(checks["summary"])
        rows.append(row)
    return rows
