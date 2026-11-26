"""Command line interface for the local WAV split/restore tool."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import core


def _json_print(value) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def cmd_split(args: argparse.Namespace) -> int:
    source = Path(args.input)
    reader = core.WavReader(source)
    if args.interval is not None:
        cuts = core.plan_fixed_cuts(
            reader.info.total_frames, reader.info.sample_rate, args.interval
        )
    else:
        values = []
        if args.cuts:
            values.extend(args.cuts.split(","))
        if args.cut_frames:
            values.extend(args.cut_frames.split(","))
        unit = "frames" if args.cut_frames and not args.cuts else "seconds"
        # If both are supplied, handle separately below.
        cuts = []
        if args.cuts:
            cuts.extend(
                core.plan_custom_cuts(
                    reader.info.total_frames,
                    reader.info.sample_rate,
                    args.cuts.split(","),
                    "seconds",
                )
            )
        if args.cut_frames:
            frame_cuts = core.plan_custom_cuts(
                reader.info.total_frames,
                reader.info.sample_rate,
                args.cut_frames.split(","),
                "frames",
            )
            existing = {c["frame"] for c in cuts}
            for c in frame_cuts:
                if c["frame"] not in existing:
                    cuts.append(c)
            cuts.sort(key=lambda c: c["frame"])
            core._reindex(cuts)  # noqa: SLF001
        if not cuts:
            raise core.CutError("请提供 --interval、--cuts 或 --cut-frames")

    manifest = core.split_wav(source, args.out, cuts=cuts)
    print(f"已导出 {len(manifest['segments'])} 段到：{args.out}")
    print(f"清单：{Path(args.out) / 'manifest.json'}")
    print("切点实际采样点：")
    for cut in cuts:
        delta_ms = cut["delta_seconds"] * 1000
        print(
            f"  #{cut['index']}: frame={cut['frame']} "
            f"t={cut['time_seconds']:.6f}s "
            f"rounding={cut['delta_frames']:+.3f} samples ({delta_ms:+.3f} ms)"
        )
    return 0


def _assignments_from_args(manifest: dict, manifest_path: Path, maps: list[str] | None):
    assignments = core.default_assignments_from_manifest_dir(manifest, manifest_path)
    names = {i: p.name for i, p in assignments.items()}
    for mapping in maps or []:
        if "=" not in mapping:
            raise ValueError("--map 格式应为 段序号(从1开始)=文件路径")
        key, value = mapping.split("=", 1)
        idx = int(key) - 1
        if idx < 0 or idx >= len(manifest["segments"]):
            raise IndexError(f"段序号超出范围：{key}")
        p = Path(value)
        assignments[idx] = p if value.lower() != "none" else None
        names[idx] = p.name if value.lower() != "none" else None
    return assignments, names


def cmd_verify(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest)
    manifest = core.load_manifest(manifest_path)
    assignments, names = _assignments_from_args(manifest, manifest_path, args.map)
    report = core.verify_assignments(manifest, assignments, names)
    _json_print(report)
    return 0 if report["sample_complete"] else 2


def cmd_restore(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest)
    manifest = core.load_manifest(manifest_path)
    assignments, names = _assignments_from_args(manifest, manifest_path, args.map)
    report = core.verify_assignments(manifest, assignments, names)

    out = Path(args.output)
    if report["sample_complete"]:
        core.write_assembly(out, manifest, assignments, report, partial=False)
        print(f"完整拼回成功：{out}")
    elif args.partial:
        core.write_assembly(out, manifest, assignments, report, partial=True)
        print(f"存在未通过分段，已写出带静音缺口的部分预览（不算完整拼回）：{out}")
    else:
        print("分段校验未通过，未写出拼回文件。可加 --partial 生成时间轴预览。", file=sys.stderr)
        _json_print(report)
        return 2

    if args.compare_original:
        comparison = core.compare_wavs(args.compare_original, out)
        _json_print(comparison)
        return 0 if comparison["identical_sample_data"] and report["sample_complete"] else 3
    return 0 if report["sample_complete"] else 2


def cmd_compare(args: argparse.Namespace) -> int:
    result = core.compare_wavs(args.original, args.candidate)
    _json_print(result)
    return 0 if result["identical_sample_data"] else 3


def cmd_demo(args: argparse.Namespace) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if args.case == "all":
        for case in ("normal", "missing", "swap", "same_name_replaced"):
            case_out = out / case
            result = core.make_demo_workspace(case_out, case)
            print(f"\n=== {case} → {case_out} ===")
            print(json.dumps(_compact_demo(result), ensure_ascii=False, indent=2))
        print(f"\n演示文件已生成到：{out}")
    else:
        result = core.make_demo_workspace(out, args.case)
        print(json.dumps(_compact_demo(result), ensure_ascii=False, indent=2))
    return 0


def _compact_demo(result: dict) -> dict:
    v = result["verification"]
    c = result["comparison_partial"]
    return {
        "source": result["source"],
        "cuts": [x["frame"] for x in result["cuts"]],
        "verification": {
            "complete": v["complete"],
            "counts": v["counts"],
            "problems": v["problems"],
        },
        "partial_preview": result["partial_preview"],
        "restored": result["restored"],
        "comparison": {
            "identical_sample_data": c["identical_sample_data"],
            "frame_count_match": c["frame_count_match"],
            "channels": [
                {
                    "channel": x["channel"],
                    "identical": x["identical"],
                    "difference_count": x["difference_count"],
                    "first_difference": x["first_difference"],
                    "first_ranges": x["difference_ranges"][:5],
                }
                for x in c["channels_report"]
            ],
        },
    }


def cmd_serve(args: argparse.Namespace) -> int:
    from .server import run_server

    run_server(host=args.host, port=args.port)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="wav-tool", description="本地 WAV 采样点级分段与复原工具")
    sub = parser.add_subparsers(dest="command", required=True)

    p_split = sub.add_parser("split", help="分段并生成清单")
    p_split.add_argument("input")
    p_split.add_argument("--out", required=True)
    p_split.add_argument("--interval", type=float, help="固定间隔，单位秒")
    p_split.add_argument("--cuts", help="自定义切点，秒，逗号分隔")
    p_split.add_argument("--cut-frames", help="自定义切点，整数采样帧，逗号分隔")
    p_split.set_defaults(func=cmd_split)

    p_verify = sub.add_parser("verify", help="按清单逐段校验")
    p_verify.add_argument("manifest")
    p_verify.add_argument("--map", action="append", help="序号=文件，可重复；none 表示缺段")
    p_verify.set_defaults(func=cmd_verify)

    p_restore = sub.add_parser("restore", help="校验并拼回")
    p_restore.add_argument("manifest")
    p_restore.add_argument("--output", "-o", required=True)
    p_restore.add_argument("--map", action="append")
    p_restore.add_argument("--partial", action="store_true", help="允许输出静音缺口预览")
    p_restore.add_argument("--compare-original", help="拼回后与原始 WAV 比较")
    p_restore.set_defaults(func=cmd_restore)

    p_compare = sub.add_parser("compare", help="比较两个 WAV 的各声道采样")
    p_compare.add_argument("original")
    p_compare.add_argument("candidate")
    p_compare.set_defaults(func=cmd_compare)

    p_demo = sub.add_parser("demo", help="生成样音和正常/异常演示")
    p_demo.add_argument("--out", default="demo_output")
    p_demo.add_argument("--case", choices=["all", "normal", "missing", "swap", "same_name_replaced"], default="all")
    p_demo.set_defaults(func=cmd_demo)

    p_serve = sub.add_parser("serve", help="启动本地网页工具")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8765)
    p_serve.set_defaults(func=cmd_serve)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except core.WavToolError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    except FileNotFoundError as exc:
        print(f"文件不存在：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
