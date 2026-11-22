"""迁移报告的数据结构与人类可读渲染。

报告 JSON 是 ``compare`` 子命令的输入, 因此字段名和顺序保持稳定。
文本渲染按步骤分组, 每条改动都明确给出 原值 / 新值 / 规则 / 来源。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Any

REPORT_VERSION = 1


def _jsonable(value: Any) -> Any:
    if isinstance(value, float):
        # 严格的 JSON 不接受 NaN/Infinity; 报告里改成字符串, 既保留信息又可再次读入。
        try:
            finite = math.isfinite(value)
        except (OverflowError, ValueError):
            finite = False
        if not finite:
            if value != value:  # NaN
                return "NaN"
            return "Infinity" if value > 0 else "-Infinity"
        # 避免 -0.0 和浮点噪声在报告里换一种写法。
        if value == 0:
            return 0.0
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def format_value(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, float):
        return json.dumps(_jsonable(value), ensure_ascii=False)
    return json.dumps(_jsonable(value), ensure_ascii=False, sort_keys=True)


@dataclass
class Change:
    step: str
    key: str
    kind: str
    path: str
    label: str
    old: Any
    new: Any
    rule: str
    source_pointer: str | None = None
    note: str | None = None

    def to_dict(self) -> dict:
        return {
            "step": self.step,
            "key": self.key,
            "kind": self.kind,
            "path": self.path,
            "label": self.label,
            "old": _jsonable(self.old),
            "new": _jsonable(self.new),
            "rule": self.rule,
            "source_pointer": self.source_pointer,
            "note": self.note,
        }


@dataclass
class Problem:
    code: str
    message: str
    path: str | None = None
    old: Any = None
    new: Any = None
    rule: str | None = None
    source_pointer: str | None = None
    detail: str | None = None

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "path": self.path,
            "old": _jsonable(self.old),
            "new": _jsonable(self.new),
            "rule": self.rule,
            "source_pointer": self.source_pointer,
            "detail": self.detail,
        }

    def identity(self) -> tuple:
        return (self.code, self.path, self.message)


@dataclass
class Report:
    mode: str
    source: dict
    rules: dict
    source_version: int | None
    target_version: int
    status: str
    steps: list[str] = field(default_factory=list)
    changes: list[Change] = field(default_factory=list)
    warnings: list[Problem] = field(default_factory=list)
    errors: list[Problem] = field(default_factory=list)
    validation: dict[str, dict] = field(default_factory=dict)
    progress: dict | None = None
    output: dict | None = None
    notes: list[str] = field(default_factory=list)

    # ------------------------------------------------------------ 序列化

    def to_dict(self) -> dict:
        errors = _dedupe_errors(self.errors)
        return {
            "report_version": REPORT_VERSION,
            "mode": self.mode,
            "status": self.status,
            "source": self.source,
            "rules": self.rules,
            "versions": {
                "source": self.source_version,
                "target": self.target_version,
                "steps": list(self.steps),
            },
            "changes": [change.to_dict() for change in self.changes],
            "warnings": [_problem_to_dict(problem) for problem in self.warnings],
            "errors": [_problem_to_dict(problem) for problem in errors],
            "validation": {
                name: {
                    "ok": entry.get("ok", not entry.get("problems")),
                    "problems": [_problem_to_dict(problem) for problem in entry.get("problems", [])],
                }
                for name, entry in self.validation.items()
            },
            "progress": _jsonable(self.progress),
            "output": _jsonable(self.output),
            "notes": [str(note) for note in self.notes],
        }

    def blocks_output(self) -> bool:
        return bool(self.errors)

    # ------------------------------------------------------------ 文本

    def render_text(self) -> str:
        lines: list[str] = []
        title = {
            "preview": "存档迁移预览",
            "migrate": "存档迁移结果",
            "check": "存档检查",
            "inspect": "存档概览",
            "compare": "迁移报告对照",
        }.get(self.mode, "存档迁移报告")
        lines.append(f"== {title} ==")
        lines.append(f"源文件: {self.source.get('path')}")
        lines.append(f"SHA-256: {self.source.get('sha256')}")
        version = self.source.get("version")
        label = self.source.get("version_label")
        build = self.source.get("build")
        if version is not None:
            lines.append(f"源版本: v{version} {label or ''} ({build or '未知构建'})".rstrip())
        else:
            lines.append("源版本: 无法识别")
        lines.append(
            f"规则: {self.rules.get('path')}  digest={str(self.rules.get('digest') or '')[:12]}"
        )
        if self.target_version:
            lines.append(f"目标版本: v{self.target_version}")
        if self.steps:
            lines.append(f"迁移路径: {' -> '.join(step for step in self.steps)}")

        if self.mode == "inspect":
            if self.status == "current":
                lines.append("结果: 当前版本，关键进度如下")
            else:
                lines.append(
                    f"结果: v{version} 存档，可迁移到 v{self.target_version}；"
                    "关键进度如下（未做校验，校验请用 check）"
                )
        elif self.mode == "check":
            if self.status == "blocked":
                lines.append(
                    f"结果: 关键字段未通过 (阻断问题 {len(_dedupe_errors(self.errors))} 个)"
                )
            else:
                lines.append("结果: 关键字段通过")
        elif self.status == "ok":
            lines.append(
                f"结果: 可迁移 (改动 {len(self.changes)} 项, 警告 {len(self.warnings)} 条, 阻断问题 0 个)"
            )
        elif self.status == "blocked":
            lines.append(
                f"结果: 已阻断 — 不写出任何存档 (改动 {len(self.changes)} 项, "
                f"警告 {len(self.warnings)} 条, 阻断问题 {len(_dedupe_errors(self.errors))} 个)"
            )
        elif self.status == "current":
            lines.append("结果: 已是最新版本，无需迁移")
        else:
            lines.append(f"结果: {self.status}")

        if self.mode in ("preview", "migrate") and self.changes:
            lines.append("")
            lines.append("改动明细")
            current_step = None
            index = 0
            for change in self.changes:
                if change.step != current_step:
                    current_step = change.step
                    lines.append(f"--- {current_step} ---")
                index += 1
                lines.append(f"{index}. [{change.step}] {change.label}  {change.path}")
                lines.append(f"   原值: {format_value(change.old)}")
                lines.append(f"   新值: {format_value(change.new)}")
                lines.append(f"   规则: {change.rule}")
                if change.source_pointer:
                    lines.append(f"   来源: {change.source_pointer}")
                if change.note:
                    lines.append(f"   说明: {change.note}")
        elif self.mode in ("preview", "migrate"):
            lines.append("")
            lines.append("改动明细: 无")

        if self.warnings:
            lines.append("")
            lines.append("警告:")
            for problem in self.warnings:
                lines.append(f"  - [{problem.code}] {problem.message}")
                extra = _problem_extra(problem)
                if extra:
                    lines.append(f"    {extra}")

        errors = _dedupe_errors(self.errors)
        if errors:
            lines.append("")
            lines.append("阻断问题:")
            for problem in errors:
                lines.append(f"  - [{problem.code}] {problem.message}")
                extra = _problem_extra(problem)
                if extra:
                    lines.append(f"    {extra}")

        if self.validation:
            lines.append("")
            lines.append("校验:")
            labels = {
                "source": "源档关键字段",
                "plan": "迁移规则适用",
                "output": "迁移后结构与范围",
                "re_read": "输出重新读入",
                "invariants": "关键进度保持",
                "written": "写出后复核",
            }
            for name, entry in self.validation.items():
                problems = entry.get("problems", [])
                ok = entry.get("ok", not problems)
                mark = "通过" if ok else f"未通过 ({len(problems)} 项)"
                lines.append(f"  {labels.get(name, name)}: {mark}")

        if self.notes:
            lines.append("")
            lines.append("说明:")
            for note in self.notes:
                lines.append(f"  - {note}")

        if self.output is not None:
            lines.append("")
            lines.append(f"输出: {_render_output(self.output)}")
        elif self.mode == "preview":
            lines.append("")
            lines.append("输出: 预览模式，未写出存档")
        elif self.mode == "migrate" and self.status == "current":
            lines.append("")
            lines.append("输出: 源档已是当前版本，未写出存档")
        elif self.mode == "migrate":
            lines.append("")
            lines.append("输出: 无（未写出存档）")

        if self.progress:
            lines.append("")
            lines.append("关键进度:")
            lines.extend(_render_progress(self.progress))

        return "\n".join(lines)


def _dedupe_errors(errors: list[Problem]) -> list[Problem]:
    seen = set()
    result = []
    for problem in errors:
        identity = problem.identity()
        if identity in seen:
            continue
        seen.add(identity)
        result.append(problem)
    return result


def _problem_to_dict(problem: Problem | dict) -> dict:
    """校验项里可能混有从异常转来的普通 dict, 统一成报告结构。"""

    if isinstance(problem, Problem):
        return problem.to_dict()
    return dict(problem)


def _problem_extra(problem: Problem) -> str:
    parts = []
    if problem.path:
        parts.append(f"路径: {problem.path}")
    if problem.old is not None:
        parts.append(f"原值: {format_value(problem.old)}")
    if problem.new is not None:
        parts.append(f"新值: {format_value(problem.new)}")
    if problem.rule:
        parts.append(f"规则: {problem.rule}")
    if problem.source_pointer:
        parts.append(f"来源: {problem.source_pointer}")
    if problem.detail:
        parts.append(f"详情: {problem.detail}")
    return " | ".join(parts)


def _render_output(output: dict) -> str:
    mode = output.get("mode")
    path = output.get("path")
    if mode == "written":
        return f"已写出 {path} (sha256={str(output.get('sha256') or '')[:12]})"
    if mode == "overwritten":
        return f"已覆盖 {path} (sha256={str(output.get('sha256') or '')[:12]})"
    if mode == "reused":
        return f"已存在且内容一致，未重复写入 {path} (sha256={str(output.get('sha256') or '')[:12]})"
    if mode == "dry-run":
        target = f"将写到 {path}" if output.get("would_write") else f"不会写入 {path}"
        return f"试运行，{target}"
    return json.dumps(_jsonable(output), ensure_ascii=False)


def _render_progress(progress: dict) -> list[str]:
    lines: list[str] = []
    player = progress.get("player") or {}
    if player:
        lines.append(
            f"  玩家: {player.get('name')} 等级 {player.get('level')} 经验 {player.get('xp')}"
        )
    location = progress.get("location") or {}
    if location:
        where = location.get("region") or location.get("map")
        checkpoint = f" 检查点 {location.get('checkpoint')}" if location.get("checkpoint") else ""
        lines.append(f"  位置: {where} ({location.get('x')}, {location.get('y')}){checkpoint}")
    inventory = progress.get("inventory") or {}
    if inventory:
        lines.append(
            f"  背包: {inventory.get('slot_count')} 格 / 共 {inventory.get('total_qty')} 件"
        )
        for item in inventory.get("items", []):
            name = item.get("name") or "未知物品"
            lines.append(f"    - {item.get('id')} {name} x{item.get('qty')}")
    quests = progress.get("quests") or {}
    if quests:
        lines.append(
            f"  支线: 进行中 {quests.get('active_count')} 条 / 已完成 {quests.get('completed_count')} 条"
        )
        for quest in quests.get("entries", []):
            progress_text = _quest_progress_text(quest)
            name = quest.get("name") or "未知支线"
            lines.append(f"    - {quest.get('id')} {name}: {progress_text}")
    return lines


def _quest_progress_text(quest: dict) -> str:
    status = quest.get("status")
    if "chapter" in quest and "step" in quest:
        where = f"第{quest['chapter']}章第{quest['step']}步"
    elif "stage" in quest:
        where = f"stage {quest['stage']}"
    else:
        where = "进度未知"
    if status == "complete":
        return f"已完成 ({where})"
    if status == "active":
        return f"进行中 ({where})"
    return where
