"""命令行入口。"""
from __future__ import annotations

import argparse
from pathlib import Path

from .report import partition_findings, render_json, render_text
from .scanner import run_scan


def load_ignores(ignore_args, ignore_file):
    """加载忽略清单：编号 -> 原因。键可以是发现编号或规则号。"""
    ignores = {}
    for item in ignore_args or []:
        key, _, reason = item.partition("=")
        ignores[key.strip()] = reason.strip()
    if ignore_file:
        text = Path(ignore_file).read_text(encoding="utf-8")
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 1)
            ignores[parts[0]] = parts[1].strip() if len(parts) > 1 else ""
    return ignores


def build_parser():
    p = argparse.ArgumentParser(
        prog="sqlguard",
        description="离线 Python SQL 注入静态审查工具（只读扫描，不执行目标代码）",
    )
    p.add_argument("paths", nargs="+",
                   help="要检查的 Python 文件或项目目录（可多个）")
    p.add_argument("--exclude", action="append", default=[], metavar="GLOB",
                   help="额外忽略的目录/文件模式，可重复，"
                        "如 --exclude 'migrations*'")
    p.add_argument("--format", choices=["text", "json"], default="text",
                   help="报告格式（默认 text）")
    p.add_argument("--ignore", action="append", default=[], metavar="ID[=原因]",
                   help="按发现编号忽略，可重复，"
                        "如 --ignore SQLI001-abcdef1234=历史代码")
    p.add_argument("--ignore-file", metavar="FILE",
                   help="忽略清单文件，每行: 发现编号 忽略原因（# 开头为注释）")
    p.add_argument("-o", "--output", metavar="FILE",
                   help="报告写入文件（默认输出到标准输出）")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    result = run_scan(args.paths, args.exclude)
    ignores = load_ignores(args.ignore, args.ignore_file)
    active, ignored = partition_findings(result.findings, ignores)
    if args.format == "json":
        out = render_json(result, active, ignored)
    else:
        out = render_text(result, active, ignored)
    if args.output:
        Path(args.output).write_text(out + "\n", encoding="utf-8")
    else:
        print(out)
    # 有未忽略的发现时退出码为 1，便于接入 CI
    return 1 if active else 0
