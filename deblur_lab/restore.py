"""Region-limited Richardson-Lucy restoration with explicit guards.

Design points:

* only the selected region (plus a reflected-context margin) is restored, then
  blended back through a feathered mask, so untouched pixels stay byte-identical;
* a *flat-area guard* fades the correction out where local variance says there
  is no real structure — the main knob against amplifying noise and faint edges;
* an optional noise floor and a denoise pre-pass further tame amplification;
* a per-pixel correction clamp prevents RL ringing from overshooting;
* overlapping regions are composited in a fixed, user-declared order and the
  *effective* mask of each region is returned so the UI can show what was
  really applied (regions stay disjoint after compositing).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

from . import ops


@dataclass
class RestoreParams:
    iterations: int = 24
    damp: float = 0.85
    prior_sigma: float = 0.6
    detail_guard: float = 0.55        # 0..1, how strongly flat areas are protected
    noise_floor: float = 0.0          # 0..1: values within this of the local mean are damped
    denoise_sigma: float = 0.0        # pre-pass gaussian (0 = off)
    gain_limit: float = 3.5           # max pixel correction, in units of 3*noise_sigma
    edge_boost: float = 0.0           # extra gain on strong gradients (0 = off)
    psf_thickness: float = 1.0
    psf_profile: str = "box"
    psf_angle_offset: float = 0.0

    def to_dict(self) -> dict:
        return {
            "iterations": int(self.iterations),
            "damp": float(self.damp),
            "prior_sigma": float(self.prior_sigma),
            "detail_guard": float(self.detail_guard),
            "noise_floor": float(self.noise_floor),
            "denoise_sigma": float(self.denoise_sigma),
            "gain_limit": float(self.gain_limit),
            "edge_boost": float(self.edge_boost),
            "psf_thickness": float(self.psf_thickness),
            "psf_profile": self.psf_profile,
            "psf_angle_offset": float(self.psf_angle_offset),
        }


@dataclass
class Region:
    name: str
    rect: tuple[int, int, int, int]
    angle: float
    length: float
    order: int = 0
    feather: float = 8.0
    thickness: float = 1.0
    profile: str = "box"
    enabled: bool = True
    source: str = "manual"  # "manual" | "estimated"
    estimate: dict | None = None

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "rect": [int(v) for v in self.rect],
            "angle_deg": float(self.angle),
            "length_px": float(self.length),
            "order": int(self.order),
            "feather_px": float(self.feather),
            "thickness_px": float(self.thickness),
            "profile": self.profile,
            "enabled": bool(self.enabled),
            "source": self.source,
            "estimate": self.estimate,
        }


@dataclass
class RestoreResult:
    image: np.ndarray
    base: np.ndarray
    residual: np.ndarray
    masks: list[np.ndarray]
    effective_masks: list[np.ndarray]
    params: RestoreParams
    regions: list[Region]
    detail_weight: np.ndarray | None = None
    clipped_fraction: float = 0.0
    notes: list[str] = field(default_factory=list)

    def apply_mask_union(self) -> np.ndarray:
        if not self.effective_masks:
            return np.zeros(self.base.shape[:2], dtype=np.float32)
        return np.clip(np.max(np.stack(self.effective_masks, axis=0), axis=0), 0, 1)

    def effective_for(self, names: Sequence[str]) -> np.ndarray:
        """Union of the effective masks of the named regions."""
        if not self.effective_masks:
            return np.zeros(self.base.shape[:2], dtype=np.float32)
        wanted = set(names)
        chosen = [
            m for m, r in zip(self.effective_masks, self.regions)
            if r.enabled and r.name in wanted
        ]
        if not chosen:
            return np.zeros(self.base.shape[:2], dtype=np.float32)
        return np.clip(np.max(np.stack(chosen, axis=0), axis=0), 0, 1)


# ---------------------------------------------------------------------------
# Richardson-Lucy
# ---------------------------------------------------------------------------

def richardson_lucy(
    image: np.ndarray,
    psf: np.ndarray,
    *,
    iterations: int = 24,
    damp: float = 0.85,
    prior_sigma: float = 0.6,
    clip_min: float = 1e-4,
) -> np.ndarray:
    """Standard RL on a single channel, with reflected boundary handling."""
    image = np.asarray(image, dtype=np.float32)
    img = np.clip(image, clip_min, 1.0)
    est = gaussian_prior(img, prior_sigma)
    est = np.clip(est, clip_min, 1.0)
    psf_t = np.ascontiguousarray(psf[::-1, ::-1])
    damp = float(np.clip(damp, 0.05, 1.0))
    for _ in range(int(max(iterations, 0))):
        conv = np.clip(ops.convolve_psf(est, psf), clip_min, None)
        ratio = img / conv
        corr = ops.convolve_psf(ratio, psf_t)
        est = np.clip(est * np.power(np.clip(corr, 1e-6, None), damp), clip_min, 1.0)
    return est.astype(np.float32)


def gaussian_prior(image: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return np.asarray(image, dtype=np.float32)
    return ops.gaussian_blur(image, sigma)


def _detail_weight(image: np.ndarray, guard: float) -> np.ndarray:
    """0..1 weight: 1 where there is real structure, lower in flat/noisy areas."""
    if guard <= 0:
        return np.ones_like(image, dtype=np.float32)
    local = ops.local_std(image, 2)
    grad = ops.gradient_magnitude(ops.gaussian_blur(image, 0.7))
    structure = np.maximum(local, grad * 0.8)
    # Scale relative to the image's own contrast so the guard is content-neutral.
    rng = float(np.percentile(structure, 99)) + 1e-6
    t = np.clip(structure / (0.12 * rng + 1e-6) - 0.35, 0.0, 1.0)
    w = ops.smoothstep(t)
    return (1.0 - guard * (1.0 - w)).astype(np.float32)


def restore_channel(
    image: np.ndarray,
    psf: np.ndarray,
    params: RestoreParams,
    noise_sigma: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Restore one channel; returns ``(result, detail_weight)``."""
    src = np.asarray(image, dtype=np.float32)
    work = src
    if params.denoise_sigma > 0:
        work = ops.gaussian_blur(work, params.denoise_sigma)
    restored = richardson_lucy(
        work,
        psf,
        iterations=params.iterations,
        damp=params.damp,
        prior_sigma=params.prior_sigma,
    )
    detail = _detail_weight(work, params.detail_guard)
    delta = restored - work
    # Clamp the per-pixel correction so ringing/overshoot cannot run away.
    limit = params.gain_limit * max(noise_sigma * 3.0, 0.01)
    delta = np.clip(delta, -limit, limit)
    if params.edge_boost > 0:
        g = ops.gradient_magnitude(ops.gaussian_blur(src, 0.8))
        boost = params.edge_boost * np.clip(g / (np.percentile(g, 95) + 1e-6), 0, 1)
        delta = delta * (1.0 + boost)
    corrected = src + delta * detail
    if params.noise_floor > 0:
        med = ops.local_mean(src, 1)
        near = np.abs(src - med) < params.noise_floor
        corrected = np.where(near, med + (corrected - med) * 0.25, corrected)
    return np.clip(corrected, 0.0, 1.0).astype(np.float32), detail.astype(np.float32)


# ---------------------------------------------------------------------------
# Region pipeline
# ---------------------------------------------------------------------------

def _psf_for(region: Region, params: RestoreParams) -> np.ndarray:
    return ops.psf_line(
        max(float(region.length), 0.0),
        float(region.angle) + params.psf_angle_offset,
        max(float(region.thickness), float(params.psf_thickness), 0.5),
        params.psf_profile or region.profile,
    )


def restore_region(
    rgb: np.ndarray,
    region: Region,
    params: RestoreParams,
    *,
    noise_sigma: float = 0.012,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Restore a single region; returns full-size ``(image, mask, detail)``.

    Pixels outside the region are copied through unchanged.
    """
    rgb = np.asarray(rgb, dtype=np.float32)
    h, w = rgb.shape[:2]
    context = max(10, int(round(region.length + 6 * max(region.thickness, 1.0))))
    crop, inner, (pad_l, pad_t) = ops.crop_with_pad(rgb, region.rect, context)
    psf = _psf_for(region, params)
    rect_h = inner[3] - inner[1]
    rect_w = inner[2] - inner[0]

    result_crop = np.empty_like(crop, dtype=np.float32)
    detail_acc = np.zeros(crop.shape[:2], dtype=np.float32)
    for c in range(rgb.shape[2]):
        out, det = restore_channel(crop[..., c], psf, params, noise_sigma)
        result_crop[..., c] = out
        detail_acc += det / rgb.shape[2]

    full = rgb.copy()
    full[inner[1]:inner[3], inner[0]:inner[2]] = result_crop[
        pad_t:pad_t + rect_h, pad_l:pad_l + rect_w
    ]
    mask = ops.feather_mask(
        ops.rect_mask((h, w), inner, feather=0.0), region.feather
    )
    detail_full = np.zeros((h, w), dtype=np.float32)
    detail_full[inner[1]:inner[3], inner[0]:inner[2]] = detail_acc[
        pad_t:pad_t + rect_h, pad_l:pad_l + rect_w
    ]
    return full, mask, detail_full


def restore_multi(
    rgb: np.ndarray,
    regions: Sequence[Region],
    params: RestoreParams | None = None,
    *,
    noise_sigma: float = 0.012,
) -> RestoreResult:
    """Restore several regions and composite them in a deterministic order."""
    params = params or RestoreParams()
    rgb = np.asarray(rgb, dtype=np.float32)
    active = [r for r in regions if r.enabled]
    if not active:
        return RestoreResult(
            image=rgb.copy(),
            base=rgb.copy(),
            residual=np.zeros_like(rgb),
            masks=[],
            effective_masks=[],
            params=params,
            regions=list(regions),
            detail_weight=np.zeros(rgb.shape[:2], dtype=np.float32),
        )
    images, masks, details = [], [], []
    for r in active:
        img, mask, det = restore_region(rgb, r, params, noise_sigma=noise_sigma)
        images.append(img)
        masks.append(mask)
        details.append(det)
    result, effective = ops.compose_ordered(rgb, images, masks, [r.order for r in active])
    detail_full = np.zeros(rgb.shape[:2], dtype=np.float32)
    for eff, det in zip(effective, details):
        detail_full += eff * det
    residual = (rgb - result).astype(np.float32)
    clipped = float(np.mean(np.any((result <= 1e-4) | (result >= 1 - 1e-4), axis=-1)))
    notes = []
    if len(active) > 1:
        notes.append("重叠区域按 order 从小到大依次覆盖, 后应用者优先")
    return RestoreResult(
        image=result.astype(np.float32),
        base=rgb.copy(),
        residual=residual,
        masks=masks,
        effective_masks=effective,
        params=params,
        regions=list(regions),
        detail_weight=detail_full,
        clipped_fraction=clipped,
        notes=notes,
    )


def composition_masks(
    shape: tuple[int, int], regions: Sequence[Region]
) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Return ``(requested_masks, effective_masks)`` for enabled regions.

    Requested masks are feathered rectangles; effective masks are disjoint and
    encode what is actually applied after order resolution.
    """
    active = [r for r in regions if r.enabled]
    requested = [ops.rect_mask(shape, r.rect, feather=r.feather) for r in active]
    remaining = np.ones(shape, dtype=np.float32)
    effective: list[np.ndarray | None] = [None] * len(active)
    for idx in sorted(range(len(active)), key=lambda i: (active[i].order, i)):
        effective[idx] = np.clip(requested[idx], 0, 1) * remaining
        remaining *= 1.0 - np.clip(requested[idx], 0, 1)
    return requested, [e if e is not None else np.zeros(shape, dtype=np.float32) for e in effective]


def applied_map(shape: tuple[int, int], regions: Sequence[Region]) -> np.ndarray:
    """Integer map: 0 = untouched, k = applied by the k-th enabled region."""
    active = [r for r in regions if r.enabled]
    out = np.zeros(shape, dtype=np.int16)
    remaining = np.ones(shape, dtype=bool)
    for idx in sorted(range(len(active)), key=lambda i: (active[i].order, i)):
        m = ops.rect_mask(shape, active[idx].rect, feather=0.0) > 0.5
        out[m & remaining] = idx + 1
        remaining &= ~m
    return out


def overlap_count(shape: tuple[int, int], regions: Sequence[Region]) -> np.ndarray:
    active = [r for r in regions if r.enabled]
    count = np.zeros(shape, dtype=np.int16)
    for r in active:
        count += (ops.rect_mask(shape, r.rect, feather=0.0) > 0.5).astype(np.int16)
    return count
