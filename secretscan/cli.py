"""命令行入口。

退出码约定:
- 0: 扫描成功且没有新增发现;
- 1: 扫描成功但存在新增 (基线之外) 的发现;
- 2: 扫描未能正常执行 (根目录缺失、配置/基线无效等)。
"""

from __future__ import annotations

import argparse
import sys

from . import __version__
from .baseline import (
    BaselineDiff,
    diff_against_baseline,
    load_baseline,
    write_baseline,
)
from .config import load_config
from .errors import BaselineError, ConfigError, ScanRootError, SecretScanError
from .models import sort_findings
from .report import Reporter
from .scanner import Scanner

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_FAILURE = 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m secretscan",
        description="离线扫描目录中的疑似凭据, 不访问网络, 输出全程脱敏。",
    )
    parser.add_argument("root", help="扫描根目录")
    parser.add_argument(
        "-c", "--config", help="TOML 配置文件路径; 省略时使用内置默认配置"
    )
    parser.add_argument(
        "-b",
        "--baseline",
        help="基线 JSON 文件; 提供后按指纹比对, 区分新增/已确认/过期/消失",
    )
    parser.add_argument(
        "--new-only",
        action="store_true",
        help="报告中只保留基线之外的新增发现",
    )
    parser.add_argument(
        "--update-baseline",
        metavar="PATH",
        help="把本次全部发现写入指定基线文件 (原子替换) 后退出, 不输出扫描报告",
    )
    parser.add_argument(
        "-f",
        "--format",
        choices=("text", "json"),
        default="text",
        help="报告格式, 默认 text",
    )
    parser.add_argument(
        "-o",
        "--output",
        help="报告输出文件; 省略时写到标准输出",
    )
    parser.add_argument(
        "--version", action="version", version=f"secretscan {__version__}"
    )
    return parser


def _emit(text: str, output: str | None) -> None:
    if output is None:
        sys.stdout.write(text)
        return
    try:
        with open(output, "w", encoding="utf-8") as handle:
            handle.write(text)
    except OSError as exc:
        raise SecretScanError(f"报告文件写入失败: {exc}") from exc


def run(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    # 1. 配置 (规则非法在此处即失败, 退出码 2)。
    try:
        config = load_config(args.config)
        rules = config.build_rules()
    except SecretScanError as exc:
        print(f"配置错误: {exc}", file=sys.stderr)
        return EXIT_FAILURE

    # 2. 基线 (损坏即失败, 退出码 2, 不静默忽略)。
    baseline_entries: dict | None = None
    if args.baseline:
        try:
            baseline_entries = load_baseline(args.baseline)
        except BaselineError as exc:
            print(f"基线错误: {exc}", file=sys.stderr)
            return EXIT_FAILURE

    # 3. 扫描 (根目录非法即失败; 单文件错误只产生告警)。
    try:
        scanner = Scanner(args.root, config, rules)
        findings, warnings = scanner.run()
    except ScanRootError as exc:
        print(f"扫描失败: {exc}", file=sys.stderr)
        return EXIT_FAILURE

    findings = sort_findings(findings)
    diff: BaselineDiff | None = None
    if baseline_entries is not None:
        diff = diff_against_baseline(findings, baseline_entries)
        new_findings = sort_findings(diff.new_findings)
    else:
        # 无基线时所有发现都视为新增。
        new_findings = findings

    # 4. 基线更新模式: 写文件后直接退出, 不输出凭据相关内容。
    if args.update_baseline:
        try:
            write_baseline(args.update_baseline, findings, baseline_entries)
        except BaselineError as exc:
            print(f"基线错误: {exc}", file=sys.stderr)
            return EXIT_FAILURE
        print(
            f"基线已更新: {args.update_baseline} "
            f"(记录 {len(findings)} 条发现)",
            file=sys.stderr,
        )
        return EXIT_OK

    shown_findings = new_findings if args.new_only else findings
    stats = {
        "scanned_files": scanner.scanned_files,
        "finding_count": len(shown_findings) if args.new_only else len(findings),
        "total_finding_count": len(findings),
        "new_count": len(new_findings),
        "acknowledged_count": len(diff.acknowledged) if diff else 0,
        "expired_count": len(diff.expired) if diff else 0,
        "missing_count": len(diff.missing) if diff else 0,
        "skipped_binary": scanner.skipped_binary,
        "skipped_oversized": scanner.skipped_oversized,
        "skipped_vcs": scanner.skipped_vcs,
        "warning_count": len(warnings),
    }

    reporter = Reporter(scanner.root)
    if args.format == "json":
        rendered = reporter.render_json(
            shown_findings, new_findings, warnings, diff, stats
        )
    else:
        rendered = reporter.render_text(
            shown_findings, new_findings, warnings, diff, stats
        )
    try:
        _emit(rendered, args.output)
    except SecretScanError as exc:
        print(f"输出失败: {exc}", file=sys.stderr)
        return EXIT_FAILURE

    return EXIT_FINDINGS if new_findings else EXIT_OK


def main() -> None:  # console_scripts 入口
    sys.exit(run())


if __name__ == "__main__":
    main()
