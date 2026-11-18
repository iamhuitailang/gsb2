"""命令行入口：python -m baseline_audit <command>。"""

from __future__ import annotations

import argparse
import json
import sys

from .auditor import Auditor
from .errors import AuditError
from .webapp import serve


def _print(payload) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m baseline_audit",
        description="本地只读主机安全基线核查台（离线、无第三方依赖）",
    )
    parser.add_argument("--data-dir", default=".audit_data",
                        help="工具状态目录（默认 ./.audit_data，永不写入被核查目录）")
    sub = parser.add_subparsers(dest="command", required=True)

    p_scan = sub.add_parser("scan", help="对指定目录执行一次只读核查")
    p_scan.add_argument("path", help="待核查的本地目录")

    p_runs = sub.add_parser("runs", help="列出该目录的历史核查")
    p_runs.add_argument("path")

    p_baseline = sub.add_parser("baseline", help="把最近一次核查保存为基线")
    p_baseline.add_argument("path")
    p_baseline.add_argument("--run-id", default=None)

    p_exc = sub.add_parser("exception", help="为发现项添加例外")
    p_exc.add_argument("path")
    p_exc.add_argument("finding_id")
    p_exc.add_argument("--scope", choices=["rule", "path", "finding"], default="finding")
    p_exc.add_argument("--expires-at", default="",
                       help="失效时间 UTC，格式 YYYY-MM-DDTHH:MM:SS；留空表示永久")
    p_exc.add_argument("--reason", default="")

    p_export = sub.add_parser("export", help="导出最近一次核查报告（JSON，仅相对路径）")
    p_export.add_argument("path")
    p_export.add_argument("--run-id", default=None)

    p_log = sub.add_parser("log", help="查看审计日志（不含敏感内容）")

    p_serve = sub.add_parser("serve", help="启动本地 Web 页面（默认 127.0.0.1:8765）")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8765)

    args = parser.parse_args(argv)
    auditor = Auditor(args.data_dir)

    try:
        if args.command == "serve":
            serve(args.data_dir, args.host, args.port)
            return 0

        if args.command == "log":
            _print({"events": auditor.read_audit_log()})
            return 0

        root = auditor.resolve_root(args.path)

        if args.command == "scan":
            _print(auditor.scan_resolved(root)["run"])
        elif args.command == "runs":
            _print([
                {k: r[k] for k in ("run_id", "started_at", "rule_version", "stats", "warnings")}
                for r in auditor.list_runs(root)
            ])
        elif args.command == "baseline":
            _print(auditor.save_baseline(root, args.run_id))
        elif args.command == "exception":
            _print(auditor.add_exception(
                root, args.finding_id, args.scope, args.expires_at, args.reason))
        elif args.command == "export":
            _print(auditor.export_report(root, args.run_id))
        return 0
    except AuditError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
