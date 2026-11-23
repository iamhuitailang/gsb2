"""Programmatically generated test files.

Creates a baseline JPEG, a progressive JPEG, and several truncated
variants covering every decode state: full, mid-scan cut, scan-boundary
cut, and a cut before SOF (dimensions unknown).
"""

from __future__ import annotations

import io
import json
import os

import numpy as np
from PIL import Image, ImageDraw

from . import parser


def make_source_image(size=(512, 384)) -> Image.Image:
    """A deterministic synthetic photo-like image (gradient + shapes +
    texture) so progressive refinement is visible."""
    w, h = size
    rng = np.random.default_rng(42)
    yy, xx = np.mgrid[0:h, 0:w]
    r = (xx / w * 200 + 30).astype(np.uint8)
    g = (yy / h * 180 + 40).astype(np.uint8)
    b = ((xx + yy) / (w + h) * 160 + 60).astype(np.uint8)
    noise = rng.integers(-12, 13, size=(h, w, 1))
    arr = np.clip(np.stack([r, g, b], axis=2).astype(np.int16) + noise,
                  0, 255).astype(np.uint8)
    im = Image.fromarray(arr, "RGB")
    d = ImageDraw.Draw(im)
    d.ellipse([w * 0.1, h * 0.15, w * 0.45, h * 0.7], fill=(220, 60, 40),
              outline=(255, 255, 255), width=4)
    d.rectangle([w * 0.55, h * 0.3, w * 0.9, h * 0.8], fill=(40, 90, 200),
                outline=(0, 0, 0), width=4)
    d.line([0, h - 1, w - 1, 0], fill=(255, 220, 0), width=6)
    for i in range(5):
        d.text((20 + i * 90, h - 40), f"#{i}", fill=(255, 255, 255))
    return im


def _jpeg_bytes(im: Image.Image, progressive: bool) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85, progressive=progressive)
    return buf.getvalue()


def generate(outdir: str, size=(512, 384)) -> dict:
    """Generate all sample files into ``outdir``. Returns a summary dict
    mapping sample name -> path."""
    os.makedirs(outdir, exist_ok=True)
    im = make_source_image(size)
    paths = {}

    def put(name, data):
        p = os.path.join(outdir, name)
        with open(p, "wb") as f:
            f.write(data)
        paths[name] = p
        return data

    baseline = _jpeg_bytes(im, progressive=False)
    progressive = _jpeg_bytes(im, progressive=True)
    put("baseline.jpg", baseline)
    put("progressive.jpg", progressive)

    st = parser.parse(progressive)
    boundaries = parser.scan_boundary_offsets(st)

    # 1. Truncated exactly at a complete-scan boundary (about 1/3 in).
    if len(boundaries) >= 2:
        cut = boundaries[max(0, len(boundaries) // 3)]
        put("trunc_scan_boundary.jpg", progressive[:cut])

    # 2. Truncated in the middle of a scan's entropy data.
    if len(st.scans) >= 2:
        mid_scan = st.scans[min(2, len(st.scans) - 1)]
        cut = (mid_scan.entropy_start + mid_scan.entropy_end) // 2
        put("trunc_mid_scan.jpg", progressive[:cut])

    # 3. Truncated before SOF completes: dimensions unknowable.
    sof = next(s for s in st.segments if s.marker in parser.SOF_MARKERS)
    put("trunc_before_sof.jpg", progressive[:sof.offset + 4])

    # 4. Truncated after SOF but before the first scan finishes.
    if st.scans:
        first = st.scans[0]
        cut = first.entropy_start + max(8, (first.entropy_end
                                            - first.entropy_start) // 4)
        put("trunc_first_scan.jpg", progressive[:cut])

    # Also a baseline truncation for contrast.
    bst = parser.parse(baseline)
    if bst.scans:
        s0 = bst.scans[0]
        cut = s0.entropy_start + (s0.entropy_end - s0.entropy_start) // 2
        put("baseline_trunc_mid_scan.jpg", baseline[:cut])

    summary = {
        "progressive_scan_count": len(st.scans),
        "progressive_size": len(progressive),
        "baseline_size": len(baseline),
        "files": {k: os.path.basename(v) for k, v in paths.items()},
    }
    with open(os.path.join(outdir, "samples.json"), "w",
              encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    return summary
