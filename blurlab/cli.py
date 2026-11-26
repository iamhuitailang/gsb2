"""命令行：生成样例、估计参数、批量去模糊、配对验证。

示例
----
    python3 -m blurlab.cli synth --out out/samples
    python3 -m blurlab.cli estimate --image out/samples/board_blur_30deg_L9.png \\
        --edge 530,112,530,212 --edge 600,140,700,140
    python3 -m blurlab.cli deblur --image in.png --region 470,238,700,408 \\
        --length 13 --angle 30 --out out/run1
    python3 -m blurlab.cli validate --clean clean.png --blurred blur.png \\
        --meta meta.json --length 9 --angle 30
"""

from __future__ import annotations

import argparse
import json
import sys

import numpy as np

from .deblur import DeblurParams
from .estimate import estimate_blur
from .export import export_result, format_validation, save_validation, validate_pair
from .image_io import json_safe, load_image, load_meta, write_json
from .pipeline import process_regions, sweep_parameters
from .profile import edge_profile_from_segment, sample_edge_profile
from .regions import RegionSet
from .synth import save_sample_suite


def _parse_rect(s: str) -> tuple[int, int, int, int]:
    parts = [int(float(v)) for v in s.replace(";", ",").split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("矩形需要 x0,y0,x1,y1")
    return tuple(parts)  # type: ignore[return-value]


def _parse_edge(s: str) -> tuple[float, float, float, float]:
    parts = [float(v) for v in s.replace(";", ",").split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("参考边需要 x0,y0,x1,y1")
    return tuple(parts)  # type: ignore[return-value]


def cmd_synth(args: argparse.Namespace) -> int:
    paths = save_sample_suite(
        args.out,
        width=args.width,
        height=args.height,
        seed=args.seed,
        noise_sigma=args.noise,
    )
    print(f"已生成样例到 {args.out}")
    print(f"  干净图: {paths['clean']}")
    for v in paths["variants"]:
        print(f"  拖影 {v['angle_deg']:.0f}° L={v['length_px']:.0f}: {v['path']}")
    print(f"  双区域: {paths['multi'][0]}")
    print(f"  真值:   {paths['meta']}")
    return 0


def cmd_estimate(args: argparse.Namespace) -> int:
    img = load_image(args.image)
    profiles = []
    labels = []
    for i, (x0, y0, x1, y1) in enumerate(args.edge):
        prof = edge_profile_from_segment(
            img, (x0, y0), (x1, y1), window_half=args.window
        )
        profiles.append(prof)
        labels.append(f"edge{i + 1}")
    est = estimate_blur(profiles, labels)
    payload = est.to_dict()
    print(json.dumps(json_safe(payload), ensure_ascii=False, indent=2, allow_nan=False))
    if args.out:
        write_json(args.out, payload)
        print(f"\n参数已写入 {args.out}")
    if est.angle_deg is None:
        print("\n注意：单边估计未确定方向，请加一条法向不同的边，或用 --angle 手填。")
    return 0


def cmd_deblur(args: argparse.Namespace) -> int:
    img = load_image(args.image)
    h, w = img.shape[:2]
    rs = RegionSet(width=w, height=h)

    specs = args.region or [(0, 0, w, h)]
    lengths = args.length if isinstance(args.length, list) else [args.length] * len(specs)
    angles = args.angle if isinstance(args.angle, list) else [args.angle] * len(specs)

    if len(lengths) != len(specs) or len(angles) != len(specs):
        print("区域数量与 --length/--angle 数量不匹配", file=sys.stderr)
        return 2

    for i, rect in enumerate(specs):
        params = DeblurParams(
            length_px=float(lengths[i]),
            angle_deg=float(angles[i]),
            noise_gain=args.noise_gain,
            regularization=args.regularization,
            shadow_limit=args.shadow_limit,
            overshoot=args.overshoot,
        )
        rs.add(rect, params, label=f"R{i + 1}", feather_px=args.feather, priority=i)

    meta = None
    if args.meta:
        meta = load_meta(args.meta)
    clean = load_image(args.clean) if args.clean else None

    pipeline = process_regions(
        img,
        rs,
        clean=clean,
        compute_metrics=args.metrics,
        bars=(meta or {}).get("bars") if meta else None,
        edges=(meta or {}).get("edges") if meta else None,
        unchanged_rect=tuple((meta or {}).get("no_blur_rect")) if meta and meta.get("no_blur_rect") else None,
    )
    paths = export_result(
        args.out,
        img,
        pipeline.result,
        pipeline.residual,
        rs,
        pipeline=pipeline,
        meta=meta,
        source=str(args.image),
    )
    print(f"已导出到 {args.out}:")
    for k, v in paths.items():
        print(f"  {k:<14} {v}")
    for note in pipeline.notes:
        print(f"  - {note}")

    if args.sweep:
        rect = _parse_rect(args.sweep_rect) if args.sweep_rect else specs[0]
        lengths = [float(v) for v in args.sweep.split(",")]
        rows = sweep_parameters(
            img, rect, angles[0], lengths, noise_gains=[args.noise_gain], clean=clean
        )
        print("\n参数扫描:")
        for row in rows:
            gr = row.get("gradient_recovery")
            gr_s = f"{gr:6.3f}" if gr is not None and np.isfinite(gr) else "   n/a"
            print(f"  L={row['length_px']:5.1f}  梯度恢复 {gr_s}  残差 RMS {row['residual_rms']:.4f}")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    clean = load_image(args.clean)
    blurred = load_image(args.blurred)
    meta = load_meta(args.meta) if args.meta else {}
    h, w = blurred.shape[:2]
    rs = RegionSet(width=w, height=h)

    if args.region:
        rects = args.region
    elif meta.get("blur_specs"):
        rects = [tuple(s["rect"]) for s in meta["blur_specs"]]
    else:
        rects = [(0, 0, w, h)]

    angles = args.angle if args.angle else [args.angle_guess] * len(rects)
    lengths = args.length if args.length else [args.length_guess] * len(rects)
    if len(angles) == 1 and len(rects) > 1:
        angles = angles * len(rects)
    if len(lengths) == 1 and len(rects) > 1:
        lengths = lengths * len(rects)
    if len(angles) != len(rects) or len(lengths) != len(rects):
        print("--region 数量必须与 --length/--angle 一致（或都给一个值）", file=sys.stderr)
        return 2

    for i, rect in enumerate(rects):
        params = DeblurParams(
            length_px=float(lengths[i]),
            angle_deg=float(angles[i]),
            noise_gain=args.noise_gain,
        )
        rs.add(rect, params, label=f"R{i + 1}", feather_px=args.feather, priority=i)

    pipeline = process_regions(blurred, rs, clean=clean, compute_metrics=False)
    report = validate_pair(clean, blurred, pipeline.result, meta)
    print(format_validation(report))
    if args.out:
        p = save_validation(
            args.out,
            report,
            params={
                "regions": [r.to_dict() for r in rs.ordered()],
                "noise_gain": args.noise_gain,
            },
        )
        print(f"\n验证报告已写入 {p}")
    return 0


def cmd_sweep(args: argparse.Namespace) -> int:
    img = load_image(args.image)
    clean = load_image(args.clean) if args.clean else None
    rect = _parse_rect(args.rect)
    lengths = [float(v) for v in args.lengths.split(",")]
    gains = [float(v) for v in args.gains.split(",")] if args.gains else [4.0]
    rows = sweep_parameters(img, rect, args.angle, lengths, gains, clean=clean)
    print(json.dumps(json_safe(rows), ensure_ascii=False, indent=2, allow_nan=False))
    if args.out:
        write_json(args.out, rows)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="blurlab", description="移动标牌拖影校准与选择性去模糊")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("synth", help="生成测试样例")
    s.add_argument("--out", required=True)
    s.add_argument("--width", type=int, default=900)
    s.add_argument("--height", type=int, default=600)
    s.add_argument("--seed", type=int, default=16317)
    s.add_argument("--noise", type=float, default=0.012)
    s.set_defaults(func=cmd_synth)

    e = sub.add_parser("estimate", help="由参考边估计长度/方向")
    e.add_argument("--image", required=True)
    e.add_argument("--edge", action="append", type=_parse_edge, required=True,
                   help="跨边线段 x0,y0,x1,y1，可重复")
    e.add_argument("--window", type=float, default=24.0)
    e.add_argument("--out")
    e.set_defaults(func=cmd_estimate)

    d = sub.add_parser("deblur", help="按区域去模糊并导出")
    d.add_argument("--image", required=True)
    d.add_argument("--region", action="append", type=_parse_rect)
    d.add_argument("--length", action="append", type=float, required=True)
    d.add_argument("--angle", action="append", type=float, required=True)
    d.add_argument("--noise-gain", type=float, default=4.0)
    d.add_argument("--regularization", type=float, default=2.5)
    d.add_argument("--shadow-limit", type=float, default=0.18)
    d.add_argument("--overshoot", type=float, default=0.20)
    d.add_argument("--feather", type=float, default=10.0)
    d.add_argument("--clean")
    d.add_argument("--meta")
    d.add_argument("--out", required=True)
    d.add_argument("--metrics", action="store_true")
    d.add_argument("--sweep", help="逗号分隔的长度列表")
    d.add_argument("--sweep-rect")
    d.set_defaults(func=cmd_deblur)

    v = sub.add_parser("validate", help="用干净样例核对")
    v.add_argument("--clean", required=True)
    v.add_argument("--blurred", required=True)
    v.add_argument("--meta")
    v.add_argument("--region", action="append", type=_parse_rect)
    v.add_argument("--length", action="append", type=float, default=None)
    v.add_argument("--angle", action="append", type=float, default=None)
    v.add_argument("--length-guess", type=float, default=9.0)
    v.add_argument("--angle-guess", type=float, default=0.0)
    v.add_argument("--noise-gain", type=float, default=4.0)
    v.add_argument("--feather", type=float, default=10.0)
    v.add_argument("--out")
    v.set_defaults(func=cmd_validate)

    w = sub.add_parser("sweep", help="参数扫描")
    w.add_argument("--image", required=True)
    w.add_argument("--clean")
    w.add_argument("--rect", required=True)
    w.add_argument("--angle", type=float, required=True)
    w.add_argument("--lengths", required=True)
    w.add_argument("--gains")
    w.add_argument("--out")
    w.set_defaults(func=cmd_sweep)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
