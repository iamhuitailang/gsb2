"""Command-line companion to the Tkinter inspector.

Two jobs:

* ``demo``   — generate the built-in synthetic samples, correct them, export
  lossless files, read them back and print the measured before/after numbers.
* ``batch``  — correct real files with an explicitly named reference group.

The CLI shares every algorithm with the GUI, so what you measure here is what
the window shows.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import core


def _cmd_demo(args: argparse.Namespace) -> int:
    out = Path(args.out)
    spec = core.SampleSpec(width=args.width, height=args.height, channels=args.channels)
    sample = core.write_synthetic_samples(out, spec)

    library = core.ReferenceLibrary()
    group = library.create_group(
        "合成参考",
        [core.load_image(image.meta.path) for image in sample.darks],
        [core.load_image(image.meta.path) for image in sample.flats],
    )
    science = core.load_image(sample.science.meta.path)
    result = core.correct_image(
        science.array,
        group,
        sensor_max=science.meta.sensor_max or None,
        bit_depth=science.meta.bit_depth,
    )
    stats = core.uniform_region_stats(
        science.array, result.corrected, sample.uniform_rect
    )
    corners = core.corner_gradient(science.array, result.corrected)

    manifest = core.export_batch(
        [core.ExportJob(image=science, group_name=group.name)],
        library,
        out / "corrected",
    )

    print("== 平场校正自检 ==")
    print(f"样例目录: {out}")
    print(
        f"均匀区: 标准差 {stats['before_std']:.3f} → {stats['after_std']:.3f} "
        f"(下降 {stats['std_reduction']:.1%})，"
        f"极差 {stats['before_span']:.2f} → {stats['after_span']:.2f} "
        f"(下降 {stats['span_reduction']:.1%})"
    )
    print(
        f"角落差 (左上−右下): {corners['before_delta']:.2f} → "
        f"{corners['after_delta']:.2f}"
    )
    if result.diagnostics is not None:
        for line in result.diagnostics.summary_lines():
            print("亮参考:", line)
    for warning in result.warnings:
        print("提示:", warning)

    for record in manifest.records:
        print(
            f"导出 {Path(record.output_path).name}: 参考组「{record.group_name}」, "
            f"读回误差 ≤ {record.readback_max_abs_error:.6f} "
            f"({'通过' if record.verified else '未通过'})"
        )
    for error in manifest.errors:
        print("跳过:", error)

    report = {
        "uniform_std_reduction": stats["std_reduction"],
        "uniform_span_reduction": stats["span_reduction"],
        "corner_before_delta": corners["before_delta"],
        "corner_after_delta": corners["after_delta"],
        "exports": [record.as_dict() for record in manifest.records],
        "export_errors": manifest.errors,
    }
    (out / "demo_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"报告: {out / 'demo_report.json'}")
    return 0 if not manifest.errors else 1


def _cmd_batch(args: argparse.Namespace) -> int:
    darks = [core.load_image(p) for p in args.dark]
    flats = [core.load_image(p) for p in args.flat]
    library = core.ReferenceLibrary()
    try:
        group = library.create_group(args.group, darks, flats)
    except core.ReferenceError as exc:
        print(f"无法建立参考组: {exc}", file=sys.stderr)
        for reason in exc.reasons:
            print(f"  - {reason}", file=sys.stderr)
        return 2

    jobs = []
    for path in args.image:
        try:
            jobs.append(core.ExportJob(image=core.load_image(path), group_name=group.name))
        except Exception as exc:  # noqa: BLE001 - report and keep going
            print(f"无法读取 {path}: {exc}", file=sys.stderr)

    manifest = core.export_batch(jobs, library, args.out)
    print(manifest.to_json())
    return 0 if not manifest.errors else 1


def _cmd_check(args: argparse.Namespace) -> int:
    report = core.synthetic_validation(
        core.SampleSpec(width=args.width, height=args.height, channels=args.channels)
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m flatfield.cli",
        description="平场校正检查器命令行版",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    demo = sub.add_parser("demo", help="生成样例、校正、导出并读回核对")
    demo.add_argument("--out", default="flatfield_demo", help="输出目录")
    demo.add_argument("--width", type=int, default=480)
    demo.add_argument("--height", type=int, default=360)
    demo.add_argument("--channels", type=int, default=3, choices=(1, 3))
    demo.set_defaults(func=_cmd_demo)

    batch = sub.add_parser("batch", help="用指定参考组校正并导出实拍图")
    batch.add_argument("--group", default="参考组")
    batch.add_argument("--dark", nargs="+", required=True, help="暗参考文件")
    batch.add_argument("--flat", nargs="+", required=True, help="亮参考文件")
    batch.add_argument("--image", nargs="+", required=True, help="待校正实拍图")
    batch.add_argument("--out", default="flatfield_out", help="输出目录")
    batch.set_defaults(func=_cmd_batch)

    check = sub.add_parser("check", help="仅运行合成自检并打印数值")
    check.add_argument("--width", type=int, default=480)
    check.add_argument("--height", type=int, default=360)
    check.add_argument("--channels", type=int, default=3, choices=(1, 3))
    check.set_defaults(func=_cmd_check)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
