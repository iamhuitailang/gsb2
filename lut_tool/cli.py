"""命令行入口：在没有显示器的环境下也能完成全部检查。

子命令
------
``info``      查看 .cube 表信息与输入适用范围（含错误行定位）
``check``     表体诊断（单调性/突变/串换/输出越界）
``testclip``  生成测试片并导出，同时输出编码往返报告
``probe``     对指定像素或标准测试色查入表/出表数值
``compare``   两张表按给定顺序应用到测试片，导出三联对照短片
``config``    保存/查看两套比较配置
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# 允许在未安装包的情况下，以 `python -I -m lut_tool.cli` 从仓库根运行。
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

from .analysis import analyze_clip_frame, analyze_lut_shape
from .config import (
    CompareConfig,
    ConfigStore,
    SLOT_NAMES,
    load_configs,
    save_configs,
)
from .cube import CubeParseError, parse_cube, write_cube
from .lut import apply_chain, diff_heatmap, diff_stats
from .patterns import SKIN_TONES, TestClipSpec, render_clip
from .video import VideoWriter, export_and_verify, rgb_float_to_bgr


def _open(path: str):
    try:
        return parse_cube(path)
    except CubeParseError as exc:
        print(f"[解析失败] {exc}", file=sys.stderr)
        sys.exit(2)


def _fmt_vec(v: np.ndarray) -> str:
    return " ".join(f"{x:.6f}" for x in np.asarray(v).reshape(-1))


def cmd_info(args) -> None:
    lut = _open(args.cube)
    print(lut.describe())
    lo, hi = lut.output_range()
    print(f"表内输出范围: [{_fmt_vec(lo)}] ~ [{_fmt_vec(hi)}]")
    print(f"数据形状: {lut.table.shape}")
    if lut.title:
        print(f"标题: {lut.title}")


def cmd_check(args) -> None:
    lut = _open(args.cube)
    rep = analyze_lut_shape(lut)
    print(f"== 表体诊断: {lut.describe()} ==")
    if rep["monotonic_violations"]:
        for ch, pos, val in rep["monotonic_violations"]:
            print(f"[问题] 通道 {'RGB'[ch]} 在采样点 {pos} 单调下降，步长 {val:.6f}")
    else:
        print("[OK] 各通道单调")
    if rep["spike_channels"]:
        for r in rep["spike_channels"]:
            print(
                f"[问题] 通道 {'RGB'[r.channel]} 存在 {len(r.spikes)} 处突变，"
                f"最大跳变 {r.max_jump:.6f}（位置 {r.max_jump_at}，"
                f"中位步长 {r.mean_step:.6f}）"
            )
    else:
        print("[OK] 未发现颜色突变")
    for c in rep["cross_reports"]:
        if c.swapped_with is not None:
            print(
                f"[问题] 通道 {'RGB'[c.driven_channel]} -> "
                f"{'RGB'[c.swapped_with]} 疑似整体互换（相关 {c.correlation[c.swapped_with]:.3f}）"
            )
        else:
            leaks = [v for v in c.leakage.values() if v >= 1e-4]
            if leaks:
                detail = ", ".join(
                    f"{'RGB'[k]} 泄漏 {v:.6f}" for k, v in c.leakage.items()
                )
                print(f"[注意] 驱动 {'RGB'[c.driven_channel]} 时 {detail}")
    if not any(not c.clean for c in rep["cross_reports"]):
        print("[OK] 未发现通道串换")
    print(
        f"输出抽样范围: [{_fmt_vec(rep['output_min'])}] ~ "
        f"[{_fmt_vec(rep['output_max'])}]，钳位占比 "
        f"{rep['output_clipped_ratio'] * 100:.2f}%"
    )


def cmd_testclip(args) -> None:
    spec = TestClipSpec(fps=args.fps, frames=args.frames)
    clip = render_clip(spec)
    print(f"已生成测试片: {clip.shape[0]} 帧 {spec.width}x{spec.height} @ {spec.fps}fps")

    frame_report = analyze_clip_frame(clip[0], spec)
    print("源片自检:")
    print("  平滑区突变:", "无" if not frame_report["has_discontinuity"] else "有")
    print("  通道串换:", "无" if not frame_report["has_crosstalk"] else "有")

    path, report = export_and_verify(clip, args.output, spec.fps, args.codec)
    print(f"已写出: {path}")
    print(report.summary())
    if args.json:
        def to_native(obj):
            if isinstance(obj, np.ndarray):
                return obj.tolist()
            if isinstance(obj, (np.floating, np.integer)):
                return obj.item()
            raise TypeError(f"不可序列化的类型: {type(obj)!r}")

        payload = {
            "file": path,
            "quant": report.quant_error,
            "codec": report.codec_error,
            "total": report.total_error,
            "visible_frames": report.visible_frames,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2, default=to_native))


def cmd_probe(args) -> None:
    lut = _open(args.cube) if args.cube else None
    if args.point:
        pts = [np.array([args.point], dtype=np.float64)]
    else:
        # 默认探针：中性灰 + 肤色 + 边界高饱和。
        grays = [np.array([v, v, v]) for v in (0.0, 0.18, 0.5, 0.9, 1.0)]
        pts = grays + [t.copy() for t in SKIN_TONES]

    from .lut import apply_lut

    print(f"{'入表 RGB':>26} | {'出表 RGB':>26} | 状态")
    for p in pts:
        probe_in = p.reshape(1, 3)
        if lut is None:
            out = p.copy()
            status = "直通"
        else:
            in_domain = bool(lut.is_in_domain(probe_in)[0])
            out = apply_lut(lut, probe_in)[0]
            clip = np.any(out < 0) or np.any(out > 1)
            if not in_domain:
                status = "超出适用范围"
            elif clip:
                status = "输出钳位"
            else:
                status = "范围内"
        print(f"{_fmt_vec(p):>26} | {_fmt_vec(out):>26} | {status}")


def cmd_compare(args) -> None:
    first = _open(args.first) if args.first else None
    second = _open(args.second) if args.second else None
    if args.swap:
        first, second = second, first
    spec = TestClipSpec(fps=args.fps, frames=args.frames)
    clip = render_clip(spec)

    processed, heats = [], []
    oor_total = clip_total = 0
    for i in range(clip.shape[0]):
        chain = apply_chain(clip[i], first, second)
        processed.append(chain.out)
        heats.append(diff_heatmap(clip[i], chain.out))
        oor_total += int(chain.oor_mask.sum())
        clip_total += int(chain.clip_mask.sum())
    processed = np.stack(processed)
    heats = np.stack(heats)

    stats = diff_stats(clip, processed)
    print(f"顺序: {'B->A' if args.swap else 'A->B'}")
    print(
        f"均值差 {stats['mean_abs']:.6f}，最大差 {stats['max_abs']:.6f}，"
        f"越界像素(累计) {oor_total}，钳位像素(累计) {clip_total}"
    )

    # 三联横向拼接导出：原片 | 套表 | 差值。
    h = spec.height
    tri = np.concatenate([clip, processed, heats], axis=2)
    with VideoWriter(args.output, spec.fps, (tri.shape[2], h), args.codec) as vw:
        for frame in tri:
            vw.write(frame)
    print(f"三联对照短片已写出: {vw.path}")


def cmd_config(args) -> None:
    if args.action == "save":
        try:
            store = load_configs(args.file)
        except (OSError, ValueError):
            store = ConfigStore.empty()
        if args.slot not in SLOT_NAMES:
            print(f"槽位必须是 {SLOT_NAMES}", file=sys.stderr)
            sys.exit(2)
        store.slots[args.slot] = CompareConfig(
            name=args.slot,
            first_path=args.first or "",
            second_path=args.second or "",
            swapped=bool(args.swap),
        )
        path = save_configs(store, args.file)
        print(f"已保存槽 {args.slot} -> {path}")
    else:
        store = load_configs(args.file)
        for name in SLOT_NAMES:
            cfg = store.slots[name]
            print(
                f"槽 {name}: first={cfg.first_path or '-'} "
                f"second={cfg.second_path or '-'} swapped={cfg.swapped}"
            )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="lut-tool", description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("info", help="查看表信息与适用范围")
    sp.add_argument("cube")
    sp.set_defaults(func=cmd_info)

    sp = sub.add_parser("check", help="表体诊断")
    sp.add_argument("cube")
    sp.set_defaults(func=cmd_check)

    sp = sub.add_parser("testclip", help="生成测试片并检查编码往返")
    sp.add_argument("output")
    sp.add_argument("--codec", default="mp4v", choices=list(("mp4v", "avc1", "FFV1")))
    sp.add_argument("--fps", type=float, default=30.0)
    sp.add_argument("--frames", type=int, default=48)
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_testclip)

    sp = sub.add_parser("probe", help="探针查入表/出表数值")
    sp.add_argument("cube", nargs="?")
    sp.add_argument("--point", nargs=3, type=float, metavar=("R", "G", "B"))
    sp.set_defaults(func=cmd_probe)

    sp = sub.add_parser("compare", help="双表应用并导出三联对照短片")
    sp.add_argument("output")
    sp.add_argument("--first", help="第一级 .cube（空=直通）")
    sp.add_argument("--second", help="第二级 .cube（空=直通）")
    sp.add_argument("--swap", action="store_true", help="交换顺序 B->A")
    sp.add_argument("--codec", default="mp4v")
    sp.add_argument("--fps", type=float, default=30.0)
    sp.add_argument("--frames", type=int, default=48)
    sp.set_defaults(func=cmd_compare)

    sp = sub.add_parser("config", help="保存/查看比较配置")
    sp.add_argument("action", choices=("save", "show"))
    sp.add_argument("--slot", default="A")
    sp.add_argument("--first")
    sp.add_argument("--second")
    sp.add_argument("--swap", action="store_true")
    sp.add_argument("--file", help="配置文件路径（默认用户配置目录）")
    sp.set_defaults(func=cmd_config)
    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
