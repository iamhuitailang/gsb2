"""Pixel comparison between an early preview and the full image.

Both images are cropped to the same region and scaled to the same size
before comparison. Images of different sizes (or missing images) are
never compared pixel-by-pixel as if they were the same thing -- the
result is reported as not comparable instead.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict, field

import numpy as np
from PIL import Image


@dataclass
class CompareResult:
    comparable: bool
    reason: str = ""
    crop: tuple = ()              # (x0, y0, x1, y1) actually used
    mean_abs_diff: float = 0.0
    max_abs_diff: float = 0.0
    changed_fraction: float = 0.0       # fraction of pixels over threshold
    threshold: int = 0
    grid: tuple = (8, 8)
    block_mean_diff: list = field(default_factory=list)  # rows of floats
    last_changed_region: tuple = ()     # (x0, y0, x1, y1) in crop coords

    def to_dict(self):
        d = asdict(self)
        d["crop"] = list(self.crop)
        d["last_changed_region"] = list(self.last_changed_region)
        d["grid"] = list(self.grid)
        return d


def _normalize_crop(crop, size):
    """Clamp a crop box to image size; default to the whole image."""
    w, h = size
    if not crop:
        return (0, 0, w, h)
    x0, y0, x1, y1 = crop
    x0 = max(0, min(int(x0), w - 1))
    y0 = max(0, min(int(y0), h - 1))
    x1 = max(x0 + 1, min(int(x1), w))
    y1 = max(y0 + 1, min(int(y1), h))
    return (x0, y0, x1, y1)


def compare(early: Image.Image, full: Image.Image, crop=None,
            threshold: int = 8, grid=(8, 8),
            work_size=(256, 256)) -> CompareResult:
    """Compare ``early`` against ``full`` over the same crop region.

    ``crop`` is (x0, y0, x1, y1) in full-image pixel coordinates. Both
    crops are resized to a common working size so partial renders at a
    different resolution can still be aligned; genuinely different image
    dimensions are reported as not comparable.
    """
    if early is None or full is None:
        return CompareResult(comparable=False,
                             reason="缺少其中一张图，无法比较")

    if early.size != full.size:
        return CompareResult(
            comparable=False,
            reason=f"尺寸不同（预览 {early.size} vs 完整 {full.size}），"
                   "不能按像素直接比较",
        )

    box = _normalize_crop(crop, full.size)
    a = np.asarray(early.convert("RGB").crop(box).resize(work_size),
                   dtype=np.int16)
    b = np.asarray(full.convert("RGB").crop(box).resize(work_size),
                   dtype=np.int16)

    diff = np.abs(a - b).mean(axis=2)  # (H, W) mean per-pixel diff
    mean_diff = float(diff.mean())
    max_diff = float(diff.max())
    changed = diff > threshold
    changed_fraction = float(changed.mean())

    gx, gy = grid
    h, w = diff.shape
    bh, bw = max(1, h // gy), max(1, w // gx)
    block_means = []
    last_region = None
    last_key = None
    cw, ch = box[2] - box[0], box[3] - box[1]
    for r in range(gy):
        row = []
        for c in range(gx):
            blk = diff[r * bh:(r + 1) * bh, c * bw:(c + 1) * bw]
            m = float(blk.mean()) if blk.size else 0.0
            row.append(round(m, 2))
            if m > threshold:
                key = (r, c)  # scan order: top-left -> bottom-right
                if last_key is None or key >= last_key:
                    last_key = key
                    last_region = (
                        box[0] + c * cw // gx,
                        box[1] + r * ch // gy,
                        box[0] + (c + 1) * cw // gx,
                        box[1] + (r + 1) * ch // gy,
                    )
        block_means.append(row)

    return CompareResult(
        comparable=True,
        crop=box,
        mean_abs_diff=round(mean_diff, 3),
        max_abs_diff=round(max_diff, 1),
        changed_fraction=round(changed_fraction, 4),
        threshold=threshold,
        grid=grid,
        block_mean_diff=block_means,
        last_changed_region=last_region or (),
    )
