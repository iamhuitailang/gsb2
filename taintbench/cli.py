"""命令行入口：本地静态检查，不执行待检代码。"""

from __future__ import annotations

import argparse
import json

from .orchestrator import check_paths, check_sources, summarize
from .webapp import serve


def _print_human(results) -> int:
    summary = summarize(results)
    for result in results:
        print(f"\n=== {result.file} ===")
        for err in result.errors:
            loc = f"第 {err.line} 行" if err.line else "位置未知"
            print(f"  [分析失败/{err.kind}] {loc}: {err.message}")
        for finding in result.findings:
            level = "高危" if finding.severity == "high" else "可能风险"
            print(f"  [{level}][{finding.certainty}] 第 {finding.line} 行 {finding.rule_id}")
            print(f"    来源: {', '.join(finding.source_labels)}（行 {finding.source_lines}）")
            print(f"    调用: {finding.sink_label}")
            print(f"    传播: {finding.propagation}")
            print(f"    依据: {finding.rule_basis}")
        for safe in result.safe_calls:
            print(f"  [规则上安全] 第 {safe.line} 行 {safe.rule_id}: {safe.reason}")
    print(
        f"\n汇总: {summary['files']} 个文件, 高危 {summary['high']}, "
        f"可能风险 {summary['medium']}, 安全调用 {summary['safe_calls']}, 失败 {summary['errors']}"
    )
    print("提示: 静态分析不能证明源码绝对安全，未覆盖的模式仍可能存在风险。")
    return 1 if summary["high"] or summary["medium"] else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="taintbench",
        description="本地 Python 源码命令注入污点分析（只解析不执行，仅本机运行）。",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    scan = sub.add_parser("scan", help="检查文件或目录")
    scan.add_argument("paths", nargs="+", help="Python 源文件或包含源码的目录")
    scan.add_argument("--json", action="store_true", help="输出 JSON")

    check = sub.add_parser("check", help="直接检查源码字符串（演示/脚本用）")
    check.add_argument("code", help="源码文本")
    check.add_argument("--name", default="inline.py")

    sub.add_parser("web", help="启动本机 Web 工作台")
    sub.add_parser("serve", help="同 web")
    for name in ("web", "serve"):
        p = sub.choices[name]
        p.add_argument("--host", default="127.0.0.1", help="只允许回环地址（默认 127.0.0.1）")
        p.add_argument("--port", type=int, default=8000)

    args = parser.parse_args(argv)
    if args.cmd in ("web", "serve"):
        host = getattr(args, "host", "127.0.0.1")
        port = getattr(args, "port", 8000)
        serve(host, port)
        return 0
    if args.cmd == "check":
        results = check_sources([(args.name, args.code)])
    else:
        results = check_paths(args.paths)
    if getattr(args, "json", False):
        print(json.dumps([r.to_dict() for r in results], ensure_ascii=False, indent=2))
        return 0
    return _print_human(results)


if __name__ == "__main__":
    raise SystemExit(main())
