"""命令行入口：无 GUI 环境下生成样例或直接合成。

用法：
  python -m focus_stack.cli samples --set scene --out ./demo
  python -m focus_stack.cli samples --set failure --out ./demo_fail
  python -m focus_stack.cli fuse --images a.png b.png c.png --out ./out_dir
"""
from __future__ import annotations

import argparse
import os

from .pipeline import load_images, run_pipeline
from .project import save_outputs, save_project
from .registration import STATUS_FAIL, STATUS_WARN
from .samples import SAMPLE_SETS, generate_focus_stack
from .selection import PinSet, SelectionConfig
from .sharpness import SharpnessConfig


def _cmd_samples(args):
    spec = SAMPLE_SETS[args.set]
    paths = generate_focus_stack(args.out, n=args.count or spec["n"],
                                 failure=spec["failure"])
    print(f"已生成 {len(paths)} 张样例 → {os.path.abspath(args.out)}")
    for p in paths:
        print("  ", p)
    if args.run:
        args.images = paths
        _cmd_fuse(args)


def _cmd_fuse(args):
    mode = getattr(args, "mode", "soft")
    coverage = getattr(args, "coverage", "keep")
    temperature = getattr(args, "temperature", 8.0)
    images = load_images(args.images)
    print(f"载入 {len(images)} 张图像，用户顺序：")
    for i, p in enumerate(args.images):
        print(f"  {i + 1}. {p}")
    result = run_pipeline(images, pins=PinSet(),
                          fusion_mode=mode,
                          coverage_mode=coverage,
                          temperature=temperature,
                          progress=lambda d, t, phase: print(f"  [{d}/{t}] {phase}"))
    print("\n配准结果：")
    for it in result.registration.items:
        flag = {"ok": "✓", "warn": "!", "fail": "✗"}[it.status]
        print(f"  [{flag}] 源 {it.index + 1}: cc={it.correlation:.3f}  {it.message}")
    n_fail = sum(1 for it in result.registration.items if it.status == STATUS_FAIL)
    n_warn = sum(1 for it in result.registration.items if it.status == STATUS_WARN)
    if n_fail:
        print(f"  ⚠ {n_fail} 张配准失败，已从合成中排除；{n_warn} 张警告")
    print(f"\n重影：{result.ghost_stats}")
    os.makedirs(args.out, exist_ok=True)
    c, s = save_outputs(args.out, result.fusion.composite, result.fusion.source_map)
    save_project(args.out, args.images, result.registration, result.pins,
                 SharpnessConfig(), SelectionConfig(),
                 result.temperature, mode, coverage,
                 cache={"scores": result.scores, "labels": result.labels,
                        "weights": result.weights, "valid_mask": result.valid_mask})
    print(f"\n输出：\n  {c}\n  {s}\n  {os.path.join(args.out, 'project.json')}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="本地多焦点照片合成工具")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("samples", help="生成自带样例")
    p1.add_argument("--set", choices=list(SAMPLE_SETS), default="scene")
    p1.add_argument("--out", required=True)
    p1.add_argument("--count", type=int, default=0)
    p1.add_argument("--run", action="store_true", help="生成后直接跑一次合成")
    p1.set_defaults(func=_cmd_samples)

    p2 = sub.add_parser("fuse", help="对一组图片执行合成")
    p2.add_argument("--images", nargs="+", required=True)
    p2.add_argument("--out", required=True)
    p2.add_argument("--mode", choices=["soft", "hard"], default="soft")
    p2.add_argument("--coverage", choices=["keep", "crop"], default="keep")
    p2.add_argument("--temperature", type=float, default=8.0)
    p2.set_defaults(func=_cmd_fuse)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
