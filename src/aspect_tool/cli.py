"""命令行入口。

子命令:
  diagnose   读取存储/显示宽高与旋转, 输出原始像素 vs 显示方向预览
  normalize  落实显示方向 / 方形像素, 支持 fit(保留全画面) 与 crop(裁切)
  verify     对导出文件单独复检 (旋转残留/比例/有效画面/声画时长)
  compare    同一时间点逐帧比较输入与输出
  fixtures   生成自带旋转素材与拉伸测试图素材
  map        查询存储平面标记点在输出中的坐标
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import fixtures as fixtures_mod
from . import ffmpeg
from .ffmpeg import FFmpegError
from .compare import compare_montage, compare_sampled
from .geometry import (
    GeometryPipeline, default_target, plan_output,
)
from .normalize import (
    AmbiguousRotationError, NormalizeRequest, run_normalize,
)
from .preview import diagnose_preview, measure_circularity
from .probe import ProbeError, probe


def _parse_target(text: str) -> tuple[int, int]:
    w, h = text.lower().split("x")
    return int(w), int(h)


def _parse_points(text: str) -> list[tuple[float, float]]:
    pts = []
    for item in text.split(";"):
        item = item.strip()
        if not item:
            continue
        x, y = item.split(",")
        pts.append((float(x), float(y)))
    return pts


def cmd_probe(args) -> int:
    info = probe(args.input)
    print(info.summary())
    if args.json:
        print(json.dumps({
            "stored": [info.stored_width, info.stored_height],
            "display": [info.display_width, info.display_height],
            "sar": str(info.sar), "dar": str(info.dar),
            "rotation_ccw": info.rotation_ccw,
            "cw_deg": info.display.cw_deg, "flip": info.display.flip,
            "ambiguous": info.ambiguous,
            "ambiguity_reasons": info.ambiguity_reasons,
            "duration_sec": info.duration_sec,
            "has_audio": info.has_audio,
        }, ensure_ascii=False, indent=2))
    return 0


def cmd_diagnose(args) -> int:
    info = probe(args.input)
    print(info.summary())
    if info.ambiguous:
        print("\n⚠ 该素材方向无法确定, 已在预览中标注; 转换时需用 --rotation 确认。")
    pipe = None
    points = _parse_points(args.points) if args.points else None
    if args.target or args.mode:
        ow, oh = _parse_target(args.target) if args.target else default_target(
            info.display)
        plan = plan_output(info.display, ow, oh, args.mode)
        pipe = GeometryPipeline(info.display, plan)
    res = diagnose_preview(args.input, args.out_dir, args.at,
                           pipe=pipe, points_s=points)
    print("\n预览图:")
    for k, v in res.items():
        print(f"  {k:8s} {v}")
    return 0


def cmd_normalize(args) -> int:
    points = _parse_points(args.points) if args.points else []
    req = NormalizeRequest(
        input_path=args.input,
        output_path=args.output,
        mode=args.mode,
        target=_parse_target(args.target) if args.target else None,
        bake_rotation=not args.no_bake_rotation,
        square_pixels=True,
        rotation_override=args.rotation,
        flip_override=args.flip,
        keep_audio=not args.drop_audio,
        marker_points=points,
    )
    try:
        result = run_normalize(req)
    except AmbiguousRotationError as e:
        print("错误: " + str(e), file=sys.stderr)
        return 2

    print("=== 输入 ===")
    print(result.info.summary())
    print("\n=== 转换规划 ===")
    print(f"模式: {result.pipeline.plan.mode}  "
          f"输出: {result.pipeline.plan.ow}x{result.pipeline.plan.oh}")
    print(f"滤镜链: {result.filter_chain}")
    if points:
        print("\n标记点映射 (存储 -> 显示 -> 输出):")
        for i, mp in enumerate(result.mapped_points):
            tag = "不可见(裁掉)" if not mp.visible else (
                "黑边区" if mp.in_black_border else "可见")
            print(f"  P{i}: S({mp.sx:.1f},{mp.sy:.1f}) -> "
                  f"D({mp.dx:.1f},{mp.dy:.1f}) -> "
                  f"O({mp.ox:.1f},{mp.oy:.1f}) [{tag}] {mp.note}")

    print("\n=== 导出复检 ===")
    v = result.verification
    for item in v["items"]:
        mark = "✓" if item["ok"] else "✗"
        print(f"  {mark} {item['name']}: {item['detail']}")
    print(f"\n总体: {'全部通过' if v['ok'] else '存在失败项, 见上'}")
    print(f"输出文件: {args.output}")

    # 生成同时间点对比与圆度
    if args.preview_dir:
        montage = compare_montage(args.input, args.output,
                                  args.frame, args.preview_dir,
                                  str(Path(args.preview_dir) / "compare.png"))
        print(f"逐帧对比: {montage}")
        out_png = str(Path(args.preview_dir) / "out_circle.png")
        ffmpeg.frame_at_index(args.output, args.frame, out_png, autorotate=True)
        circ = measure_circularity(out_png)
        if circ["found"]:
            print(f"圆度(轴比, 1=正圆): {circ['axis_ratio']:.3f}")
    return 0 if v["ok"] else 1


def cmd_verify(args) -> int:
    info = probe(args.input)
    print(info.summary())
    ok = True
    has_rot = (info.rotation_ccw is not None and abs(info.rotation_ccw) > 1e-6)
    has_matrix = info.matrix3x3 is not None and any(
        abs(x) > 1e-6 for x in info.matrix3x3[:4])
    print("\n旋转残留: ", "无" if not (has_rot or has_matrix) else "有!")
    print("方形像素: " + ("是" if info.sar == 1 else f"否 (SAR={info.sar})"))
    if has_rot or has_matrix or info.sar != 1:
        ok = False
    print("结论: " + ("播放器不会再多转, 比例正常" if ok else "需要处理"))
    return 0 if ok else 1


def cmd_compare(args) -> int:
    if args.montage:
        p = compare_montage(args.input, args.output, args.frame,
                            args.work_dir, args.montage)
        print("拼图:", p)
    diffs = compare_sampled(args.input, args.output, args.work_dir,
                            samples=args.samples)
    print(f"{'帧':>4} {'时间s':>7} {'平均差':>8} {'最大差':>7} "
          f"{'非黑占比in':>11} {'非黑占比out':>12}")
    for d in diffs:
        print(f"{d.index:>4} {d.time_sec:>7.3f} {d.mean_abs_diff:>8.2f} "
              f"{d.max_diff:>7d} {d.nonblack_ratio_in:>11.3f} "
              f"{d.nonblack_ratio_out:>12.3f}")
    return 0


def cmd_fixtures(args) -> int:
    res = fixtures_mod.generate(args.out_dir, n_frames=args.frames)
    print("已生成测试素材:")
    for k, v in res.items():
        print(f"  {k:11s} {v}")
        print("    " + probe(v).summary().replace("\n", "\n    "))
    return 0


def cmd_map(args) -> int:
    info = probe(args.input)
    ow, oh = args.target or default_target(info.display)
    plan = plan_output(info.display, ow, oh, args.mode)
    pipe = GeometryPipeline(info.display, plan)
    for x, y in _parse_points(args.points):
        mp = pipe.map_point_s_to_o(x, y)
        back = pipe.map_point_o_to_s(mp.ox, mp.oy)
        print(f"S({x},{y}) -> D({mp.dx:.2f},{mp.dy:.2f}) -> "
              f"O({mp.ox:.2f},{mp.oy:.2f}) | 反查 S({back[0]:.2f},{back[1]:.2f})")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="aspect-tool",
        description="本地视频画幅诊断与规范化工具 (旋转 / 非方形像素 / fit / crop)",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("probe", help="只读取并打印存储/显示宽高与旋转")
    sp.add_argument("input"); sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_probe)

    sp = sub.add_parser("diagnose", help="原始像素 vs 显示方向预览")
    sp.add_argument("input")
    sp.add_argument("--out-dir", default="workdir/diagnose")
    sp.add_argument("--at", type=float, default=0.0, help="时间点(秒)")
    sp.add_argument("--mode", choices=["fit", "crop"], default="fit")
    sp.add_argument("--target", help="目标画幅, 如 720x1280")
    sp.add_argument("--points", help="存储平面标记点 x,y;x,y")
    sp.set_defaults(func=cmd_diagnose)

    sp = sub.add_parser("normalize", help="落实方向/方形像素并导出复检")
    sp.add_argument("input"); sp.add_argument("output")
    sp.add_argument("--mode", choices=["fit", "crop"], default="fit")
    sp.add_argument("--target", help="目标画幅, 如 720x1280")
    sp.add_argument("--rotation", type=int, choices=[0, 90, 180, 270],
                    help="方向无法确定时, 用户确认的顺时针角度")
    sp.add_argument("--flip", action="store_true", help="确认需要水平镜像")
    sp.add_argument("--no-bake-rotation", action="store_true",
                    help="不落实旋转, 仅做像素方形化")
    sp.add_argument("--drop-audio", action="store_true")
    sp.add_argument("--points", help="存储平面标记点 x,y;x,y")
    sp.add_argument("--preview-dir", default="workdir/normalize")
    sp.add_argument("--frame", type=int, default=0, help="对比/圆度所用帧号")
    sp.set_defaults(func=cmd_normalize)

    sp = sub.add_parser("verify", help="单独复检一个文件的旋转/比例")
    sp.add_argument("input"); sp.set_defaults(func=cmd_verify)

    sp = sub.add_parser("compare", help="同时间点逐帧比较输入输出")
    sp.add_argument("input"); sp.add_argument("output")
    sp.add_argument("--work-dir", default="workdir/compare")
    sp.add_argument("--samples", type=int, default=5)
    sp.add_argument("--frame", type=int, default=0)
    sp.add_argument("--montage", help="可选: 输出该帧拼图路径")
    sp.set_defaults(func=cmd_compare)

    sp = sub.add_parser("fixtures", help="生成自带测试素材")
    sp.add_argument("--out-dir", default="workdir/samples")
    sp.add_argument("--frames", type=int, default=25)
    sp.set_defaults(func=cmd_fixtures)

    sp = sub.add_parser("map", help="标记点坐标映射查询")
    sp.add_argument("input")
    sp.add_argument("points", help="x,y;x,y")
    sp.add_argument("--mode", choices=["fit", "crop"], default="fit")
    sp.add_argument("--target", type=_parse_target)
    sp.set_defaults(func=cmd_map)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ProbeError as e:
        print(f"探测失败: {e}", file=sys.stderr)
        return 3
    except FFmpegError as e:
        print(f"ffmpeg 执行失败: {e}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
