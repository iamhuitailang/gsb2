"""Core HDR processing engine.

All heavy lifting (alignment, ghost detection, exposure fusion, tonemapping)
lives here and is pure function style, so it can be exercised from the API
layer or directly from tests. Input images are never overwritten: every
result is written to a separate working directory.
"""

from __future__ import annotations

import base64
import io
import math
from dataclasses import dataclass, field

import cv2
import numpy as np
from PIL import Image, ExifTags

# ---------------------------------------------------------------------------
# Constants / thresholds
# ---------------------------------------------------------------------------

# MTB shifts larger than this fraction of the image dimension are considered
# alignment failures rather than plausible handheld jitter.
ALIGN_MAX_SHIFT_FRAC = 0.12
# Minimum stdev of the median-threshold bitmap; flat images cannot be aligned.
MIN_TEXTURE_STD = 4.0
# Per-pixel exposure-weight exponent (well-exposedness).
WELL_EXPOSED_GAMMA = 0.7
# Pyramid levels for multi-resolution blending.
PYRAMID_LEVELS = 6
# Max preview edge length — preview processing stays interactive.
PREVIEW_MAX_EDGE = 900

_EXIF_TAGS = {v: k for k, v in ExifTags.TAGS.items()}


# ---------------------------------------------------------------------------
# Data containers
# ---------------------------------------------------------------------------


@dataclass
class ImageInfo:
    """Metadata for one bracketing frame."""

    image_id: str
    filename: str
    width: int
    height: int
    ev: float | None          # exposure value derived from EXIF, None if missing
    ev_source: str            # "exif" | "estimated" | "unknown"
    exposure_time: float | None
    f_number: float | None
    iso: float | None
    status: str = "ok"        # ok | warn | error
    message: str = ""
    shift: tuple[int, int] = (0, 0)   # (dx, dy) applied during alignment
    aligned: bool = False


@dataclass
class GhostMark:
    """A user-drawn polygon mask and the frame chosen as the source of truth."""

    mark_id: str
    points: list[list[float]]          # normalized 0..1 polygon coordinates
    source_index: int                  # frame index supplying this region
    label: str = ""


@dataclass
class GroupState:
    """One bracketing group (a scene shot at several exposures)."""

    group_id: str
    name: str
    image_ids: list[str] = field(default_factory=list)
    order: list[int] = field(default_factory=list)          # indices into image_ids, dark→bright
    marks: list[GhostMark] = field(default_factory=list)
    auto_ghost: dict | None = None                          # detection result
    fused_npy: str | None = None                            # path to cached float fusion
    last_params: dict | None = None


# ---------------------------------------------------------------------------
# IO / EXIF
# ---------------------------------------------------------------------------


def read_image_bgr(path: str) -> np.ndarray:
    """Read an 8-bit image as BGR uint8 (OpenCV convention)."""
    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"无法解码图片: {path}")
    return img


def image_to_png_bytes(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("PNG 编码失败")
    return buf.tobytes()


def image_to_jpeg_bytes(img: np.ndarray, quality: int = 88) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG 编码失败")
    return buf.tobytes()


def make_thumbnail(img: np.ndarray, max_edge: int = 220) -> np.ndarray:
    h, w = img.shape[:2]
    scale = min(1.0, max_edge / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (round(w * scale), round(h * scale)),
                         interpolation=cv2.INTER_AREA)
    return img


def read_exif(path: str) -> dict:
    """Extract exposure-related EXIF tags. Missing tags come back as None."""
    out = {"exposure_time": None, "f_number": None, "iso": None, "ev": None}
    try:
        with Image.open(path) as im:
            exif = im.getexif()
    except Exception:
        return out
    if not exif:
        return out

    def get(name: str):
        tag = _EXIF_TAGS.get(name)
        val = exif.get(tag) if tag else None
        if isinstance(val, tuple) and len(val) == 2:      # rational
            num, den = val
            return float(num) / float(den) if den else None
        return float(val) if val is not None else None

    out["exposure_time"] = get("ExposureTime")
    out["f_number"] = get("FNumber")
    out["iso"] = get("ISOSpeedRatings") or get("PhotographicSensitivity")
    t, f, iso = out["exposure_time"], out["f_number"], out["iso"]
    if t and t > 0 and f and iso:
        # EV at ISO 100; common baseline for ordering brackets.
        out["ev"] = math.log2((f * f) / t) - math.log2(iso / 100.0)
    return out


def estimate_evs(images: list[np.ndarray]) -> list[float]:
    """Fallback EV estimate from mean luminance when EXIF is missing.

    Returns relative EVs on the standard scale (brighter image => lower EV),
    anchored so the median frame is 0.
    """
    means = []
    for img in images:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float64)
        means.append(math.log2(max(float(gray.mean()), 1e-3)))
    means = np.array(means)
    # Doubling scene luminance == +1 EV of sensor output == -1 EV camera side;
    # sign convention only matters for ordering, so negate for camera EV.
    evs = -(means - np.median(means))
    return [float(v) for v in evs]


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------


def check_texture(img: np.ndarray) -> float:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    med = np.median(gray)
    bitmap = (gray > med).astype(np.uint8)
    return float(bitmap.std() * 255.0)


# Minimum normalized cross-correlation for an alignment to be trusted. Below
# this the frames probably do not depict the same scene (missing/extreme shift).
MIN_ALIGN_CORRELATION = 0.30


def _ncc_integer_shift(ref_gray: np.ndarray, cur_gray: np.ndarray,
                       max_shift: int) -> tuple[int, int, float]:
    """Find the integer (dx, dy) content displacement via coarse-to-fine NCC.

    The current frame is first histogram-matched to the reference so global
    exposure differences do not affect the normalized cross-correlation score.
    A moving object only lowers the correlation locally; static background
    still drives the global optimum.
    """
    matched = _match_histogram(cur_gray, ref_gray)
    # Coarse pass on half resolution keeps the search radius cheap while
    # staying within the convergence basin of small handheld shifts.
    ref_s = cv2.resize(ref_gray, None, fx=0.5, fy=0.5,
                       interpolation=cv2.INTER_AREA).astype(np.float32)
    cur_s = cv2.resize(matched, None, fx=0.5, fy=0.5,
                       interpolation=cv2.INTER_AREA).astype(np.float32)
    ref_s = (ref_s - ref_s.mean()) / (ref_s.std() + 1e-6)
    cur_s = (cur_s - cur_s.mean()) / (cur_s.std() + 1e-6)
    coarse_max = max(4, int(np.ceil(max_shift / 2)))
    margin = coarse_max + 2

    def score_at(img_a, img_b, dx, dy):
        m = np.float32([[1, 0, -dx], [0, 1, -dy]])   # content moved by (dx,dy)
        w = cv2.warpAffine(img_b, m, (img_b.shape[1], img_b.shape[0]),
                           borderMode=cv2.BORDER_REFLECT_101)
        inner_a = img_a[margin:-margin, margin:-margin]
        inner_w = w[margin:-margin, margin:-margin]
        return float((inner_a * inner_w).mean())

    best = (-2.0, 0, 0)
    for dy in range(-coarse_max, coarse_max + 1):
        for dx in range(-coarse_max, coarse_max + 1):
            s = score_at(ref_s, cur_s, dx, dy)
            if s > best[0]:
                best = (s, dx, dy)
    coarse_dx, coarse_dy = best[1] * 2, best[2] * 2

    # Fine pass on full resolution within +-2 px of the coarse estimate.
    ref_f = ref_gray.astype(np.float32)
    cur_f = matched.astype(np.float32)
    ref_f = (ref_f - ref_f.mean()) / (ref_f.std() + 1e-6)
    cur_f = (cur_f - cur_f.mean()) / (cur_f.std() + 1e-6)
    best = (-2.0, coarse_dx, coarse_dy)
    fine_margin = max_shift + 4
    for dy in range(coarse_dy - 2, coarse_dy + 3):
        for dx in range(coarse_dx - 2, coarse_dx + 3):
            m = np.float32([[1, 0, -dx], [0, 1, -dy]])
            w = cv2.warpAffine(cur_f, m, (cur_f.shape[1], cur_f.shape[0]),
                               borderMode=cv2.BORDER_REFLECT_101)
            s = float((ref_f[fine_margin:-fine_margin, fine_margin:-fine_margin]
                       * w[fine_margin:-fine_margin, fine_margin:-fine_margin]).mean())
            if s > best[0]:
                best = (s, dx, dy)
    return best[1], best[2], best[0]


def align_images(images: list[np.ndarray]) -> tuple[list[np.ndarray], list[tuple[int, int]], list[dict]]:
    """Align a bracket to the first frame using NCC over matched histograms.

    Returns (aligned images, per-frame (dx, dy) shifts, per-frame reports).
    A frame whose shift is implausibly large, or whose content is too flat to
    align, is returned *unshifted* with an error report; the other frames are
    still aligned and usable.
    """
    h, w = images[0].shape[:2]
    max_shift = int(ALIGN_MAX_SHIFT_FRAC * min(h, w))

    ref_gray = cv2.cvtColor(images[0], cv2.COLOR_BGR2GRAY)
    aligned = [images[0].copy()]
    shifts: list[tuple[int, int]] = [(0, 0)]
    reports: list[dict] = [{"aligned": True, "shift": [0, 0], "status": "ok", "message": "参考帧"}]

    for i in range(1, len(images)):
        gray = cv2.cvtColor(images[i], cv2.COLOR_BGR2GRAY)
        texture = check_texture(images[i])
        if texture < MIN_TEXTURE_STD:
            reports.append({
                "aligned": False, "shift": [0, 0], "status": "error",
                "message": f"画面纹理过少（纹理指标 {texture:.1f}），无法可靠对齐，已保留原始位置",
            })
            aligned.append(images[i].copy())
            shifts.append((0, 0))
            continue
        dx, dy, score = _ncc_integer_shift(ref_gray, gray, max_shift)
        if abs(dx) > max_shift or abs(dy) > max_shift:
            reports.append({
                "aligned": False, "shift": [0, 0], "status": "error",
                "message": f"检测到位移 ({dx}, {dy}) 超过合理范围（阈值 {max_shift}px，相关度 {score:.2f}），"
                           "疑似非同一场景或画面缺失，已跳过该帧对齐",
            })
            aligned.append(images[i].copy())
            shifts.append((0, 0))
        elif score < MIN_ALIGN_CORRELATION:
            reports.append({
                "aligned": False, "shift": [0, 0], "status": "error",
                "message": f"最佳相关度仅 {score:.2f}（阈值 {MIN_ALIGN_CORRELATION:.2f}），"
                           "两帧内容匹配度过低，疑似场景不一致，已跳过该帧对齐",
            })
            aligned.append(images[i].copy())
            shifts.append((0, 0))
        else:
            m = np.float32([[1, 0, -dx], [0, 1, -dy]])
            warped = cv2.warpAffine(images[i], m, (w, h),
                                    flags=cv2.INTER_LINEAR,
                                    borderMode=cv2.BORDER_REFLECT_101)
            reports.append({
                "aligned": True, "shift": [dx, dy], "status": "ok",
                "message": f"对齐成功，位移 ({dx}, {dy})px，相关度 {score:.2f}",
            })
            aligned.append(warped)
            shifts.append((dx, dy))
    return aligned, shifts, reports


# ---------------------------------------------------------------------------
# Ghost detection
# ---------------------------------------------------------------------------


def _match_histogram(src_gray: np.ndarray, ref_gray: np.ndarray) -> np.ndarray:
    """Map src gray levels so its histogram matches ref (CDF matching).

    This removes global exposure differences while preserving the spatial
    structure needed to spot moving objects.
    """
    src = src_gray.ravel()
    ref = ref_gray.ravel()
    s_values, bin_idx, s_counts = np.unique(src, return_inverse=True,
                                            return_counts=True)
    r_values, r_counts = np.unique(ref, return_counts=True)
    s_cdf = np.cumsum(s_counts).astype(np.float64) / src.size
    r_cdf = np.cumsum(r_counts).astype(np.float64) / ref.size
    # For each source CDF level find the reference level with the same CDF.
    mapped = np.interp(s_cdf, r_cdf, r_values)
    return mapped[bin_idx].reshape(src_gray.shape).astype(np.float32)


def detect_ghost_masks(aligned: list[np.ndarray], threshold: float = 0.08,
                       min_area: int = 120) -> list[np.ndarray]:
    """Detect moving-object ghost regions in a bracket.

    Each frame is histogram-matched to the *middle* frame so global exposure
    differences cancel. A pixel is flagged only when it differs from the
    reference on BOTH sides (or on the available side for two-frame sets),
    which rejects the "object shadow" problem: where the reference object sits
    but other frames show background, adjacent-only comparison would mark the
    whole background band.

    Returns one binary mask (uint8, 0/255) per frame except the reference;
    call :func:`union_masks` for the combined region.
    """
    grays = [cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) for img in aligned]
    ref_idx = len(grays) // 2
    ref = grays[ref_idx].astype(np.float32)

    matched = []
    for g in grays:
        if g is grays[ref_idx]:
            matched.append(ref)
        else:
            matched.append(_match_histogram(g, grays[ref_idx]))

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    diffs: dict[int, np.ndarray] = {}
    sats: dict[int, np.ndarray] = {}
    for i, m in enumerate(matched):
        if i == ref_idx:
            continue
        sat = ((grays[i] <= 2) | (grays[i] >= 253)
               | (grays[ref_idx] <= 2) | (grays[ref_idx] >= 253))
        diff = cv2.GaussianBlur(cv2.absdiff(m, ref) / 255.0, (5, 5), 0)
        diffs[i] = diff
        sats[i] = sat

    masks: list[np.ndarray] = []
    for i in sorted(diffs):
        # Intersect with the mirror side when both neighbours exist: an object
        # that actually moved differs from the reference on every other frame.
        mirror = 2 * ref_idx - i
        if mirror in diffs:
            score = np.minimum(diffs[i], diffs[mirror])
            sat = sats[i] | sats[mirror]
        else:
            score = diffs[i]
            sat = sats[i]
        _, binary = cv2.threshold(score, threshold, 255, cv2.THRESH_BINARY)
        binary = binary.astype(np.uint8)
        binary[sat] = 0
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=1)
        if min_area > 0:
            n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
            clean = np.zeros_like(binary)
            for lab in range(1, n):
                if stats[lab, cv2.CC_STAT_AREA] >= min_area:
                    clean[labels == lab] = 255
            binary = clean
        masks.append(binary)
    return masks


def union_masks(masks: list[np.ndarray]) -> np.ndarray:
    if not masks:
        return np.zeros((1, 1), np.uint8)
    out = masks[0].copy()
    for m in masks[1:]:
        out = cv2.bitwise_or(out, m)
    return out


def polygon_to_mask(points_norm: list[list[float]], shape: tuple[int, int]) -> np.ndarray:
    """Rasterize a normalized polygon (0..1) into a full-resolution mask."""
    h, w = shape
    pts = np.array([[round(x * w), round(y * h)] for x, y in points_norm],
                   dtype=np.int32)
    mask = np.zeros((h, w), np.uint8)
    if len(pts) >= 3:
        cv2.fillPoly(mask, [pts], 255)
    return mask


def overlay_mask(img: np.ndarray, mask: np.ndarray,
                 color: tuple[int, int, int] = (0, 0, 255), alpha: float = 0.35) -> np.ndarray:
    """Return an image with the mask region tinted (input untouched)."""
    out = img.copy()
    region = mask > 0
    if not region.any():
        return out
    tint = np.full_like(out, color)
    out[region] = cv2.addWeighted(out, 1 - alpha, tint, alpha, 0)[region]
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(out, contours, -1, color, 1)
    return out


# ---------------------------------------------------------------------------
# Exposure fusion with manual ghost-source control
# ---------------------------------------------------------------------------


def _well_exposed_weights(images: list[np.ndarray]) -> list[np.ndarray]:
    """Per-pixel weight favouring mid-tone, non-saturated pixels."""
    weights = []
    for img in images:
        f = img.astype(np.float32) / 255.0
        # Gaussian around 0.5 per channel, multiply channels, mild contrast term.
        per_ch = np.exp(-((f - 0.5) ** 2) / (2 * 0.2 ** 2))
        w = np.prod(per_ch, axis=2)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        # Saturated pixels must never contribute.
        sat = ((gray <= 0.02) | (gray >= 0.98)).astype(np.float32)
        w = w * (1.0 - 0.98 * sat)
        w = np.power(np.maximum(w, 1e-8), WELL_EXPOSED_GAMMA)
        weights.append(w)
    return weights


def _build_ghost_weight_masks(images: list[np.ndarray],
                              marks: list[GhostMark],
                              auto_union: np.ndarray | None,
                              default_source: int) -> list[np.ndarray]:
    """Per-frame boolean masks saying where each frame is allowed to contribute.

    Inside a marked region only the chosen source frame contributes. The
    auto-detected ghost union (if the user accepts it) defaults to the middle
    exposure, which usually carries the least motion-blurred content.
    """
    h, w = images[0].shape[:2]
    allowed = [np.ones((h, w), np.float32) for _ in images]
    if auto_union is not None and auto_union.shape == (h, w):
        region = auto_union > 0
        if region.any():
            for i in range(len(images)):
                allowed[i][region] = 1.0 if i == default_source else 0.0
    for mark in marks:
        if mark.source_index < 0 or mark.source_index >= len(images):
            continue
        m = polygon_to_mask(mark.points, (h, w))
        region = m > 0
        if not region.any():
            continue
        for i in range(len(images)):
            allowed[i][region] = 1.0 if i == mark.source_index else 0.0
    return allowed


def _gaussian_pyramid(img: np.ndarray, levels: int) -> list[np.ndarray]:
    pyr = [img]
    for _ in range(levels - 1):
        pyr.append(cv2.pyrDown(pyr[-1]))
    return pyr


def _laplacian_pyramid(img: np.ndarray, levels: int) -> list[np.ndarray]:
    g = _gaussian_pyramid(img, levels)
    lap = []
    for i in range(levels - 1):
        up = cv2.pyrUp(g[i + 1], dstsize=(g[i].shape[1], g[i].shape[0]))
        lap.append(g[i].astype(np.float32) - up.astype(np.float32))
    lap.append(g[-1].astype(np.float32))
    return lap


def fuse_exposures(images: list[np.ndarray], marks: list[GhostMark] | None = None,
                   auto_union: np.ndarray | None = None,
                   default_source: int | None = None) -> np.ndarray:
    """Multi-resolution exposure fusion.

    Returns a float32 BGR image in [0, 1] with full retained dynamic range.
    Ghost marks pin regions to a chosen source frame; inputs are not modified.
    """
    n = len(images)
    if n < 2:
        raise ValueError("至少需要两张照片才能合成")
    levels = min(PYRAMID_LEVELS, int(np.log2(min(images[0].shape[:2]))) - 1)
    levels = max(2, levels)
    if default_source is None:
        default_source = n // 2

    base_weights = _well_exposed_weights(images)
    ghost_masks = _build_ghost_weight_masks(images, marks or [], auto_union, default_source)
    weights = [w * g for w, g in zip(base_weights, ghost_masks)]

    # Normalize per pixel; guard against all-zero (fully marked) pixels.
    stack = np.stack(weights, axis=0)
    total = stack.sum(axis=0)
    dead = total <= 1e-8
    total[dead] = 1.0
    norm = [w / total for w in weights]
    for w in norm:
        w[dead] = 1.0 / n

    lps = [_laplacian_pyramid(img.astype(np.float32) / 255.0, levels) for img in images]
    blended = [np.zeros_like(lp) for lp in lps[0]]
    for level in range(levels):
        size = lps[0][level].shape[:2]
        for i in range(n):
            w = cv2.resize(norm[i], (size[1], size[0]), interpolation=cv2.INTER_AREA)
            if lps[i][level].ndim == 3:
                w = w[..., None]
            blended[level] += lps[i][level] * w

    out = blended[-1]
    for level in range(levels - 2, -1, -1):
        out = cv2.pyrUp(out, dstsize=(blended[level].shape[1], blended[level].shape[0]))
        out = out + blended[level]
    return np.clip(out, 0.0, 1.0).astype(np.float32)


# ---------------------------------------------------------------------------
# Tonemapping (non-destructive preview controls)
# ---------------------------------------------------------------------------


def tonemap(fused: np.ndarray, exposure: float = 0.0, shadows: float = 0.0,
            highlights: float = 0.0, saturation: float = 1.0) -> np.ndarray:
    """Map a float [0,1] fusion result to a displayable 8-bit BGR image.

    exposure:   overall tone, -2..+2 stops
    shadows:    -1..+1, positive lifts dark areas
    highlights: -1..+1, positive compresses bright areas
    saturation: 0..2, color strength around per-pixel luminance
    """
    f = np.clip(fused, 1e-4, 1.0).astype(np.float32)
    # Per-pixel luminance curve, evaluated in log space for a natural roll-off.
    gray = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32)
    log_l = np.log(gray).astype(np.float32)

    # Global exposure in stops = shift of log luminance.
    log_l += np.float32(exposure * math.log(2.0))

    # Shadows: scale deviations below mid-tone; highlights: above mid-tone.
    mid = np.float32(math.log(0.5))
    dev = log_l - mid
    below = dev < 0
    shadow_gain = np.float32(1.0 - 0.6 * np.clip(shadows, -1, 1))
    highlight_gain = np.float32(1.0 - 0.6 * np.clip(highlights, -1, 1))
    new_dev = np.where(below, dev * shadow_gain, dev * highlight_gain) \
        .astype(np.float32)
    new_gray = np.exp(mid + new_dev).astype(np.float32)

    # Re-apply color around the new luminance (preserve hue).
    ratio = (new_gray / np.maximum(gray, np.float32(1e-4)))[..., None]
    out = (f * ratio).astype(np.float32)
    # Saturation adjustment around luminance.
    l2 = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY).astype(np.float32)[..., None]
    out = (l2 + (out - l2) * np.float32(np.clip(saturation, 0.0, 2.0)))
    out = np.clip(out, 0.0, 1.0).astype(np.float32)
    return (out * np.float32(255.0) + 0.5).astype(np.uint8)


def downscale_for_preview(img: np.ndarray, max_edge: int = PREVIEW_MAX_EDGE) -> np.ndarray:
    h, w = img.shape[:2]
    scale = min(1.0, max_edge / max(h, w))
    if scale >= 1.0:
        return img
    return cv2.resize(img, (round(w * scale), round(h * scale)),
                      interpolation=cv2.INTER_AREA)


# ---------------------------------------------------------------------------
# Helpers for project (de)serialization
# ---------------------------------------------------------------------------


def encode_png_data_url(img: np.ndarray) -> str:
    b64 = base64.b64encode(image_to_png_bytes(img)).decode("ascii")
    return f"data:image/png;base64,{b64}"


def decode_data_url(data_url: str) -> np.ndarray:
    raw = base64.b64decode(data_url.split(",", 1)[1])
    arr = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if arr is None:
        raise ValueError("内嵌图片解码失败")
    return arr


def save_tiff16(path: str, img8: np.ndarray, fused: np.ndarray) -> None:
    """Write a 16-bit TIFF reconstructed from the float fusion result."""
    h, w = fused.shape[:2]
    # Match the tonemapped 8-bit look but keep 16-bit precision.
    gain = (img8.astype(np.float32) / 255.0) / np.maximum(fused, 1e-4)
    gain = np.median(gain.reshape(-1, 3), axis=0)[None, None, :]
    out16 = np.clip(fused * gain, 0, 1)
    out16 = (out16 * 65535.0 + 0.5).astype(np.uint16)
    cv2.imwrite(path, out16, [cv2.IMWRITE_TIFF_COMPRESSION, 5])
