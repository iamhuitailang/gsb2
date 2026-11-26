"""Everything that touches the filesystem: load a session, export results.

An exported session is a directory:

    result.png            restored image
    original.png          input (or a copy of the selected region)
    residual.png          输入 - 结果 (signed, mid-grey = 0)
    parameters.json       every region, every parameter, every estimate
    checks.json           metrics against the preserved sharp sample
    contact_sheet.png     original | result | residual, same scale (optional)

``parameters.json`` is the machine-readable contract; ``checks.json`` is the
pass/fail report for the held-out targets.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

from . import metrics, ops, restore, synth


# ---------------------------------------------------------------------------
# Session / input
# ---------------------------------------------------------------------------

@dataclass
class InputSet:
    original: np.ndarray            # uint8 RGB, what the user opened
    clean: np.ndarray | None = None  # sharp reference if available
    targets: list[dict] | None = None
    blurred_regions: list[tuple[int, int, int, int]] | None = None
    source: str = ""

    @property
    def has_reference(self) -> bool:
        return self.clean is not None


def load_input(
    path: str | Path,
    *,
    clean_path: str | Path | None = None,
    targets_path: str | Path | None = None,
) -> InputSet:
    path = Path(path)
    original = ops.load_rgb(path)
    clean = None
    targets = None
    blurred_regions = None

    scene = path.parent / "scene.json"
    if clean is None and scene.exists():
        try:
            meta = json.loads(scene.read_text(encoding="utf-8"))
            ref = meta.get("clean")
            if ref and (path.parent / ref).exists():
                clean = ops.load_rgb(path.parent / ref)
                targets = _load_targets(path.parent / meta.get("targets_file", "targets.json"))
                blurred_regions = [tuple(r["rect"]) for r in meta.get("regions", [])]
        except (OSError, ValueError, KeyError):
            pass
    if clean_path is not None:
        clean = ops.load_rgb(clean_path)
    if targets_path is not None:
        targets = _load_targets(targets_path)
    return InputSet(
        original=original,
        clean=clean,
        targets=targets,
        blurred_regions=blurred_regions,
        source=str(path),
    )


def _load_targets(path: str | Path) -> list[dict] | None:
    p = Path(path)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, list) else None


# ---------------------------------------------------------------------------
# Visualisation
# ---------------------------------------------------------------------------

def residual_image(result_rgb: np.ndarray, base_rgb: np.ndarray, gain: float = 4.0) -> np.ndarray:
    """Signed residual centered on mid-grey (uint8)."""
    diff = (np.asarray(base_rgb, dtype=np.float32) - np.asarray(result_rgb, dtype=np.float32)) / 255.0
    vis = np.clip(0.5 + gain * diff, 0.0, 1.0)
    return (vis * 255.0).astype(np.uint8)


def annotated_overlay(
    rgb: np.ndarray,
    regions: Sequence[restore.Region],
    effective_masks: Sequence[np.ndarray] | None = None,
) -> np.ndarray:
    """Draw region rectangles and effective coverage as an overlay."""
    out = np.asarray(rgb, dtype=np.float32).copy() / 255.0
    h, w = out.shape[:2]
    if effective_masks:
        for eff in effective_masks:
            if eff.size == 0 or eff.shape != (h, w):
                continue
            tint = np.zeros((h, w, 3), dtype=np.float32)
            tint[..., 0] = 0.10
            tint[..., 2] = 0.30
            out = out * (1 - 0.45 * eff[..., None]) + tint * (0.45 * eff[..., None])
    colors = [(0.9, 0.2, 0.2), (0.2, 0.55, 0.9), (0.15, 0.7, 0.3), (0.85, 0.6, 0.1)]
    for i, r in enumerate(regions):
        x0, y0, x1, y1 = ops.clamp_rect(r.rect, (h, w))
        c = np.array(colors[i % len(colors)], dtype=np.float32)
        for yy, t in ((y0, 0), (y1 - 1, 0)):
            if 0 <= yy < h:
                out[yy, x0:x1] = c
        for xx, t in ((x0, 0), (x1 - 1, 0)):
            if 0 <= xx < w:
                out[y0:y1, xx] = c
        # order tick marks at the top-left corner
        for k in range(min(int(r.order), 5)):
            yy = y0 + 3 + 2 * k
            if yy + 1 < h:
                out[yy, x0 + 2:x0 + 10] = c
    return (np.clip(out, 0, 1) * 255).astype(np.uint8)


def contact_sheet(
    panels: Sequence[np.ndarray],
    *,
    labels: Sequence[str] | None = None,
    gap: int = 8,
    background: int = 32,
) -> np.ndarray:
    """Lay panels out horizontally at one common scale."""
    if not panels:
        raise ValueError("contact_sheet needs at least one panel")
    arrays = [np.asarray(p, dtype=np.uint8) for p in panels]
    h = max(a.shape[0] for a in arrays)
    total_w = sum(a.shape[1] for a in arrays) + gap * (len(arrays) + 1)
    canvas = np.full((h + gap * 2, total_w, 3), background, dtype=np.uint8)
    if any(a.ndim == 2 for a in arrays):
        arrays = [ops.gray_to_rgb(a.astype(np.float32) / 255.0).astype(np.uint8) if a.ndim == 2 else a
                  for a in arrays]
    x = gap
    for a in arrays:
        canvas[gap:gap + a.shape[0], x:x + a.shape[1]] = a
        x += a.shape[1] + gap
    if labels:
        _draw_labels(canvas, labels, arrays, gap)
    return canvas


def _draw_labels(canvas, labels, arrays, gap):
    """Tiny 5x7 labels in the top margin, drawn without a font dependency."""
    from .synth import _FONT, GLYPH_H, GLYPH_W, ADVANCE

    x = gap
    for a, text in zip(arrays, labels):
        px, py = x, max(0, gap - GLYPH_H - 2)
        for ch in text.upper():
            pat = _FONT.get(ch, _FONT[" "])
            for ry, row in enumerate(pat):
                for rx, bit in enumerate(row):
                    if bit == "1" and py + ry < canvas.shape[0] and px + rx < canvas.shape[1]:
                        canvas[py + ry, px + rx] = (235, 235, 235)
            px += ADVANCE
        x += a.shape[1] + gap


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def _json_default(o):
    if isinstance(o, (np.floating, np.integer)):
        return float(o)
    if isinstance(o, np.ndarray):
        return [None if not np.isfinite(v) else float(v) for v in o.tolist()]
    if isinstance(o, Path):
        return str(o)
    raise TypeError(f"not JSON serialisable: {type(o)!r}")


def _dump(path: Path, data: Any) -> None:
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False, default=_json_default),
        encoding="utf-8",
    )


def export_session(
    outdir: str | Path,
    result: restore.RestoreResult,
    *,
    input_set: InputSet | None = None,
    extra: dict | None = None,
    include_contact_sheet: bool = True,
    residual_gain: float = 4.0,
) -> dict:
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    meta: dict = {"schema": "deblur-lab/1", "created_by": "deblur_lab.report.export_session"}

    result_u8 = ops.to_uint8(result.image)
    base_u8 = ops.to_uint8(result.base)
    ops.save_rgb(outdir / "result.png", result_u8)
    ops.save_rgb(outdir / "original.png", base_u8)
    residual_u8 = residual_image(result_u8, base_u8, gain=residual_gain)
    ops.save_rgb(outdir / "residual.png", residual_u8)

    overlay = annotated_overlay(base_u8, result.regions, result.effective_masks)
    ops.save_rgb(outdir / "regions.png", overlay)

    params = {
        "schema": "deblur-lab/1",
        "source": input_set.source if input_set else None,
        "restore_params": result.params.to_dict(),
        "regions": [r.to_dict() for r in result.regions],
        "applied_regions": [r.to_dict() for r in result.regions if r.enabled],
        "order_note": "启用的区域按 order 升序应用, 重叠处后应用者覆盖前者",
        "clipped_fraction": round(float(result.clipped_fraction), 5),
        "notes": list(result.notes),
        "coverage": _coverage_summary(result),
    }
    _dump(outdir / "parameters.json", params)
    meta["parameters"] = "parameters.json"

    checks = None
    if input_set is not None and input_set.has_reference and input_set.clean is not None:
        clean = input_set.clean.astype(np.float32) / 255.0
        test = result.image.astype(np.float32)
        blurred = input_set.original.astype(np.float32) / 255.0
        clean_g = ops.rgb_to_gray((clean * 255).astype(np.uint8))
        test_g = ops.rgb_to_gray(ops.to_uint8(test))
        blurred_g = ops.rgb_to_gray(input_set.original)
        effective = result.effective_masks
        union = (
            np.clip(np.max(np.stack(effective, axis=0), axis=0), 0, 1)
            if effective else np.zeros(clean_g.shape, dtype=np.float32)
        )
        targets = input_set.targets or []
        # Judge *improvement* on targets inside the restored regions; targets in
        # untouched bands are reported separately (they should not change).
        region_bool = (union > 0.5).astype(np.float32)
        before_t = metrics.check_targets(
            clean_g, blurred_g, targets, region_mask=region_bool
        )
        after_t = metrics.check_targets(clean_g, test_g, targets, region_mask=region_bool)
        checks = {
            "schema": "deblur-lab/1",
            "reference": "clean.png (sharp sample kept out of estimation)",
            "before": {
                "psnr_db": round(metrics.psnr(clean_g, blurred_g), 2),
                "ssim": round(metrics.ssim(clean_g, blurred_g), 4),
                "targets": before_t["summary"],
            },
            "after": {
                "psnr_db": round(metrics.psnr(clean_g, test_g), 2),
                "ssim": round(metrics.ssim(clean_g, test_g), 4),
                "targets": after_t["summary"],
            },
            "edge_detail": after_t["rows"],
            # test vs the *input* outside the applied mask: proves untouched
            # areas really did not change.
            "untouched": metrics.untouched_change(blurred_g, test_g, union),
            "untouched_vs_clean": metrics.untouched_change(clean_g, test_g, union),
            "regions": _per_region_checks(result, clean_g, blurred_g, test_g),
            "flat_noise": {
                "ref": metrics._round(metrics.noise_sigma(clean_g)),
                "before": metrics._round(metrics.noise_sigma(blurred_g)),
                "after": metrics._round(metrics.noise_sigma(test_g)),
            },
        }
        _dump(outdir / "checks.json", checks)
        meta["checks"] = "checks.json"

    if include_contact_sheet:
        sheet = contact_sheet(
            [base_u8, result_u8, residual_u8],
            labels=("INPUT", "RESULT", f"RESIDUAL x{residual_gain:g}"),
        )
        ops.save_rgb(outdir / "contact_sheet.png", sheet)
        meta["contact_sheet"] = "contact_sheet.png"

    if extra:
        meta.update(extra)
    _dump(outdir / "session.json", meta)
    return meta


def _per_region_checks(result, clean_g, blurred_g, test_g) -> list[dict]:
    """Per-region noise/gain, measured inside each region's *effective* area."""
    out = []
    enabled = [r for r in result.regions if r.enabled]
    for i, r in enumerate(enabled):
        if i < len(result.effective_masks):
            mask = result.effective_masks[i] > 0.5
        else:
            mask = ops.rect_mask(clean_g.shape, r.rect, feather=0.0) > 0.5
        if mask.sum() < 16:
            out.append({"name": r.name, "rect": list(r.rect), "pixels": int(mask.sum())})
            continue
        # dark_edge_gain is measured from the *input* to the result.
        gain = metrics.dark_edge_gain(blurred_g, test_g, mask)
        rep = metrics.region_report(clean_g, test_g, mask.astype(np.float32), dark_gain=gain)
        out.append({"name": r.name, "rect": list(r.rect), **rep})
    return out


def _coverage_summary(result: restore.RestoreResult) -> dict:
    if not result.effective_masks:
        return {"pixels": 0, "fraction": 0.0}
    union = np.clip(np.max(np.stack(result.effective_masks, axis=0), axis=0), 0, 1)
    overlap = np.sum(np.stack([m > 0.5 for m in result.effective_masks], axis=0), axis=0) if result.effective_masks else None
    return {
        "pixels": int((union > 0.5).sum()),
        "fraction": round(float((union > 0.5).mean()), 5),
        "overlap_pixels": int((overlap > 1).sum()) if overlap is not None else 0,
    }


# ---------------------------------------------------------------------------
# Batch helpers (used by CLI and tests)
# ---------------------------------------------------------------------------

def export_batch_sheet(
    outpath: str | Path,
    entries: Sequence[tuple[str, np.ndarray, np.ndarray]],
    *,
    residual_gain: float = 4.0,
) -> None:
    """One row per entry: input | result | residual."""
    rows = []
    for label, base, res in entries:
        b = ops.to_uint8(base)
        r = ops.to_uint8(res)
        rows.append(contact_sheet([b, r, residual_image(r, b, residual_gain)], labels=(label, "RESULT", "RESIDUAL")))
    if not rows:
        raise ValueError("no entries")
    width = max(r.shape[1] for r in rows)
    height = sum(r.shape[0] for r in rows)
    canvas = np.full((height, width, 3), 24, dtype=np.uint8)
    y = 0
    for r in rows:
        canvas[y:y + r.shape[0], :r.shape[1]] = r
        y += r.shape[0]
    ops.save_rgb(outpath, canvas)
