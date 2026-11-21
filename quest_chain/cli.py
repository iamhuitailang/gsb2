"""命令行入口。

用法示例::

    python -m quest_chain.cli validate samples/quest_demo.qchain.json
    python -m quest_chain.cli simulate samples/quest_demo.qchain.json \\
        --step q_intro:complete --step q_branch_a:accept --step q_branch_a:complete
    python -m quest_chain.cli export samples/quest_demo.qchain.json -o runtime.json
    python -m quest_chain.cli import-check runtime.json
    python -m quest_chain.cli impact samples/quest_demo.qchain.json q_intro
    python -m quest_chain.cli serve --port 8765
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from .analysis import analyze_project, compare_projects, downstream_impact
from .model import Project, ProjectError, export_runtime, import_runtime, load_project, save_project
from .simulator import Simulator


def _print_issues(issues) -> int:
    if not issues:
        print("✓ 未发现问题")
        return 0
    error_count = 0
    for issue in issues:
        marker = "✗ ERROR" if issue.severity == "error" else "⚠ WARN "
        print(f"{marker} [{issue.code}] {issue.message}")
        if issue.severity == "error":
            error_count += 1
    print(f"\n共 {len(issues)} 个问题 (错误 {error_count}, 警告 {len(issues) - error_count})")
    return 1 if error_count else 0


def cmd_validate(args: argparse.Namespace) -> int:
    try:
        project = load_project(args.path)
    except ProjectError as exc:
        print(f"✗ 工程文件无法解析: {exc}")
        return 2
    print(f"工程: {project.name or args.path}  任务数: {len(project.quests)}")
    return _print_issues(analyze_project(project))


def cmd_simulate(args: argparse.Namespace) -> int:
    try:
        project = load_project(args.path)
    except ProjectError as exc:
        print(f"✗ {exc}")
        return 2
    sim = Simulator(project)
    if args.load_progress:
        try:
            with open(args.load_progress, "r", encoding="utf-8") as fp:
                warnings = sim.load_progress(json.load(fp))
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(f"✗ 进度载入失败: {exc}")
            return 2
        print(f"✓ 已载入模拟进度 {args.load_progress}")
        for warning in warnings:
            print(f"  ⚠ {warning}")
    for raw in args.step or []:
        if ":" not in raw:
            print(f"步骤格式错误: {raw!r}, 应为 任务id:accept|complete|fail")
            return 2
        quest_id, action = raw.split(":", 1)
        diff = sim.step(action.strip(), quest_id.strip())
        flag = "✓" if diff.ok else "✗"
        print(f"{flag} {action} {quest_id}: {diff.message or '成功'}")
        for event in diff.events:
            print(f"    · {event}")
        if diff.new_available:
            print(f"    新可接取: {', '.join(diff.new_available)}")
        if diff.invalidated:
            for item in diff.invalidated:
                print(f"    失效: {item['quest_id']} ({item['reason']})")
        if diff.endings_reached:
            print(f"    达成结局: {', '.join(diff.endings_reached)}")
        if not diff.ok:
            return 1

    summary = sim.summary()
    if args.save_progress:
        with open(args.save_progress, "w", encoding="utf-8") as fp:
            json.dump(sim.export_progress(), fp, ensure_ascii=False, indent=2)
        print(f"✓ 模拟进度已保存到 {args.save_progress}")
    print("\n=== 局面总结 ===")
    print("状态计数:", json.dumps(summary["counts"], ensure_ascii=False))
    print("可接取:", ", ".join(summary["available"]) or "(无)")
    print("进行中:", ", ".join(summary["active"]) or "(无)")
    print("已完成:", ", ".join(summary["completed"]) or "(无)")
    print("已失败:", ", ".join(summary["failed"]) or "(无)")
    if summary["stuck"]:
        print("\n✗ 玩家已卡住:")
        for item in summary["stuck"]["blocked_quests"]:
            print(f"    - {item['quest_id']}: {item['reason']}")
        return 1
    print("\n✓ 局面仍可推进")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    try:
        project = load_project(args.path)
        data = export_runtime(project)
    except ProjectError as exc:
        print(f"✗ {exc}")
        return 2
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fp:
            fp.write(text)
        print(f"✓ 已导出运行时数据到 {args.output} ({len(data['quests'])} 个任务)")
    else:
        print(text)
    return 0


def cmd_import_check(args: argparse.Namespace) -> int:
    try:
        with open(args.path, "r", encoding="utf-8") as fp:
            data = json.load(fp)
        project, problems = import_runtime(data)
    except (ProjectError, json.JSONDecodeError) as exc:
        print(f"✗ 导入失败: {exc}")
        return 2
    print(f"✓ 结构解析通过, 任务数: {len(project.quests)}")
    if problems:
        print(f"发现 {len(problems)} 个引用/表达式问题:")
        for problem in problems:
            print(f"  ✗ {problem}")
        return 1
    print("✓ 引用完整性检查通过, 无缺失引用")
    return 0


def cmd_impact(args: argparse.Namespace) -> int:
    try:
        project = load_project(args.path)
    except ProjectError as exc:
        print(f"✗ {exc}")
        return 2
    impact = downstream_impact(project, args.quest_id)
    if not impact["found"]:
        print(f"✗ 任务 {args.quest_id} 不存在")
        return 1
    print(f"任务 {args.quest_id} 的影响面:")
    print("  直接后继:", ", ".join(impact["direct"]) or "(无)")
    print("  全部传递后继:", ", ".join(impact["transitive"]) or "(无)")
    print("  受影响结局:", ", ".join(impact["endings"]) or "(无)")
    return 0


def cmd_diff(args: argparse.Namespace) -> int:
    try:
        before = load_project(args.before)
        after = load_project(args.after)
    except ProjectError as exc:
        print(f"✗ {exc}")
        return 2
    result = compare_projects(before, after)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    from .server import run_server

    run_server(host=args.host, port=args.port)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="quest_chain",
        description="任务链编辑与试玩工具: 诊断循环依赖/死路, 模拟玩家路径, 导出运行时数据",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("validate", help="静态诊断任务图")
    p.add_argument("path")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("simulate", help="按给定步骤模拟玩家行为")
    p.add_argument("path")
    p.add_argument(
        "--step",
        action="append",
        help="模拟步骤, 格式 任务id:accept|complete|fail, 可重复",
    )
    p.add_argument("--save-progress", help="把模拟结束后的进度保存到文件")
    p.add_argument("--load-progress", help="从进度文件恢复后再执行 --step")
    p.set_defaults(func=cmd_simulate)

    p = sub.add_parser("export", help="导出游戏读取的运行时 JSON")
    p.add_argument("path")
    p.add_argument("-o", "--output", help="输出路径, 缺省打印到标准输出")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("import-check", help="导入数据并检查缺失引用")
    p.add_argument("path")
    p.set_defaults(func=cmd_import_check)

    p = sub.add_parser("impact", help="查看某任务修改后的影响面")
    p.add_argument("path")
    p.add_argument("quest_id")
    p.set_defaults(func=cmd_impact)

    p = sub.add_parser("diff", help="对比两个工程版本的条件变更与影响")
    p.add_argument("before")
    p.add_argument("after")
    p.set_defaults(func=cmd_diff)

    p = sub.add_parser("serve", help="启动本地 Web 编辑器服务")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.set_defaults(func=cmd_serve)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
