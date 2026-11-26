"""Synthetic sign snapshots with known geometry, blur and noise.

The generator renders a scene at a supersampled resolution (anti-aliased when
downsampled), records exact target geometry (edges, bars, character stems),
then applies a *different* motion PSF to each named region.  The result is a
pair of images:

    clean.png      the sharp reference
    blurred.png    blurred regions + sensor noise

plus ``targets.json`` describing every edge/line/stroke target and whether it
is held out from estimation.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
from PIL import Image, ImageDraw

from . import ops

# ---------------------------------------------------------------------------
# A 5x7 bitmap font (portable: no system font required).
# ---------------------------------------------------------------------------

_FONT = {
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01110", "10001", "10000", "10000", "10000", "10001", "01110"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01110", "10001", "10000", "10111", "10001", "10001", "01110"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("11111", "00100", "00100", "00100", "00100", "00100", "11111"),
    "J": ("00111", "00010", "00010", "00010", "10010", "10010", "01100"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "11011", "10001"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
    "0": ("01110", "10011", "10101", "10101", "10101", "11001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11111", "00010", "00100", "00010", "00001", "10001", "01110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "11110", "00001", "00001", "10001", "01110"),
    "6": ("00110", "01000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00010", "01100"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    ".": ("00000", "00000", "00000", "00000", "00000", "01100", "01100"),
    ":": ("00000", "01100", "01100", "00000", "01100", "01100", "00000"),
    "!": ("00100", "00100", "00100", "00100", "00100", "00000", "00100"),
    " ": ("00000",) * 7,
}

GLYPH_W, GLYPH_H, ADVANCE, LINE_GAP = 5, 7, 6, 3


@dataclass
class BlurRegion:
    name: str
    rect: tuple[int, int, int, int]
    angle: float
    length: float
    thickness: float = 1.0
    profile: str = "box"
    feather: float = 1.5

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "rect": list(self.rect),
            "angle": float(self.angle),
            "length": float(self.length),
            "thickness": float(self.thickness),
            "profile": self.profile,
            "feather": float(self.feather),
        }


@dataclass
class Target:
    id: str
    kind: str  # "edge" | "line"
    region: str
    heldout: bool
    point: tuple[float, float]
    normal_deg: float = 0.0
    direction_deg: float = 0.0
    width: float = 0.0
    true_value: float = 0.0
    note: str = ""

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "kind": self.kind,
            "region": self.region,
            "heldout": bool(self.heldout),
            "point": [float(self.point[0]), float(self.point[1])],
            "normal_deg": float(self.normal_deg),
            "note": self.note,
        }
        if self.kind == "line":
            d["direction_deg"] = float(self.direction_deg)
            d["width"] = float(self.width)
        if self.kind == "edge":
            d["true_width"] = float(self.true_value)
        return d


# ---------------------------------------------------------------------------
# Scene drawing
# ---------------------------------------------------------------------------

class _Scene:
    """Draws in final-image coordinates onto a supersampled canvas."""

    def __init__(self, width: int, height: int, supersample: int = 3):
        self.w = width
        self.h = height
        self.s = int(max(1, supersample))
        self.canvas = Image.new("RGB", (width * self.s, height * self.s), (232, 230, 224))
        self.draw = ImageDraw.Draw(self.canvas)
        self.targets: list[Target] = []
        self._target_serial = 0

    # -- primitives ---------------------------------------------------------
    def _pt(self, x: float, y: float) -> tuple[float, float]:
        return x * self.s, y * self.s

    def rect(self, rect: Sequence[float], fill=None, outline=None, width: float = 1.0) -> None:
        x0, y0, x1, y1 = rect
        self.draw.rectangle(
            [*self._pt(x0, y0), *self._pt(x1, y1)],
            fill=fill,
            outline=outline,
            width=max(1, int(round(width * self.s))),
        )

    def rounded_rect(self, rect, radius, fill=None, outline=None, width=1.0) -> None:
        x0, y0, x1, y1 = rect
        self.draw.rounded_rectangle(
            [*self._pt(x0, y0), *self._pt(x1, y1)],
            radius=radius * self.s,
            fill=fill,
            outline=outline,
            width=max(1, int(round(width * self.s))),
        )

    def polygon(self, points, fill=None, outline=None, width=1.0) -> None:
        pts = [self._pt(x, y) for x, y in points]
        self.draw.polygon(pts, fill=fill, outline=outline, width=max(1, int(round(width * self.s))))

    def line(self, p0, p1, fill, width: float = 1.0) -> None:
        self.draw.line(
            [*self._pt(*p0), *self._pt(*p1)],
            fill=fill,
            width=max(1, int(round(width * self.s))),
        )

    def ellipse(self, rect, fill=None, outline=None, width=1.0) -> None:
        x0, y0, x1, y1 = rect
        self.draw.ellipse(
            [*self._pt(x0, y0), *self._pt(x1, y1)],
            fill=fill,
            outline=outline,
            width=max(1, int(round(width * self.s))),
        )

    def bars(self, x: float, y: float, widths: Sequence[float], height: float, gap: float = 6.0) -> None:
        cx = x
        for wdt in widths:
            self.rect((cx, y, cx + wdt, y + height), fill=(20, 20, 20))
            cx += wdt + gap

    # -- text ---------------------------------------------------------------
    def text(
        self,
        text: str,
        x: float,
        y: float,
        scale: float,
        color=(20, 20, 20),
        *,
        region: str = "",
        heldout: bool = True,
        record: bool = True,
        record_limit: int = 2,
    ) -> tuple[float, float]:
        """Draw text; returns its final (width, height) in image pixels."""
        s = scale
        pen = x
        recorded = 0
        for ch in text.upper():
            pattern = _FONT.get(ch, _FONT[" "])
            if record and region and recorded < record_limit and ch not in " .:":
                recorded += self._record_glyph_targets(pattern, pen, y, s, ch, region, heldout)
            for ry, row in enumerate(pattern):
                for rx, bit in enumerate(row):
                    if bit == "1":
                        self.rect(
                            (pen + rx * s, y + ry * s, pen + (rx + 1) * s, y + (ry + 1) * s),
                            fill=color,
                        )
            pen += ADVANCE * s
        return pen - x, GLYPH_H * s

    def _record_glyph_targets(
        self,
        pattern: Sequence[str],
        x: float,
        y: float,
        s: float,
        ch: str,
        region: str,
        heldout: bool,
    ) -> int:
        """Record a vertical and/or horizontal stem of this glyph."""
        cols = [
            c
            for c in range(GLYPH_W)
            if all(pattern[r][c] == "1" for r in range(GLYPH_H))
        ]
        rows = [
            r
            for r in range(GLYPH_H)
            if all(pattern[r][c] == "1" for c in range(GLYPH_W))
        ]
        made = 0
        if cols:
            c0 = min(cols)
            run = 1
            while c0 + run in cols:
                run += 1
            cx = x + (c0 + run / 2.0) * s
            cy = y + GLYPH_H * s / 2.0
            self._add_target(
                Target(
                    id=f"{region}-stem-{ch}-v{self._target_serial}",
                    kind="line",
                    region=region,
                    heldout=heldout,
                    point=(cx, cy),
                    direction_deg=90.0,
                    width=run * s,
                    note=f"vertical stem of {ch}",
                )
            )
            made += 1
        if rows:
            r0 = min(rows)
            run = 1
            while r0 + run in rows:
                run += 1
            cx = x + GLYPH_W * s / 2.0
            cy = y + (r0 + run / 2.0) * s
            self._add_target(
                Target(
                    id=f"{region}-stem-{ch}-h{self._target_serial}",
                    kind="line",
                    region=region,
                    heldout=heldout,
                    point=(cx, cy),
                    direction_deg=0.0,
                    width=run * s,
                    note=f"horizontal stem of {ch}",
                )
            )
            made += 1
        return made

    def _add_target(self, target: Target) -> None:
        self._target_serial += 1
        self.targets.append(target)

    def add_edge(
        self,
        region: str,
        point: tuple[float, float],
        normal_deg: float,
        *,
        heldout: bool,
        note: str = "",
        true_width: float = 0.0,
        target_id: str | None = None,
    ) -> None:
        tid = target_id or f"{region}-edge-{self._target_serial}"
        self._add_target(
            Target(
                id=tid,
                kind="edge",
                region=region,
                heldout=heldout,
                point=point,
                normal_deg=normal_deg,
                true_value=true_width,
                note=note,
            )
        )

    def add_line(
        self,
        region: str,
        point: tuple[float, float],
        direction_deg: float,
        width: float,
        *,
        heldout: bool,
        note: str = "",
    ) -> None:
        self._add_target(
            Target(
                id=f"{region}-line-{self._target_serial}",
                kind="line",
                region=region,
                heldout=heldout,
                point=point,
                direction_deg=direction_deg,
                width=width,
                note=note,
            )
        )


def _texture(shape: tuple[int, int], rng: np.random.Generator, strength: float = 0.015) -> np.ndarray:
    h, w = shape
    low = rng.normal(0.0, 1.0, (max(2, h // 48), max(2, w // 48))).astype(np.float32)
    low = np.asarray(
        Image.fromarray(
            ((low - low.min()) / (np.ptp(low) + 1e-6) * 255).astype(np.uint8)
        ).resize((w, h), ops.RESAMPLE_BICUBIC),
        dtype=np.float32,
    ) / 255.0
    low = low - low.mean()
    fine = rng.normal(0.0, 1.0, (h, w)).astype(np.float32)
    fine = ops.gaussian_blur(fine, 1.2)
    fine /= fine.std() + 1e-6
    return (low * 0.9 + fine * 0.35) * strength


def render_scene(
    width: int = 960,
    height: int = 640,
    *,
    seed: int = 7,
    supersample: int = 3,
) -> tuple[np.ndarray, list[Target], tuple[int, int, int, int]]:
    """Render the sharp scene.  Returns (rgb float, targets, control_rect).

    The layout is designed at 960x640; other sizes are rendered at that grid
    and uniformly scaled to fit, so edge normals and angle targets stay valid.
    """
    DW, DH = 960, 640
    sc = _Scene(DW, DH, supersample)
    d = sc.draw
    W, H = DW, DH

    # Board background with two tone panels.
    sc.rect((0, 0, W, H), fill=(226, 224, 216))
    sc.rect((0, 0, W, 64), fill=(196, 197, 192))          # sharp control band
    sc.rect((0, H - 78, W, H), fill=(200, 198, 190))      # sharp lower band

    # ---- Region A: exit sign -------------------------------------------------
    ax0, ay0, ax1, ay1 = 46, 92, 462, 404
    sc.rounded_rect((ax0, ay0, ax1, ay1), 10, fill=(247, 246, 240), outline=(30, 40, 36), width=2.0)
    sc.text("EXIT", ax0 + 30, ay0 + 26, 9.0, (24, 34, 30), region="A", heldout=False, record_limit=1)
    sc.text("P3 LEVEL", ax0 + 30, ay0 + 100, 2.0, (40, 48, 44), region="A", heldout=True, record_limit=1)
    sc.text("SERVICE DOOR", ax0 + 30, ay0 + 132, 1.0, (60, 66, 62), region="A", heldout=True, record_limit=1)
    # arrow
    sc.polygon(
        [(ax0 + 320, ay0 + 40), (ax0 + 320, ay0 + 100), (ax0 + 385, ay0 + 70)],
        fill=(22, 30, 26),
    )
    # thin bars inside A (known widths)
    sc.bars(ax0 + 32, ay0 + 196, (1.0, 2.0, 3.0, 5.0), 34.0, gap=9.0)
    sc.add_line("A", (ax0 + 32 + 0.5, ay0 + 213), 90.0, 1.0, heldout=True, note="bar 1 px")
    sc.add_line("A", (ax0 + 32 + 1 + 9 + 1.0, ay0 + 213), 90.0, 2.0, heldout=True, note="bar 2 px")
    sc.add_line("A", (ax0 + 32 + 1 + 9 + 2 + 9 + 1.5, ay0 + 213), 90.0, 3.0, heldout=True, note="bar 3 px")
    sc.add_line("A", (ax0 + 32 + 1 + 9 + 2 + 9 + 3 + 9 + 2.5, ay0 + 213), 90.0, 5.0, heldout=True, note="bar 5 px")
    sc.text("KEEP CLEAR", ax0 + 32, ay0 + 262, 2.0, (30, 38, 34), region="A", heldout=True, record_limit=1)

    # known straight edges of the panel
    sc.add_edge("A", (ax1, ay0 + 80), 0.0, heldout=False, note="panel A right border", true_width=0.0)
    sc.add_edge("A", (ax0 + 120, ay1), 90.0, heldout=True, note="panel A bottom border", true_width=0.0)
    sc.add_edge("A", (ax0, ay0 + 300), 0.0, heldout=True, note="panel A left border", true_width=0.0)
    # diagonal of the arrow: normal along 30 deg
    sc.add_edge("A", (ax0 + 350, ay0 + 68), 30.0, heldout=True, note="arrow diagonal", true_width=0.0)

    # ---- Region B: hazard panel ---------------------------------------------
    bx0, by0, bx1, by1 = 534, 246, 916, 566
    sc.rounded_rect((bx0, by0, bx1, by1), 8, fill=(236, 212, 92), outline=(40, 36, 20), width=2.0)
    # diagonal hazard stripes (thin edges)
    for i in range(7):
        x = bx0 + 26 + i * 34
        sc.line((x, by1 - 18), (x + 52, by1 - 92), (40, 36, 20), width=3.0)
    sc.text("CAUTION", bx0 + 28, by0 + 24, 3.0, (34, 30, 18), region="B", heldout=False, record_limit=1)
    sc.text("KEEP CLEAR", bx0 + 28, by0 + 62, 1.5, (44, 40, 26), region="B", heldout=True, record_limit=1)
    sc.text("LOT 7", bx0 + 28, by0 + 96, 1.0, (44, 40, 26), region="B", heldout=True, record_limit=1)
    sc.ellipse((bx0 + 250, by0 + 22, bx0 + 340, by0 + 112), fill=(247, 242, 218), outline=(50, 44, 24), width=2.0)
    sc.text("3", bx0 + 278, by0 + 38, 5.0, (50, 44, 24), region="B", heldout=True, record_limit=0)

    sc.add_edge("B", (bx1, by0 + 60), 0.0, heldout=False, note="panel B right border", true_width=0.0)
    sc.add_edge("B", (bx0 + 100, by0), 90.0, heldout=True, note="panel B top border", true_width=0.0)
    sc.add_edge("B", (bx0 + 240, by0 + 70), 38.0, heldout=True, note="stripe diagonal", true_width=3.0)

    # ---- Sharp control band (top) -------------------------------------------
    sc.text("FIRE LANE", 60, 18, 2.0, (32, 38, 34), region="CTRL", heldout=True, record_limit=1)
    sc.text("NO PARKING", 250, 22, 1.0, (48, 54, 50), region="CTRL", heldout=True, record_limit=1)
    sc.bars(520, 16, (1.0, 2.0), 34.0, gap=10.0)
    sc.add_line("CTRL", (520.5, 33), 90.0, 1.0, heldout=True, note="control bar 1 px")
    sc.add_line("CTRL", (532.0, 33), 90.0, 2.0, heldout=True, note="control bar 2 px")
    sc.add_edge("CTRL", (700, 18), 90.0, heldout=True, note="control band edge", true_width=0.0)

    # ---- Sharp lower band (held-out clean sample) ---------------------------
    sc.text("BAY 12", 60, H - 62, 2.0, (30, 36, 32), region="HELD", heldout=True, record_limit=1)
    sc.text("ZONE C", 220, H - 60, 1.0, (30, 36, 32), region="HELD", heldout=True, record_limit=1)
    sc.bars(480, H - 64, (1.0, 2.0, 3.0), 34.0, gap=12.0)
    sc.add_line("HELD", (480.5, H - 47), 90.0, 1.0, heldout=True, note="heldout bar 1 px")
    sc.add_line("HELD", (493.0, H - 47), 90.0, 2.0, heldout=True, note="heldout bar 2 px")
    sc.add_line("HELD", (508.5, H - 47), 90.0, 3.0, heldout=True, note="heldout bar 3 px")
    sc.add_edge("HELD", (740, H - 46), 90.0, heldout=True, note="heldout panel edge", true_width=0.0)

    # Uniform scale to fit the requested canvas (no anisotropic distortion,
    # which would bend edge normals and invalidate the targets).  Remaining
    # area is filled with the board background.
    W, H = DW, DH
    k = min(width / DW, height / DH)
    out_w = max(1, int(round(DW * k)))
    out_h = max(1, int(round(DH * k)))
    arr = np.asarray(
        sc.canvas.resize((out_w, out_h), ops.RESAMPLE_LANCZOS), dtype=np.float32
    ) / 255.0
    if out_w != width or out_h != height:
        canvas = np.empty((height, width, 3), dtype=np.float32)
        canvas[:] = np.array([226, 224, 216], dtype=np.float32) / 255.0
        canvas[:out_h, :out_w] = arr
        arr = canvas
    rng = np.random.default_rng(seed)
    arr = np.clip(arr + _texture((height, width), rng)[..., None] * 0.55, 0.0, 1.0)

    # Scale target points / widths by the same uniform factor k.
    if abs(k - 1.0) > 1e-9:
        for t in sc.targets:
            t.point = (t.point[0] * k, t.point[1] * k)
            if t.kind == "line":
                t.width *= k
        control_rect = (
            int(round(12 * k)), int(round(8 * k)),
            int(round((DW - 12) * k)), int(round(56 * k)),
        )
    else:
        control_rect = (12, 8, DW - 12, 56)
    return arr.astype(np.float32), sc.targets, control_rect


# ---------------------------------------------------------------------------
# Blur + noise
# ---------------------------------------------------------------------------

def apply_blur_regions(
    clean: np.ndarray,
    regions: Sequence[BlurRegion],
) -> np.ndarray:
    """Blur each region with its own PSF, blending on a thin feather."""
    clean = np.asarray(clean, dtype=np.float32)
    out = clean.copy()
    for region in regions:
        psf = ops.psf_line(region.length, region.angle, region.thickness, region.profile)
        blurred = np.stack(
            [ops.convolve_psf(clean[..., c], psf) for c in range(clean.shape[2])],
            axis=-1,
        ) if clean.ndim == 3 else ops.convolve_psf(clean, psf)
        mask = ops.rect_mask(clean.shape[:2], region.rect, feather=region.feather)
        if clean.ndim == 3:
            mask = mask[..., None]
        out = out * (1.0 - mask) + blurred * mask
    return np.clip(out, 0.0, 1.0).astype(np.float32)


def add_sensor_noise(
    image: np.ndarray,
    *,
    sigma: float = 0.012,
    seed: int = 7,
    hot_pixels: int = 12,
) -> tuple[np.ndarray, float]:
    rng = np.random.default_rng(seed)
    arr = np.asarray(image, dtype=np.float32)
    noise = rng.normal(0.0, sigma, arr.shape).astype(np.float32)
    # A pinch of shot noise on top of the read noise.
    shot = rng.normal(0.0, 1.0, arr.shape).astype(np.float32) * np.sqrt(np.clip(arr, 0, 1) / 255.0) * 0.35
    out = np.clip(arr + noise + shot, 0.0, 1.0)
    if hot_pixels > 0 and arr.ndim == 3:
        h, w = arr.shape[:2]
        ys = rng.integers(0, h, hot_pixels)
        xs = rng.integers(0, w, hot_pixels)
        out[ys, xs, :] = 1.0
    return out.astype(np.float32), float(np.sqrt(sigma ** 2 + 0.01 ** 2))


def default_regions(width: int = 960, height: int = 640) -> list[BlurRegion]:
    """Two-region demo matching ``render_scene``'s uniform-fit scaling."""
    k = min(width / 960.0, height / 640.0)
    ax0, ay0 = int(round(46 * k)), int(round(92 * k))
    ax1, ay1 = int(round(462 * k)), int(round(404 * k))
    bx0, by0 = int(round(534 * k)), int(round(246 * k))
    bx1, by1 = int(round(916 * k)), int(round(566 * k))
    return [
        BlurRegion("A", (ax0, ay0, ax1, ay1), angle=12.0, length=17.0, thickness=1.2),
        BlurRegion("B", (bx0, by0, bx1, by1), angle=101.0, length=11.0, thickness=1.0),
    ]


# ---------------------------------------------------------------------------
# Saving a sample set
# ---------------------------------------------------------------------------

def _write_targets(path: Path, targets: Sequence[Target]) -> None:
    path.write_text(json.dumps([t.to_dict() for t in targets], indent=2), encoding="utf-8")


def save_sample(
    outdir: str | Path,
    *,
    width: int = 960,
    height: int = 640,
    seed: int = 7,
    noise: float = 0.012,
    regions: Sequence[BlurRegion] | None = None,
    supersample: int = 3,
) -> dict:
    """Render, blur, add noise and write clean/blurred/targets/meta."""
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    clean, targets, control_rect = render_scene(width, height, seed=seed, supersample=supersample)
    regions = list(regions if regions is not None else default_regions(width, height))
    blurred = apply_blur_regions(clean, regions)
    noisy, sigma_est = add_sensor_noise(blurred, sigma=noise, seed=seed + 1)
    ops.save_rgb(outdir / "clean.png", clean)
    ops.save_rgb(outdir / "blurred.png", noisy)
    _write_targets(outdir / "targets.json", targets)

    meta = {
        "schema": "deblur-lab/1",
        "width": width,
        "height": height,
        "seed": seed,
        "noise_sigma": noise,
        "noise_sigma_expected": sigma_est,
        "control_rect": list(control_rect),
        "regions": [r.to_dict() for r in regions],
        "targets_file": "targets.json",
        "clean": "clean.png",
        "blurred": "blurred.png",
    }
    (outdir / "scene.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def save_batch(
    outdir: str | Path,
    *,
    angles: Sequence[float] = (0, 15, 30, 45, 60, 90, 120, 150),
    lengths: Sequence[float] = (5, 9, 13, 18, 25),
    noise: float = 0.012,
    seed: int = 7,
    width: int = 640,
    height: int = 440,
) -> list[dict]:
    """A grid of single-blur samples, for calibration / recovery curves."""
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    manifest = []
    idx = 0
    # Keep the top control band and the bottom held-out band sharp; blur only
    # the middle strip so targets outside it remain valid references.
    x0, y0 = int(round(0.05 * width)), int(round(0.18 * height))
    x1, y1 = int(round(0.95 * width)), int(round(0.78 * height))
    for angle in angles:
        for length in lengths:
            idx += 1
            name = f"a{int(angle):03d}_l{int(round(length)):02d}"
            region = BlurRegion("MAIN", (x0, y0, x1, y1), float(angle), float(length), 1.0)
            meta = save_sample(
                outdir / name,
                width=width,
                height=height,
                seed=seed + idx,
                noise=noise,
                regions=[region],
                supersample=2,
            )
            meta["sample"] = name
            meta["true_angle"] = float(angle)
            meta["true_length"] = float(length)
            (outdir / name / "scene.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
            manifest.append({"sample": name, "angle": float(angle), "length": float(length)})
    (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest
