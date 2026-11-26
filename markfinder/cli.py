"""markfinder 命令行入口。

子命令：
  extract   从图片圈出模板（矩形/背景 flood/中心前景），存带 alpha 的 PNG
  find      在目标图里查找，导出 CSV/JSON/修订日志/标注图
  synthetic 生成可计算数量的合成验证数据集
  validate  在合成数据集上跑查找并输出计数、查准/查全、翻面统计
  gui       启动图形界面（人工复核用）
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2

from .export import export_results
from .matching import SearchParams, find_matches
from .review import ReviewStore, image_identity
from .synthetic import generate_dataset, validate_dataset
from .template import extract_rect_template, load_image, load_template, save_template


def _add_search_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--min-angle", type=float, default=0.0, help="最小角度（度，逆时针为正）")
    p.add_argument("--max-angle", type=float, default=360.0)
    p.add_argument("--angle-step", type=float, default=5.0, help="角度网格步距（度）")
    p.add_argument("--min-scale", type=float, default=0.8)
    p.add_argument("--max-scale", type=float, default=1.25)
    p.add_argument("--num-scales", type=int, default=5, help="对数缩放网格档数")
    p.add_argument("--allow-flip", action="store_true", help="允许水平翻面（默认不匹配翻面）")
    p.add_argument("--threshold", type=float, default=0.6, help="方向 chamfer 分数阈值")
    p.add_argument("--max-matches", type=int, default=200)


def _params_from_args(args: argparse.Namespace) -> SearchParams:
    return SearchParams(
        min_angle=args.min_angle,
        max_angle=args.max_angle,
        angle_step=args.angle_step,
        min_scale=args.min_scale,
        max_scale=args.max_scale,
        num_scales=args.num_scales,
        allow_flip=args.allow_flip,
        score_threshold=args.threshold,
        max_matches=args.max_matches,
    )


def cmd_extract(args: argparse.Namespace) -> int:
    img = load_image(args.image)
    x, y, w, h = args.rect
    tpl = extract_rect_template(img, (x, y, w, h), mode=args.mode, bg_tolerance=args.tolerance)
    if args.crop:
        tpl = tpl.cropped()
    save_template(tpl, args.output)
    print(f"模板已保存: {args.output}  尺寸 {tpl.width}x{tpl.height}  有效像素 {(tpl.mask > 0).sum()}")
    return 0


def cmd_find(args: argparse.Namespace) -> int:
    tpl = load_template(args.template)
    img = load_image(args.image)
    params = _params_from_args(args)

    def progress(done: int, total: int, msg: str) -> None:
        if not args.quiet:
            print(f"\r[{done}/{total}] {msg}      ", end="", flush=True)

    params.progress = progress
    matches = find_matches(tpl, img, params)
    if not args.quiet:
        print()

    store = ReviewStore(args.state)
    key = image_identity(args.image, img.shape)
    state = store.get_state(key, str(Path(args.image).resolve()))
    store.replace_matches(
        state,
        matches,
        params={
            "min_angle": params.min_angle, "max_angle": params.max_angle,
            "angle_step": params.angle_step, "min_scale": params.min_scale,
            "max_scale": params.max_scale, "num_scales": params.num_scales,
            "allow_flip": params.allow_flip,
        },
        threshold=args.threshold,
        position_tol_px=0.6 * min(tpl.width, tpl.height),
    )
    store.save()

    paths = export_results(state, img, args.out, template=tpl)
    counts = state.counts()
    print(
        f"候选 {counts['total']}（确认 {counts['confirmed']} / "
        f"误报 {counts['false_positive']} / 待复核 {counts['candidate']}）"
    )
    for name, p in paths.items():
        print(f"  {name}: {p}")
    return 0


def cmd_synthetic(args: argparse.Namespace) -> int:
    truth = generate_dataset(
        args.out,
        n_sheets=args.sheets,
        marks_per_sheet=args.marks,
        seed=args.seed,
        shape_kind=args.shape,
    )
    total = sum(len(s["instances"]) for s in truth["sheets"])
    print(f"已生成 {args.sheets} 张合成图，共 {total} 个标记 -> {args.out}")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    params = _params_from_args(args)
    summary = validate_dataset(args.dataset, params=params)
    print(json.dumps(summary["totals"], ensure_ascii=False, indent=2))
    for s in summary["sheets"]:
        print(
            f"{Path(s['file']).name}: 真值 {s['gt_total']}（翻面 {s['gt_flipped']}）"
            f" 预测 {s['predicted']} 命中 {s['matched']} 误报 {s['false_positives']}"
        )
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)
        print(f"指标已写入 {args.output}")
    t = summary["totals"]
    # 务实验收线：查全 0.9、查准 0.85；残余误报由 GUI 人工复核剔除
    if t["recall_normal"] < 0.9 or t["precision"] < 0.85:
        print("警告：查全 <0.9 或查准 <0.85", file=sys.stderr)
        return 2
    return 0


def cmd_gui(args: argparse.Namespace) -> int:
    from .gui import run_gui

    return run_gui(initial_image=args.image, initial_template=args.template, state_path=args.state)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="markfinder", description="本地旋转/缩放模板查找器")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ext = sub.add_parser("extract", help="圈出模板并保存")
    p_ext.add_argument("image")
    p_ext.add_argument("output", help="输出 PNG（带 alpha 掩膜）")
    p_ext.add_argument("--rect", type=int, nargs=4, metavar=("X", "Y", "W", "H"), required=True)
    p_ext.add_argument("--mode", choices=["rect", "flood", "center"], default="flood")
    p_ext.add_argument("--tolerance", type=int, default=24)
    p_ext.add_argument("--crop", action="store_true", help="裁掉掩膜四周空白")
    p_ext.set_defaults(func=cmd_extract)

    p_find = sub.add_parser("find", help="查找并导出结果")
    p_find.add_argument("template")
    p_find.add_argument("image")
    p_find.add_argument("--out", default="markfinder_out")
    p_find.add_argument("--state", default="markfinder_out/review_state.json")
    _add_search_args(p_find)
    p_find.add_argument("--quiet", action="store_true")
    p_find.set_defaults(func=cmd_find)

    p_syn = sub.add_parser("synthetic", help="生成合成验证数据集")
    p_syn.add_argument("--out", default="synthetic_data")
    p_syn.add_argument("--sheets", type=int, default=3)
    p_syn.add_argument("--marks", type=int, default=12)
    p_syn.add_argument("--seed", type=int, default=20261126)
    p_syn.add_argument(
        "--shape",
        choices=["arrow", "cross", "star", "hex", "asym"],
        default="arrow",
        help="asym 为非对称形状，翻面在外观上可区分",
    )
    p_syn.set_defaults(func=cmd_synthetic)

    p_val = sub.add_parser("validate", help="在合成数据集上验证计数与指标")
    p_val.add_argument("dataset")
    p_val.add_argument("--output", default=None)
    _add_search_args(p_val)
    p_val.set_defaults(func=cmd_validate)

    p_gui = sub.add_parser("gui", help="启动图形界面")
    p_gui.add_argument("--image", default=None)
    p_gui.add_argument("--template", default=None)
    p_gui.add_argument("--state", default="markfinder_out/review_state.json")
    p_gui.set_defaults(func=cmd_gui)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
