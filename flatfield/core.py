"""Core algorithms for the flat-field correction inspector.

Physical model
--------------
A fixed camera under fixed illumination records a uniform scene as

    raw(x, y) = dark(x, y) + gain(x, y) * scene

``dark`` is the additive offset (bias plus dark current) and ``gain`` is the
per-pixel light collection efficiency.  The bottom-right corner of the example
photo is darker than the top-left because ``gain`` falls off across the sensor
(vignetting).  Flat-field correction inverts the model:

    scene = (raw - dark) / gain

Everything here is explicit about provenance: which frames produced ``dark``
and ``gain``, which reference pixels were unusable, and which scene pixels were
left untouched because correcting them would clip them to white.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import re
import struct
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Iterable, Optional, Sequence

import numpy as np

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover - dependency hint
    raise SystemExit("Pillow is required: pip install pillow numpy") from exc

from .tiffio import read_tiff, write_tiff

# ---------------------------------------------------------------------------
# Numeric helpers
# ---------------------------------------------------------------------------


def _channel_arrays(array: np.ndarray) -> Iterable[np.ndarray]:
    if array.ndim == 2:
        yield array
    else:
        for c in range(array.shape[2]):
            yield array[..., c]


def _box_blur(channel: np.ndarray, radius: int = 1) -> np.ndarray:
    """Separable box blur, used to compare a pixel with its neighbourhood."""
    size = 2 * radius + 1
    padded = np.pad(channel, radius, mode="edge")
    cum = np.cumsum(padded, axis=0, dtype=np.float64)
    cum = np.vstack([np.zeros((1, cum.shape[1])), cum])
    blurred = (cum[size:] - cum[:-size]) / size
    cum = np.cumsum(blurred, axis=1)
    cum = np.hstack([np.zeros((cum.shape[0], 1)), cum])
    return (cum[:, size:] - cum[:, :-size]) / size


def _median_ignore_nonfinite(values: np.ndarray) -> float:
    finite = values[np.isfinite(values)]
    return float(np.median(finite)) if finite.size else float("nan")


def _dtype_max(bit_depth: int) -> float:
    if bit_depth == 8:
        return 255.0
    if bit_depth == 16:
        return 65535.0
    if bit_depth == 32:
        return float(2**32 - 1)
    return float("nan")


# ---------------------------------------------------------------------------
# Loading and metadata
# ---------------------------------------------------------------------------

IMAGE_SUFFIXES = {".png", ".tif", ".tiff", ".bmp", ".jpg", ".jpeg", ".pgm", ".ppm", ".webp"}

_EV_NAME_RE = re.compile(r"(?:^|[^A-Za-z0-9])EV(?P<ev>[+-]?\d+(?:\.\d+)?)", re.IGNORECASE)


def parse_exposure_from_name(path: str | os.PathLike) -> Optional[float]:
    """Extract an EV token from a filename, e.g. ``flat_ev-1.5.png``.

    Only the literal ``EV`` token is accepted.  Exposure *time* is not an
    exposure *stop* and is deliberately not guessed from filenames.
    """
    m = _EV_NAME_RE.search(Path(path).stem)
    if not m:
        return None
    try:
        return float(m.group("ev"))
    except ValueError:
        return None


def read_exposure_metadata(path: str | os.PathLike) -> Optional[float]:
    """Read an exposure-stop value from image text metadata.

    PNG ``tEXt`` chunks surface differently across Pillow versions (``info``
    vs ``text``), so both are checked.  Only values that parse cleanly as a
    number are accepted; anything else is treated as unknown rather than
    guessed.
    """
    try:
        with Image.open(path) as img:
            info = getattr(img, "info", {}) or {}
            text = getattr(img, "text", {}) or {}
            for source in (info, text):
                for key in ("exposure_ev", "ExposureEV", "exposure EV", "EV"):
                    if key in source:
                        try:
                            return float(str(source[key]).strip())
                        except (TypeError, ValueError):
                            continue
    except Exception:
        pass
    return None


def infer_exposure(path: str | os.PathLike) -> Optional[float]:
    value = read_exposure_metadata(path)
    if value is not None:
        return value
    return parse_exposure_from_name(path)

def format_ev(value: Optional[float]) -> str:
    return "未知 EV" if value is None else f"{value:g} EV"


def _channel_names(mode: str, channels: int) -> tuple[str, ...]:
    if channels == 1:
        return ("Y",)
    if channels == 3:
        return ("R", "G", "B")
    if channels == 4:
        return ("R", "G", "B", "A")
    return tuple(f"C{i}" for i in range(channels))


def _bit_depth_for_mode(mode: str) -> int:
    if mode in ("L", "P", "RGB", "RGBA"):
        return 8
    if mode in ("I;16", "I;16B", "I;16L", "I;16N"):
        return 16
    if mode == "I":
        return 32
    if mode == "F":
        return 0
    return 8


@dataclass(frozen=True)
class ImageMeta:
    path: Path
    width: int
    height: int
    channels: int
    channel_names: tuple[str, ...]
    bit_depth: int
    exposure_ev: Optional[float]
    mode: str

    @property
    def sensor_max(self) -> float:
        value = _dtype_max(self.bit_depth)
        return value if math.isfinite(value) and value > 0 else 0.0

    @property
    def size_label(self) -> str:
        return f"{self.width}×{self.height}"

    @property
    def channel_label(self) -> str:
        return "+".join(self.channel_names)

    @property
    def exposure_label(self) -> str:
        return format_ev(self.exposure_ev)

    def summary(self) -> str:
        return (
            f"{self.size_label} · {self.channel_label} · {self.exposure_label}"
            f" · {self.mode}"
        )


@dataclass
class LoadedImage:
    meta: ImageMeta
    array: np.ndarray  # float64 (H,W) or (H,W,C)
    source_bytes: bytes = b""

    @property
    def shape(self) -> tuple[int, int]:
        return (self.array.shape[0], self.array.shape[1])

    @property
    def channels(self) -> int:
        return 1 if self.array.ndim == 2 else self.array.shape[2]

    def display_name(self) -> str:
        return self.meta.path.name


def _meta_for(
    path: Path,
    array: np.ndarray,
    mode: str,
    bit_depth: int,
    exposure_ev: Optional[float],
) -> ImageMeta:
    channels = 1 if array.ndim == 2 else array.shape[2]
    return ImageMeta(
        path=path,
        width=array.shape[1],
        height=array.shape[0],
        channels=channels,
        channel_names=_channel_names(mode, channels),
        bit_depth=bit_depth,
        exposure_ev=exposure_ev,
        mode=mode,
    )


def load_image(path: str | os.PathLike, exposure_ev: Optional[float] = None) -> LoadedImage:
    """Decode an image to float64 without rescaling its numeric values.

    TIFF is decoded by the local reader first so 16-bit colour data is not
    silently narrowed by Pillow; other formats go through Pillow.
    """
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(str(p))
    if p.suffix.lower() not in IMAGE_SUFFIXES:
        raise ValueError(f"不支持的图像格式: {p.suffix}")

    payload = p.read_bytes()
    ev = exposure_ev if exposure_ev is not None else infer_exposure(p)

    if p.suffix.lower() in (".tif", ".tiff"):
        try:
            uint_array, bits = read_tiff(p)
            array = uint_array.astype(np.float64)
            mode = "L" if array.ndim == 2 else ("RGB" if array.shape[2] == 3 else "RGBA")
            return LoadedImage(
                meta=_meta_for(p, array, mode, bits, ev),
                array=array,
                source_bytes=payload,
            )
        except (ValueError, KeyError, struct.error, OSError):
            pass  # compressed or exotic TIFF: fall back to Pillow

    with Image.open(p) as img:
        img.load()
        mode = img.mode
        bit_depth = _bit_depth_for_mode(mode)
        if mode == "F":
            array = np.asarray(img, dtype=np.float64)
        else:
            array = np.asarray(img)
            if array.ndim == 3 and array.shape[2] == 4:
                array = array[..., :3]
            array = array.astype(np.float64)

    return LoadedImage(
        meta=_meta_for(p, array, mode, bit_depth, ev),
        array=array,
        source_bytes=payload,
    )


# ---------------------------------------------------------------------------
# Reference groups
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReferenceKey:
    """Configuration under which a correction is physically valid."""

    width: int
    height: int
    channels: int
    channel_names: tuple[str, ...]
    exposure_ev: Optional[float]

    @classmethod
    def from_meta(cls, meta: ImageMeta) -> "ReferenceKey":
        return cls(
            width=meta.width,
            height=meta.height,
            channels=meta.channels,
            channel_names=meta.channel_names,
            exposure_ev=meta.exposure_ev,
        )

    def label(self) -> str:
        return (
            f"{self.width}×{self.height} · {self.channels}通道"
            f"({'+'.join(self.channel_names)}) · {format_ev(self.exposure_ev)}"
        )

    def mismatch(self, other: "ReferenceKey") -> list[str]:
        reasons: list[str] = []
        if (self.width, self.height) != (other.width, other.height):
            reasons.append(
                f"尺寸不符: {self.width}×{self.height} ≠ {other.width}×{other.height}"
            )
        if (self.channels, self.channel_names) != (other.channels, other.channel_names):
            reasons.append(
                f"通道不符: {self.channels}通道({'+'.join(self.channel_names)})"
                f" ≠ {other.channels}通道({'+'.join(other.channel_names)})"
            )
        if not _ev_equal(self.exposure_ev, other.exposure_ev):
            reasons.append(
                f"曝光档不符: {format_ev(self.exposure_ev)} ≠ {format_ev(other.exposure_ev)}"
            )
        return reasons

    def as_dict(self) -> dict:
        return {
            "width": self.width,
            "height": self.height,
            "channels": self.channels,
            "channel_names": list(self.channel_names),
            "exposure_ev": self.exposure_ev,
        }


def _ev_equal(a: Optional[float], b: Optional[float]) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) < 1e-6


class ReferenceError(ValueError):
    """Raised when a group cannot be used for an image, with human reasons."""

    def __init__(self, message: str, reasons: Sequence[str] = ()) -> None:
        super().__init__(message)
        self.reasons = [r for r in reasons if r]


@dataclass
class ReferenceGroup:
    """A dark and flat stack captured under one explicit configuration.

    Either stack may be empty so partial groups can be inspected, but only a
    complete group is offered as a correction source.
    """

    name: str
    key: ReferenceKey
    darks: list[LoadedImage] = field(default_factory=list)
    flats: list[LoadedImage] = field(default_factory=list)
    notes: str = ""

    def add_dark(self, image: LoadedImage) -> None:
        self._validate_member(image)
        self.darks.append(image)

    def add_flat(self, image: LoadedImage) -> None:
        self._validate_member(image)
        self.flats.append(image)

    def _validate_member(self, image: LoadedImage) -> None:
        reasons = self.key.mismatch(ReferenceKey.from_meta(image.meta))
        if reasons:
            raise ReferenceError(
                f"{image.meta.path.name} 与参考组「{self.name}」配置不同", reasons
            )

    @property
    def complete(self) -> bool:
        return bool(self.darks and self.flats)

    @property
    def frame_label(self) -> str:
        return f"{len(self.darks)} 暗帧 / {len(self.flats)} 亮帧"

    def dark_master(self) -> Optional[np.ndarray]:
        return _median_stack([img.array for img in self.darks])

    def flat_master(self) -> Optional[np.ndarray]:
        return _median_stack([img.array for img in self.flats])

    def summary(self) -> str:
        return f"{self.name} · {self.key.label()} · {self.frame_label}"

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "key": self.key.as_dict(),
            "darks": [str(img.meta.path) for img in self.darks],
            "flats": [str(img.meta.path) for img in self.flats],
            "notes": self.notes,
        }


def _median_stack(arrays: Sequence[np.ndarray]) -> Optional[np.ndarray]:
    if not arrays:
        return None
    if len(arrays) == 1:
        return np.array(arrays[0], dtype=np.float64, copy=True)
    stack = np.stack([np.asarray(a, dtype=np.float64) for a in arrays], axis=0)
    return np.median(stack, axis=0)


@dataclass
class GroupAvailability:
    group: ReferenceGroup
    config_matches: bool
    usable: bool
    reasons: list[str]
    notes: list[str] = field(default_factory=list)

    @property
    def label(self) -> str:
        state = "可用" if self.usable else "不可用"
        text = f"{self.group.summary()} [{state}]"
        if not self.config_matches:
            text += "  ← " + "；".join(self.reasons)
        elif self.notes:
            text += "  ⚠ " + "；".join(self.notes)
        return text


class ReferenceLibrary:
    """Named groups plus strict, explainable resolution for an image."""

    def __init__(self) -> None:
        self.groups: dict[str, ReferenceGroup] = {}

    def create_group(
        self,
        name: str,
        darks: Sequence[LoadedImage] = (),
        flats: Sequence[LoadedImage] = (),
        notes: str = "",
    ) -> ReferenceGroup:
        name = name.strip()
        if not name:
            raise ReferenceError("参考组名称不能为空")
        if name in self.groups:
            raise ReferenceError(f"参考组「{name}」已存在")
        members = list(darks) + list(flats)
        if not members:
            raise ReferenceError("参考组至少需要一帧暗参考或亮参考")
        key = ReferenceKey.from_meta(members[0].meta)
        problems: list[str] = []
        for image in members[1:]:
            for reason in key.mismatch(ReferenceKey.from_meta(image.meta)):
                problems.append(f"{image.meta.path.name}: {reason}")
        if problems:
            raise ReferenceError("所选参考帧配置不一致，无法建立同一组", problems)
        group = ReferenceGroup(name=name, key=key, notes=notes)
        group.darks.extend(darks)
        group.flats.extend(flats)
        self.groups[name] = group
        return group

    def remove_group(self, name: str) -> None:
        self.groups.pop(name, None)

    def availability(self, meta: ImageMeta) -> list[GroupAvailability]:
        key = ReferenceKey.from_meta(meta)
        rows: list[GroupAvailability] = []
        for group in self.groups.values():
            mismatch = group.key.mismatch(key)
            missing: list[str] = []
            if not group.darks:
                missing.append("缺少暗参考帧")
            if not group.flats:
                missing.append("缺少亮参考帧")
            usable = not mismatch and not missing
            rows.append(
                GroupAvailability(
                    group=group,
                    config_matches=not mismatch,
                    usable=usable,
                    reasons=mismatch,
                    notes=missing,
                )
            )
        return rows

    def resolve(self, meta: ImageMeta, name: str) -> ReferenceGroup:
        group = self.groups.get(name)
        if group is None:
            raise ReferenceError(f"参考组「{name}」不存在")
        reasons = group.key.mismatch(ReferenceKey.from_meta(meta))
        if reasons:
            raise ReferenceError(f"参考组「{name}」与图像配置不匹配", reasons)
        if not group.complete:
            raise ReferenceError(
                f"参考组「{name}」不完整",
                ["缺少暗参考帧" if not group.darks else "缺少亮参考帧"],
            )
        return group

    def auto_resolve(self, meta: ImageMeta) -> tuple[Optional[ReferenceGroup], list[str]]:
        """Pick a group only when exactly one complete group matches."""
        rows = self.availability(meta)
        matches = [row for row in rows if row.usable]
        if len(matches) == 1:
            return matches[0].group, []
        if not matches:
            reasons = [
                f"「{row.group.name}」: " + "；".join(row.reasons + row.notes) for row in rows
            ]
            return None, reasons or ["尚未建立参考组"]
        return None, [
            "多个参考组配置相同，请明确选择: " + "、".join(r.group.name for r in matches)
        ]


# ---------------------------------------------------------------------------
# Bright-reference diagnostics
# ---------------------------------------------------------------------------


@dataclass
class FlatDiagnostics:
    dead_mask: np.ndarray
    hot_mask: np.ndarray
    saturated_mask: np.ndarray
    clipped_fraction: float
    warnings: list[str] = field(default_factory=list)

    @property
    def invalid_mask(self) -> np.ndarray:
        return self.dead_mask | self.hot_mask | self.saturated_mask

    @property
    def any_problem(self) -> bool:
        mask = self.invalid_mask
        return bool(mask.any())

    def summary_lines(self) -> list[str]:
        def pixel_count(mask: np.ndarray) -> int:
            # For colour references a bad pixel is usually bad in every
            # channel; count locations, not channel-entries, so the number
            # matches what the user sees circled on the preview.
            return int(mask.any(axis=2).sum()) if mask.ndim == 3 else int(mask.sum())

        lines = [
            f"亮参考过曝(近量程上沿): {self.clipped_fraction:.3%} 像素",
            f"极暗/坏点: {pixel_count(self.dead_mask)} 像素位置",
            f"局部过亮热点: {pixel_count(self.hot_mask)} 像素位置",
        ]
        lines.extend(self.warnings)
        return lines


def analyze_flat(
    flat: np.ndarray,
    dark: Optional[np.ndarray],
    sensor_max: float,
    *,
    saturation_fraction: float = 0.995,
    dead_ratio: float = 0.08,
    hot_ratio: float = 1.3,
    hot_radius: int = 1,
) -> FlatDiagnostics:
    """Mark unusable pixels in the bright reference.

    Thresholds are relative to the flat's own signal because a flat is meant to
    be non-uniform: a pixel far below its channel's bulk is dead, a pixel far
    above its immediate neighbourhood is a speck, and a pixel at the top of the
    sensor range is clipped.  Raising the bug count is better than silently
    dividing by a bad reference.
    """
    flat = np.asarray(flat, dtype=np.float64)
    dark_arr = np.asarray(dark, dtype=np.float64) if dark is not None else None
    fm = flat - dark_arr if dark_arr is not None else flat.copy()
    warnings: list[str] = []

    if not math.isfinite(sensor_max) or sensor_max <= 0:
        sensor_max = float(np.max(flat)) if flat.size else 255.0
    saturated = flat >= sensor_max * saturation_fraction

    # Full-shape masks: ``invalid_mask`` is combined with the per-channel gain
    # arrays, so a colour flat's masks must be (H, W, C) rather than (H, W).
    dead = np.zeros(flat.shape, dtype=bool)
    hot = np.zeros(flat.shape, dtype=bool)

    for index, channel in enumerate(_channel_arrays(fm)):
        median = _median_ignore_nonfinite(channel)
        if not math.isfinite(median) or median <= max(sensor_max * 1e-4, 1e-9):
            warnings.append(
                f"通道 {index} 亮参考扣暗后中位数接近零 ({median:g})，该通道增益不可靠"
            )
            mask = channel <= max(median, 0.0)
            if fm.ndim == 2:
                dead |= mask
            else:
                dead[..., index] |= mask
            continue
        if float(np.mean(channel < median * 0.05)) > 0.05:
            warnings.append(
                f"通道 {index} 亮参考偏暗，近零像素较多，增益噪声会被放大"
            )
        dead_ch = channel < median * dead_ratio
        blurred = _box_blur(channel, hot_radius)
        hot_ch = (channel > blurred * hot_ratio) & (channel > median * 0.25)
        if fm.ndim == 2:
            dead |= dead_ch
            hot |= hot_ch
        else:
            dead[..., index] |= dead_ch
            hot[..., index] |= hot_ch

    clipped_fraction = float(np.mean(saturated)) if saturated.size else 0.0
    if clipped_fraction > 0.001:
        warnings.append(
            f"亮参考有 {clipped_fraction:.2%} 像素接近量程上沿，"
            "这些位置不参与增益估计，按邻域插值并标记"
        )
    return FlatDiagnostics(
        dead_mask=dead,
        hot_mask=hot,
        saturated_mask=saturated,
        clipped_fraction=clipped_fraction,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Correction
# ---------------------------------------------------------------------------


@dataclass
class CorrectionOptions:
    subtract_dark: bool = True
    apply_gain: bool = True
    #: When a pixel's corrected value would exceed the sensor range, clamp it
    #: and record it in ``guard_mask``.  The count is always reported; the
    #: correction never silently turns a whole frame into pure white.
    guard_overflow: bool = True
    #: Near-saturation threshold used for reporting and for the guard.
    highlight_guard: float = 0.98
    min_gain: float = 0.05
    max_gain: float = 10.0
    inpaint_gain: bool = True


@dataclass
class CorrectionResult:
    original: np.ndarray
    dark_used: Optional[np.ndarray]
    flat_used: Optional[np.ndarray]
    after_dark: np.ndarray
    gain: np.ndarray
    corrected: np.ndarray
    diagnostics: Optional[FlatDiagnostics]
    gain_valid_mask: np.ndarray
    guard_mask: np.ndarray
    sensor_max: float
    clipped_before: float
    clipped_after: float
    group_name: str
    steps: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def view(self, name: str) -> np.ndarray:
        mapping = {
            "原图": self.original,
            "扣暗后": self.after_dark,
            "校正后": self.corrected,
            "增益图": self.gain,
        }
        if name not in mapping:
            raise KeyError(name)
        return mapping[name]

    @property
    def reference_bad_mask(self) -> np.ndarray:
        if self.diagnostics is None:
            return np.zeros(self.original.shape[:2], dtype=bool)
        return self.diagnostics.invalid_mask


VIEW_NAMES = ("原图", "扣暗后", "校正后", "增益图")


def _fallback_sensor_max(image: np.ndarray, bit_depth: int) -> float:
    value = _dtype_max(bit_depth)
    if math.isfinite(value) and value > 0:
        return value
    return float(np.max(image)) if image.size else 255.0


def correct_image(
    image: np.ndarray,
    group: ReferenceGroup,
    options: Optional[CorrectionOptions] = None,
    *,
    sensor_max: Optional[float] = None,
    bit_depth: int = 8,
) -> CorrectionResult:
    """Apply dark subtraction and flat-field division, with explicit guards."""
    opts = options or CorrectionOptions()
    img = np.asarray(image, dtype=np.float64)
    sensor = (
        float(sensor_max)
        if sensor_max is not None and sensor_max > 0
        else _fallback_sensor_max(img, bit_depth)
    )
    steps: list[str] = []
    warnings: list[str] = []

    dark = group.dark_master() if opts.subtract_dark else None
    flat = group.flat_master() if opts.apply_gain else None
    if opts.subtract_dark and dark is None:
        warnings.append("参考组没有暗帧，本次未扣除暗参考")
    if opts.apply_gain and flat is None:
        warnings.append("参考组没有亮帧，本次未按位置校正亮度")

    clipped_before = (
        float(np.mean(img >= sensor * opts.highlight_guard)) if img.size else 0.0
    )

    after_dark = img - dark if dark is not None else img.copy()
    steps.append("扣除暗参考: raw − dark" if dark is not None else "未扣除暗参考")

    diagnostics: Optional[FlatDiagnostics] = None
    gain = np.ones_like(img, dtype=np.float64)
    gain_valid = np.ones(img.shape[:2], dtype=bool)
    guard = np.zeros(img.shape[:2], dtype=bool)
    corrected = after_dark.copy()

    if flat is not None:
        diagnostics = analyze_flat(flat, dark, sensor)
        warnings.extend(diagnostics.warnings)
        gain, gain_valid, gain_warnings = _build_gain(flat, dark, diagnostics, opts, sensor)
        warnings.extend(gain_warnings)
        if gain is None:
            warnings.append("亮参考不可用，本次未应用位置增益")
            gain = np.ones_like(img, dtype=np.float64)
            gain_valid = np.zeros(img.shape[:2], dtype=bool)
            steps.append("亮参考不可用，未应用增益")
        else:
            steps.append("按位置校正: (raw − dark) / gain")
            denom = np.maximum(gain, 1e-9)
            raw_corrected = after_dark / denom
            corrected = raw_corrected
            # Overflow means the corrected value cannot exist within the
            # sensor's range.  We do not clamp it to pure white: we keep the
            # dark-subtracted value, which is in range and still carries
            # scene structure, and mark the pixel.  This is what keeps a bright
            # real scene from pulsing to a solid white frame.
            if opts.guard_overflow:
                overflow = raw_corrected > sensor
                pixel_overflow = (
                    overflow if overflow.ndim == 2 else overflow.any(axis=2)
                )
                if pixel_overflow.any():
                    guard = pixel_overflow
                    if img.ndim == 2:
                        corrected = np.where(guard, after_dark, raw_corrected)
                    else:
                        corrected = np.where(guard[..., None], after_dark, raw_corrected)
                    warnings.append(
                        f"{float(np.mean(guard)):.2%} 像素校正后会超过量程，"
                        "保留扣暗后的值并标记，不整片截白；"
                        "若比例很高，说明场景或亮参考本身过曝，应减少曝光重拍"
                    )
            corrected = np.clip(corrected, None, sensor)
    else:
        steps.append("未按位置校正亮度")

    clipped_after = (
        float(np.mean(corrected >= sensor * opts.highlight_guard)) if corrected.size else 0.0
    )
    if clipped_before > 0 and clipped_after >= clipped_before:
        warnings.append(
            "校正后高光占比没有下降；若场景本身已过曝，平场校正无法恢复，应减少曝光"
        )

    return CorrectionResult(
        original=img,
        dark_used=dark,
        flat_used=flat,
        after_dark=after_dark,
        gain=gain,
        corrected=corrected,
        diagnostics=diagnostics,
        gain_valid_mask=gain_valid,
        guard_mask=guard,
        sensor_max=sensor,
        clipped_before=clipped_before,
        clipped_after=clipped_after,
        group_name=group.name,
        steps=steps,
        warnings=warnings,
    )


def _build_gain(
    flat: np.ndarray,
    dark: Optional[np.ndarray],
    diagnostics: FlatDiagnostics,
    opts: CorrectionOptions,
    sensor_max: float,
) -> tuple[Optional[np.ndarray], np.ndarray, list[str]]:
    """Return ``(gain, valid_mask, warnings)``; gain is ``None`` when unusable."""
    warnings: list[str] = []
    fm = np.asarray(flat, dtype=np.float64)
    if dark is not None:
        fm = fm - np.asarray(dark, dtype=np.float64)

    bad = diagnostics.invalid_mask | ~np.isfinite(fm)
    good = ~bad
    if not good.any():
        warnings.append("参考中所有像素都被判为不可用，无法估计增益；本次不应用增益")
        return None, np.zeros(fm.shape[:2], dtype=bool), warnings

    if fm.ndim == 3:
        channel_values = [fm[..., c][good[..., c]] for c in range(fm.shape[2])]
    else:
        channel_values = [fm[good]]
    pooled = fm[good]

    minimum = max(sensor_max * 1e-3, 1e-6)
    for index, values in enumerate(channel_values):
        med = _median_ignore_nonfinite(values)
        if not math.isfinite(med) or med <= minimum:
            warnings.append(
                f"通道 {index} 亮参考扣暗后的有效中位数接近零 ({med:g})，"
                "增益不可估计；本次不应用位置增益"
            )
            return None, np.zeros(fm.shape[:2], dtype=bool), warnings

    # One *global* scale, not one per channel: dividing each channel by its own
    # median would normalise the channel-to-channel sensitivity difference away
    # and leave a colour cast behind.  A single scalar keeps relative channel
    # response intact, which is exactly what "分通道偏差" needs removed.
    global_scale = _median_ignore_nonfinite(pooled)
    if not math.isfinite(global_scale) or abs(global_scale) <= minimum:
        warnings.append("亮参考有效值整体接近零，增益不可估计")
        return None, np.zeros(fm.shape[:2], dtype=bool), warnings
    gain = fm / global_scale
    gain = np.where(good, gain, np.nan)

    if opts.inpaint_gain and bad.any():
        gain = _fill_gain_from_neighbours(gain, good)
        warnings.append(
            f"参考中 {float(np.mean(bad)):.2%} 像素不可用，增益按邻域插值并标记"
        )
    else:
        gain = np.where(np.isfinite(gain), gain, 1.0)

    gain = np.where(np.isfinite(gain), gain, 1.0)
    gain = np.clip(gain, opts.min_gain, opts.max_gain)
    return gain, good, warnings


def _fill_gain_from_neighbours(gain: np.ndarray, good: np.ndarray) -> np.ndarray:
    filled = np.array(gain, dtype=np.float64, copy=True)
    radius = 4
    if filled.ndim == 2:
        valid = good & np.isfinite(filled)
        num = _box_blur(np.where(valid, filled, 0.0), radius)
        den = _box_blur(valid.astype(np.float64), radius)
        fallback = np.where(den > 1e-9, num / np.maximum(den, 1e-9), 1.0)
        return np.where(valid, filled, fallback)
    for c in range(filled.shape[2]):
        valid = good[..., c] & np.isfinite(filled[..., c])
        num = _box_blur(np.where(valid, filled[..., c], 0.0), radius)
        den = _box_blur(valid.astype(np.float64), radius)
        fallback = np.where(den > 1e-9, num / np.maximum(den, 1e-9), 1.0)
        filled[..., c] = np.where(valid, filled[..., c], fallback)
    return filled


# ---------------------------------------------------------------------------
# Point inspection and regional measurements
# ---------------------------------------------------------------------------


@dataclass
class PointSample:
    x: int
    y: int
    channel_names: tuple[str, ...]
    original: tuple[float, ...]
    dark: tuple[float, ...]
    flat: tuple[float, ...]
    gain: tuple[float, ...]
    corrected: tuple[float, ...]
    guarded: bool
    reference_bad: bool
    gain_interpolated: bool

    def lines(self) -> list[str]:
        def fmt(values: tuple[float, ...]) -> str:
            if not values:
                return "—"
            if len(values) == 1:
                return f"{values[0]:.3f}"
            return "  ".join(
                f"{name}={value:.2f}"
                for name, value in zip(self.channel_names, values)
            )

        out = [
            f"位置 ({self.x}, {self.y})",
            f"原始值        {fmt(self.original)}",
            f"暗参考值      {fmt(self.dark)}",
            f"亮参考值      {fmt(self.flat)}",
            f"增益          {fmt(self.gain)}",
            f"校正结果      {fmt(self.corrected)}",
        ]
        flags = []
        if self.guarded:
            flags.append("高光保护，未除法")
        if self.reference_bad:
            flags.append("该位置参考不可用")
        if self.gain_interpolated:
            flags.append("增益由邻域插值")
        if flags:
            out.append("标记: " + "，".join(flags))
        return out


def sample_point(
    result: CorrectionResult, x: int, y: int, channel_names: Sequence[str] | None = None
) -> PointSample:
    h, w = result.original.shape[:2]
    x = max(0, min(w - 1, int(x)))
    y = max(0, min(h - 1, int(y)))
    if channel_names is None:
        channel_names = (
            ("Y",)
            if result.original.ndim == 2
            else tuple(f"C{i}" for i in range(result.original.shape[2]))
        )

    def at(array: Optional[np.ndarray]) -> tuple[float, ...]:
        if array is None:
            return ()
        return tuple(float(v) for v in np.atleast_1d(array[y, x]))

    def flag(mask: np.ndarray) -> bool:
        return bool(np.any(mask[y, x]))

    return PointSample(
        x=x,
        y=y,
        channel_names=tuple(channel_names),
        original=at(result.original),
        dark=at(result.dark_used),
        flat=at(result.flat_used),
        gain=at(result.gain),
        corrected=at(result.corrected),
        guarded=flag(result.guard_mask),
        reference_bad=flag(result.reference_bad_mask),
        gain_interpolated=bool(
            result.flat_used is not None and not np.all(result.gain_valid_mask[y, x])
        ),
    )


def clip_rect(
    rect: tuple[int, int, int, int], shape: tuple[int, int]
) -> tuple[int, int, int, int]:
    """Normalise a rectangle to ``(x0, y0, x1, y1)`` with x1/y1 exclusive."""
    h, w = shape
    x0, y0, x1, y1 = (int(v) for v in rect)
    x0, x1 = sorted((max(0, min(w - 1, x0)), max(0, min(w - 1, x1))))
    y0, y1 = sorted((max(0, min(h - 1, y0)), max(0, min(h - 1, y1))))
    return x0, y0, max(x0 + 1, min(w, x1 + 1)), max(y0 + 1, min(h, y1 + 1))


def uniform_region_stats(
    before: np.ndarray,
    after: np.ndarray,
    rect: tuple[int, int, int, int],
) -> dict[str, object]:
    """Measure how much a supposedly uniform patch still varies after correction.

    Statistics are computed *per channel* and then averaged, because a coloured
    scene legitimately differs between channels; a flat correction is supposed
    to remove spatial variation, not the channel response difference.
    """
    x0, y0, x1, y1 = clip_rect(rect, before.shape[:2])
    b = np.asarray(before[y0:y1, x0:x1], dtype=np.float64)
    a = np.asarray(after[y0:y1, x0:x1], dtype=np.float64)
    if b.ndim == 2:
        b = b[..., None]
    if a.ndim == 2:
        a = a[..., None]

    per_channel: list[dict[str, float]] = []
    for c in range(b.shape[2]):
        bc, ac = b[..., c], a[..., c]
        b_std = float(np.std(bc))
        a_std = float(np.std(ac))
        b_span = float(np.max(bc) - np.min(bc))
        a_span = float(np.max(ac) - np.min(ac))
        per_channel.append(
            {
                "before_mean": float(np.mean(bc)),
                "before_std": b_std,
                "before_span": b_span,
                "after_mean": float(np.mean(ac)),
                "after_std": a_std,
                "after_span": a_span,
            }
        )

    count = len(per_channel)
    before_std = float(np.mean([s["before_std"] for s in per_channel]))
    after_std = float(np.mean([s["after_std"] for s in per_channel]))
    before_span = float(np.mean([s["before_span"] for s in per_channel]))
    after_span = float(np.mean([s["after_span"] for s in per_channel]))
    return {
        "rect": (x0, y0, x1, y1),
        "channels": count,
        "per_channel": per_channel,
        "before_mean": float(np.mean([s["before_mean"] for s in per_channel])),
        "before_std": before_std,
        "before_span": before_span,
        "after_mean": float(np.mean([s["after_mean"] for s in per_channel])),
        "after_std": after_std,
        "after_span": after_span,
        "std_reduction": 0.0 if before_std == 0 else 1.0 - after_std / before_std,
        "span_reduction": 0.0 if before_span == 0 else 1.0 - after_span / before_span,
        "mean_change": float(
            np.mean([s["after_mean"] - s["before_mean"] for s in per_channel])
        ),
    }


def corner_gradient(before: np.ndarray, after: np.ndarray) -> dict[str, float]:
    """Compare top-left and bottom-right corner means before and after.

    Measured per channel and averaged, so the scene's own colour balance does
    not masquerade as an illumination gradient.
    """
    def means(img: np.ndarray) -> tuple[float, float]:
        img = np.asarray(img, dtype=np.float64)
        h, w = img.shape[:2]
        box = max(4, min(h, w) // 10)
        tl = img[:box, :box]
        br = img[-box:, -box:]
        if tl.ndim == 3:
            tl = tl.reshape(-1, tl.shape[2])
            br = br.reshape(-1, br.shape[2])
            return float(np.mean(tl)), float(np.mean(br))
        return float(np.mean(tl)), float(np.mean(br))

    b_tl, b_br = means(before)
    a_tl, a_br = means(after)
    return {
        "before_tl": b_tl,
        "before_br": b_br,
        "before_delta": b_tl - b_br,
        "after_tl": a_tl,
        "after_br": a_br,
        "after_delta": a_tl - a_br,
        "delta_reduction": abs(b_tl - b_br) - abs(a_tl - a_br),
    }


# ---------------------------------------------------------------------------
# Lossless export, manifest and read-back verification
# ---------------------------------------------------------------------------


@dataclass
class ExportJob:
    image: LoadedImage
    group_name: Optional[str] = None


@dataclass
class ExportRecord:
    input_path: str
    output_path: str
    group_name: str
    group_key: dict
    #: ``value ≈ stored / store_scale + store_offset`` recovers the corrected
    #: float from the 16-bit file exactly, including negative values.
    store_scale: float
    store_offset: float
    store_low: float
    store_high: float
    corner_before_delta: float
    corner_after_delta: float
    readback_max_abs_error: float = float("nan")
    readback_mean_abs_error: float = float("nan")
    verified: bool = False

    def as_dict(self) -> dict:
        return {
            "input": self.input_path,
            "output": self.output_path,
            "reference_group": self.group_name,
            "reference_key": self.group_key,
            "store_scale": self.store_scale,
            "store_offset": self.store_offset,
            "store_range": [self.store_low, self.store_high],
            "corner_delta_before": self.corner_before_delta,
            "corner_delta_after": self.corner_after_delta,
            "readback_max_abs_error": self.readback_max_abs_error,
            "readback_mean_abs_error": self.readback_mean_abs_error,
            "verified": self.verified,
        }


@dataclass
class ExportManifest:
    created: str
    output_dir: str
    records: list[ExportRecord] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(
            {
                "created": self.created,
                "output_dir": self.output_dir,
                "records": [r.as_dict() for r in self.records],
                "errors": self.errors,
            },
            ensure_ascii=False,
            indent=2,
        )

    def write(self, path: str | os.PathLike) -> Path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(self.to_json() + "\n", encoding="utf-8")
        return p


def save_corrected(
    corrected: np.ndarray,
    dest: str | os.PathLike,
    *,
    sensor_max: float,
) -> tuple[float, float, float, float]:
    """Save losslessly as a 16-bit TIFF.

    Returns ``(store_scale, store_offset, lowest, highest)`` such that
    ``value ≈ stored / store_scale + store_offset``.  Dark subtraction can
    legitimately produce negative values; rather than silently clipping them
    (which would break the "lossless" promise), the stored range is shifted so
    the whole corrected range fits.  ``lowest``/``highest`` describe that stored
    range and are written to the manifest so a reader can invert it exactly.
    """
    arr = np.asarray(corrected, dtype=np.float64)
    if arr.size == 0:
        stored = arr.astype(np.uint16)
        write_tiff(dest, stored, bits=16)
        return 1.0, 0.0, 0.0, 0.0

    lowest = min(0.0, float(np.min(arr)))
    highest = max(float(sensor_max) if sensor_max > 0 else 0.0, float(np.max(arr)))
    if highest <= lowest:
        highest = lowest + 1.0
    span = highest - lowest
    scale = 65535.0 / span

    stored = np.rint((arr - lowest) * scale).clip(0, 65535).astype(np.uint16)
    write_tiff(dest, stored, bits=16)
    return scale, lowest, lowest, highest


def read_back_verify(record: ExportRecord, expected: np.ndarray) -> None:
    """Re-open a written file, undo the storage transform and score the error."""
    stored = load_image(record.output_path)
    recovered = stored.array / record.store_scale + record.store_offset
    if expected.ndim == 2 and recovered.ndim == 3:
        recovered = recovered[..., 0]
    elif expected.ndim == 3 and recovered.ndim == 2:
        recovered = recovered[..., None]
    error = np.abs(recovered - expected)
    record.readback_max_abs_error = float(np.max(error)) if error.size else 0.0
    record.readback_mean_abs_error = float(np.mean(error)) if error.size else 0.0
    corners = corner_gradient(expected, recovered)
    record.corner_after_delta = corners["after_delta"]
    # Half a stored step is the unavoidable rounding floor.
    record.verified = bool(
        record.readback_max_abs_error <= (0.5 / record.store_scale) + 1e-9
    )


def export_batch(
    jobs: Sequence[ExportJob],
    library: ReferenceLibrary,
    output_dir: str | os.PathLike,
    options: Optional[CorrectionOptions] = None,
) -> ExportManifest:
    """Correct and save every job, resolving each group strictly.

    An image whose configuration has no single matching group is skipped and
    the reasons are recorded; no group is ever guessed.
    """
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = ExportManifest(
        created=_dt.datetime.now().isoformat(timespec="seconds"),
        output_dir=str(out_dir),
    )
    used_names: set[str] = set()
    for job in jobs:
        image = job.image
        meta = image.meta
        try:
            if job.group_name is not None:
                group = library.resolve(meta, job.group_name)
            else:
                group, reasons = library.auto_resolve(meta)
                if group is None:
                    raise ReferenceError("没有唯一匹配的参考组", reasons)
        except ReferenceError as exc:
            manifest.errors.append(
                f"{meta.path.name}: {exc}"
                + ("；" + "；".join(exc.reasons) if exc.reasons else "")
            )
            continue

        result = correct_image(
            image.array,
            group,
            options,
            sensor_max=meta.sensor_max or None,
            bit_depth=meta.bit_depth,
        )
        stem = meta.path.stem or "image"
        name = f"{stem}_flatfield.tif"
        counter = 1
        while name in used_names:
            counter += 1
            name = f"{stem}_flatfield_{counter}.tif"
        used_names.add(name)
        dest = out_dir / name
        scale, offset, low, high = save_corrected(
            result.corrected, dest, sensor_max=meta.sensor_max or result.sensor_max
        )
        corners = corner_gradient(image.array, result.corrected)
        record = ExportRecord(
            input_path=str(meta.path),
            output_path=str(dest),
            group_name=group.name,
            group_key=group.key.as_dict(),
            store_scale=scale,
            store_offset=offset,
            store_low=low,
            store_high=high,
            corner_before_delta=corners["before_delta"],
            corner_after_delta=corners["after_delta"],
        )
        read_back_verify(record, result.corrected)
        manifest.records.append(record)

    manifest_path = out_dir / "flatfield_manifest.json"
    manifest.write(manifest_path)
    return manifest


# ---------------------------------------------------------------------------
# Synthetic samples
# ---------------------------------------------------------------------------


@dataclass
class SampleSpec:
    width: int = 480
    height: int = 360
    channels: int = 3
    exposure_ev: float = 0.0
    vignette_strength: float = 0.25
    channel_scale: tuple[float, ...] = (1.0, 0.94, 0.89)
    flat_level: float = 185.0
    scene_level: float = 150.0
    bright_level: float = 220.0
    seed: int = 7


@dataclass
class SyntheticSet:
    science: LoadedImage
    darks: list[LoadedImage]
    flats: list[LoadedImage]
    truth_scene: np.ndarray
    truth_gain: np.ndarray
    truth_dark: np.ndarray
    uniform_rect: tuple[int, int, int, int]
    bright_rect: tuple[int, int, int, int]

    def group(self, name: str = "合成参考") -> ReferenceGroup:
        key = ReferenceKey.from_meta(self.science.meta)
        return ReferenceGroup(name=name, key=key, darks=list(self.darks), flats=list(self.flats))


def vignette_field(
    h: int,
    w: int,
    strength: float,
    offset_x: float = 0.0,
    offset_y: float = 0.0,
    tilt_x: float = 0.45,
    tilt_y: float = 0.30,
) -> np.ndarray:
    """Directional illumination gradient plus a radial falloff.

    The desk lamp sits up and to the left, so the top-left of the frame is
    brighter than the bottom-right; a radial term adds corner falloff on top of
    that.  Shifting the centre per channel makes the channel gradients genuinely
    different, not just differently scaled.
    """
    yy, xx = np.mgrid[0:h, 0:w]
    yn = (yy + 0.5) / h - 0.5 - offset_y
    xn = (xx + 0.5) / w - 0.5 - offset_x
    directional = 1.0 - tilt_x * xn - tilt_y * yn
    radius = np.sqrt(xn * xn + yn * yn) / math.sqrt(0.5)
    radial = 1.0 - strength * radius**2
    return np.clip(directional * radial, 0.05, 2.0)


def make_synthetic_set(spec: SampleSpec = SampleSpec()) -> SyntheticSet:
    """Deterministic scene with a one-sided fall-off, channel bias and specks.

    Each channel gets a *differently positioned* gradient as well as its own
    scale, so a correction that assumes one shared grey gradient cannot pass.
    """
    rng = np.random.default_rng(spec.seed)
    h, w, c = spec.height, spec.width, spec.channels
    if c < 1:
        raise ValueError("channels must be at least 1")

    xs = np.arange(w)
    bump = 1.0 + 0.05 * np.exp(
        -(((xs[None, :] - w * 0.72) ** 2) / (2 * (w * 0.13) ** 2))
    )
    scales = list(spec.channel_scale[:c])
    while len(scales) < c:
        scales.append(1.0)

    if c == 1:
        gain = (vignette_field(h, w, spec.vignette_strength) * bump)[..., None]
    else:
        channel_gains = []
        for ci in range(c):
            field = vignette_field(
                h,
                w,
                spec.vignette_strength,
                offset_x=0.05 * ci,
                offset_y=-0.03 * ci,
            )
            channel_gains.append(field * bump * scales[ci])
        gain = np.stack(channel_gains, axis=-1)
    gain = np.clip(gain, 0.05, 2.0)

    dark_2d = 4.0 + 3.0 * rng.random((h, w))
    truth_dark = dark_2d[..., None] if c == 1 else np.repeat(dark_2d[..., None], c, axis=2)

    scene_2d = np.full((h, w), spec.scene_level, dtype=np.float64)
    bx0, by0 = int(w * 0.58), int(h * 0.14)
    bx1, by1 = int(w * 0.82), int(h * 0.38)
    scene_2d[by0:by1, bx0:bx1] = spec.bright_level
    if c == 1:
        scene = scene_2d[..., None]
    else:
        scene = np.repeat(scene_2d[..., None], c, axis=2)
        scene = scene * np.array([1.0, 0.97, 0.93])[None, None, :c]

    raw = np.clip(np.rint(truth_dark + gain * scene), 0, 255)

    darks: list[LoadedImage] = []
    darks_count = 3
    for i in range(darks_count):
        frame = truth_dark[..., 0] + rng.normal(0, 0.7, (h, w))
        if c > 1:
            frame = np.repeat(frame[..., None], c, axis=2)
        darks.append(
            _synthetic_loaded(frame, f"dark_ev{spec.exposure_ev:g}_{i}.png", spec, c)
        )

    flats: list[LoadedImage] = []
    for i in range(darks_count):
        frame = truth_dark + gain * spec.flat_level
        frame = frame + rng.normal(0, 1.0, frame.shape)
        frame = np.clip(frame, 0, 255)
        frame = np.array(frame, copy=True)
        specks = [(int(h * 0.19), int(w * 0.31)), (int(h * 0.21), int(w * 0.33))]
        dead = [(int(h * 0.44), int(w * 0.78)), (int(h * 0.52), int(w * 0.16))]
        for yy, xx in specks:
            # ``frame[yy, xx]`` is shape (C,) — or (1,) for a gray frame — so
            # use np.minimum rather than the builtin min, which would try to
            # take the truth value of an array.
            frame[yy, xx] = np.minimum(255.0, frame[yy, xx] * 4.0)
        for yy, xx in dead:
            frame[yy, xx] = 0.0
        sy0, sy1 = int(h * 0.05), int(h * 0.08)
        sx0, sx1 = int(w * 0.05), int(w * 0.09)
        frame[sy0:sy1, sx0:sx1] = 255.0
        flats.append(
            _synthetic_loaded(frame, f"flat_ev{spec.exposure_ev:g}_{i}.png", spec, c)
        )

    # For single-channel data the working arrays are (H, W, 1) internally; drop
    # the trailing axis before handing them to _synthetic_loaded so stored
    # images and truth arrays follow the 2-D convention used everywhere else.
    def _out(arr: np.ndarray) -> np.ndarray:
        return arr[..., 0] if c == 1 else arr

    science = _synthetic_loaded(
        _out(raw), f"science_ev{spec.exposure_ev:g}.png", spec, c
    )
    return SyntheticSet(
        science=science,
        darks=darks,
        flats=flats,
        truth_scene=_out(scene),
        truth_gain=_out(gain),
        truth_dark=_out(truth_dark),
        uniform_rect=(int(w * 0.06), int(h * 0.58), int(w * 0.32), int(h * 0.84)),
        bright_rect=(bx0, by0, bx1, by1),
    )


def _synthetic_loaded(
    array: np.ndarray, name: str, spec: SampleSpec, channels: int
) -> LoadedImage:
    arr = np.asarray(array, dtype=np.float64)
    if arr.ndim == 3 and arr.shape[2] == 1:
        arr = arr[..., 0]  # keep single-channel data 2-D everywhere
    meta = ImageMeta(
        path=Path(name),
        width=arr.shape[1],
        height=arr.shape[0],
        channels=channels,
        channel_names=_channel_names("L" if channels == 1 else "RGB", channels),
        bit_depth=8,
        exposure_ev=spec.exposure_ev,
        mode="L" if channels == 1 else "RGB",
    )
    return LoadedImage(meta=meta, array=arr)


def write_synthetic_samples(
    directory: str | os.PathLike, spec: SampleSpec = SampleSpec()
) -> SyntheticSet:
    """Write sample PNGs for the GUI, with EV encoded in the filenames."""
    out = Path(directory)
    out.mkdir(parents=True, exist_ok=True)
    sample = make_synthetic_set(spec)
    written: list[LoadedImage] = [sample.science, *sample.darks, *sample.flats]
    for image in written:
        data = np.clip(np.rint(image.array), 0, 255).astype(np.uint8)
        if data.ndim == 3 and data.shape[2] == 1:
            data = data[..., 0]
        dest = out / image.meta.path.name
        Image.fromarray(data).save(dest)
        image.meta = replace(image.meta, path=dest)
    return sample


def synthetic_validation(spec: SampleSpec = SampleSpec()) -> dict[str, object]:
    """Run the whole pipeline on synthetic data and report measurable change."""
    sample = make_synthetic_set(spec)
    group = sample.group()
    result = correct_image(
        sample.science.array,
        group,
        sensor_max=sample.science.meta.sensor_max,
        bit_depth=sample.science.meta.bit_depth,
    )
    before = uniform_region_stats(
        sample.science.array, sample.science.array, sample.uniform_rect
    )
    after = uniform_region_stats(
        sample.science.array, result.corrected, sample.uniform_rect
    )
    corners = corner_gradient(sample.science.array, result.corrected)
    # Flat correction preserves the flat's global level, so the expected
    # result is the scene multiplied by the median of the true gain field.
    truth_level = float(np.median(sample.truth_gain))
    expected = sample.truth_scene * truth_level
    truth_error_before = float(np.mean(np.abs(sample.science.array - expected)))
    truth_error_after = float(np.mean(np.abs(result.corrected - expected)))
    diagnostics = result.diagnostics
    return {
        "group": group.name,
        "corner_before_delta": corners["before_delta"],
        "corner_after_delta": corners["after_delta"],
        "corner_delta_reduction": corners["delta_reduction"],
        "uniform_before_std": before["before_std"],
        "uniform_after_std": after["after_std"],
        "uniform_std_reduction": after["std_reduction"],
        "uniform_before_span": before["before_span"],
        "uniform_after_span": after["after_span"],
        "uniform_span_reduction": after["span_reduction"],
        "mean_abs_error_to_truth_before": truth_error_before,
        "mean_abs_error_to_truth_after": truth_error_after,
        "flat_dead_pixels": int(diagnostics.dead_mask.sum()) if diagnostics else 0,
        "flat_hot_pixels": int(diagnostics.hot_mask.sum()) if diagnostics else 0,
        "flat_saturated_pixels": int(diagnostics.saturated_mask.sum()) if diagnostics else 0,
        "guard_fraction": float(np.mean(result.guard_mask)),
        "warnings": list(result.warnings),
    }
