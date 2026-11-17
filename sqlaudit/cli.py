"""命令行入口。

用法示例：
  python -m sqlaudit ./my_project
  python -m sqlaudit ./my_project --min-level medium --format json
  python -m sqlaudit ./my_project --output report.json --no-color
"""

from __future__ import annotations

import argparse
import json
import sys

from .model import Severity
from .report import render_text
from .scanner import scan_project

# 退出码约定：
#   0  没有达到输出阈值的发现（分析失败本身不改变退出码，仅在报告中指出）
#   1  存在达到输出阈值的发现
#   2  用法错误（路径不存在等）
EXIT_CLEAN = 0
EXIT_FINDINGS = 1
EXIT_USAGE = 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sqlaudit",
        description="本地 Python 项目 SQL 注入静态审查工具"
                    "（只读源码，不执行代码，不访问网络）",
    )
    parser.add_argument(
        "target",
        help="要检查的 Python 项目目录或单个 .py 文件",
    )
    parser.add_argument(
        "--min-level",
        default="low",
        choices=["low", "medium", "high"],
        help="只显示指定等级及以上的结果（low 默认全部显示）",
    )
    parser.add_argument(
        "--format",
        default="text",
        choices=["text", "json"],
        help="输出格式：text 适合人阅读，json 供其他工具读取",
    )
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="把结果写入指定文件；不指定则输出到标准输出",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="文本报告不使用颜色",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="NAME",
        help="额外跳过的目录名或文件名（可重复使用）",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    import os
    if not os.path.exists(args.target):
        print(f"错误: 目标路径不存在: {args.target}", file=sys.stderr)
        return EXIT_USAGE

    min_level = Severity.from_name(args.min_level)
    result = scan_project(args.target, excludes=args.exclude)
    filtered = result.filter_by_level(min_level)

    if args.format == "json":
        payload = json.dumps(filtered.to_dict(), ensure_ascii=False,
                             indent=2, sort_keys=False)
    else:
        payload = render_text(filtered, color=not args.no_color)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.write("\n")
    else:
        print(payload)

    return EXIT_FINDINGS if filtered.findings else EXIT_CLEAN
