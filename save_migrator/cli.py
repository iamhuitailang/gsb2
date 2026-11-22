"""命令行入口。

用法:
    python3 -m save_migrator inspect  samples/save_v1_cross.json
    python3 -m save_migrator preview  samples/save_v1_cross.json
    python3 -m save_migrator preview  samples/save_v1_cross.json --json-report out/preview.json
    python3 -m save_migrator migrate  samples/save_v1_cross.json -o out/save_v3.json
    python3 -m save_migrator check    out/save_v3.json
    python3 -m save_migrator compare  a.json b.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .errors import MigrationError, UnknownVersionError
from .migrate import (
    DEFAULT_RULES,
    OutputConflictError,
    check_save,
    inspect_save,
    migrate_file,
    preview_save,
)
from .report import format_value

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_BLOCKED = 3
EXIT_CONFLICT = 4
EXIT_UNKNOWN_VERSION = 5


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="save_migrator",
        description="虚构游戏存档迁移检查器：预览、迁移、复核，源档只读。",
    )
    parser.add_argument(
        "--rules",
        default=str(DEFAULT_RULES),
        help="规则文件路径（默认 rules/default_rules.json）",
    )
    # 子命令上也接受 --rules；用 SUPPRESS 作默认值, 避免它覆盖写在子命令之前的同名参数。
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--rules",
        default=argparse.SUPPRESS,
        help="规则文件路径（默认 rules/default_rules.json）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    inspect_parser = sub.add_parser("inspect", parents=[common], help="只读概览：版本、关键进度")
    inspect_parser.add_argument("save")
    inspect_parser.add_argument("--json-report", help="把报告写成 JSON")

    check_parser = sub.add_parser("check", parents=[common], help="检查关键字段是否合法（不迁移）")
    check_parser.add_argument("save")
    check_parser.add_argument("--json-report", help="把报告写成 JSON")

    preview_parser = sub.add_parser("preview", parents=[common], help="预览迁移改动，不写存档")
    preview_parser.add_argument("save")
    preview_parser.add_argument("--json-report", help="把报告写成 JSON，供 compare 使用")

    migrate_parser = sub.add_parser("migrate", parents=[common], help="迁移并写出版本 3 存档")
    migrate_parser.add_argument("save")
    migrate_parser.add_argument("-o", "--output", required=True, help="输出路径，不能与源档相同")
    migrate_parser.add_argument("--force", action="store_true", help="目标已存在且不同时覆盖（默认拒绝）")
    migrate_parser.add_argument("--json-report", help="把报告写成 JSON")

    compare_parser = sub.add_parser("compare", help="对照两份迁移报告（例如调整规则前后）")
    compare_parser.add_argument("before")
    compare_parser.add_argument("after")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "compare":
            return _compare(args.before, args.after)
        if args.command == "inspect":
            report = inspect_save(args.save, args.rules)
        elif args.command == "check":
            report = check_save(args.save, args.rules)
        elif args.command == "preview":
            report = preview_save(args.save, args.rules)
        elif args.command == "migrate":
            report = migrate_file(args.save, args.output, args.rules, force=args.force)
        else:  # pragma: no cover - argparse 已限制
            parser.error(f"未知命令: {args.command}")
            return EXIT_USAGE
    except OutputConflictError as exc:
        print(f"错误: {exc.message}", file=sys.stderr)
        if exc.detail:
            print(f"      {exc.detail}", file=sys.stderr)
        return EXIT_CONFLICT
    except UnknownVersionError as exc:
        print(f"错误: {exc.message}", file=sys.stderr)
        print(
            f"      本工具支持 format = {exc.supported}；无法识别的版本不会被猜测迁移。",
            file=sys.stderr,
        )
        return EXIT_UNKNOWN_VERSION
    except MigrationError as exc:
        print(f"错误: {exc.message}", file=sys.stderr)
        if exc.detail:
            print(f"      {exc.detail}", file=sys.stderr)
        return EXIT_USAGE
    except ValueError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return EXIT_USAGE

    print(report.render_text())
    if getattr(args, "json_report", None):
        _write_report(report, args.json_report)

    if report.status == "blocked":
        return EXIT_BLOCKED
    return EXIT_OK


def _write_report(report, path: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(report.to_dict(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"\n报告已写入: {target}")

# ---------------------------------------------------------------- compare


def _load_report(path: str) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        raise MigrationError(f"读不到报告: {path}", detail=str(exc)) from exc
    except json.JSONDecodeError as exc:
        raise MigrationError(
            f"报告不是合法 JSON: {path}",
            detail=f"第 {exc.lineno} 行第 {exc.colno} 列: {exc.msg}",
        ) from exc
    if not isinstance(data, dict) or "report_version" not in data:
        raise MigrationError(f"不是本工具生成的报告: {path}")
    return data


def _change_index(report: dict) -> dict[tuple, dict]:
    index = {}
    for change in report.get("changes", []):
        key = (change.get("step"), change.get("kind"), change.get("path"))
        index[key] = change
    return index


def _compare(before_path: str, after_path: str) -> int:
    before = _load_report(before_path)
    after = _load_report(after_path)

    print("== 迁移报告对照 ==")
    for title, report in (("原报告", before), ("新报告", after)):
        print(
            f"{title}: {report.get('source', {}).get('path')} "
            f"源版本 v{report.get('versions', {}).get('source')} "
            f"digest={str(report.get('rules', {}).get('digest') or '')[:12]} "
            f"状态={report.get('status')}"
        )
    same_source = (
        before.get("source", {}).get("sha256") == after.get("source", {}).get("sha256")
    )
    print(f"同一份原档: {'是' if same_source else '否（注意：两次输入不同，改动差异不能只归因于规则）'}")
    if before.get("rules", {}).get("digest") == after.get("rules", {}).get("digest"):
        print("规则 digest 相同：两次迁移使用的规则一致")

    before_changes = _change_index(before)
    after_changes = _change_index(after)
    all_keys = sorted(set(before_changes) | set(after_changes), key=lambda k: tuple(str(v) for v in k))

    print()
    print("改动对照 (原值 / 新值 / 规则):")
    if not all_keys:
        print("  两次报告都没有改动记录。")
    for key in all_keys:
        step, kind, path = key
        old = before_changes.get(key)
        new = after_changes.get(key)
        print(f"- [{step}] {kind}  {path}")
        if old is None:
            print("    原报告: 无此项")
        else:
            print(
                f"    原报告: {format_value(old.get('old'))} -> {format_value(old.get('new'))}"
                f"  规则: {old.get('rule')}"
            )
        if new is None:
            print("    新报告: 无此项（该改动消失）")
        else:
            print(
                f"    新报告: {format_value(new.get('old'))} -> {format_value(new.get('new'))}"
                f"  规则: {new.get('rule')}"
            )
        if old is not None and new is not None:
            if (old.get("old"), old.get("new")) != (new.get("old"), new.get("new")):
                print("    判定: 结果变化")
            elif old.get("rule") != new.get("rule"):
                print("    判定: 结果不变，仅规则来源变化")
            else:
                print("    判定: 一致")

    _compare_problems("新增警告", before, after, "warnings")
    _compare_problems("新增阻断问题", before, after, "errors")
    _compare_progress(before, after)
    return EXIT_OK


def _problem_identities(report: dict, field: str) -> set[tuple]:
    return {
        (problem.get("code"), problem.get("path"), problem.get("message"))
        for problem in report.get(field, [])
    }


def _compare_problems(title: str, before: dict, after: dict, field: str) -> None:
    added = _problem_identities(after, field) - _problem_identities(before, field)
    removed = _problem_identities(before, field) - _problem_identities(after, field)
    if not added and not removed:
        return
    print()
    print(f"{title}:")
    for code, path, message in sorted(added, key=lambda item: str(item)):
        print(f"  + [{code}] {message}  ({path})")
    for code, path, message in sorted(removed, key=lambda item: str(item)):
        print(f"  - [{code}] {message}  ({path})")


def _compare_progress(before: dict, after: dict) -> None:
    before_progress = before.get("progress")
    after_progress = after.get("progress")
    if before_progress is None or after_progress is None:
        return
    print()
    print("关键进度对照:")
    for label, key in (("玩家", "player"), ("位置", "location"), ("背包", "inventory"), ("支线", "quests")):
        left = before_progress.get(key)
        right = after_progress.get(key)
        mark = "一致" if left == right else "不同"
        print(f"  {label}: {mark}")
        if left != right:
            print(f"    原报告: {format_value(left)}")
            print(f"    新报告: {format_value(right)}")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
