"""命令行入口：生成样例、查看布局信息、导出 PNG、校验导出。"""
from __future__ import annotations

import argparse
import json
import sys

from . import __version__
from .model import FrameParams
from .layout import planes_of, frame_size, trace_pixel, describe_location
from .rawio import RawFile
from .samples import generate_all
from .config import export_png_sequence, verify_export, load_config


def _params_from_args(a) -> FrameParams:
    return FrameParams(
        width=a.width, height=a.height, fmt=a.fmt,
        stride_y=a.stride_y or 0, stride_uv=a.stride_uv or 0,
        color_range=a.range)


def cmd_generate(a) -> int:
    specs = generate_all(a.out_dir)
    print(f"已在 {a.out_dir} 生成 {len(specs)} 个样例：")
    for s in specs:
        print(f"  {s.filename:32s} {s.description}")
    return 0


def cmd_info(a) -> int:
    p = _params_from_args(a)
    with RawFile(a.file, p) as rf:
        scan = rf.scan
        print(f"文件: {a.file}  大小: {scan.file_size} 字节")
        print(f"解释: {p.width}x{p.height} {p.fmt} "
              f"stride_y={p.resolved_strides()[0]} "
              f"stride_uv={p.resolved_strides()[1]} range={p.color_range}")
        print(f"单帧大小: {scan.frame_size} 字节，平面布局：")
        for g in planes_of(p):
            print(f"  平面 {g.name:4s} 起点偏移 {g.offset:6d}  "
                  f"{g.cols}x{g.rows}  bpp={g.bpp}  stride={g.stride}  "
                  f"行尾填充 {g.row_padding} 字节  大小 {g.size}")
        print(f"可安全读取的完整帧数: {scan.safe_frame_count}")
        print(f"剩余字节: {scan.leftover}")
        if scan.partial:
            pa = scan.partial
            print(f"截断帧 #{pa.index}: 仅有 {pa.present_bytes}/"
                  f"{scan.frame_size} 字节")
            print(f"  首个缺失位置: 绝对偏移 {pa.first_missing_abs} "
                  f"({pa.location})")
            print(f"  缺失是否全为行尾填充: {pa.image_valid_complete}")
        if a.pixel:
            x, y = a.pixel
            print(f"像素 ({x},{y}) 的字节来源：")
            for tr in rf.read_trace(0, trace_pixel(p, x, y)):
                e = tr["entry"]
                vals = tr["values"]
                print(f"  {e.label:8s} 帧内偏移 {e.frame_rel_offset:6d} "
                      f"绝对偏移 {tr['abs_offset']:6d} 值={vals} "
                      f"({describe_location(p, e.frame_rel_offset)})")
                if e.coverage:
                    print(f"           色度覆盖亮度矩形 {e.coverage}")
    return 0


def cmd_export(a) -> int:
    p = _params_from_args(a)
    with RawFile(a.file, p) as rf:
        count = rf.scan.complete_frames
    indices = list(range(count)) if a.frames == "all" else [
        int(x) for x in a.frames.split(",") if x != ""]
    res = export_png_sequence(a.file, p, a.out_dir, indices, tag=a.tag)
    print(f"导出 {len(res.png_files)} 张 PNG 到 {res.out_dir}")
    print(f"配置: {res.config_path}")
    print(f"源文件 SHA256: {res.source_sha256}")
    return 0


def cmd_verify(a) -> int:
    r = verify_export(a.config)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if r["ok"] else 1


def cmd_show_config(a) -> int:
    cfg = load_config(a.config)
    cfg["params"] = cfg["params"].to_dict()
    print(json.dumps(cfg, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rawframe",
        description="原始视频帧布局检查工具（i420/nv12/rgba）")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="生成内置演示样例")
    g.add_argument("out_dir")
    g.set_defaults(func=cmd_generate)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("file")
    common.add_argument("--width", type=int, required=True)
    common.add_argument("--height", type=int, required=True)
    common.add_argument("--fmt", choices=("i420", "nv12", "rgba"),
                        default="i420")
    common.add_argument("--stride-y", type=int, default=0)
    common.add_argument("--stride-uv", type=int, default=0)
    common.add_argument("--range", choices=("limited", "full"),
                        default="limited")

    i = sub.add_parser("info", parents=[common],
                       help="打印平面起点、完整帧数、缺数据位置")
    i.add_argument("--pixel", type=int, nargs=2, metavar=("X", "Y"),
                   help="额外打印该像素的字节溯源")
    i.set_defaults(func=cmd_info)

    e = sub.add_parser("export", parents=[common], help="导出 PNG 序列+配置")
    e.add_argument("out_dir")
    e.add_argument("--frames", default="all",
                   help="'all' 或逗号分隔的帧索引，如 0,2,5")
    e.add_argument("--tag", default="")
    e.set_defaults(func=cmd_export)

    v = sub.add_parser("verify", help="按导出配置回读并逐像素校验")
    v.add_argument("config")
    v.set_defaults(func=cmd_verify)

    c = sub.add_parser("show-config", help="查看配置文件内容")
    c.add_argument("config")
    c.set_defaults(func=cmd_show_config)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
