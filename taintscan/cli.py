"""Command line interface for taintscan."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional, Sequence

from . import BASELINE_VERSION, __version__
from .analyzer import Scanner
from .baseline import Baseline, BaselineError, compare
from .reporter import render_json, render_text
from .rules import Severity

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_USAGE = 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="taintscan",
        description=(
            "离线 Python 源码污点检查：追踪用户输入经过项目内函数传递后"
            "进入命令执行、SQL、动态代码、反序列化和文件路径等危险操作。"
            "扫描过程只解析源码，不执行被检查的代码，也不访问网络。"
        ),
    )
    parser.add_argument(
        "path",
        nargs="?",
        default=".",
        help="要扫描的目录（或单个 .py 文件），默认当前目录",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="PATH",
        help="额外排除的路径/通配符/目录名，可重复使用",
    )
    parser.add_argument(
        "--json",
        dest="json_path",
        metavar="FILE",
        help="把机器可读报告写入 FILE（'-' 表示标准输出）",
    )
    parser.add_argument(
        "--baseline",
        metavar="FILE",
        help="读取已有基线，标记 new/existing/resolved",
    )
    parser.add_argument(
        "--save-baseline",
        metavar="FILE",
        help="把本次结果保存为基线",
    )
    parser.add_argument(
        "--fail-on",
        choices=[severity.name.lower() for severity in Severity],
        default=None,
        help="存在不低于该严重程度的问题时以退出码 1 结束",
    )
    parser.add_argument(
        "--only-new",
        action="store_true",
        help="配合 --baseline，仅输出新发现的问题",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"taintscan {__version__} (baseline schema v{BASELINE_VERSION})",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    root = Path(args.path)
    if not root.exists():
        print(f"error: scan path does not exist: {root}", file=sys.stderr)
        return EXIT_USAGE

    try:
        result = Scanner(str(root), args.exclude).scan()
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE

    baseline: Optional[Baseline] = None
    if args.baseline:
        try:
            baseline = Baseline.load(args.baseline)
        except BaselineError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_USAGE

    comparison = compare(result.findings, baseline) if baseline is not None else None
    if comparison is not None:
        comparison.apply()

    # Keep the full result for baseline saving even when --only-new filters
    # the terminal output.
    all_findings = list(result.findings)
    if args.only_new and comparison is not None:
        result.findings = [finding for finding in result.findings if finding.status == "new"]

    # When the JSON report goes to stdout, send the human report to stderr so
    # that stdout stays a single, parseable JSON document.
    text_stream = sys.stderr if args.json_path == "-" else sys.stdout
    render_text(
        result,
        text_stream,
        show_status=baseline is not None,
        comparison=comparison,
    )

    if args.json_path:
        if args.json_path == "-":
            render_json(result, sys.stdout, comparison, __version__)
        else:
            destination = Path(args.json_path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("w", encoding="utf-8") as handle:
                render_json(result, handle, comparison, __version__)

    if args.save_baseline:
        try:
            Baseline.from_findings(
                all_findings, root=str(result.root), version=BASELINE_VERSION
            ).save(args.save_baseline)
        except (BaselineError, OSError) as exc:
            print(f"error: cannot save baseline: {exc}", file=sys.stderr)
            return EXIT_USAGE
        print(f"baseline saved to {args.save_baseline} ({len(all_findings)} finding(s))")

    if args.fail_on:
        threshold = Severity.parse(args.fail_on)
        if any(finding.severity >= threshold for finding in result.findings):
            return EXIT_FINDINGS
    return EXIT_OK


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
