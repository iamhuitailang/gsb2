"""命令行入口：python -m regex_risk <输入文件> [--format text|json]。

退出码约定（便于脚本判断）：

* 0：所有表达式都检查通过，没有风险发现也没有非法表达式；
* 1：至少一条表达式存在风险发现或无法通过编译；
* 2：输入文件本身无法读取（与行内语法错误区分开）。
"""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from .checker import InputFileError, check_file
from .report import (
    build_input_error_json,
    build_input_error_text,
    build_json,
    build_text,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m regex_risk",
        description="静态检查文本文件中每条 Python 正则表达式的灾难性回溯风险"
                    "（只做语法分析，不会实际执行匹配）。",
    )
    parser.add_argument("input_file", help="包含正则表达式的文本文件，每行一条")
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="输出格式：text（默认，面向人）或 json（机器可读，字段稳定）",
    )
    parser.add_argument(
        "--output",
        "-o",
        default=None,
        help="把报告写入指定文件；缺省输出到标准输出",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = check_file(args.input_file)
    except InputFileError as exc:
        message = str(exc)
        rendered = (
            build_input_error_json(args.input_file, message)
            if args.format == "json"
            else build_input_error_text(args.input_file, message)
        )
        _emit(rendered, args.output)
        return 2

    rendered = build_json(result) if args.format == "json" else build_text(result)
    _emit(rendered, args.output)

    if result.finding_count or result.invalid_count:
        return 1
    return 0


def _emit(rendered: str, output_path: Optional[str]) -> None:
    if output_path is None:
        sys.stdout.write(rendered)
        if not rendered.endswith("\n"):
            sys.stdout.write("\n")
        return
    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write(rendered)
        if not rendered.endswith("\n"):
            handle.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
