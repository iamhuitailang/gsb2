"""mp4rescue 命令行入口。

子命令:
  generate   生成标准片与全部中断/异常样例
  scan       只扫描,打印分段/轨道/断点报告,不导出
  rescue     扫描并抢救导出,支持一次传入多个文件或目录
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import generator
from .rescue import STATUS_CN, build_text_report, rescue_batch
from .scanner import scan

SAMPLE_SUFFIXES = {".mp4", ".m4v", ".mov", ".bin", ".fmp4"}


def _collect_inputs(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            files.extend(
                sorted(child for child in p.rglob("*") if child.is_file() and child.suffix.lower() in SAMPLE_SUFFIXES)
            )
        elif p.is_file():
            files.append(p)
        else:
            print(f"[警告] 路径不存在,跳过: {raw}", file=sys.stderr)
    # 去重保持顺序
    seen: set[Path] = set()
    unique = []
    for f in files:
        if f not in seen:
            seen.add(f)
            unique.append(f)
    return unique


def cmd_generate(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir)
    print(f"[1/2] 渲染 {generator.DURATION_SECONDS}s 标准片(画面帧号 + 每秒蜂鸣)...")
    outputs = generator.generate_all(out_dir)
    print(f"[2/2] 已在 {out_dir} 生成 {len(outputs)} 个样例:")
    for name in sorted(outputs):
        size = outputs[name].stat().st_size
        print(f"  - {name:<16} {size:>9} 字节")
    return 0


def cmd_scan(args: argparse.Namespace) -> int:
    files = _collect_inputs(args.paths)
    if not files:
        print("没有可扫描的文件。", file=sys.stderr)
        return 2
    rc = 0
    for f in files:
        try:
            data = f.read_bytes()
            result = scan(data, str(f))
        except OSError as exc:
            print(f"[读取失败] {f}: {exc}", file=sys.stderr)
            rc = 1
            continue
        print(build_text_report(result))
        if not result.readable:
            rc = 1
    return rc


def cmd_rescue(args: argparse.Namespace) -> int:
    files = _collect_inputs(args.paths)
    if not files:
        print("没有可抢救的文件。", file=sys.stderr)
        return 2
    out_dir = Path(args.out_dir)
    outcomes = rescue_batch(files, out_dir, do_verify=not args.no_verify)

    print("=" * 72)
    print("批量抢救汇总")
    print("=" * 72)
    failed = 0
    for outcome in outcomes:
        name = Path(outcome.source).name
        if not outcome.accepted:
            failed += 1
            print(f"[拒绝] {name}: {outcome.reject_reason}")
            continue
        flag = "解码通过" if outcome.decode_ok else "解码有告警"
        print(
            f"[完成] {name}: 导出 {Path(outcome.rescued_mp4).name}, "
            f"视频前缀 {outcome.video_seconds_prefix:.3f}s, "
            f"音频前缀 {outcome.audio_seconds_prefix:.3f}s, {flag}"
        )
        if outcome.audio_stop_note:
            print(f"       {outcome.audio_stop_note}")
        print(f"       报告: {Path(outcome.report_txt).name} / {Path(outcome.report_json).name}")
    print("-" * 72)
    print(f"共 {len(outcomes)} 份: 成功 {len(outcomes) - failed}, 拒绝 {failed}。输出目录: {out_dir}")
    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m mp4rescue",
        description="分段 MP4 崩溃录像抢救工具(仅处理本工具生成的 fMP4 样例)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_gen = sub.add_parser("generate", help="生成标准片与中断/异常样例")
    p_gen.add_argument("-o", "--out-dir", default="samples", help="样例输出目录(默认 samples)")
    p_gen.set_defaults(func=cmd_generate)

    p_scan = sub.add_parser("scan", help="只扫描出报告,不导出")
    p_scan.add_argument("paths", nargs="+", help="一个或多个 MP4 文件/目录")
    p_scan.set_defaults(func=cmd_scan)

    p_res = sub.add_parser("rescue", help="扫描并抢救导出")
    p_res.add_argument("paths", nargs="+", help="一个或多个 MP4 文件/目录")
    p_res.add_argument("-o", "--out-dir", default="rescued", help="抢救输出目录(默认 rescued)")
    p_res.add_argument("--no-verify", action="store_true", help="跳过 ffmpeg 全量解码校验")
    p_res.set_defaults(func=cmd_rescue)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
