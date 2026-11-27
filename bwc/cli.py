"""命令行入口: 无头自检/处理/导出/回读, GUI 单独由 app.py 提供。

用法:
    python -m bwc selftest                # 无头跑全流程自检并打印报告
    python -m bwc sample --out DIR        # 导出样例灰度图
    python -m bwc process IMG --out DIR   # 命令行跑一遍清理并导出
    python -m bwc check CLEAN.png         # 回读干净图打印统计
    python -m bwc gui [IMG]               # 启动图形界面(默认)
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# 支持 `python -I bwc/cli.py ...` 直跑: 隔离模式下 cwd 和 PYTHONPATH
# 都不进 sys.path, 这里把仓库根目录(本文件的上一级)显式加进去。
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from bwc import export as exp
    from bwc import morphology as morph
    from bwc import render
    from bwc.pipeline import Project, Step, StepKind
    from bwc.sample import make_sample
else:
    from . import export as exp
    from . import morphology as morph
    from . import render
    from .pipeline import Project, Step, StepKind
    from .sample import make_sample

import numpy as np


def _print_stats(v, prefix="") -> None:
    print(f"{prefix}连通块={v.n_components}  孔洞={v.n_holes}  "
          f"墨迹像素={v.ink_pixels}  相对上版变化={v.changed_count}px")
    for st in v.component_stats[1:]:
        print(f"    块 {st['label']:>2}: 面积 {st['area']:>5}px  "
              f"质心=({st['centroid'][0]:.1f},{st['centroid'][1]:.1f})")
    for st in v.hole_stats[1:]:
        print(f"    孔 H{st['hole']}: 面积 {st['area']:>5}px")


def cmd_selftest(args) -> int:
    print("== 1. 生成样例并按阈值二值化 ==")
    gray = make_sample()
    proj = Project(gray, threshold=args.threshold, connectivity=8)
    _print_stats(proj.current, "[8-连通基线] ")

    print("\n== 2. 4/8 连通对角块差异 ==")
    p4 = Project(gray, threshold=args.threshold, connectivity=4)
    p8 = Project(gray, threshold=args.threshold, connectivity=8)
    print(f"[4-连通] 连通块={p4.current.n_components} 孔洞={p4.current.n_holes}")
    print(f"[8-连通] 连通块={p8.current.n_components} 孔洞={p8.current.n_holes}")
    assert p4.current.n_components != p8.current.n_components, \
        "对角块在 4/8 连通下应给出不同块数"

    print("\n== 3. 两种处理顺序对照(顺序敏感结构: 1px 缝隙旁的 9px 孤岛) ==")
    order_a = [Step(StepKind.REMOVE_SMALL, min_size=20),
               Step(StepKind.CLOSING, radius=1)]
    order_b = [Step(StepKind.CLOSING, radius=1),
               Step(StepKind.REMOVE_SMALL, min_size=20)]
    results = {}
    for name, steps in (("先删孤岛", order_a), ("先补短缝", order_b)):
        p = Project(gray, threshold=args.threshold, connectivity=8)
        for s in steps:
            p.add_step(s)
        results[name] = p.current
        _print_stats(p.current, f"[{name}] ")
    # 先补短缝把 9px 孤岛并进了主块, 墨迹像素必然更多
    assert results["先补短缝"].ink_pixels > results["先删孤岛"].ink_pixels, \
        "先补短缝应保住被并的孤岛, 墨迹像素更多"
    print("   顺序差异 ✓: 先补短缝比先删孤岛 "
          f"+{results['先补短缝'].ink_pixels - results['先删孤岛'].ink_pixels}px 墨迹"
          "(孤岛被并进主块, 删不掉了)")

    print("\n== 4. 约束: 禁并 + 保留孔, 并制造违规 ==")
    p = Project(gray, threshold=args.threshold, connectivity=4)
    base_labels = p.current.labels
    # 对角相接的两个方块在样例中心 (140,60) 附近, 4-连通下是两个块
    lab_a = int(base_labels[135, 55])
    lab_b = int(base_labels[146, 66])
    assert lab_a and lab_b and lab_a != lab_b, (lab_a, lab_b)
    p.add_no_merge(lab_a, lab_b)
    print(f"   禁并: 块 {lab_a} 与块 {lab_b}")
    # 保留主块 A 内的纯白孔 (42,42)-(62,62), 框内全是背景
    p.add_preserve_hole((43, 43, 61, 61))
    print("   保留孔框: (43,43)-(61,61)")
    assert not p.violations_at(), "基线下不应有违规"
    # 大半径闭运算大概率填掉孔并合并块 -> 应报违规
    p.add_step(Step(StepKind.CLOSING, radius=8))
    violations = p.violations_at()
    for v in violations:
        print(f"   违规[{v.kind}]: {v.detail} 定位点={v.locations[:3]}")
    assert violations, "大半径闭运算应破坏至少一条约束"

    print("\n== 5. 撤回后统计回到旧版本 ==")
    base_count = p.versions[0].n_components
    base_ink = p.versions[0].ink_pixels
    p.rollback(0)
    assert p.current.n_components == base_count
    assert p.current.ink_pixels == base_ink
    assert not p.violations_at(), "撤回到基线(闭运算之前)应无违规"
    print(f"   已撤回到版本0(基线), 连通块={p.current.n_components}, "
          f"墨迹={p.current.ink_pixels}, 无违规 ✓")
    # 在旧版本上重新加步骤, 历史从该点截断重建
    p.add_step(Step(StepKind.OPENING, radius=1))
    assert len(p.versions) == 2, "撤回后加新步骤应截断旧未来"
    print(f"   旧版本上调参重建 ✓, 当前版本数={len(p.versions)}")

    print("\n== 6. 导出 + 回读一致性 ==")
    out = args.out or os.path.join(os.getcwd(), "bwc_output")
    os.makedirs(out, exist_ok=True)
    # 重新建一个完整流程用于导出
    pe = Project(gray, threshold=args.threshold, connectivity=8)
    for s in order_a:
        pe.add_step(s)
    base = os.path.join(out, "selftest")
    paths = exp.export_all(pe, base)
    for k, vpath in paths.items():
        print(f"   导出 {k}: {vpath}")
    report = exp.verify_roundtrip(pe, paths["clean"])
    print("   回读校验:", "通过 ✓" if report["ok"] else "失败")
    for mm in report["mismatches"]:
        print("    -", mm)
    assert report["ok"]

    # 三联图和编号图也存一份便于肉眼检查
    render.save_image(
        render.render_triple(pe.gray, pe.base.mask, pe.current.mask),
        os.path.join(out, "selftest_triple.png"))
    render.save_image(
        render.render_labels(pe.current.mask, pe.current.labels,
                             pe.current.n_components, pe.current.component_stats,
                             pe.current.hole_labels, pe.current.hole_stats),
        os.path.join(out, "selftest_labels.png"))
    print(f"\n全部自检通过。可视化结果在 {out}/")
    return 0


def cmd_sample(args) -> int:
    gray = make_sample(seed=args.seed)
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "sample_gray.png")
    render.save_image(render.gray_to_image(gray), path)
    print(f"样例灰度图: {path}  尺寸={gray.shape}")
    return 0


def cmd_process(args) -> int:
    gray = render.load_gray(args.image)
    proj = Project(gray, threshold=args.threshold, connectivity=args.connectivity)
    # 步骤语法: opening:2 closing:1 remove_small:30
    for raw in args.steps:
        kind, _, param = raw.partition(":")
        param = int(param) if param else 1
        if kind == "opening":
            proj.add_step(Step(StepKind.OPENING, radius=param))
        elif kind == "closing":
            proj.add_step(Step(StepKind.CLOSING, radius=param))
        elif kind == "remove_small":
            proj.add_step(Step(StepKind.REMOVE_SMALL, min_size=param))
        else:
            print(f"未知步骤 {kind}", file=sys.stderr)
            return 2
    _print_stats(proj.current, "[处理后] ")
    os.makedirs(args.out, exist_ok=True)
    base = os.path.join(args.out, os.path.splitext(os.path.basename(args.image))[0])
    paths = exp.export_all(proj, base)
    render.save_image(
        render.render_triple(proj.gray, proj.base.mask, proj.current.mask),
        base + "_triple.png")
    report = exp.verify_roundtrip(proj, paths["clean"])
    print("回读校验:", "通过 ✓" if report["ok"] else "失败 " + str(report["mismatches"]))
    print("导出:", json.dumps(paths, ensure_ascii=False))
    return 0 if report["ok"] else 1


def cmd_check(args) -> int:
    rb = exp.readback_clean(args.image, args.connectivity)
    print(f"文件={args.image} 连通性={args.connectivity}")
    print(f"连通块={rb['n_components']} 孔洞={rb['n_holes']} "
          f"墨迹像素={rb['ink_pixels']}")
    for st in rb["component_stats"][1:]:
        print(f"  块 {st['label']}: {st['area']}px")
    return 0


def cmd_gui(args) -> int:
    from .app import run_gui
    return run_gui(args.image)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="bwc", description="黑白图清理对照工具")
    sub = p.add_subparsers(dest="cmd")

    sp = sub.add_parser("selftest", help="无头全流程自检")
    sp.add_argument("--threshold", type=int, default=128)
    sp.add_argument("--out", default=None)
    sp.set_defaults(func=cmd_selftest)

    sp = sub.add_parser("sample", help="生成样例灰度图")
    sp.add_argument("--out", default="bwc_output")
    sp.add_argument("--seed", type=int, default=7)
    sp.set_defaults(func=cmd_sample)

    sp = sub.add_parser("process", help="命令行清理一张图")
    sp.add_argument("image")
    sp.add_argument("--threshold", type=int, default=128)
    sp.add_argument("--connectivity", type=int, choices=[4, 8], default=8)
    sp.add_argument("--steps", nargs="+",
                    default=["opening:1", "closing:1", "remove_small:20"])
    sp.add_argument("--out", default="bwc_output")
    sp.set_defaults(func=cmd_process)

    sp = sub.add_parser("check", help="回读干净图并打印统计")
    sp.add_argument("image")
    sp.add_argument("--connectivity", type=int, choices=[4, 8], default=8)
    sp.set_defaults(func=cmd_check)

    sp = sub.add_parser("gui", help="启动图形界面")
    sp.add_argument("image", nargs="?", default=None)
    sp.set_defaults(func=cmd_gui)

    p.set_defaults(func=cmd_gui)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
