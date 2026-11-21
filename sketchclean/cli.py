"""命令行入口。

用法：
  python -m sketchclean.cli clean  图1.png 图2.jpg -o out/ [--params params.json]
  python -m sketchclean.cli batch  目录/ -o out/
  python -m sketchclean.cli inspect 图.png [--params params.json]   # 额外导出检查叠加图
  python -m sketchclean.cli samples [目录]
  python -m sketchclean.cli web       # 启动本地网页界面
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import cv2

from .batch import run_batch
from .params import ProcessParams
from .pipeline import overlay_issues, process_file
from .samples import generate as generate_samples


def _load_params(path: str | None) -> ProcessParams:
    if not path:
        return ProcessParams()
    with open(path, encoding="utf-8") as f:
        return ProcessParams.from_dict(json.load(f))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sketchclean",
                                     description="纸面草稿本地清理工具")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def add_params(p):
        p.add_argument("--params", help="参数 JSON（可由网页端导出）")
        p.add_argument("-o", "--outdir", default="cleaned_out", help="输出目录")

    pc = sub.add_parser("clean", help="清理一张或多张图片")
    pc.add_argument("inputs", nargs="+")
    add_params(pc)

    pb = sub.add_parser("batch", help="批量清理（目录或文件列表，逐张容错）")
    pb.add_argument("inputs", nargs="+")
    add_params(pb)

    pi = sub.add_parser("inspect", help="清理并导出问题检查叠加图")
    pi.add_argument("image")
    pi.add_argument("--params", default=None)
    pi.add_argument("-o", "--outdir", default="inspect_out")

    ps = sub.add_parser("samples", help="生成两张程序草稿样图")
    ps.add_argument("outdir", nargs="?", default=None)

    sub.add_parser("web", help="启动本地网页界面")

    args = parser.parse_args(argv)

    if args.cmd in ("clean", "batch"):
        params = _load_params(args.params)
        report = run_batch(args.inputs, args.outdir, params,
                           progress=lambda p, i, n: print(f"[{i}/{n}] {p}"))
        print(f"\n成功 {len(report.succeeded)} 张，失败 {len(report.failed)} 张")
        for item in report.failed:
            print(f"  失败: {item['input']} —— {item['error']}", file=sys.stderr)
        print(f"报告: {os.path.join(args.outdir, 'batch_report.json')}")
        return 1 if report.failed else 0

    if args.cmd == "inspect":
        params = _load_params(args.params)
        os.makedirs(args.outdir, exist_ok=True)
        result, _ = process_file(args.image, params)
        stem = os.path.splitext(os.path.basename(args.image))[0]
        cv2.imwrite(os.path.join(args.outdir, f"{stem}.cleaned.png"),
                    result.cleaned)
        overlay = overlay_issues(result.cleaned, {
            "breaks": result.break_mask,
            "dots": result.small_dot_mask,
            "shadow": result.shadow_mask,
        })
        cv2.imwrite(os.path.join(args.outdir, f"{stem}.inspect.png"), overlay)
        print(f"已导出到 {args.outdir}/")
        return 0

    if args.cmd == "samples":
        outdir = args.outdir or os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples")
        for p in generate_samples(outdir):
            print(p)
        return 0

    if args.cmd == "web":
        from .web.app import main as web_main
        return web_main()

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
