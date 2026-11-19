"""命令行入口。

退出码：
    0  扫描完成，无未豁免的发现
    1  扫描完成，存在未豁免的发现
    2  输入错误（路径不存在、没有匹配文件、文件不可读或格式有问题）
    3  工具自身故障
"""
from __future__ import annotations

import argparse
import sys
import traceback
from datetime import date

from . import __version__
from .loader import collect_files, is_workflow, load_file
from .model import FileError, ScanResult
from .report import render_json, render_text
from .rules import RULES, analyze_workflow
from .suppressions import apply_suppressions, parse_suppressions

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_INPUT_ERROR = 2
EXIT_INTERNAL_ERROR = 3


def build_parser():
    parser = argparse.ArgumentParser(
        prog="gha-audit",
        description="本地检查 GitHub Actions 工作流的常见配置风险"
        "（只读取本地文件，不访问网络，不修改被检查文件）。")
    parser.add_argument("paths", nargs="*",
                        help="工作流文件或包含工作流的目录（可多个）")
    parser.add_argument("--format", choices=("text", "json"), default="text",
                        help="报告格式，默认 text")
    parser.add_argument("--list-rules", action="store_true",
                        help="列出全部规则编号与说明后退出")
    parser.add_argument("--version", action="version",
                        version=f"gha-audit {__version__}")
    return parser


def _analyze_into(result: ScanResult, path, data, text, today):
    result.scanned.append(path)
    findings = analyze_workflow(path, data)
    suppressions, exception_findings = parse_suppressions(
        path, text, set(RULES), today)
    apply_suppressions(findings, suppressions)
    result.findings.extend(findings)
    result.findings.extend(exception_findings)


def _run(args) -> int:
    explicit, discovered, errors = collect_files(args.paths)
    result = ScanResult()
    result.errors.extend(errors)
    today = date.today()

    for path in explicit:
        data, text, error = load_file(path)
        if error:
            result.errors.append(FileError(path, error))
        elif not is_workflow(data):
            result.errors.append(
                FileError(path, "不是可识别的工作流文件（缺少 on 或 jobs）"))
        else:
            _analyze_into(result, path, data, text, today)

    for path in discovered:
        data, text, error = load_file(path)
        if error:
            result.errors.append(FileError(path, error))
        elif not is_workflow(data):
            result.skipped.append(path)
        else:
            _analyze_into(result, path, data, text, today)

    if not result.scanned and not result.errors:
        result.errors.append(
            FileError("(输入)", "没有匹配到任何可分析的工作流文件"))

    output = render_json(result) if args.format == "json" else render_text(result)
    print(output)

    if result.errors:
        return EXIT_INPUT_ERROR
    if result.active_findings:
        return EXIT_FINDINGS
    return EXIT_OK


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.list_rules:
        for rule_id in sorted(RULES):
            print(f"{rule_id}  {RULES[rule_id]}")
        return EXIT_OK
    if not args.paths:
        build_parser().error("需要提供至少一个文件或目录路径")
    try:
        return _run(args)
    except Exception:  # noqa: BLE001 - 工具自身故障需要可区分的退出码
        traceback.print_exc()
        print("gha-audit 内部错误", file=sys.stderr)
        return EXIT_INTERNAL_ERROR


def run():
    sys.exit(main())
