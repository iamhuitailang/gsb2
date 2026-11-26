"""Self-check: end-to-end validation of the deblur lab on synthetic ground truth.

Run with::

    python -m deblur_lab.selftest

Each check prints PASS/FAIL with the measured numbers.  Exit code is non-zero
if any check fails, so it also works as a smoke test in CI.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
from pathlib import Path

import numpy as np

from . import estimate, metrics, ops, report, restore, synth


def _check(name: str, ok: bool, detail: str = "") -> bool:
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))
    return ok


def check_psf() -> bool:
    ok = True
    for angle in (0.0, 30.0, 90.0, 135.0):
        k = ops.psf_line(11.0, angle, 1.0)
        ok &= _check(
            f"psf 11px @ {angle:g}° sums to 1",
            abs(float(k.sum()) - 1.0) < 1e-4,
            f"sum={k.sum():.6f} shape={k.shape}",
        )
    # The centroid of a line PSF must sit at its centre.
    k = ops.psf_line(15.0, 25.0)
    n = k.shape[0]
    yy, xx = np.mgrid[0:n, 0:n]
    cx, cy = float((k * xx).sum()), float((k * yy).sum())
    c = n // 2
    ok &= _check(
        "psf centroid at kernel centre",
        abs(cx - c) < 0.35 and abs(cy - c) < 0.35,
        f"centroid=({cx:.2f},{cy:.2f}) centre={c}",
    )
    return ok


def check_width_model() -> bool:
    ok = True
    # Predicted width along the motion direction should grow ~linearly with L.
    w0 = float(estimate.predicted_width(0.0, 30.0, 30.0))
    w10 = float(estimate.predicted_width(10.0, 30.0, 30.0))
    w20 = float(estimate.predicted_width(20.0, 30.0, 30.0))
    ok &= _check("base width ~= base param", abs(w0 - 1.4) < 0.15, f"w0={w0:.3f}")
    ok &= _check("width grows with length", w10 > w0 + 8 and w20 > w10 + 8,
                 f"w10={w10:.2f} w20={w20:.2f}")
    # Perpendicular to the motion the width stays near the base.
    w_perp = float(estimate.predicted_width(20.0, 30.0, 120.0))
    ok &= _check("width ~base perpendicular", abs(w_perp - w0) < 1.2, f"perp={w_perp:.3f}")
    return ok


def check_estimate_on_synthetic() -> bool:
    """A rectangle blurred at a known angle/length is recovered.

    A rectangle supplies two orthogonal edge families (normals 0 deg and 90 deg)
    plus corners, which is exactly the over-determined case the estimator
    needs; a single straight edge could never pin both angle and length.
    """
    h, w = 300, 300
    ok = True
    for theta in (20.0, 70.0, 115.0):
        for L in (9.0, 15.0):
            base = np.full((h, w), 0.15, dtype=np.float32)
            base[80:220, 70:230] = 0.85  # bright rectangle -> edges at 0/90 deg
            psf = ops.psf_line(L, theta, 1.0)
            gray = np.clip(ops.convolve_psf(base, psf), 0, 1).astype(np.float32)
            est = estimate.estimate_region(
                gray, (20, 20, w - 20, h - 20), use_auto_edges=True,
                base_width=1.4, spectral_window=192,
            )
            a_err = ops.angle_difference(est.angle, theta)
            l_err = abs(est.length - L)
            ok &= _check(
                f"estimate theta={theta:g} L={L:g}",
                a_err <= 8.0 and l_err <= 3.0,
                f"got {est.angle:.1f}° / {est.length:.1f}px ({est.method})",
            )
    return ok


def check_restore_improves() -> bool:
    """Restoration must sharpen a known blurred edge without touching elsewhere."""
    h, w = 240, 320
    clean = synth.render_scene(w, h, supersample=2)[0]
    region = synth.BlurRegion("T", (40, 60, w - 40, h - 30), 18.0, 13.0)
    blurred = synth.apply_blur_regions(clean, [region])
    noisy, _ = synth.add_sensor_noise(blurred, sigma=0.008, seed=3)
    reg = restore.Region("T", region.rect, 18.0, 13.0, feather=6.0)
    res = restore.restore_multi(
        noisy,
        [reg],
        restore.RestoreParams(iterations=30, detail_guard=0.45, gain_limit=4.0),
        noise_sigma=0.008,
    )
    clean_g = ops.rgb_to_gray((clean * 255).astype(np.uint8))
    before_g = ops.rgb_to_gray((noisy * 255).astype(np.uint8))
    after_g = ops.rgb_to_gray(ops.to_uint8(res.image))
    p_before = metrics.psnr(clean_g, before_g)
    p_after = metrics.psnr(clean_g, after_g)
    union = res.apply_mask_union()
    untouched = metrics.untouched_change(clean_g, after_g, union)
    ok = True
    ok &= _check("restore raises PSNR", p_after > p_before + 0.2,
                 f"{p_before:.2f} -> {p_after:.2f} dB")
    ok &= _check("untouched area stays put", untouched["max_abs"] < 1e-6,
                 f"max|Δ|={untouched['max_abs']:.2e}")
    return ok


def check_multi_region_order() -> bool:
    """Overlapping regions: later order wins, effective masks are disjoint."""
    h, w = 120, 160
    base = np.full((h, w, 3), 0.5, dtype=np.float32)
    r1 = restore.Region("A", (20, 20, 100, 100), 0.0, 1.0, order=0, feather=0.0)
    r2 = restore.Region("B", (60, 60, 140, 110), 90.0, 1.0, order=1, feather=0.0)
    res = restore.restore_multi(base, [r1, r2], restore.RestoreParams(iterations=1))
    union = res.apply_mask_union()
    ok = _check("union equals first rect ∪ second rect",
                int((union > 0.5).sum()) == 80 * 80 + 80 * 50 - 40 * 40,
                f"got {int((union > 0.5).sum())}")
    overlap = (res.effective_masks[0] > 0.5) & (res.effective_masks[1] > 0.5)
    ok &= _check("effective masks do not overlap", int(overlap.sum()) == 0,
                 f"overlap={int(overlap.sum())}")
    return ok


def check_targets_roundtrip(tmp: Path) -> bool:
    """Generate a sample, restore with the true parameters, check targets."""
    out = tmp / "sample"
    meta = synth.save_sample(out, width=640, height=440, seed=5, noise=0.006)
    input_set = report.load_input(out / "blurred.png")
    rgb = input_set.original.astype(np.float32) / 255.0
    regions = [
        restore.Region(
            r["name"], tuple(r["rect"]), r["angle"], r["length"], order=i, feather=4.0
        )
        for i, r in enumerate(meta["regions"])
    ]
    res = restore.restore_multi(
        rgb, regions, restore.RestoreParams(iterations=30, detail_guard=0.5), noise_sigma=0.006
    )
    checks = report.export_session(tmp / "out", res, input_set=input_set)
    checks_path = tmp / "out" / "checks.json"
    ok = _check("export wrote checks.json", checks_path.exists())
    if checks_path.exists():
        data = json.loads(checks_path.read_text(encoding="utf-8"))
        before = data["before"]["targets"]
        after = data["after"]["targets"]
        # Compare like with like: inside-region targets are where restoration
        # can actually help; outside-band targets should be unchanged.
        b_in = before.get("inside_region", {})
        a_in = after.get("inside_region", {})
        ok &= _check(
            "held-out targets improve (inside restored regions)",
            a_in.get("pass_rate", 0) >= b_in.get("pass_rate", 0),
            f"{b_in.get('passed')}/{b_in.get('count')} -> {a_in.get('passed')}/{a_in.get('count')}",
        )
        ok &= _check(
            "line width error shrinks (inside)",
            a_in.get("line_width_abs_error_mean_px", 99)
            < b_in.get("line_width_abs_error_mean_px", 0) + 1e-6,
            f"{b_in.get('line_width_abs_error_mean_px')} -> {a_in.get('line_width_abs_error_mean_px')}",
        )
        ok &= _check(
            "outside-band targets unchanged",
            data.get("untouched", {}).get("max_abs", 1.0) < 1e-6,
            f"max|Δ| outside = {data.get('untouched', {}).get('max_abs')}",
        )
    ok &= _check("parameters.json written", (tmp / "out" / "parameters.json").exists())
    return ok


def check_estimate_matches_truth(tmp: Path) -> bool:
    """Estimating from a generated sample should land near the true values."""
    out = tmp / "est_sample"
    meta = synth.save_sample(out, width=520, height=360, seed=9, noise=0.008, supersample=2)
    gray = ops.load_gray(out / "blurred.png")
    ok = True
    for r in meta["regions"]:
        est = estimate.estimate_region(
            gray, r["rect"], thickness=r["thickness"], base_width=1.4,
            spectral_window=192, use_auto_edges=True,
        )
        a_err = ops.angle_difference(est.angle, r["angle"])
        l_err = abs(est.length - r["length"])
        ok &= _check(
            f"sample region {r['name']} estimate",
            a_err <= 12.0 and l_err <= 4.0,
            f"true {r['angle']:.0f}°/{r['length']:.0f}px  got "
            f"{est.angle:.1f}°/{est.length:.1f}px  conf={est.confidence:.2f}",
        )
    return ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="deblur lab self-check")
    parser.add_argument("--keep", default=None, help="keep artifacts in this directory")
    args = parser.parse_args(argv)
    passed = True
    passed &= check_psf()
    passed &= check_width_model()
    passed &= check_estimate_on_synthetic()
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(args.keep) if args.keep else Path(td)
        tmp.mkdir(parents=True, exist_ok=True)
        passed &= check_restore_improves()
        passed &= check_multi_region_order()
        passed &= check_targets_roundtrip(tmp)
        passed &= check_estimate_matches_truth(tmp)
    print()
    print("SELFTEST", "PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
