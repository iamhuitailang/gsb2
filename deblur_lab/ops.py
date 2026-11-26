"""Numerical image operations used by the deblur lab.

Only numpy and Pillow are required.  Image arrays are float32 in ``[0, 1]``
unless their name says ``uint8``.  Coordinates are ``(x, y)`` in image
array space (x right, y down).  Angles are *visual* degrees, counter-clockwise
from +x, so an angle of 30 degrees points up-right on screen.  Inside an array
that direction is ``(cos a, -sin a)``.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
from PIL import Image, ImageOps

EPS = 1e-8
try:  # Pillow >= 9.1
    RESAMPLE_LANCZOS = Image.Resampling.LANCZOS
    RESAMPLE_BICUBIC = Image.Resampling.BICUBIC
except AttributeError:  # pragma: no cover - very old Pillow
    RESAMPLE_LANCZOS = Image.LANCZOS
    RESAMPLE_BICUBIC = Image.BICUBIC


# ---------------------------------------------------------------------------
# IO
# ---------------------------------------------------------------------------

def load_rgb(path: str | Path) -> np.ndarray:
    """Load an image as ``uint8`` RGB, honouring EXIF orientation."""
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    return np.asarray(im.convert("RGB"), dtype=np.uint8)


def load_gray(path: str | Path) -> np.ndarray:
    return rgb_to_gray(load_rgb(path))


def save_rgb(path: str | Path, rgb: np.ndarray) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    arr = np.clip(np.asarray(rgb), 0, 255).astype(np.uint8)
    Image.fromarray(arr).save(path)


def save_gray(path: str | Path, gray: np.ndarray, *, scale: float = 1.0) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    arr = np.clip(np.asarray(gray) * scale * 255.0, 0, 255).astype(np.uint8)
    Image.fromarray(arr).save(path)


def rgb_to_gray(rgb: np.ndarray) -> np.ndarray:
    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    if arr.ndim == 2:
        return arr
    return (0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]).astype(np.float32)


def gray_to_rgb(gray: np.ndarray) -> np.ndarray:
    g = np.clip(np.asarray(gray, dtype=np.float32), 0, 1)
    return np.repeat(g[..., None], 3, axis=2)


def resize_rgb(rgb: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    im = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    return np.asarray(im.resize(size, RESAMPLE_LANCZOS), dtype=np.uint8)


def to_uint8(arr: np.ndarray) -> np.ndarray:
    return np.clip(np.asarray(arr) * 255.0, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# Kernels and convolution
# ---------------------------------------------------------------------------

def angle_to_vec(angle_deg: float) -> tuple[float, float]:
    """Visual angle -> array-space unit vector."""
    a = math.radians(angle_deg)
    return math.cos(a), -math.sin(a)


def vec_to_angle(dx: float, dy: float) -> float:
    """Array-space vector -> visual angle in degrees, wrapped to [0, 180)."""
    ang = math.degrees(math.atan2(-dy, dx)) % 180.0
    return ang


def wrap_angle_180(angle_deg: float) -> float:
    return float(angle_deg) % 180.0


def angle_difference(a: float, b: float) -> float:
    """Smallest absolute difference between two unsigned directions."""
    d = abs((float(a) - float(b)) % 180.0)
    return min(d, 180.0 - d)


def psf_line(
    length: float,
    angle_deg: float,
    thickness: float = 1.0,
    profile: str = "box",
) -> np.ndarray:
    """Anti-aliased line PSF.

    ``length`` is the full support length in pixels (1.0 -> delta).  ``profile``
    is one of ``box``, ``tent`` or ``gauss`` along the motion axis.  The kernel
    is odd-sized, centred, and normalised to sum to one.
    """
    length = max(float(length), 0.0)
    thickness = max(float(thickness), 1.0)
    profile = profile.lower()

    # Enough room for the line plus its thickness, always odd.
    n = int(math.ceil(max(length, 1.0) + thickness)) + 2
    if n % 2 == 0:
        n += 1
    center = n // 2
    kernel = np.zeros((n, n), dtype=np.float64)

    if length <= 1e-6:
        # Pure delta, optionally thickened.
        if thickness <= 1.0:
            kernel[center, center] = 1.0
            return (kernel / kernel.sum()).astype(np.float32)
        radius = thickness / 2.0
        yy, xx = np.mgrid[0:n, 0:n]
        kernel = np.clip(radius + 0.5 - np.hypot(xx - center, yy - center), 0, None)
        total = kernel.sum()
        if total <= EPS:
            kernel = np.eye(n, dtype=np.float64)
            total = 1.0
        return (kernel / total).astype(np.float32)

    ux, uy = angle_to_vec(angle_deg)  # array-space direction
    nx, ny = -uy, ux                  # array-space perpendicular

    n_along = max(24, int(math.ceil(length * 12)))
    n_across = max(1, int(math.ceil(thickness * 6)))
    half_len = length / 2.0
    half_thk = max(thickness - 1.0, 0.0) / 2.0

    for i in range(n_along):
        t = -half_len + 2.0 * half_len * (i + 0.5) / n_along
        if profile == "tent":
            weight = max(0.0, 1.0 - abs(t) / (half_len + EPS))
        elif profile in ("gauss", "gaussian"):
            sigma = max(half_len / 2.0, 0.35)
            weight = math.exp(-0.5 * (t / sigma) ** 2)
        else:  # box
            weight = 1.0
        for j in range(n_across):
            off = 0.0 if n_across == 1 else (
                -half_thk + (2.0 * half_thk) * (j + 0.5) / n_across
            )
            x = center + t * ux + off * nx
            y = center + t * uy + off * ny
            _splat(kernel, x, y, weight)

    total = kernel.sum()
    if total <= EPS:
        kernel[center, center] = 1.0
        total = 1.0
    return (kernel / total).astype(np.float32)


def _splat(kernel: np.ndarray, x: float, y: float, weight: float) -> None:
    h, w = kernel.shape
    x0, y0 = int(math.floor(x)), int(math.floor(y))
    fx, fy = x - x0, y - y0
    for yy, wy in ((y0, 1.0 - fy), (y0 + 1, fy)):
        if not (0 <= yy < h) or wy == 0.0:
            continue
        for xx, wx in ((x0, 1.0 - fx), (x0 + 1, fx)):
            if not (0 <= xx < w) or wx == 0.0:
                continue
            kernel[yy, xx] += weight * wx * wy


def psf_gaussian(sigma: float, radius: float | None = None) -> np.ndarray:
    sigma = max(float(sigma), 1e-3)
    radius = float(radius if radius is not None else max(1.0, math.ceil(3 * sigma)))
    r = int(math.ceil(radius))
    x = np.arange(-r, r + 1, dtype=np.float64)
    g = np.exp(-0.5 * (x / sigma) ** 2)
    g /= g.sum()
    kernel = np.outer(g, g)
    return (kernel / kernel.sum()).astype(np.float32)


def next_fast_len(n: int) -> int:
    """Smallest number >= n whose only prime factors are 2, 3 and 5."""
    n = max(1, int(n))
    for candidate in range(n, n + 128):
        value = candidate
        for p in (2, 3, 5):
            while value % p == 0:
                value //= p
        if value == 1:
            return candidate
    return n


def pad_reflect(arr: np.ndarray, pad_y: int, pad_x: int | None = None) -> np.ndarray:
    pad_x = pad_y if pad_x is None else pad_x
    pad_y, pad_x = max(int(pad_y), 0), max(int(pad_x), 0)
    if pad_y == 0 and pad_x == 0:
        return arr
    h, w = arr.shape[:2]
    # ``reflect`` needs pad < dim on each axis; fall back per axis so a thin
    # image (e.g. a 1-px strip) still works.
    pad_spec = []
    modes = []
    for pad, n in ((pad_y, h), (pad_x, w)):
        if pad == 0:
            pad_spec.append((0, 0))
            modes.append("constant")
        elif pad < n:
            pad_spec.append((pad, pad))
            modes.append("reflect")
        else:
            pad_spec.append((pad, pad))
            modes.append("symmetric")
    if len(set(modes)) == 1:
        extra = [(0, 0)] * (arr.ndim - 2)
        return np.pad(arr, pad_spec + extra, mode=modes[0])
    # Mixed modes: pad each axis in turn.
    out = arr
    if pad_y:
        out = np.pad(
            out,
            [(pad_y, pad_y)] + [(0, 0)] * (arr.ndim - 1),
            mode=modes[0],
        )
    if pad_x:
        out = np.pad(
            out,
            [(0, 0), (pad_x, pad_x)] + [(0, 0)] * (arr.ndim - 2),
            mode=modes[1],
        )
    return out


def fft_convolve(image: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    """Linear convolution ("same"), output same shape as ``image``.

    ``kernel`` is centred (odd size).  Reflect-pad the image by ``k//2``, take
    the full linear convolution ``D = P * K`` with the kernel unshifted, and
    crop at ``2*(k//2) = k-1``.

    Derivation (1-D, k=3, pad ph=1, ``P[n] = I[n-ph]``):
    ``D[m] = sum_n I[n-ph] K[m-n]``; with ``n' = n-ph`` this is
    ``sum I[n'] K[m-ph-n']``.  The "same" result
    ``O[i] = sum_u K[u] I[i+ph-u]`` equals ``D[i+2*ph]``, hence crop at
    ``2*ph = k-1``.  Worked example confirms ``O[0] = D[k-1]``.
    """
    image = np.asarray(image, dtype=np.float32)
    kernel = np.asarray(kernel, dtype=np.float32)
    kh, kw = kernel.shape
    ph, pw = kh // 2, kw // 2
    padded = pad_reflect(image, ph, pw)

    shape = (
        next_fast_len(padded.shape[0] + kh - 1),
        next_fast_len(padded.shape[1] + kw - 1),
    )
    f_img = np.fft.rfft2(padded, s=shape)
    f_k = np.fft.rfft2(kernel, s=shape)
    full = np.fft.irfft2(f_img * f_k, s=shape)
    y0, x0 = 2 * ph, 2 * pw
    return full[y0:y0 + image.shape[0], x0:x0 + image.shape[1]].astype(np.float32)


def convolve_psf(image: np.ndarray, psf: np.ndarray) -> np.ndarray:
    return fft_convolve(image, psf)


# ---------------------------------------------------------------------------
# 1-D filtering
# ---------------------------------------------------------------------------

def gaussian_1d(sigma: float, radius: int | None = None) -> np.ndarray:
    sigma = max(float(sigma), 1e-3)
    r = int(radius if radius is not None else max(1, math.ceil(3 * sigma)))
    x = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-0.5 * (x / sigma) ** 2)
    return (k / k.sum()).astype(np.float32)


def convolve1d(arr: np.ndarray, kernel: np.ndarray, axis: int) -> np.ndarray:
    arr = np.asarray(arr, dtype=np.float32)
    kernel = np.asarray(kernel, dtype=np.float32)
    r = kernel.size // 2
    pad = [(0, 0)] * arr.ndim
    pad[axis] = (r, r)
    padded = np.pad(arr, pad, mode="symmetric")
    out = np.zeros_like(arr, dtype=np.float32)
    n = arr.shape[axis]
    for i, w in enumerate(kernel):
        if w == 0:
            continue
        sl = [slice(None)] * arr.ndim
        sl[axis] = slice(i, i + n)
        out += w * padded[tuple(sl)]
    return out


def gaussian_blur(arr: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return np.asarray(arr, dtype=np.float32)
    k = gaussian_1d(sigma)
    return convolve1d(convolve1d(arr, k, 0), k, 1)


def box_blur(arr: np.ndarray, radius: int) -> np.ndarray:
    radius = int(max(radius, 0))
    if radius == 0:
        return np.asarray(arr, dtype=np.float32)
    k = np.ones(2 * radius + 1, dtype=np.float32)
    k /= k.sum()
    return convolve1d(convolve1d(arr, k, 0), k, 1)


def local_mean(arr: np.ndarray, radius: int) -> np.ndarray:
    return box_blur(arr, radius)


def local_variance(arr: np.ndarray, radius: int) -> np.ndarray:
    arr = np.asarray(arr, dtype=np.float32)
    mean = box_blur(arr, radius)
    return np.clip(box_blur(arr * arr, radius) - mean * mean, 0, None)


def local_std(arr: np.ndarray, radius: int) -> np.ndarray:
    return np.sqrt(local_variance(arr, radius))


def gradient_magnitude(arr: np.ndarray) -> np.ndarray:
    arr = np.asarray(arr, dtype=np.float32)
    gy, gx = np.gradient(arr)
    return np.hypot(gx, gy).astype(np.float32)


def gradient_xy(arr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    gy, gx = np.gradient(np.asarray(arr, dtype=np.float32))
    return gx.astype(np.float32), gy.astype(np.float32)


# ---------------------------------------------------------------------------
# Masks and composition
# ---------------------------------------------------------------------------

def clamp_rect(rect: Sequence[float], shape: tuple[int, int]) -> tuple[int, int, int, int]:
    h, w = shape
    x0, y0, x1, y1 = (int(round(v)) for v in rect)
    x0, x1 = sorted((max(0, min(w, x0)), max(0, min(w, x1))))
    y0, y1 = sorted((max(0, min(h, y0)), max(0, min(h, y1))))
    if x1 - x0 < 1:
        x1 = min(w, x0 + 1)
    if y1 - y0 < 1:
        y1 = min(h, y0 + 1)
    return x0, y0, x1, y1


def smoothstep(t: np.ndarray | float) -> np.ndarray | float:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def rect_mask(shape: tuple[int, int], rect: Sequence[float], feather: float = 0.0) -> np.ndarray:
    """Rectangle mask with a raised-cosine-like ramp kept inside the rect."""
    h, w = shape
    x0, y0, x1, y1 = clamp_rect(rect, (h, w))
    mask = np.zeros((h, w), dtype=np.float32)
    if x1 <= x0 or y1 <= y0:
        return mask
    # Never let the ramp consume the whole rectangle.
    f = max(float(feather), 0.0)
    f = min(f, 0.5 * (x1 - x0) - 0.5, 0.5 * (y1 - y0) - 0.5)
    f = max(f, 0.0)
    xs = np.arange(w, dtype=np.float32)
    ys = np.arange(h, dtype=np.float32)
    if f <= 1e-6:
        ax = ((xs >= x0) & (xs < x1)).astype(np.float32)
        ay = ((ys >= y0) & (ys < y1)).astype(np.float32)
    else:
        ax = smoothstep((xs - x0 + 0.5) / f) * smoothstep((x1 - xs - 0.5) / f)
        ay = smoothstep((ys - y0 + 0.5) / f) * smoothstep((y1 - ys - 0.5) / f)
    mask[:] = ay[:, None] * ax[None, :]
    return mask


def feather_mask(mask: np.ndarray, feather: float) -> np.ndarray:
    if feather <= 0:
        return mask.astype(np.float32)
    sigma = max(float(feather) / 2.0, 0.5)
    return np.clip(gaussian_blur(mask.astype(np.float32), sigma), 0, 1)


def compose_ordered(
    base: np.ndarray,
    images: Sequence[np.ndarray],
    masks: Sequence[np.ndarray],
    orders: Sequence[int],
) -> tuple[np.ndarray, list[np.ndarray]]:
    """Composite region results in a deterministic order.

    Later regions win in overlaps.  Returns the result and the *effective*
    mask of every region (i.e. what that region actually contributes).
    """
    if not images:
        return base.astype(np.float32), []
    if not (len(images) == len(masks) == len(orders)):
        raise ValueError("images, masks and orders must have the same length")
    result = np.asarray(base, dtype=np.float32).copy()
    remaining = np.ones(result.shape[:2], dtype=np.float32)
    effective: list[np.ndarray | None] = [None] * len(images)
    for idx in sorted(range(len(images)), key=lambda i: (orders[i], i)):
        eff2d = np.clip(masks[idx], 0, 1) * remaining
        eff = eff2d[..., None] if result.ndim == 3 else eff2d
        result = result * (1.0 - eff) + np.asarray(images[idx], dtype=np.float32) * eff
        remaining = remaining * (1.0 - np.clip(masks[idx], 0, 1))
        effective[idx] = eff2d
    return result, [e if e is not None else np.zeros_like(base[..., 0] if base.ndim == 3 else base) for e in effective]


def mask_bbox(mask: np.ndarray, threshold: float = 0.01) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask > threshold)
    if xs.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


# ---------------------------------------------------------------------------
# Sampling
# ---------------------------------------------------------------------------

def sample_bilinear(arr: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinear sample; ``arr`` may be 2-D or multi-channel (channels last)."""
    arr = np.asarray(arr, dtype=np.float32)
    h, w = arr.shape[:2]
    x = np.clip(np.asarray(x, dtype=np.float32), 0, w - 1.001)
    y = np.clip(np.asarray(y, dtype=np.float32), 0, h - 1.001)
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = (x - x0)
    fy = (y - y0)
    if arr.ndim == 3:
        fx = fx[..., None]
        fy = fy[..., None]
    v00 = arr[y0, x0]
    v10 = arr[y0, x1]
    v01 = arr[y1, x0]
    v11 = arr[y1, x1]
    top = v00 * (1 - fx) + v10 * fx
    bottom = v01 * (1 - fx) + v11 * fx
    return (top * (1 - fy) + bottom * fy).astype(np.float32)


def sample_profile(
    gray: np.ndarray,
    center: tuple[float, float],
    normal_angle_deg: float,
    halfwidth: float,
    step: float = 0.25,
) -> tuple[np.ndarray, np.ndarray]:
    """Sample a profile across an edge along the given visual normal angle."""
    n = max(8, int(round(2.0 * halfwidth / step)) + 1)
    s = np.linspace(-halfwidth, halfwidth, n, dtype=np.float32)
    ux, uy = angle_to_vec(normal_angle_deg)
    xs = center[0] + s * ux
    ys = center[1] + s * uy
    vals = sample_bilinear(gray, xs, ys)
    return s, vals


def sample_band_profiles(
    gray: np.ndarray,
    center: tuple[float, float],
    normal_angle_deg: float,
    halfwidth: float,
    step: float = 0.25,
    n_profiles: int = 11,
    spacing: float = 2.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Average several parallel profiles to lower noise.

    Returns ``(s, mean_profile, individual_profiles)``.
    """
    ux, uy = angle_to_vec(normal_angle_deg)
    tx, ty = -uy, ux
    n_profiles = max(1, int(n_profiles))
    offsets = np.linspace(-(n_profiles - 1) / 2.0, (n_profiles - 1) / 2.0, n_profiles) * spacing
    profiles = []
    s = None
    for off in offsets:
        cx = center[0] + off * tx
        cy = center[1] + off * ty
        s, vals = sample_profile(gray, (cx, cy), normal_angle_deg, halfwidth, step)
        profiles.append(vals)
    stack = np.stack(profiles, axis=0)
    return s, stack.mean(axis=0), stack


def crop_with_pad(
    arr: np.ndarray,
    rect: Sequence[float],
    pad: int,
) -> tuple[np.ndarray, tuple[int, int, int, int], tuple[int, int]]:
    """Crop ``rect`` plus reflected context, padding each side independently.

    Returns ``(padded_crop, clamped_rect, (pad_left, pad_top))``.
    """
    h, w = arr.shape[:2]
    x0, y0, x1, y1 = clamp_rect(rect, (h, w))
    pad = int(max(pad, 0))
    xa, ya = max(0, x0 - pad), max(0, y0 - pad)
    xb, yb = min(w, x1 + pad), min(h, y1 + pad)
    crop = arr[ya:yb, xa:xb]
    left, top = x0 - xa, y0 - ya
    right, bottom = xb - x1, yb - y1
    if left or right or top or bottom:
        ch, cw = crop.shape[:2]
        mode = "reflect" if (left < cw and right < cw and top < ch and bottom < ch) else "symmetric"
        crop = np.pad(crop, ((top, bottom), (left, right)), mode=mode)
    return crop.astype(np.float32), (x0, y0, x1, y1), (left, top)


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

def percentile_range(arr: np.ndarray, low: float = 1.0, high: float = 99.0) -> tuple[float, float]:
    a = np.asarray(arr, dtype=np.float32)
    return float(np.percentile(a, low)), float(np.percentile(a, high))


def otsu_threshold(arr: np.ndarray, bins: int = 256) -> float:
    values = np.asarray(arr, dtype=np.float32).ravel()
    values = values[np.isfinite(values)]
    if values.size == 0:
        return 0.5
    hist, edges = np.histogram(values, bins=bins, range=(0.0, 1.0))
    hist = hist.astype(np.float64)
    total = hist.sum()
    if total <= 0:
        return 0.5
    centers = (edges[:-1] + edges[1:]) / 2.0
    weight_bg = np.cumsum(hist)
    weight_fg = total - weight_bg
    mean_bg = np.cumsum(hist * centers)
    mean_total = mean_bg[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        var_between = (mean_total * weight_bg / total - mean_bg) ** 2 / (
            weight_bg * weight_fg / (total * total) + 1e-12
        )
    var_between[~np.isfinite(var_between)] = -1
    idx = int(np.argmax(var_between))
    return float(centers[idx])


def parse_rect(text: str) -> tuple[int, int, int, int]:
    parts = [p for p in text.replace(";", ",").split(",") if p.strip()]
    if len(parts) != 4:
        raise ValueError(f"rect needs 4 numbers x0,y0,x1,y1: {text!r}")
    return tuple(int(round(float(p))) for p in parts)  # type: ignore[return-value]


def parse_region_spec(text: str) -> dict:
    """Parse ``x0,y0,x1,y1,angle,length[,order[,feather]]``."""
    parts = [p for p in text.replace(";", ",").split(",") if p.strip()]
    if len(parts) < 6:
        raise ValueError(
            "region needs x0,y0,x1,y1,angle,length[,order[,feather]]: " f"{text!r}"
        )
    vals = [float(p) for p in parts]
    spec = {
        "rect": tuple(int(round(v)) for v in vals[:4]),
        "angle": vals[4],
        "length": vals[5],
        "order": int(vals[6]) if len(vals) > 6 else 0,
        "feather": float(vals[7]) if len(vals) > 7 else 8.0,
    }
    return spec
