"""命令行入口。

子命令：
  scan      扫描并输出报告（可同时导出 JSON）
  baseline  把当前发现保存为问题清单
  diff      和已有清单对比，标注新增 / 仍存在 / 已消失
"""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from . import __version__
from .baseline import diff_against_baseline, load_baseline, save_baseline
from .model import ScanResult, SEVERITY_VULNERABILITY
from .report import render_json, render_text, write_json_file
from .scanner import scan_path


def _add_common_scan_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("path", help="要扫描的项目目录或单个 Python 文件")
    parser.add_argument(
        "-s",
        "--subdir",
        action="append",
        default=[],
        metavar="DIR",
        help="只扫描该子目录，可重复指定多个；相对扫描根目录",
    )
    parser.add_argument(
        "--extra-source",
        action="append",
        default=[],
        metavar="DOTTED_NAME",
        help="追加识别的外部输入函数全名，例如 myframework.current_request.params",
    )
    parser.add_argument(
        "--skip-dir",
        action="append",
        default=[],
        metavar="NAME",
        help="额外跳过的目录名（内置规则之外），可重复指定",
    )
    parser.add_argument(
        "--assume-params-tainted",
        action="store_true",
        help="把所有函数参数视为不可信输入（用于框架参数注入场景，可能带来误报）",
    )
    parser.add_argument(
        "--json",
        dest="json_path",
        metavar="FILE",
        help="同时把结构化结果导出到该 JSON 文件",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sqli_scanner",
        description="离线 Python SQL 注入静态检查工具（基于 AST，不执行被扫描代码）",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser("scan", help="扫描项目并输出报告")
    _add_common_scan_args(scan)
    scan.add_argument(
        "--fail-on-finding",
        action="store_true",
        help="存在确认风险时以退出码 1 结束，方便接入 CI",
    )

    baseline = sub.add_parser("baseline", help="保存当前发现为问题清单")
    _add_common_scan_args(baseline)
    baseline.add_argument(
        "-o",
        "--output",
        default="sqli-baseline.json",
        help="清单输出路径（默认 sqli-baseline.json）",
    )

    diff = sub.add_parser("diff", help="与已有问题清单对比")
    _add_common_scan_args(diff)
    diff.add_argument(
        "-b",
        "--baseline",
        default="sqli-baseline.json",
        help="问题清单路径（默认 sqli-baseline.json）",
    )

    return parser


def _run_scan(args: argparse.Namespace) -> ScanResult:
    return scan_path(
        root=args.path,
        subdirs=args.subdir or None,
        extra_sources=args.extra_source or None,
        extra_skip=args.skip_dir or None,
        assume_params_tainted=args.assume_params_tainted,
    )


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    result = _run_scan(args)

    if args.command == "baseline":
        save_baseline(args.output, result.root, result.findings)
        print(render_text(result), end="")
        print(f"\n问题清单已保存: {args.output}（共 {len(result.findings)} 条）")
        return 0

    diff = None
    baseline_path: Optional[str] = None
    if args.command == "diff":
        baseline_path = args.baseline
        try:
            baseline = load_baseline(baseline_path)
        except FileNotFoundError:
            print(f"错误: 找不到问题清单 {baseline_path}", file=sys.stderr)
            return 2
        diff = diff_against_baseline(result.findings, baseline)

    print(render_text(result, diff=diff, baseline_path=baseline_path), end="")

    if args.json_path:
        write_json_file(args.json_path, render_json(result, diff=diff, baseline_path=baseline_path))
        print(f"结构化结果已导出: {args.json_path}")

    if args.command == "scan" and args.fail_on_finding:
        if any(f.severity == SEVERITY_VULNERABILITY for f in result.findings):
            return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
