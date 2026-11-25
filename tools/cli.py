#!/usr/bin/env python3
"""SeamSqueeze 命令行入口。

示例：
  # 生成两张演示图
  python tools/cli.py demo --out examples

  # 对演示图缩窄到 460 宽（高不变），圈住左右物件、标记中部留白
  python tools/cli.py run examples/sparse.png --out examples/run_sparse \\
      --target 460 300 --order width_first \\
      --protect 24,102,156,234:左圆 --protect 566,102,692,234:右方块 \\
      --shrink 190,32,530,294:中部留白

  # 逐步预览（每 20 步存一张预览图，含拟抽缝高亮）
  python tools/cli.py preview examples/sparse.png --out examples/preview \\
      --target 460 300 --every 20 \\
      --protect 24,102,156,234 --protect 566,102,692,234 \\
      --shrink 190,32,530,294

  # 从项目文件复现
  python tools/cli.py replay examples/run_sparse/result_project.json \\
      --out examples/replay
"""

from __future__ import annotations

import argparse
import os
import sys

# 允许 `python -I tools/cli.py` 直接运行：把仓库根目录加入 import 路径。
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from PIL import Image

from seamsqueeze import MaskSet, Rect, SeamEngine
from seamsqueeze.demo import build_demo_images, make_dense, make_sparse
from seamsqueeze.engine import (
    HORIZONTAL,
    VERTICAL,
    EngineError,
    ProtectionBlockedError,
    TargetTooSmallError,
)
from seamsqueeze.project import Project, load_rgb
from seamsqueeze.viz import draw_masks, draw_seam
from tools.exportutil import export_all, save_png


def parse_rect(text: str) -> Rect:
    """``x0,y0,x1,y1`` 或 ``x0,y0,x1,y1:名称``。"""
    name = ""
    if ":" in text:
        text, name = text.split(":", 1)
    parts = [int(v) for v in text.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(f"矩形需要 x0,y0,x1,y1，收到：{text!r}")
    return Rect(*parts, name=name)


def build_masks(args: argparse.Namespace) -> MaskSet:
    return MaskSet(
        protect=list(args.protect or []),
        shrink=list(args.shrink or []),
    )


# ----------------------------------------------------------------------
def cmd_demo(args: argparse.Namespace) -> int:
    paths = build_demo_images(args.out, args.width, args.height)
    print("已生成演示图：")
    for name, path in paths.items():
        print(f"  {name:6s} -> {path}")
    print("\n推荐蒙版（源图坐标，闭区间）：")
    for name, builder in (("sparse", make_sparse), ("dense", make_dense)):
        _, masks = builder(args.width, args.height)
        print(f"  [{name}]")
        for r in masks.protect:
            print(f"    --protect {r.x0},{r.y0},{r.x1},{r.y1}:{r.name}")
        for r in masks.shrink:
            print(f"    --shrink  {r.x0},{r.y0},{r.x1},{r.y1}:{r.name}")
    return 0


def _load(image_path: str) -> np.ndarray:
    return np.asarray(Image.open(image_path).convert("RGB"))


def cmd_run(args: argparse.Namespace) -> int:
    masks = build_masks(args)
    source = _load(args.image)
    engine = SeamEngine(source, masks)
    tw, th = args.target
    try:
        engine.check_target(tw, th)
        engine.resize_to(tw, th, order=args.order)
    except TargetTooSmallError as exc:
        print(f"[拒绝] {exc}", file=sys.stderr)
        return 2
    except ProtectionBlockedError as exc:
        print(f"[拒绝] {exc}", file=sys.stderr)
        return 2

    paths = export_all(
        args.out, os.path.abspath(args.image), source, engine, masks, args.order
    )
    print(f"源 {engine.source_size} -> 结果 {engine.size}，共 {len(engine.steps)} 步")
    for label, path in paths.items():
        print(f"  {label:7s} -> {path}")
    return 0


def cmd_preview(args: argparse.Namespace) -> int:
    masks = build_masks(args)
    source = _load(args.image)
    engine = SeamEngine(source, masks)
    tw, th = args.target
    engine.check_target(tw, th)

    os.makedirs(args.out, exist_ok=True)
    # 第 0 张：带蒙版的源图。
    save_png(
        os.path.join(args.out, "step_0000_masks.png"),
        draw_masks(source, engine.protect, engine.shrink),
    )

    n_w, n_h = engine.size[0] - tw, engine.size[1] - th
    sequence = SeamEngine._plan_sequence(n_w, n_h, args.order)
    every = max(1, args.every)
    for i, direction in enumerate(sequence, start=1):
        rec = engine.preview_seam(direction)
        if i % every == 1 or i == len(sequence):
            preview = draw_seam(
                draw_masks(engine.image, engine.protect, engine.shrink),
                rec.current_path,
                engine.protect,
            )
            save_png(os.path.join(args.out, f"step_{i:04d}_seam.png"), preview)
        try:
            engine.remove_seam(direction)
        except ProtectionBlockedError as exc:
            print(f"[拒绝] 第 {i} 步保护区放不下：{exc}", file=sys.stderr)
            return 2

    paths = export_all(
        args.out, os.path.abspath(args.image), source, engine, masks, args.order,
        prefix="final",
    )
    print(f"逐步预览已写入 {args.out}（每 {every} 步一张），最终产物：")
    for label, path in paths.items():
        print(f"  {label:7s} -> {path}")
    return 0


def cmd_replay(args: argparse.Namespace) -> int:
    project = Project.load(args.project)
    try:
        engine, result = project.replay(source_root=args.source_root)
    except EngineError as exc:
        print(f"[复现失败] {exc}", file=sys.stderr)
        return 2

    os.makedirs(args.out, exist_ok=True)
    result_path = os.path.join(args.out, "replayed_result.png")
    save_png(result_path, result)
    print(f"复现成功：{engine.source_size} -> {engine.size}，"
          f"{len(engine.steps)} 步 -> {result_path}")
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    project = Project.load(args.project)
    d = project.to_dict()
    for key in (
        "schema_version", "source_path", "source_size", "source_sha256",
        "target_size", "order",
    ):
        print(f"{key}: {d[key]}")
    n_v = project.directions.count(VERTICAL)
    n_h = project.directions.count(HORIZONTAL)
    print(f"steps: {len(project.directions)} (vertical={n_v}, horizontal={n_h})")
    print("masks:", d["masks"])
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="seamsqueeze",
        description="本地内容感知缩图（seam carving），保护完整物件、优先吃留白",
    )
    sub = p.add_subparsers(dest="command", required=True)

    d = sub.add_parser("demo", help="生成稀疏 / 密集两张几何演示图")
    d.add_argument("--out", default="examples", help="输出目录")
    d.add_argument("--width", type=int, default=720)
    d.add_argument("--height", type=int, default=300)
    d.set_defaults(func=cmd_demo)

    def add_common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("image", help="源图路径（不会被覆盖）")
        sp.add_argument("--out", required=True, help="输出目录")
        sp.add_argument(
            "--target", type=int, nargs=2, metavar=("W", "H"), required=True,
            help="目标宽高（只允许小于等于当前尺寸）",
        )
        sp.add_argument(
            "--order", choices=("width_first", "height_first", "alternate"),
            default="alternate",
            help="宽高都变化时的先后顺序（默认 alternate）",
        )
        sp.add_argument(
            "--protect", type=parse_rect, action="append",
            help="保护矩形 x0,y0,x1,y1[:名称]，可重复",
        )
        sp.add_argument(
            "--shrink", type=parse_rect, action="append",
            help="优先缩减留白 x0,y0,x1,y1[:名称]，可重复",
        )

    r = sub.add_parser("run", help="一次性缩到目标尺寸并导出全套产物")
    add_common(r)
    r.set_defaults(func=cmd_run)

    pv = sub.add_parser("preview", help="逐步预览，输出每步拟抽缝的高亮图")
    add_common(pv)
    pv.add_argument("--every", type=int, default=10, help="每隔几步存一张预览")
    pv.set_defaults(func=cmd_preview)

    rp = sub.add_parser("replay", help="从项目文件 + 源图复现结果")
    rp.add_argument("project", help="*_project.json 路径")
    rp.add_argument("--out", required=True)
    rp.add_argument("--source-root", default=None,
                    help="源图原路径失效时，在该目录下按文件名寻找")
    rp.set_defaults(func=cmd_replay)

    inf = sub.add_parser("info", help="查看项目文件摘要")
    inf.add_argument("project")
    inf.set_defaults(func=cmd_info)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (EngineError, ValueError, FileNotFoundError) as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
