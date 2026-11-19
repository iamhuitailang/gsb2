"""命令行入口。

子命令：
  create   创建空案件
  collect  采集目录（支持中断续采）
  info     查看案件与条目状态（不输出任何文件正文）
  verify   复核副本与清单的一致性

退出码：
  0 成功 / 复核无差异
  1 复核发现差异
  2 用法或流程错误（案件损坏、目录冲突等）
  3 采集完成但为 partial
  4 采集 failed（没有任何文件成功）
  5 采集中断（in_progress）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional, Sequence

from . import __version__
from .collector import CollectionError, collect, create_case
from .manifest import check_manifest_integrity, in_progress_path
from .paths import PathError
from .verifier import verify_case

# 终端状态标签（中文可读，括号内保留机器状态码）
STATUS_LABELS = {
    "collected": "已采集(collected)",
    "recorded": "仅登记(recorded)",
    "skipped": "已跳过(skipped)",
    "failed": "失败(failed)",
    "conflict": "路径冲突(conflict)",
    "out_of_bounds": "越界(out_of_bounds)",
    "limit_exceeded": "超限(limit_exceeded)",
    "pending": "待处理(pending)",
}

CASE_STATUS_LABELS = {
    "new": "新建未采集(new)",
    "in_progress": "中断/进行中(in_progress)",
    "complete": "完整(complete)",
    "partial": "部分完成(partial)",
    "failed": "失败(failed)",
}


def _print(line: str = "") -> None:
    print(line)


def _emit(data: dict, as_json: bool, human_text: str) -> None:
    if as_json:
        print(json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2))
    else:
        _print(human_text)


# --------------------------------------------------------------- create

def _cmd_create(args: argparse.Namespace) -> int:
    try:
        meta = create_case(
            args.case_dir,
            args.source,
            max_files=args.max_files,
            max_bytes=args.max_bytes,
        )
    except PathError as exc:
        _print(f"[失败] 源根目录无效，创建案件未完成：{exc}")
        return 2
    except CollectionError as exc:
        _print(f"[失败] 创建案件未完成：{exc}")
        return 2
    except OSError as exc:
        _print(f"[失败] 创建目录时出错：{exc}")
        return 2
    data = {"ok": True, "case_dir": os.path.abspath(args.case_dir), "meta": meta}
    text = (
        "[成功] 案件已创建\n"
        f"  案件目录 : {os.path.abspath(args.case_dir)}\n"
        f"  案件 ID  : {meta['case_id']}\n"
        f"  源根目录 : {meta['source_root']}\n"
        f"  采集上限 : max_files={meta['limits']['max_files']}, "
        f"max_bytes={meta['limits']['max_bytes']}"
    )
    _emit(data, args.json, text)
    return 0


# -------------------------------------------------------------- collect

def _cmd_collect(args: argparse.Namespace) -> int:
    try:
        result = collect(
            args.case_dir,
            source_root=args.source,
            max_files=args.max_files,
            max_bytes=args.max_bytes,
        )
    except PathError as exc:
        _print(f"[失败] 源根目录无效，采集未完成：{exc}")
        return 2
    except CollectionError as exc:
        _print(f"[失败] 采集未完成：{exc}")
        return 2
    except FileNotFoundError as exc:
        _print(f"[失败] 源目录或案件目录不存在：{exc}")
        return 2
    except OSError as exc:
        _print(f"[失败] 文件系统错误，采集未完成：{exc}")
        return 2

    s = result.stats
    text_lines = [
        f"[完成] {result.message}",
        f"  案件目录 : {os.path.abspath(result.case_dir)}",
        f"  复用已有副本 : {s.reused}    重新处理 : {s.reprocessed}",
        f"  采集字节数   : {s.total_bytes}",
    ]
    if result.problems:
        text_lines.append("  未成功条目（不影响其他文件结果）:")
        for rel, status, reason in result.problems:
            text_lines.append(f"    - {rel}  [{STATUS_LABELS.get(status, status)}] {reason}")
    data = {
        "ok": True,
        "case_dir": os.path.abspath(result.case_dir),
        "case_status": result.case_status,
        "interrupted": result.interrupted,
        "stats": s.as_dict(),
        "problems": [
            {"rel_path": rel, "status": status, "reason": reason}
            for rel, status, reason in result.problems
        ],
    }
    _emit(data, args.json, "\n".join(text_lines))

    if result.interrupted:
        return 5
    if result.case_status == "failed":
        return 4
    if result.case_status == "partial":
        return 3
    return 0


# ----------------------------------------------------------------- info

def _cmd_info(args: argparse.Namespace) -> int:
    case_dir = args.case_dir
    meta_path = os.path.join(case_dir, "case.json")
    if not os.path.isfile(meta_path):
        _print(f"[失败] 不是有效的案件目录（缺少 case.json）: {case_dir}")
        return 2
    ok, problem, manifest = check_manifest_integrity(case_dir)
    try:
        with open(meta_path, "rb") as fh:
            meta = json.loads(fh.read().decode("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _print(f"[失败] case.json 无法读取: {exc}")
        return 2

    if not ok:
        _print(f"[警告] 清单损坏：{problem}")
        entries = (manifest or {}).get("entries", [])
    else:
        entries = manifest.get("entries", [])

    counts: dict[str, int] = {}
    for raw in entries:
        counts[raw["status"]] = counts.get(raw["status"], 0) + 1

    lines = [
        f"案件目录 : {os.path.abspath(case_dir)}",
        f"案件 ID  : {meta.get('case_id')}",
        f"案件状态 : {CASE_STATUS_LABELS.get(meta.get('case_status'), meta.get('case_status'))}",
        f"源根目录 : {meta.get('source_root')}",
        f"采集上限 : {meta.get('limits')}",
        f"中断标记 : {'存在（半成品，需续采）' if os.path.exists(in_progress_path(case_dir)) else '无'}",
        f"清单状态 : {'完好' if ok else '损坏: ' + str(problem)}",
        "条目计数 : " + (", ".join(
            f"{STATUS_LABELS.get(k, k)}={v}" for k, v in sorted(counts.items())
        ) or "（空）"),
        "",
        "条目明细（仅元数据，不包含文件正文）:",
    ]
    for raw in entries:
        label = STATUS_LABELS.get(raw["status"], raw["status"])
        line = f"  {raw['rel_path']}  [{label}] 类型={raw['entry_type']} 大小={raw.get('size', 0)}"
        if raw.get("sha256"):
            line += f"  sha256={raw['sha256'][:16]}…"
        if raw.get("reason"):
            line += f"  原因={raw['reason']}"
        if raw.get("detail") and args.verbose:
            line += f"  说明={raw['detail']}"
        lines.append(line)

    data = {
        "ok": ok,
        "case_dir": os.path.abspath(case_dir),
        "meta": meta,
        "manifest_problem": problem,
        "status_counts": counts,
        "entries": entries,
    }
    _emit(data, args.json, "\n".join(lines))
    return 0 if ok else 1


# --------------------------------------------------------------- verify

def _cmd_verify(args: argparse.Namespace) -> int:
    if not os.path.isfile(os.path.join(args.case_dir, "case.json")):
        _print(f"[失败] 不是有效的案件目录: {args.case_dir}")
        return 2
    try:
        report = verify_case(args.case_dir, check_source=args.check_source)
    except OSError as exc:
        _print(f"[失败] 复核过程出错: {exc}")
        return 2

    lines = [f"复核案件: {os.path.abspath(args.case_dir)}"]
    if not report.manifest_ok:
        lines.append(f"[清单损坏] {report.manifest_problem}")
    else:
        lines.append(
            f"清单完整性: 完好；已核对副本 {report.verified_files} 个，"
            f"共 {report.verified_bytes} 字节"
        )
    sections = (
        ("缺失(missing)", report.missing),
        ("内容变化(changed)", report.changed),
        ("意外新增(unexpected)", report.unexpected),
        ("清单内历史问题(entry_problems)", report.entry_problems),
    )
    if args.check_source:
        sections += (("源端变化(source_drift)", report.source_drift),)
    for title, items in sections:
        lines.append("")
        lines.append(f"{title}: {len(items)} 项")
        for item in items:
            lines.append(f"  - {item['rel_path']}  {item.get('detail', '')}")
    lines.append("")
    lines.append("[结论] 复核通过，副本与清单一致" if report.ok else "[结论] 复核发现差异，详见上文")

    _emit(report.as_dict(), args.json, "\n".join(lines))
    if not report.manifest_ok:
        return 2
    return 0 if report.ok else 1


# -------------------------------------------------------------- parser

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="forensics",
        description="本机数字取证采集工具（标准库实现，不联网）",
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create", help="创建空案件")
    p_create.add_argument("case_dir", help="新案件目录（必须不存在或为空）")
    p_create.add_argument("source", help="被采集的源根目录")
    p_create.add_argument("--max-files", type=int, default=None,
                          help="普通文件数量上限")
    p_create.add_argument("--max-bytes", type=int, default=None,
                          help="普通文件总字节数上限")
    p_create.add_argument("--json", action="store_true", help="输出 JSON")
    p_create.set_defaults(func=_cmd_create)

    p_collect = sub.add_parser("collect", help="采集目录；中断后重跑即续采")
    p_collect.add_argument("case_dir", help="案件目录")
    p_collect.add_argument("source", nargs="?", default=None,
                           help="源根目录（首次采集必填，续采可省略）")
    p_collect.add_argument("--max-files", type=int, default=None)
    p_collect.add_argument("--max-bytes", type=int, default=None)
    p_collect.add_argument("--json", action="store_true")
    p_collect.set_defaults(func=_cmd_collect)

    p_info = sub.add_parser("info", help="查看案件状态与条目明细")
    p_info.add_argument("case_dir")
    p_info.add_argument("-v", "--verbose", action="store_true",
                        help="显示每条记录的详细说明")
    p_info.add_argument("--json", action="store_true")
    p_info.set_defaults(func=_cmd_info)

    p_verify = sub.add_parser("verify", help="复核副本与清单一致性")
    p_verify.add_argument("case_dir")
    p_verify.add_argument("--check-source", action="store_true",
                          help="额外只读对比源根目录当前状态")
    p_verify.add_argument("--json", action="store_true")
    p_verify.set_defaults(func=_cmd_verify)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
