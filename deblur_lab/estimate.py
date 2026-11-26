"""Blur length / direction estimation from reference edges and the spectrum.

The estimator is deliberately transparent about what it depends on:

* a *reference edge* (clicked by the user) gives the projected blur width
  along the edge normal: ``W = g(L * |cos(theta - phi)| + t * |sin(theta - phi)|)``;
* several edges at different normals turn that into an over-determined
  ``(theta, L)`` grid solve;
* the Fourier spectrum supplies the missing direction when only one edge is
  usable, and a cross-check when several are;
* every result carries the search ranges, the frequency window/band, the
  edges used, and 1-sigma basin widths, so an unstable estimate is obvious
  and can be overridden by hand.

Angles are visual degrees, counter-clockwise from +x, wrapped to ``[0, 180)``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Sequence

import numpy as np

from . import ops

SQRT2 = math.sqrt(2.0)
INV_SQRT_2PI = 1.0 / math.sqrt(2.0 * math.pi)


# ---------------------------------------------------------------------------
# Edge profile model: step convolved with box(W) and Gaussian(sigma)
# ---------------------------------------------------------------------------

def _erf(x: np.ndarray | float) -> np.ndarray:
    """Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7)."""
    x = np.asarray(x, dtype=np.float64)
    sign = np.sign(x)
    ax = np.abs(x)
    t = 1.0 / (1.0 + 0.3275911 * ax)
    poly = (
        ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
        + 0.254829592
    ) * t
    return sign * (1.0 - poly * np.exp(-ax * ax))


def _phi(x: np.ndarray) -> np.ndarray:
    return INV_SQRT_2PI * np.exp(-0.5 * np.asarray(x, dtype=np.float64) ** 2)


def _cdf(x: np.ndarray) -> np.ndarray:
    return 0.5 * (1.0 + _erf(np.asarray(x, dtype=np.float64) / SQRT2))


def box_gauss_profile(s: np.ndarray, width: float, sigma: float) -> np.ndarray:
    """CDF of a uniform box of ``width`` convolved with a Gaussian ``sigma``."""
    s = np.asarray(s, dtype=np.float64)
    sigma = max(float(sigma), 1e-6)
    a = max(float(width), 0.0) / 2.0
    if a <= 1e-9:
        return _cdf(s / sigma)
    sp = (s + a) / sigma
    sm = (s - a) / sigma
    out = (s + a) * _cdf(sp) + sigma * _phi(sp) - (s - a) * _cdf(sm) - sigma * _phi(sm)
    out = out / (2.0 * a)
    return np.clip(out, 0.0, 1.0)


@lru_cache(maxsize=1)
def _width_table() -> tuple[np.ndarray, np.ndarray]:
    """10-90 width of ``step * box(r) * gauss(1)`` for r in [0, 120]."""
    sigma = 1.0
    ratios = np.linspace(0.0, 120.0, 241)
    widths = np.empty_like(ratios)
    for i, r in enumerate(ratios):
        a = r / 2.0
        span = a + 8.0 * sigma
        s = np.linspace(-span, span, 4001)
        profile = box_gauss_profile(s, r, sigma)
        lo, hi = float(profile[0]), float(profile[-1])
        a10, a90 = lo + 0.1 * (hi - lo), lo + 0.9 * (hi - lo)
        i10 = int(np.argmax(profile >= a10))
        i90 = int(np.argmax(profile >= a90))
        s10 = float(np.interp(a10, profile[max(0, i10 - 1):i10 + 1], s[max(0, i10 - 1):i10 + 1]))
        s90 = float(np.interp(a90, profile[max(0, i90 - 1):i90 + 1], s[max(0, i90 - 1):i90 + 1]))
        widths[i] = abs(s90 - s10)
    return ratios, widths


def base_sigma_from_width(width_10_90: float) -> float:
    """Camera/base 10-90 width -> equivalent Gaussian sigma."""
    return max(float(width_10_90), 0.6) / 2.563


def predicted_width(
    length: np.ndarray | float,
    angle_deg: np.ndarray | float,
    normal_deg: np.ndarray | float,
    thickness: float = 1.0,
    base_width: float = 1.4,
) -> np.ndarray | float:
    """Predicted 10-90 edge width for motion ``L`` at ``angle``."""
    sigma = base_sigma_from_width(base_width)
    alpha = np.radians(np.asarray(angle_deg) - np.asarray(normal_deg))
    box = np.asarray(length) * np.abs(np.cos(alpha)) + float(thickness) * np.abs(np.sin(alpha))
    ratios, widths = _width_table()
    r = np.clip(box / sigma, 0.0, ratios[-1])
    return sigma * np.interp(r, ratios, widths)


# ---------------------------------------------------------------------------
# Edge observations
# ---------------------------------------------------------------------------

@dataclass
class EdgeObservation:
    point: tuple[float, float]
    normal_deg: float
    width_10_90: float
    width_sigma: float
    contrast: float
    quality: float
    source: str = "auto"  # "auto" | "reference"
    weight: float = 1.0

    def to_dict(self) -> dict:
        return {
            "point": [round(float(self.point[0]), 2), round(float(self.point[1]), 2)],
            "normal_deg": round(float(self.normal_deg), 2),
            "width_10_90": round(float(self.width_10_90), 3),
            "width_sigma": round(float(self.width_sigma), 3),
            "contrast": round(float(self.contrast), 3),
            "quality": round(float(self.quality), 3),
            "source": self.source,
            "weight": float(self.weight),
        }


@dataclass
class SpectralResult:
    angle: float
    length: float
    angle_marginal: np.ndarray
    angles: np.ndarray
    modulation: np.ndarray
    length_scores: np.ndarray
    lengths: np.ndarray
    profile: np.ndarray
    profile_p: np.ndarray
    window: int
    band: tuple[float, float]
    angle_sigma: float
    length_sigma: float
    confident: bool
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "angle": round(float(self.angle), 2),
            "length": round(float(self.length), 2),
            "angle_sigma": round(float(self.angle_sigma), 2),
            "length_sigma": round(float(self.length_sigma), 2),
            "confident": bool(self.confident),
            "window": int(self.window),
            "band": [float(self.band[0]), float(self.band[1])],
            "notes": list(self.notes),
        }


@dataclass
class BlurEstimate:
    angle: float
    length: float
    angle_sigma: float
    length_sigma: float
    confidence: float
    stable: bool
    method: str
    edges: list[EdgeObservation]
    spectral: SpectralResult | None
    dependencies: dict
    warnings: list[str]
    cost: np.ndarray | None = None
    cost_angles: np.ndarray | None = None
    cost_lengths: np.ndarray | None = None
    angle_marginal: np.ndarray | None = None
    length_marginal: np.ndarray | None = None
    thickness: float = 1.0
    base_width: float = 1.4

    def to_dict(self) -> dict:
        return {
            "angle_deg": round(float(self.angle), 2),
            "length_px": round(float(self.length), 2),
            "angle_sigma_deg": round(float(self.angle_sigma), 2),
            "length_sigma_px": round(float(self.length_sigma), 2),
            "confidence": round(float(self.confidence), 3),
            "stable": bool(self.stable),
            "method": self.method,
            "thickness": float(self.thickness),
            "base_width_px": float(self.base_width),
            "edges": [e.to_dict() for e in self.edges],
            "spectral": self.spectral.to_dict() if self.spectral else None,
            "dependencies": _jsonable(self.dependencies),
            "warnings": list(self.warnings),
        }


def _jsonable(obj):
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return [None if not np.isfinite(v) else round(float(v), 5) for v in obj.tolist()]
    if isinstance(obj, (np.floating, np.integer)):
        return float(obj)
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    return obj


# ---------------------------------------------------------------------------
# Measuring an edge
# ---------------------------------------------------------------------------

def _profile_crossings(
    s: np.ndarray, profile: np.ndarray
) -> tuple[float, float, float, float, float] | None:
    """Return ``(s10, s50, s90, contrast, monotone_fraction)``."""
    n = profile.size
    if n < 8:
        return None
    k = max(3, int(round(0.14 * n)))
    lo = float(np.median(profile[:k]))
    hi = float(np.median(profile[-k:]))
    contrast = hi - lo
    if abs(contrast) < 1e-4:
        return None
    if contrast < 0:
        profile = lo + hi - profile
        lo, hi = hi, lo
        contrast = -contrast
    mid = 0.5 * (lo + hi)
    idx = np.where(profile >= mid)[0]
    if idx.size == 0:
        return None
    i50 = int(idx[0])
    if i50 == 0:
        return None
    s50 = float(np.interp(mid, profile[i50 - 1:i50 + 1], s[i50 - 1:i50 + 1]))

    def _right(level: float) -> float | None:
        sub, ss = profile[i50:], s[i50:]
        hits = np.where(sub >= level)[0]
        if hits.size == 0:
            return None
        j = int(hits[0])
        if j == 0:
            return float(ss[0])
        return float(np.interp(level, sub[j - 1:j + 1], ss[j - 1:j + 1]))

    def _left(level: float) -> float | None:
        sub, ss = profile[: i50 + 1][::-1], s[: i50 + 1][::-1]
        hits = np.where(sub <= level)[0]
        if hits.size == 0:
            return None
        j = int(hits[0])
        if j == 0:
            return float(ss[0])
        # ``sub`` / ``ss`` are reversed; interpolate, then return the coordinate.
        seg_p = sub[j - 1:j + 1][::-1]
        seg_s = ss[j - 1:j + 1][::-1]
        return float(np.interp(level, seg_p, seg_s))

    s10 = _left(lo + 0.1 * contrast)
    s90 = _right(lo + 0.9 * contrast)
    if s10 is None or s90 is None:
        return None
    a, b = min(s10, s90), max(s10, s90)
    sel = (s >= a) & (s <= b)
    if sel.sum() < 3:
        return None
    d = np.diff(profile[sel])
    mono = float(np.mean(d >= -0.02 * contrast)) if d.size else 0.0
    return s10, s50, s90, contrast, mono


def measure_edge(
    gray: np.ndarray,
    point: tuple[float, float],
    normal_deg: float,
    *,
    halfwidth: float = 18.0,
    n_profiles: int = 9,
    spacing: float = 2.0,
    refine: float = 6.0,
) -> EdgeObservation | None:
    """Measure a straight edge's 10-90 width along its normal.

    The normal is refined within +/- ``refine`` degrees, choosing the direction
    with the highest contrast/width ratio (i.e. the sharpest cross-section).
    """
    offsets = np.arange(-refine, refine + 1e-9, 1.0) if refine > 0 else [0.0]
    best: EdgeObservation | None = None
    best_sharp = -1.0
    for off in offsets:
        phi = float(normal_deg) + float(off)
        s, mean, stack = ops.sample_band_profiles(
            gray, point, phi, halfwidth, step=0.25, n_profiles=n_profiles, spacing=spacing
        )
        res = _profile_crossings(s, mean)
        if res is None:
            continue
        s10, s50, s90, contrast, mono = res
        width = abs(s90 - s10)
        if width < 0.25:
            continue
        sharp = contrast / max(width, 0.25)
        if sharp <= best_sharp * 1.0005:
            continue
        widths = []
        for row in stack:
            r = _profile_crossings(s, row)
            if r is not None:
                widths.append(abs(r[2] - r[0]))
        sig = (
            float(np.std(widths, ddof=1) / math.sqrt(len(widths)))
            if len(widths) >= 2
            else 0.5
        )
        best_sharp = sharp
        best = EdgeObservation(
            point=(float(point[0]), float(point[1])),
            normal_deg=phi % 180.0,
            width_10_90=float(width),
            width_sigma=float(max(sig, 0.1)),
            contrast=float(contrast),
            quality=float(mono * min(1.0, contrast / 0.15)),
        )
    return best


def snap_to_edge(
    gray: np.ndarray, point: tuple[float, float], radius: int = 10
) -> tuple[tuple[float, float], float, float] | None:
    """Snap a click to the strongest nearby edge; returns point, normal, strength."""
    h, w = gray.shape
    x0 = max(0, int(round(point[0])) - radius)
    x1 = min(w, int(round(point[0])) + radius + 1)
    y0 = max(0, int(round(point[1])) - radius)
    y1 = min(h, int(round(point[1])) + radius + 1)
    if x1 - x0 < 3 or y1 - y0 < 3:
        return None
    patch = ops.gaussian_blur(gray[y0:y1, x0:x1], 0.8)
    gx, gy = ops.gradient_xy(patch)
    mag = np.hypot(gx, gy)
    iy, ix = np.unravel_index(int(np.argmax(mag)), mag.shape)
    strength = float(mag[iy, ix])
    if strength < 0.01:
        return None
    cx, cy = x0 + ix, y0 + iy
    r = 5
    xs0, xs1 = max(0, cx - r), min(w, cx + r + 1)
    ys0, ys1 = max(0, cy - r), min(h, cy + r + 1)
    gp = ops.gaussian_blur(gray[ys0:ys1, xs0:xs1], 1.0)
    pgx, pgy = ops.gradient_xy(gp)
    yy, xx = np.mgrid[0:gp.shape[0], 0:gp.shape[1]]
    wgt = np.exp(-((xx - (cx - xs0)) ** 2 + (yy - (cy - ys0)) ** 2) / (2 * 3.0 ** 2))
    jxx = float(np.sum(wgt * pgx * pgx))
    jyy = float(np.sum(wgt * pgy * pgy))
    jxy = float(np.sum(wgt * pgx * pgy))
    theta = 0.5 * math.atan2(2.0 * jxy, jxx - jyy)
    normal = ops.vec_to_angle(math.cos(theta), math.sin(theta))
    return (float(cx), float(cy)), normal, strength


def detect_edges(
    gray: np.ndarray,
    rect: Sequence[float],
    *,
    count: int = 6,
    min_spacing: float = 30.0,
    min_contrast: float = 0.09,
    max_per_normal: int = 2,
    normal_bin: float = 20.0,
) -> list[EdgeObservation]:
    """Greedy detection of strong, well-separated, differently oriented edges."""
    h, w = gray.shape
    x0, y0, x1, y1 = ops.clamp_rect(rect, (h, w))
    if x1 - x0 < 24 or y1 - y0 < 24:
        return []
    crop = ops.gaussian_blur(gray[y0:y1, x0:x1], 0.8)
    gx, gy = ops.gradient_xy(crop)
    mag = np.hypot(gx, gy)
    local = _local_max(mag, 2)
    thr = max(float(np.percentile(mag, 88)), 0.012)
    ys, xs = np.where((mag >= thr) & local)
    if xs.size == 0:
        return []
    order = np.argsort(mag[ys, xs])[::-1]
    accepted: list[EdgeObservation] = []
    normals: list[float] = []
    for idx in order:
        px, py = float(xs[idx]), float(ys[idx])
        gxp, gyp = x0 + px, y0 + py
        if any(math.hypot(gxp - e.point[0], gyp - e.point[1]) < min_spacing for e in accepted):
            continue
        ang = ops.vec_to_angle(float(gx[int(py), int(px)]), float(gy[int(py), int(px)]))
        if sum(ops.angle_difference(ang, n) < normal_bin for n in normals) >= max_per_normal:
            continue
        obs = measure_edge(gray, (gxp, gyp), ang, halfwidth=17.0, n_profiles=7)
        if obs is None:
            continue
        if obs.contrast < min_contrast or obs.quality < 0.55:
            continue
        obs.point = (gxp, gyp)
        accepted.append(obs)
        normals.append(obs.normal_deg)
        if len(accepted) >= count:
            break
    return accepted


def _local_max(arr: np.ndarray, radius: int) -> np.ndarray:
    out = arr.copy()
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx == 0 and dy == 0:
                continue
            out = np.maximum(out, np.roll(np.roll(arr, dy, axis=0), dx, axis=1))
    return arr >= out


# ---------------------------------------------------------------------------
# Spectral estimate
# ---------------------------------------------------------------------------

def _bin_mean(values: np.ndarray, bins: np.ndarray, n_bins: int) -> tuple[np.ndarray, np.ndarray]:
    sums = np.bincount(bins, weights=values, minlength=n_bins)
    counts = np.bincount(bins, minlength=n_bins)
    prof = np.zeros(n_bins, dtype=np.float64)
    valid = counts > 0
    prof[valid] = sums[valid] / counts[valid]
    return prof, counts


def _spectral_patch(
    gray: np.ndarray, rect: Sequence[float] | None, window: int
) -> tuple[np.ndarray, int, int]:
    h, w = gray.shape
    size = int(min(window, w, h))
    if rect is not None:
        x0, y0, x1, y1 = ops.clamp_rect(rect, (h, w))
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        size = int(min(size, max(16, x1 - x0), max(16, y1 - y0)))
    else:
        cx, cy = w / 2.0, h / 2.0
    # Never exceed the image, and keep the patch a usable size.
    size = max(16, min(size, w, h))
    if size % 2:
        size -= 1
    size = max(16, size)
    xa = max(0, min(w - size, int(round(cx - size / 2.0))))
    ya = max(0, min(h - size, int(round(cy - size / 2.0))))
    return gray[ya:ya + size, xa:xa + size].astype(np.float32), xa, ya


def spectral_estimate(
    gray: np.ndarray,
    rect: Sequence[float] | None = None,
    *,
    window: int = 256,
    band: tuple[float, float] = (0.02, 0.45),
    angle_step: float = 1.0,
    length_range: tuple[float, float] = (2.0, 45.0),
    n_pbins: int = 40,
) -> SpectralResult | None:
    """Estimate blur direction/length from the orientation of spectral notches."""
    patch, _, _ = _spectral_patch(gray, rect, window)
    size = patch.shape[0]
    if patch.std() < 1e-3:
        return None
    win = np.outer(np.hanning(size), np.hanning(size)).astype(np.float32)
    detrended = patch - float(patch.mean())
    detrended = detrended - ops.gaussian_blur(detrended, 1.0)
    f = np.fft.fftshift(np.fft.fft2(detrended * win))
    power = np.log1p(np.abs(f).astype(np.float64))

    freqs = np.fft.fftshift(np.fft.fftfreq(size))
    fx, fy = np.meshgrid(freqs, freqs)
    radius = np.hypot(fx, fy)
    valid = (radius >= band[0]) & (radius <= band[1])
    if int(valid.sum()) < 200:
        return None

    # Whiten the 1/f trend by subtracting the radial mean inside the band.
    r_bins = np.clip((radius / (band[1] + 1e-9) * 48).astype(int), 0, 47)
    radial, counts = _bin_mean(power[valid], r_bins[valid], 48)
    centers = (np.arange(48) + 0.5) / 48.0 * (band[1] + 1e-9)
    baseline = np.interp(radius, centers, radial)
    whitened = power - baseline
    vals = whitened[valid]
    fxv, fyv = fx[valid], fy[valid]

    def mod_at(angle: float) -> float:
        _, m = _angular_modulation(vals, fxv, fyv, angle, band[1], n_pbins)
        return m

    angles = np.arange(0.0, 180.0, float(angle_step))
    mod = np.array([mod_at(float(a)) for a in angles], dtype=np.float64)

    coarse = int(np.argmax(mod))
    fine_angles = (angles[coarse] + np.arange(-1.0, 1.01, 0.25)) % 180.0
    fine_mod = np.array([mod_at(float(a)) for a in fine_angles], dtype=np.float64)
    theta = float(fine_angles[int(np.argmax(fine_mod))]) % 180.0

    dx, dy = ops.angle_to_vec(theta)
    p_abs = np.abs(fxv * dx + fyv * dy)
    bins = np.clip((p_abs / (band[1] + 1e-9) * 60).astype(int), 0, 59)
    prof, cnt = _bin_mean(vals, bins, 60)
    good = cnt > 3
    if good.sum() < 5:
        return None
    idx = np.arange(60)
    profile_filled = np.interp(idx, idx[good], prof[good])
    p_centers = (idx + 0.5) / 60.0 * (band[1] + 1e-9)

    def score_length(L: float) -> float:
        k = np.arange(1, int(max(1, math.floor(L * band[1] * 1.5))) + 1, dtype=np.float64)
        notch = k / L
        notch = notch[notch <= band[1]]
        mid = (k + 0.5) / L
        mid = mid[mid <= band[1]]
        if notch.size == 0 or mid.size == 0:
            return -1e9
        a = np.interp(notch / band[1] * 60.0 - 0.5, idx, profile_filled)
        b = np.interp(mid / band[1] * 60.0 - 0.5, idx, profile_filled)
        return float(np.mean(b) - np.mean(a))

    lengths = np.arange(length_range[0], length_range[1] + 1e-9, 0.25)
    scores = np.array([score_length(float(L)) for L in lengths], dtype=np.float64)
    best_L = float(lengths[int(np.argmax(scores))])

    peak = float(mod.max())
    med = float(np.median(mod))
    strength = 0.0 if abs(peak) < 1e-9 else max(0.0, min(1.0, (peak - med) / (abs(peak) + 1e-9)))
    sigma_angle = _halfmax_sigma(angles, mod, wrap=True) or 45.0
    sigma_len = _halfmax_sigma(lengths, scores, wrap=False) or 20.0
    notes: list[str] = []
    if _halfmax_sigma(angles, mod, wrap=True) is None:
        notes.append("角度调制曲线无单峰, 频谱方向不可靠")
    if _halfmax_sigma(lengths, scores, wrap=False) is None:
        notes.append("长度得分无单峰, 频谱长度不可靠")
    confident = bool(sigma_angle <= 10.0 and sigma_len <= 12.0 and strength > 0.08)
    angle_marginal = (mod - med) / (peak - med + 1e-9)
    return SpectralResult(
        angle=theta,
        length=best_L,
        angle_marginal=angle_marginal,
        angles=angles,
        modulation=mod,
        length_scores=scores,
        lengths=lengths,
        profile=profile_filled,
        profile_p=p_centers,
        window=size,
        band=band,
        angle_sigma=float(sigma_angle),
        length_sigma=float(sigma_len),
        confident=confident,
        notes=notes,
    )


def _angular_modulation(vals, fxv, fyv, angle, fmax, n_bins):
    dx, dy = ops.angle_to_vec(float(angle))
    p = np.abs(fxv * dx + fyv * dy)
    bins = np.clip((p / (fmax + 1e-9) * n_bins).astype(int), 0, n_bins - 1)
    prof, cnt = _bin_mean(vals, bins, n_bins)
    good = cnt > 0
    if good.sum() < 5:
        return prof, 0.0
    m = float(np.std(prof[good]) / (abs(np.mean(prof[good])) + 1.0))
    return prof, m


def _halfmax_sigma(x: np.ndarray, y: np.ndarray, wrap: bool) -> float | None:
    """Half-maximum width / 2.355 around the dominant peak."""
    if y.size < 5 or not np.all(np.isfinite(y)):
        return None
    peak = int(np.argmax(y))
    step = float(x[1] - x[0]) if x.size > 1 else 1.0
    if wrap:
        # Circular half-maximum run: walk out from the peak (wrapping) and keep
        # walking as long as the curve is still descending (no silent jumps).
        half = 0.5 * (float(y.max()) + float(y.min()))
        n = y.size

        def descend(direction: int) -> int:
            steps = 0
            best = float(y[peak])
            for k in range(1, n):
                idx = (peak + direction * k) % n
                val = float(y[idx])
                if val >= half:
                    steps = k
                    best = max(best, val)
                elif val <= best:
                    break
                else:
                    break
            return steps

        width = descend(1) + descend(-1)
        if width < 1:
            return None
        return float(width * step) / 2.355
    ys, xs = np.asarray(y, dtype=np.float64), np.asarray(x, dtype=np.float64)
    left = peak
    while left > 0 and ys[left - 1] <= ys[left]:
        left -= 1
    right = peak
    while right < len(ys) - 1 and ys[right + 1] <= ys[right]:
        right += 1
    xs, ys = xs[left:right + 1], ys[left:right + 1]
    peak = int(np.argmax(ys))
    if ys.size < 3:
        return None
    half = 0.5 * (float(ys[peak]) + float(np.min(ys)))
    above = ys >= half
    l = peak
    while l > 0 and above[l - 1]:
        l -= 1
    r = peak
    while r < len(ys) - 1 and above[r + 1]:
        r += 1
    if r - l < 1:
        return None
    return abs(float(xs[r] - xs[l])) / 2.355


# ---------------------------------------------------------------------------
# Joint grid solve
# ---------------------------------------------------------------------------

def _grid_solve(
    edges: Sequence[EdgeObservation],
    *,
    thickness: float,
    base_width: float,
    angle_step: float = 1.0,
    length_range: tuple[float, float] = (1.0, 45.0),
    length_step: float = 0.5,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    angles = np.arange(0.0, 180.0, angle_step)
    lengths = np.arange(length_range[0], length_range[1] + 1e-9, length_step)
    cost = np.zeros((angles.size, lengths.size), dtype=np.float64)
    A = angles[:, None]
    L = lengths[None, :]
    denom = 0.0
    for e in edges:
        pred = predicted_width(L, A, e.normal_deg, thickness, base_width)
        sigma = max(float(e.width_sigma), 0.12)
        cost += float(e.weight) * ((pred - e.width_10_90) / sigma) ** 2
        denom += float(e.weight)
    if denom > 0:
        cost /= denom
    return angles, lengths, cost, np.sqrt(cost)


def _cost_sigma(
    x: np.ndarray, marginal_cost: np.ndarray, delta: float = 1.0, wrap: bool = False
) -> float | None:
    """1-sigma half-width where the marginal cost rises by ``delta``.

    Walks away from the minimum on both sides, interpolating the crossing.
    ``x`` must be evenly spaced; ``wrap`` means the axis is periodic in 180 deg.
    """
    c = np.asarray(marginal_cost, dtype=np.float64)
    n = c.size
    if n < 5 or not np.all(np.isfinite(c)):
        return None
    peak = int(np.argmin(c))
    base = float(c[peak])
    step = float(x[1] - x[0]) if n > 1 else 1.0

    def walk(direction: int) -> float:
        prev_val = base
        for k in range(1, n):
            j = peak + direction * k
            if wrap:
                j %= n
            elif j < 0 or j >= n:
                return float(k - 1) * step
            val = float(c[j]) - base
            if val >= delta:
                if abs(val - prev_val) < 1e-12:
                    t = 0.5
                else:
                    t = (delta - prev_val) / (val - prev_val)
                return (k - 1 + t) * step
            prev_val = val
        return float(n - 1) * step

    left = walk(-1)
    right = walk(1)
    return 0.5 * (left + right)


def _marginals(
    angles: np.ndarray, lengths: np.ndarray, cost: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    return cost.min(axis=1), cost.min(axis=0)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def estimate_region(
    gray: np.ndarray,
    rect: Sequence[float],
    *,
    ref_point: tuple[float, float] | None = None,
    ref_normal: float | None = None,
    thickness: float = 1.0,
    base_width: float = 1.4,
    spectral_window: int = 256,
    spectral_band: tuple[float, float] = (0.02, 0.45),
    length_range: tuple[float, float] = (1.0, 45.0),
    max_edges: int = 6,
    use_auto_edges: bool = True,
) -> BlurEstimate:
    """Estimate ``(angle, length)`` for one region, with full provenance."""
    x0, y0, x1, y1 = ops.clamp_rect(rect, gray.shape)
    rect = (x0, y0, x1, y1)
    rect_w, rect_h = x1 - x0, y1 - y0
    ref_point = tuple(map(float, ref_point)) if ref_point is not None else None

    edges: list[EdgeObservation] = []
    if use_auto_edges:
        edges = detect_edges(
            gray,
            rect,
            count=max_edges,
            min_spacing=max(18.0, min(34.0, 0.17 * min(rect_w, rect_h))),
        )
    if ref_point is not None:
        rp, rn = ref_point, (float(ref_normal) if ref_normal is not None else None)
        if rn is None:
            snapped = snap_to_edge(gray, rp)
            if snapped is not None:
                rp, rn, _ = snapped
        if rn is not None:
            obs = measure_edge(gray, rp, rn, halfwidth=20.0, n_profiles=11, spacing=1.5)            if obs is not None:
                obs.point = rp
                obs.source = "reference"
                obs.weight = 1.8
                edges = [e for e in edges if math.hypot(e.point[0] - rp[0], e.point[1] - rp[1]) > 18.0]
                edges.insert(0, obs)
            else:
                edges = [e for e in edges if math.hypot(e.point[0] - rp[0], e.point[1] - rp[1]) > 18.0]
        else:
            edges = [e for e in edges if math.hypot(e.point[0] - rp[0], e.point[1] - rp[1]) > 18.0]

    spectral = None
    spectral_error = None
    try:
        spectral = spectral_estimate(
            gray, rect, window=spectral_window, band=spectral_band, length_range=length_range
        )
    except Exception as exc:  # noqa: BLE001 - estimation must never kill the app
        spectral_error = repr(exc)

    warnings: list[str] = []
    if spectral_error:
        warnings.append(f"频谱估计失败: {spectral_error}")

    dep: dict = {
        "rect": [int(v) for v in rect],
        "reference_point": [round(ref_point[0], 2), round(ref_point[1], 2)] if ref_point else None,
        "reference_normal_deg": round(float(ref_normal), 2) if ref_normal is not None else None,
        "base_width_px": float(base_width),
        "thickness_px": float(thickness),
        "edges": [e.to_dict() for e in edges],
        "normal_spread_deg": _normal_spread([e.normal_deg for e in edges]),
        "spectral": {
            "window": int(spectral.window) if spectral else None,
            "band": list(spectral.band) if spectral else list(spectral_band),
            "angle_sigma_deg": round(float(spectral.angle_sigma), 2) if spectral else None,
            "length_sigma_px": round(float(spectral.length_sigma), 2) if spectral else None,
            "confident": bool(spectral.confident) if spectral else False,
            "notes": list(spectral.notes) if spectral else [],
        },
        "search": {
            "angle_range_deg": [0.0, 180.0],
            "angle_step_deg": 1.0,
            "length_range_px": [float(length_range[0]), float(length_range[1])],
            "length_step_px": 0.5,
            "cost": "mean weighted squared edge-width residual (1 sigma = +1)",
        },
    }

    state: dict = {}

    def _adopt(angle, length, a_sig, l_sig, method, confidence, stable, grid=None):
        if grid is not None:
            ga, gl, gc, _ = grid
            state["angles"] = ga
            state["lengths"] = gl
            state["cost"] = gc
            state["angle_marginal"], state["length_marginal"] = _marginals(ga, gl, gc)
        return BlurEstimate(
            angle=float(angle) % 180.0,
            length=float(length),
            angle_sigma=float(a_sig),
            length_sigma=float(l_sig),
            confidence=float(confidence),
            stable=bool(stable),
            method=method,
            edges=list(edges),
            spectral=spectral,
            dependencies=dep,
            warnings=list(warnings),
            cost=state.get("cost"),
            cost_angles=state.get("angles"),
            cost_lengths=state.get("lengths"),
            angle_marginal=state.get("angle_marginal"),
            length_marginal=state.get("length_marginal"),
            thickness=float(thickness),
            base_width=float(base_width),
        )

    grid = _grid_solve(edges, thickness=thickness, base_width=base_width,
                       length_range=length_range) if edges else None
    if grid is not None:
        ga, gl, gc, _ = grid
        am, lm = _marginals(ga, gl, gc)
        a_sig = _cost_sigma(ga, am, wrap=True) or 90.0
        l_sig = _cost_sigma(gl, lm, wrap=False) or 45.0
        stable = a_sig <= 4.5 and l_sig <= 2.5 and len(edges) >= 2
        conf = _confidence(a_sig, l_sig, len(edges))
        dep["cost_min"] = float(np.min(gc))
        dep["angle_sigma_from_edges_deg"] = round(float(a_sig), 2)
        dep["length_sigma_from_edges_px"] = round(float(l_sig), 2)
        dep["marginals"] = {
            "angles_deg": _jsonable(ga),
            "lengths_px": _jsonable(gl),
            "angle_cost": _jsonable(am),
            "length_cost": _jsonable(lm),
        }
        dep["cost_grid_shape"] = [int(gc.shape[0]), int(gc.shape[1])]

        i, j = np.unravel_index(int(np.argmin(gc)), gc.shape)
        best_angle, best_length = float(ga[i]), float(gl[j])

        # With >= 2 differently-oriented edges the grid solve is the primary
        # evidence; only use the spectrum as a cross-check, never to override
        # it.  (A texture/small-text low-frequency image can dominate the
        # spectrum with unrelated directions.)
        if len(edges) >= 2:
            spread = _normal_spread([e.normal_deg for e in edges])
            dep["normal_spread_deg_resolved"] = spread
            if spectral is not None and spectral.confident:
                delta = ops.angle_difference(best_angle, spectral.angle)
                dep["spectral_angle_delta_deg"] = round(float(delta), 2)
                if delta > 18.0:
                    warnings.append(
                        f"边缘方向 {best_angle:.0f}° 与频谱方向 {spectral.angle:.0f}° 相差 "
                        f"{delta:.0f}°, 建议核对参考边或手填"
                    )
                    conf *= 0.6
            if spread < 12.0:
                # All edges share one normal: still under-determined.
                warnings.append(
                    f"可用边法线差仅 {spread:.0f}°, 方向/长度仍不可唯一确定; 可手填"
                )
                conf = min(conf, 0.25)
                return _adopt(
                    best_angle, best_length, a_sig, l_sig,
                    "edges-single-direction", conf, False, grid,
                )
            stable = a_sig <= 4.5 and l_sig <= 2.5
            if not stable:
                warnings.append("边缘约束给出的不确定度偏大, 建议核对或手填")
            return _adopt(best_angle, best_length, a_sig, l_sig, "edges", conf, stable, grid)

        if len(edges) == 1 and spectral is not None and spectral.confident:
            e = edges[0]
            Ls = np.arange(length_range[0], length_range[1] + 1e-9, 0.1)
            pred = predicted_width(Ls, spectral.angle, e.normal_deg, thickness, base_width)
            cc = ((pred - e.width_10_90) / max(e.width_sigma, 0.12)) ** 2
            k = int(np.argmin(cc))
            l_sig_s = _cost_sigma(Ls, cc) or 20.0
            conf = 0.55
            if cc[k] > 9.0:
                warnings.append("参考边宽度与频谱方向不自洽, 长度可信度低")
                conf = 0.25
            dep["spectral_length_sigma_px"] = round(float(l_sig_s), 2)
            dep["edge_length_cost"] = _jsonable(cc)
            dep["edge_length_axis"] = _jsonable(Ls)
            return _adopt(spectral.angle, float(Ls[k]), spectral.angle_sigma,
                          l_sig_s, "spectrum-angle+edge-length", conf, False, grid)

        if spectral is not None:
            if len(edges) == 1:
                e = edges[0]
                Ls = np.arange(length_range[0], length_range[1] + 1e-9, 0.1)
                pred = predicted_width(Ls, spectral.angle, e.normal_deg, thickness, base_width)
                cc = ((pred - e.width_10_90) / max(e.width_sigma, 0.12)) ** 2
                k = int(np.argmin(cc))
                length = float(Ls[k])
                l_sig = _cost_sigma(Ls, cc) or 20.0
            else:
                length = best_length
                l_sig = 20.0
            warnings.append("边缘约束不足以同时定出方向和长度, 已用频谱补方向; 结果不稳, 可手填")
            conf = 0.35 if spectral.confident else 0.2
            return _adopt(spectral.angle, length, spectral.angle_sigma, l_sig,
                          "spectrum-fallback", conf, False, grid)

        warnings.append("只有一条参考边且频谱不可靠: 方向/长度不可唯一确定, 请手填")
        return _adopt(best_angle, best_length, a_sig, l_sig, "edges-only-unstable", 0.1, False, grid)

    if spectral is not None and spectral.confident:
        return _adopt(spectral.angle, spectral.length, spectral.angle_sigma,
                      spectral.length_sigma, "spectrum", 0.5, False, None)
    warnings.append("未找到可用边缘, 频谱也不可靠; 请点选清晰的边或手填参数")
    if spectral is not None:
        return _adopt(spectral.angle, spectral.length, spectral.angle_sigma,
                      spectral.length_sigma, "spectrum-unstable", 0.05, False, None)
    return _adopt(0.0, 1.0, 90.0, 45.0, "manual-required", 0.0, False, None)


def _normal_spread(normals: Sequence[float]) -> float:
    best = 0.0
    for i in range(len(normals)):
        for j in range(i + 1, len(normals)):
            best = max(best, ops.angle_difference(normals[i], normals[j]))
    return round(best, 2)


def _confidence(a_sig: float, l_sig: float, n_edges: int) -> float:
    ca = max(0.0, min(1.0, 1.0 - a_sig / 20.0))
    cl = max(0.0, min(1.0, 1.0 - l_sig / 12.0))
    cn = min(1.0, 0.35 + 0.2 * n_edges)
    return float(ca * cl * cn)


# ---------------------------------------------------------------------------
# Convenience
# ---------------------------------------------------------------------------

def fit_pair_from_edges(
    measurements: Sequence[tuple[float, float]],
    *,
    thickness: float = 1.0,
    base_width: float = 1.4,
) -> tuple[float, float]:
    """Given ``(normal_deg, width)`` pairs, return the best ``(angle, length)``."""
    edges = [EdgeObservation((0.0, 0.0), n, w, 0.2, 0.5, 1.0) for n, w in measurements]
    angles, lengths, cost, _ = _grid_solve(
        edges, thickness=thickness, base_width=base_width, length_range=(1.0, 50.0)
    )
    i, j = np.unravel_index(int(np.argmin(cost)), cost.shape)
    return float(angles[i]), float(lengths[j])


_ = SQRT2  # kept for callers that import it

__all__ = [
    "predicted_width",
    "box_gauss_profile",
    "base_sigma_from_width",
    "EdgeObservation",
    "SpectralResult",
    "BlurEstimate",
    "measure_edge",
    "snap_to_edge",
    "detect_edges",
    "spectral_estimate",
    "estimate_region",
    "fit_pair_from_edges",
]
