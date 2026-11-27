"""badcol 命令行入口。

子命令:
  synth   生成带已知坏列的模拟批次(含干净参考与注入清单)
  detect  对一个批次做坏列检测, 输出证据报告与初始坏列表
  repair  按坏列表修补另一(或同一)批次, 尺寸不符明确拒绝; 可带参考对比
  gui     打开交互视图
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from .badlist import BadList, BadListError
from .detect import ColumnSelection, DetectConfig, detect_columns
from .io_utils import load_frames, save_image, to_gray
from .repair import RepairConfig, repair_batch
from .report import (
    compare_with_clean,
    export_repaired,
    write_change_stats,
    write_comparison_report,
)
from .synth import default_config, generate_batch, write_batch


def _print(result, file=sys.stdout) -> None:
    for line in result.summary_lines():
        print(line, file=file)


def cmd_synth(args: argparse.Namespace) -> int:
    cfg = default_config(n_frames=args.frames, seed=args.seed)
    cfg.width, cfg.height = args.width, args.height
    clean, defective, _manifest = generate_batch(cfg)
    info = write_batch(args.out, cfg, defective, clean)
    with (Path(args.out) / "manifest.json").open("w", encoding="utf-8") as fh:
        json.dump(info, fh, ensure_ascii=False, indent=2)
    print(f"已生成 {cfg.n_frames} 帧到 {Path(args.out).resolve()}")
    print(f"  缺陷帧: {info['defective_dir']}")
    print(f"  干净参考: {info['clean_dir']}")
    print(f"  注入清单: {Path(args.out) / 'manifest.json'}")
    print("注入的缺陷列:")
    for s in cfg.defects:
        scope = "所有帧" if s.frames is None else f"帧 {s.frames}"
        print(f"  列 {s.col:>3d} {s.kind:<6s} {scope}")
    return 0


def _load_gray(input_dir: str) -> tuple[list[str], np.ndarray, np.ndarray]:
    names, frames = load_frames(input_dir)
    gray = frames if frames.ndim == 3 else np.stack([to_gray(f) for f in frames])
    return names, frames, gray


def cmd_detect(args: argparse.Namespace) -> int:
    names, frames, gray = _load_gray(args.input)
    cfg = DetectConfig(persist_ratio=args.persist_ratio)
    result = detect_columns(gray, cfg)
    _print(result)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    sel = ColumnSelection()
    if not args.include_weak:
        sel.apply_strong_only(result)
    eff = sel.effective(result)
    bl = BadList.from_selection(
        eff, sel.protected, result.height, result.width, result.n_frames
    )
    bl.save(out_dir / "badlist.json", notes="detect 自动检测初始坏列表")
    evidence = [e.to_dict() for e in result.evidences]
    with (out_dir / "evidence.json").open("w", encoding="utf-8") as fh:
        json.dump(
            {
                "n_frames": result.n_frames,
                "height": result.height,
                "width": result.width,
                "noise_per_frame": result.noise_per_frame,
                "columns": evidence,
            },
            fh, ensure_ascii=False, indent=2,
        )
    groups = result.columns_by_label()
    n_weak = sum(1 for e in result.evidences if e.confidence == "weak")
    print(f"\n坏列表 -> {out_dir / 'badlist.json'} (强候选 "
          f"{len(eff)} 个, 弱候选 {n_weak} 个仅入证据报告)")
    print(f"证据报告 -> {out_dir / 'evidence.json'}")
    print(f"固定坏列 {len(groups['persistent'])} 个, 偶发异常列 "
          f"{len(groups['intermittent'])} 个")
    return 0


def cmd_repair(args: argparse.Namespace) -> int:
    names, frames, _gray = _load_gray(args.input)
    try:
        bl = BadList.load(args.badlist)
        per_frame, warnings = bl.apply_to_batch(frames, strict=False)
    except BadListError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2
    for w in warnings:
        print(f"警告: {w}", file=sys.stderr)

    rcfg = RepairConfig(max_span=args.max_span)
    result = repair_batch(frames, per_frame, bl.protected, rcfg)
    out_dir = Path(args.out)
    paths = export_repaired(out_dir / "repaired", names, result)
    write_change_stats(out_dir / "change_stats.csv", names, result)
    print(f"已修补 {len(paths)} 帧 -> {out_dir / 'repaired'}")
    print(f"变更统计 -> {out_dir / 'change_stats.csv'}")

    unreliable = result.unreliable_columns()
    if unreliable:
        print("以下位置无法可靠修补, 请人工查看:", file=sys.stderr)
        for f, cols in unreliable.items():
            print(f"  帧 {f} ({names[f]}): 列 {cols}", file=sys.stderr)
    else:
        print("全部选中列均已可靠修补")

    if args.clean:
        _names_clean, clean_frames = load_frames(args.clean)[:2]
        if clean_frames.shape != frames.shape:
            print(
                f"错误: 参考批次尺寸 {clean_frames.shape} 与输入 {frames.shape} 不符",
                file=sys.stderr,
            )
            return 2
        cmp_ = compare_with_clean(
            frames, result.repaired, clean_frames, per_frame, bl.protected
        )
        write_comparison_report(out_dir / "clean_comparison.csv", cmp_)
        print(f"干净参考对比 -> {out_dir / 'clean_comparison.csv'}")
        print(f"  恢复 MAE={cmp_['recovery_mae']:.4f}  "
              f"误伤 MAE={cmp_['damage_mae']:.4f}  最大误伤={cmp_['max_damage']:.2f}")
        print(f"  结论: {cmp_['verdict']}")
    return 0


def cmd_gui(args: argparse.Namespace) -> int:
    import matplotlib.pyplot as plt

    from .gui import launch_gui

    names, frames, gray = _load_gray(args.input)
    detection = detect_columns(gray)
    clean = None
    if args.clean:
        _n, clean = load_frames(args.clean)[:2]
        if clean.shape != frames.shape:
            print(f"错误: 参考批次尺寸不符 {clean.shape} != {frames.shape}",
                  file=sys.stderr)
            return 2
    gui = launch_gui(frames, names, detection, clean)
    print("GUI 已启动; 关闭窗口退出。")
    plt.show()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m badcol.cli",
        description="面阵扫描图坏列分析与补图工具",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("synth", help="生成模拟坏列批次")
    p.add_argument("--out", required=True, help="输出目录")
    p.add_argument("--frames", type=int, default=8)
    p.add_argument("--width", type=int, default=300)
    p.add_argument("--height", type=int, default=220)
    p.add_argument("--seed", type=int, default=42)
    p.set_defaults(func=cmd_synth)

    p = sub.add_parser("detect", help="检测坏列并输出证据与坏列表")
    p.add_argument("--input", required=True, help="图像目录")
    p.add_argument("--out", required=True, help="分析结果输出目录")
    p.add_argument("--persist-ratio", type=float, default=0.8,
                   help="命中比例达到该值判为固定坏列(默认 0.8)")
    p.add_argument("--include-weak", action="store_true",
                   help="坏列表也纳入只命中 1~2 帧的弱候选(默认排除, 仅写证据报告)")
    p.set_defaults(func=cmd_detect)

    p = sub.add_parser("repair", help="按坏列表修补批次")
    p.add_argument("--input", required=True, help="待修补图像目录")
    p.add_argument("--badlist", required=True, help="坏列表 JSON")
    p.add_argument("--out", required=True, help="输出目录")
    p.add_argument("--clean", help="(可选)干净参考批次目录, 用于恢复/误伤评估")
    p.add_argument("--max-span", type=int, default=3,
                   help="连续坏列超过该长度标记不可靠(默认 3)")
    p.set_defaults(func=cmd_repair)

    p = sub.add_parser("gui", help="打开交互视图")
    p.add_argument("--input", required=True)
    p.add_argument("--clean", help="(可选)干净参考批次目录")
    p.set_defaults(func=cmd_gui)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
