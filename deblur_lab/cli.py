"""Command line entry point.

Examples
--------
Generate samples (a full two-region scene plus a calibration grid)::

    python -m deblur_lab.cli gen --out samples

Estimate blur for a region, using a clicked reference edge point::

    python -m deblur_lab.cli estimate --image samples/demo/blurred.png \\
        --rect 46,92,462,404 --ref 462,172

Restore one region and export everything, including checks against the
preserved sharp sample::

    python -m deblur_lab.cli restore --image samples/demo/blurred.png \\
        --region 46,92,462,404,12,17 --region 534,246,916,566,101,11 \\
        --out out/demo

Sweep parameters to see how much is recoverable::

    python -m deblur_lab.cli sweep --image samples/demo/blurred.png \\
        --region 46,92,462,404 --lengths 8,11,14,17,20 --angles 8,10,12,14,16
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from . import metrics, ops, report, restore, synth


def _parse_region(text: str) -> restore.Region:
    spec = ops.parse_region_spec(text)
    return restore.Region(
        name=f"R{spec['rect'][0]}_{spec['rect'][1]}",
        rect=spec["rect"],
        angle=spec["angle"],
        length=spec["length"],
        order=spec["order"],
        feather=spec["feather"],
    )


def _load_targets(path: Path | None):
    if path is None:
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


def cmd_gen(args) -> int:
    out = Path(args.out)
    if args.batch:
        manifest = synth.save_batch(
            out / "calib",
            angles=[float(a) for a in args.angles.split(",")],
            lengths=[float(v) for v in args.lengths.split(",")],
            noise=args.noise,
        )
        print(f"wrote {len(manifest)} calibration samples under {out / 'calib'}")
        return 0
    meta = synth.save_sample(
        out / "demo",
        width=args.width,
        height=args.height,
        seed=args.seed,
        noise=args.noise,
    )
    print(f"wrote {out / 'demo'}: clean.png, blurred.png, targets.json, scene.json")
    for r in meta["regions"]:
        print(f"  region {r['name']}: rect={r['rect']} angle={r['angle']} length={r['length']}")
    return 0


def cmd_estimate(args) -> int:
    gray = ops.load_gray(args.image)
    rect = ops.parse_rect(args.rect)
    ref_point = None
    ref_normal = None
    if args.ref:
        vals = [float(v) for v in args.ref.split(",")]
        ref_point = (vals[0], vals[1])
        if len(vals) > 2:
            ref_normal = vals[2]
    est = estimate_region_for(args, gray, rect, ref_point, ref_normal)
    payload = est.to_dict()
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0


def estimate_region_for(args, gray, rect, ref_point, ref_normal):
    from . import estimate

    return estimate.estimate_region(
        gray,
        rect,
        ref_point=ref_point,
        ref_normal=ref_normal,
        thickness=args.thickness,
        base_width=args.base,
        spectral_window=args.window,
        spectral_band=(args.band_min, args.band_max),
        length_range=(args.min_length, args.max_length),
    )


def cmd_restore(args) -> int:
    input_set = report.load_input(
        args.image,
        clean_path=args.clean,
        targets_path=args.targets,
    )
    rgb = input_set.original.astype(np.float32) / 255.0
    regions = [_parse_region(t) for t in args.region]
    params = restore.RestoreParams(
        iterations=args.iterations,
        damp=args.damp,
        prior_sigma=args.prior,
        detail_guard=args.guard,
        noise_floor=args.noise_floor,
        denoise_sigma=args.denoise,
        gain_limit=args.gain,
        edge_boost=args.edge_boost,
        psf_profile=args.profile,
    )
    result = restore.restore_multi(rgb, regions, params, noise_sigma=args.noise)
    meta = report.export_session(
        args.out,
        result,
        input_set=input_set,
        extra={"regions_source": "cli", "params_source": "cli"},
        residual_gain=args.residual_gain,
    )
    print(json.dumps(meta, indent=2, ensure_ascii=False))
    if input_set.targets:
        clean_g = ops.rgb_to_gray(input_set.clean)
        test_g = ops.rgb_to_gray(ops.to_uint8(result.image))
        before_g = ops.rgb_to_gray(input_set.original)
        b = metrics.check_targets(clean_g, before_g, input_set.targets)["summary"]
        a = metrics.check_targets(clean_g, test_g, input_set.targets)["summary"]
        print("\nheld-out target summary")
        print(f"  before: {b}")
        print(f"  after : {a}")
    return 0


def cmd_sweep(args) -> int:
    input_set = report.load_input(args.image, clean_path=args.clean, targets_path=args.targets)
    rgb = input_set.original.astype(np.float32) / 255.0
    rect = ops.parse_rect(args.rect)
    angles = [float(v) for v in args.angles.split(",")]
    lengths = [float(v) for v in args.lengths.split(",")]
    rows = []
    ref = input_set.clean.astype(np.float32) / 255.0 if input_set.clean is not None else None
    for angle in angles:
        for length in lengths:
            region = restore.Region("S", rect, angle, length, 0, args.feather)
            res = restore.restore_multi(
                rgb,
                [region],
                restore.RestoreParams(iterations=args.iterations, detail_guard=args.guard),
                noise_sigma=args.noise,
            )
            row = {"angle": angle, "length": length}
            if ref is not None:
                union = res.apply_mask_union()
                ref_g = ops.rgb_to_gray((ref * 255).astype(np.uint8))
                test_g = ops.rgb_to_gray(ops.to_uint8(res.image))
                row["psnr_db"] = round(metrics.psnr(ref_g, test_g), 2)
                row["ssim"] = round(metrics.ssim(ref_g, test_g), 4)
                row["untouched_mean_abs"] = metrics.untouched_change(ref_g, test_g, union)["mean_abs"]
                if input_set.targets:
                    row.update(metrics.check_targets(ref_g, test_g, input_set.targets)["summary"])
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False))
    if args.out:
        _dump_sweep(args.out, rows)
    return 0


def _dump_sweep(path: str, rows: list[dict]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="deblur_lab", description="拖影修复试验台")
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("gen", help="生成合成样例")
    g.add_argument("--out", default="samples")
    g.add_argument("--width", type=int, default=960)
    g.add_argument("--height", type=int, default=640)
    g.add_argument("--seed", type=int, default=7)
    g.add_argument("--noise", type=float, default=0.012)
    g.add_argument("--batch", action="store_true", help="生成标定网格")
    g.add_argument("--angles", default="0,15,30,45,60,90,120,150")
    g.add_argument("--lengths", default="5,9,13,18,25")
    g.set_defaults(func=cmd_gen)

    e = sub.add_parser("estimate", help="估计拖影方向和长度")
    e.add_argument("--image", required=True)
    e.add_argument("--rect", required=True, help="x0,y0,x1,y1")
    e.add_argument("--ref", default=None, help="点击的参考边: x,y[,normal_deg]")
    e.add_argument("--thickness", type=float, default=1.0)
    e.add_argument("--base", type=float, default=1.4, help="无拖影时的边宽 10-90 (px)")
    e.add_argument("--window", type=int, default=256)
    e.add_argument("--band-min", type=float, default=0.02)
    e.add_argument("--band-max", type=float, default=0.45)
    e.add_argument("--min-length", type=float, default=1.0)
    e.add_argument("--max-length", type=float, default=45.0)
    e.add_argument("--out", default=None)
    e.set_defaults(func=cmd_estimate)

    r = sub.add_parser("restore", help="修复并导出")
    r.add_argument("--image", required=True)
    r.add_argument("--clean", default=None)
    r.add_argument("--targets", default=None)
    r.add_argument("--region", action="append", required=True,
                   help="x0,y0,x1,y1,angle,length[,order[,feather]] (可重复)")
    r.add_argument("--out", required=True)
    r.add_argument("--iterations", type=int, default=24)
    r.add_argument("--damp", type=float, default=0.85)
    r.add_argument("--prior", type=float, default=0.6)
    r.add_argument("--guard", type=float, default=0.55)
    r.add_argument("--noise-floor", type=float, default=0.0)
    r.add_argument("--denoise", type=float, default=0.0)
    r.add_argument("--gain", type=float, default=3.5)
    r.add_argument("--edge-boost", type=float, default=0.0)
    r.add_argument("--profile", default="box", choices=["box", "tent", "gauss"])
    r.add_argument("--noise", type=float, default=0.012)
    r.add_argument("--residual-gain", type=float, default=4.0)
    r.set_defaults(func=cmd_restore)

    s = sub.add_parser("sweep", help="参数扫描, 观察可恢复程度")
    s.add_argument("--image", required=True)
    s.add_argument("--clean", default=None)
    s.add_argument("--targets", default=None)
    s.add_argument("--rect", required=True)
    s.add_argument("--angles", default="0,10,20,30")
    s.add_argument("--lengths", default="6,10,14,18,22")
    s.add_argument("--iterations", type=int, default=24)
    s.add_argument("--guard", type=float, default=0.55)
    s.add_argument("--feather", type=float, default=8.0)
    s.add_argument("--noise", type=float, default=0.012)
    s.add_argument("--out", default=None)
    s.set_defaults(func=cmd_sweep)

    gui = sub.add_parser("gui", help="打开交互界面")
    gui.add_argument("--image", default=None)
    gui.set_defaults(func=cmd_gui)
    return p


def cmd_gui(args) -> int:
    from . import gui

    gui.main(args.image)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
