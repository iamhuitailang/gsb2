"""迁移计划、校验与（原子）写出。

整体流程:
1. 读取源档并做结构检查;
2. 逐步生成迁移计划 (每一步都记录 原值 / 新值 / 规则 / 来源);
3. 对计划结果做结构与范围校验;
4. 把结果序列化成字节, 再从字节重新解析并校验, 与源档做关键进度比对;
5. 全部通过且需要写出时, 才用临时文件 + ``os.replace`` 原子落盘;
6. 重新读入落盘文件, 确认与计划一致。源文件全程只读。
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import tempfile
from pathlib import Path
from typing import Any

from . import checks
from .errors import MigrationError, SaveReadError, ValidationError
from .formats import CURRENT_VERSION, SUPPORTED_VERSIONS, Save, read_save, validate_shape
from .report import Change, Problem, Report, format_value
from .rules import Rules, load_rules

DEFAULT_RULES = Path(__file__).resolve().parent.parent / "rules" / "default_rules.json"
TOOL_VERSION = "save-migrator/1"
STEPS = {1: "1->2", 2: "2->3"}

# 顶层字段集合; 其余字段只记录警告, 但仍会原样携带。
TOP_LEVEL_FIELDS = {
    1: {"format", "meta", "player", "location", "inventory", "quests"},
    2: {"format", "meta", "player", "location", "inventory", "quests"},
    3: {"format", "meta", "player", "location", "inventory", "quests", "migration"},
}


class OutputConflictError(MigrationError):
    """目标路径已有内容不同的存档, 默认不覆盖。"""

    kind = "output-conflict"


# ---------------------------------------------------------------- 入口


def resolve_rules(rules: Rules | str | Path | None) -> Rules:
    if isinstance(rules, Rules):
        return rules
    return load_rules(rules or DEFAULT_RULES)


def inspect_save(path: str | Path, rules: Rules | str | Path | None = None) -> Report:
    resolved = resolve_rules(rules)
    source = read_save(path)
    report = _base_report("inspect", source, resolved)
    report.progress = checks.snapshot_progress(source.raw, resolved)
    report.status = "current" if source.version == CURRENT_VERSION else "ok"
    if source.version != CURRENT_VERSION:
        report.notes.append(f"可迁移到 v{CURRENT_VERSION}；先用 preview 查看改动。")
    return report


def check_save(path: str | Path, rules: Rules | str | Path | None = None) -> Report:
    """检查任意受支持版本的关键字段; 不做迁移。"""

    resolved = resolve_rules(rules)
    source = read_save(path)
    report = _base_report("check", source, resolved)
    report.progress = checks.snapshot_progress(source.raw, resolved)
    source_problems = checks.check_source(source.raw, resolved)
    report.validation["source"] = {"ok": not source_problems, "problems": source_problems}
    problems = list(source_problems)
    if source.version == CURRENT_VERSION:
        output_problems = checks.check_output(source.raw, resolved)
        report.validation["output"] = {"ok": not output_problems, "problems": output_problems}
        problems.extend(output_problems)
    report.errors.extend(problems)
    report.status = "blocked" if problems else "ok"
    if source.version != CURRENT_VERSION:
        report.notes.append(
            f"该档为 v{source.version}，check 只做源档检查；迁移请用 preview / migrate。"
        )
    return report


def preview_save(
    path: str | Path,
    rules: Rules | str | Path | None = None,
) -> Report:
    return migrate_file(path, None, rules, preview=True)


def migrate_file(
    path: str | Path,
    output: str | Path | None,
    rules: Rules | str | Path | None = None,
    *,
    preview: bool = False,
    force: bool = False,
) -> Report:
    """生成迁移计划; ``preview=True`` 或 ``output=None`` 时不写存档。"""

    if not preview and output is None:
        raise ValueError("migrate_file 需要 output, 或显式传 preview=True")
    resolved = resolve_rules(rules)
    source = read_save(path)
    report = _base_report("preview" if preview else "migrate", source, resolved)

    if source.version == CURRENT_VERSION:
        report.progress = checks.snapshot_progress(source.raw, resolved)
        report.notes.append("源档已经是当前格式，没有执行迁移，也不会写出新文件。")
        source_problems = checks.check_source(source.raw, resolved)
        output_problems = checks.check_output(source.raw, resolved)
        report.validation["source"] = {"ok": not source_problems, "problems": source_problems}
        report.validation["output"] = {"ok": not output_problems, "problems": output_problems}
        if source_problems or output_problems:
            report.errors = source_problems + output_problems
            report.status = "blocked"
            report.notes.append("当前版本存档本身未通过关键字段校验，请先修复源档。")
        else:
            report.status = "current"
        return report

    plan = _Planner(source, resolved, report)
    planned = plan.run()
    report.steps = plan.steps
    report.progress = checks.snapshot_progress(planned, resolved)

    # ---- 校验 1: 源档关键字段
    source_problems = checks.check_source(source.raw, resolved)
    report.validation["source"] = {"ok": not source_problems, "problems": source_problems}

    # ---- 校验 2: 迁移规则是否完整适用
    plan_problems = [problem for problem in report.errors]
    report.validation["plan"] = {"ok": not plan_problems, "problems": list(plan_problems)}

    # ---- 校验 3: 目标结构与范围
    output_problems = checks.check_output(planned, resolved)
    report.validation["output"] = {"ok": not output_problems, "problems": output_problems}

    # ---- 校验 4: 序列化后重新读入
    try:
        payload = _serialize(planned)
        serialize_problems: list[Problem] = []
    except (TypeError, ValueError) as exc:
        # 例如坐标里混入 NaN/Infinity, 不能写出非法 JSON。
        payload = b""
        serialize_problems = [
            Problem(
                code="output-not-serializable",
                message="迁移结果无法序列化为合法 JSON",
                detail=str(exc),
            )
        ]
    if serialize_problems:
        reread_problems: list[Problem] = list(serialize_problems)
        reread: dict | None = None
    else:
        reread_problems, reread = _reread(payload, resolved)
    report.validation["re_read"] = {"ok": not reread_problems, "problems": reread_problems}

    # ---- 校验 5: 关键进度不变量
    invariant_problems: list[Problem] = []
    if reread is not None:
        invariant_problems = _check_invariants(source.raw, planned, reread, resolved, plan)
    report.validation["invariants"] = {"ok": not invariant_problems, "problems": invariant_problems}

    _collect_errors(report)
    report.status = "blocked" if report.errors else "ok"

    if preview:
        report.notes.append("预览模式：只显示改动，不写任何存档文件。")
        return report

    if report.errors:
        report.notes.append("存在阻断问题，未写出存档；修复后可对同一份原档重跑。")
        return report

    report.output = _write_output(
        output_path=Path(output),
        source=source,
        payload=payload,
        report=report,
        rules=resolved,
        force=force,
    )
    return report


# ---------------------------------------------------------------- 计划器


class _Planner:
    """把源档逐步升级, 同时记录改动、警告和阻断问题。"""

    def __init__(self, source: Save, rules: Rules, report: Report) -> None:
        self.source = source
        self.rules = rules
        self.report = report
        self.steps: list[str] = []
        self.dropped_item_qty = 0
        self.dropped_item_count = 0
        self.failed_slot_qty = 0
        self.failed_slot_count = 0
        self.merged_slot_count = 0
        self.mapped_item_count = 0
        # 版本 -> 与 entries 对齐的"最初源档路径"列表。
        self.item_origins: dict[int, list[str]] = {}
        self.quest_origins: dict[Any, str] = {}
        self.location_origin: str | None = None
        self.coord_origins: dict[str, str] = {}

    def run(self) -> dict:
        self.report.warnings.extend(_dropped_top_level_fields(self.source.raw, self.source.version))
        data = copy.deepcopy(self.source.raw)
        version = self.source.version
        while version < CURRENT_VERSION:
            step = STEPS[version]
            self.steps.append(step)
            self.report.changes.append(
                Change(
                    step=step,
                    key="format",
                    kind="format",
                    path="$.format",
                    label="存档格式版本",
                    old=version,
                    new=version + 1,
                    rule=f"versions[{version}] -> versions[{version + 1}]",
                )
            )
            data = self._step(data, version, step)
            version += 1
        data["format"] = CURRENT_VERSION
        data["migration"] = self._migration_block()
        return data

    def _step(self, data: dict, version: int, step: str) -> dict:
        # 保留本工具不认识的顶层字段, 让 meta/player 等扩展数据不丢失;
        # 无法表达的字段已在 run() 开头记为警告。
        target = copy.deepcopy(data)
        target.update(
            {
                "format": version + 1,
                "meta": copy.deepcopy(data.get("meta") or {}),
                "player": copy.deepcopy(data.get("player") or {}),
                "location": self._location(data.get("location") or {}, version, step),
                "inventory": self._inventory(data.get("inventory") or {}, version, step),
                "quests": self._quests(data.get("quests"), version, step),
            }
        )
        return target

    # ------------------------------------------------------------ 背包

    def _inventory(self, inventory: dict, version: int, step: str) -> dict:
        source_key = "items" if version == 1 else "slots"
        id_key = "item" if version == 1 else "id"
        entries = inventory.get(source_key)
        entries = entries if isinstance(entries, list) else []
        item_map = self.rules.item_map(step)
        removed = self.rules.removed_items(step)
        source_catalog = self.rules.item_catalog(version)
        target_catalog = self.rules.item_catalog(version + 1)
        origins_in = self.item_origins.get(version)

        slots: list[dict] = []
        origins_out: list[str] = []
        slot_by_id: dict[Any, dict] = {}
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                # 结构检查已在 formats 阶段拒绝; 这里只是兜底。
                continue
            old_id = entry.get(id_key)
            qty = entry.get("qty")
            current_pointer = f"$.inventory.{source_key}[{index}].{id_key}"
            source_pointer = origins_in[index] if origins_in and index < len(origins_in) else current_pointer
            old_name = source_catalog.get(str(old_id), "未知物品")
            key = str(old_id)

            if key in removed:
                reason = removed[key]
                self.dropped_item_count += 1
                if _is_int(qty) and qty > 0:
                    self.dropped_item_qty += qty
                self.report.warnings.append(
                    Problem(
                        code="item-removed",
                        message=(
                            f"物品 {old_id}（{old_name}）按规则在 {step} 移除：{reason}。"
                            f"该格 {format_value(qty)} 件不会带入新版本。"
                        ),
                        path=current_pointer,
                        old={"id": old_id, "name": old_name, "qty": qty},
                        rule=f"removed_items[{step}]",
                        source_pointer=source_pointer,
                    )
                )
                self.report.changes.append(
                    Change(
                        step=step,
                        key="item-removed",
                        kind="item-removed",
                        path=current_pointer,
                        label=f"物品移除: {old_id} {old_name}",
                        old={"id": old_id, "name": old_name, "qty": qty},
                        new=None,
                        rule=f"removed_items[{step}]: {reason}",
                        source_pointer=source_pointer,
                        note="保留来源记录，便于策划核对丢失内容",
                    )
                )
                continue

            new_id = item_map.get(key)
            if new_id is None:
                self.report.errors.append(
                    Problem(
                        code="item-unmapped",
                        message=(
                            f"物品编号 {old_id}（{old_name}）在 {step} 的规则中既没有映射, "
                            f"也没有标记为移除，无法迁移。"
                        ),
                        path=current_pointer,
                        old={"id": old_id, "name": old_name, "qty": qty},
                        rule=f"items[{step}] / removed_items[{step}]",
                        source_pointer=source_pointer,
                    )
                )
                self.report.changes.append(
                    Change(
                        step=step,
                        key="item-unmapped",
                        kind="item-unmapped",
                        path=current_pointer,
                        label=f"物品缺映射: {old_id} {old_name}",
                        old={"id": old_id, "name": old_name, "qty": qty},
                        new=None,
                        rule=f"items[{step}] / removed_items[{step}]",
                        source_pointer=source_pointer,
                    )
                )
                # 该格无法映射, 不再带入下一步, 避免同一问题在后续步骤重复报;
                # 不变量校验会把这一格从预期数量里扣除。结果已阻断, 不会写出。
                self.failed_slot_count += 1
                if _is_int(qty) and qty > 0:
                    self.failed_slot_qty += qty
                continue

            slot = copy.deepcopy(entry)
            slot.pop("item", None)
            slot["id"] = new_id
            if new_id in slot_by_id:
                # 两个旧编号映射到同一新编号时合并堆叠, 而不是写出重复物品。
                previous = slot_by_id[new_id]
                if _is_int(previous.get("qty")) and _is_int(qty):
                    previous["qty"] += qty
                self.merged_slot_count += 1
                self.report.warnings.append(
                    Problem(
                        code="item-merged",
                        message=(
                            f"物品 {old_id}（{old_name}）映射到 {new_id} 时与已有格合并，"
                            f"数量合并为 {previous.get('qty')}。"
                        ),
                        path=current_pointer,
                        old={"id": old_id, "qty": qty},
                        new={"id": new_id, "qty": previous.get("qty")},
                        rule=f"items[{step}][{old_id}] = {new_id}",
                        source_pointer=source_pointer,
                    )
                )
                continue
            slot_by_id[new_id] = slot
            slots.append(slot)
            origins_out.append(source_pointer)
            self.mapped_item_count += 1

            new_name = target_catalog.get(str(new_id), "未知物品")
            note = f"{old_name} → {new_name}"
            if old_id != new_id:
                self.report.changes.append(
                    Change(
                        step=step,
                        key="item-id",
                        kind="item-id",
                        path=current_pointer,
                        label=f"物品编号映射: {old_name}",
                        old=old_id,
                        new=new_id,
                        rule=f"items[{step}][{old_id}] = {new_id}",
                        source_pointer=source_pointer,
                        note=note,
                    )
                )

        result: dict[str, Any] = {
            key: copy.deepcopy(value) for key, value in inventory.items() if key != source_key
        }
        result["slots"] = slots
        self.item_origins[version + 1] = origins_out
        return result

    # ------------------------------------------------------------ 位置

    def _location(self, location: dict, version: int, step: str) -> dict:
        source_key = "map" if version == 1 else "region"
        old_region = location.get(source_key)
        region_map = self.rules.region_map(step)
        current_pointer = f"$.location.{source_key}"
        source_pointer = self.location_origin or current_pointer
        new_region = region_map.get(str(old_region))

        if new_region is None:
            self.report.errors.append(
                Problem(
                    code="region-unmapped",
                    message=(
                        f"地图区域 {old_region!r} 在 {step} 的规则中没有映射，"
                        f"无法确定新版本位置。"
                    ),
                    path=current_pointer,
                    old=old_region,
                    rule=f"regions[{step}]",
                    source_pointer=source_pointer,
                )
            )
            self.report.changes.append(
                Change(
                    step=step,
                    key="region-unmapped",
                    kind="region-unmapped",
                    path=current_pointer,
                    label="区域缺映射",
                    old=old_region,
                    new=None,
                    rule=f"regions[{step}]",
                    source_pointer=source_pointer,
                )
            )
            new_region = old_region
        elif new_region != old_region:
            self.report.changes.append(
                Change(
                    step=step,
                    key="region",
                    kind="region",
                    path=current_pointer,
                    label="地图区域调整",
                    old=old_region,
                    new=new_region,
                    rule=f"regions[{step}][{old_region}] = {new_region}",
                    source_pointer=source_pointer,
                )
            )

        transform = self.rules.map_transform(step)
        scale = transform["scale"]
        offset_x = transform["offset_x"]
        offset_y = transform["offset_y"]
        formula = f"(x, y) * {scale} + ({offset_x}, {offset_y})"

        # 保留源档里本工具不认识的附加字段（例如朝向），避免静默丢失。
        new_location: dict[str, Any] = {
            key: copy.deepcopy(value)
            for key, value in location.items()
            if key not in (source_key, "region", "x", "y", "checkpoint")
        }
        new_location["region"] = new_region
        for axis, offset in (("x", offset_x), ("y", offset_y)):
            self.coord_origins.setdefault(axis, f"$.location.{axis}")
            old_value = location.get(axis)
            if isinstance(old_value, bool) or not isinstance(old_value, (int, float)):
                # 源档检查会记为阻断问题; 这里保留原值让后续校验也可见。
                new_value = old_value
            else:
                try:
                    finite = math.isfinite(old_value)
                except (OverflowError, ValueError):
                    finite = False
                if not finite:
                    new_value = old_value
                else:
                    new_value = _clean_number(old_value * scale + offset)
                    if new_value != old_value:
                        self.report.changes.append(
                            Change(
                                step=step,
                                key=f"coord-{axis}",
                                kind="coordinate",
                                path=f"$.location.{axis}",
                                label=f"地图坐标 {axis}",
                                old=old_value,
                                new=new_value,
                                rule=f"map_transforms[{step}] {formula}",
                                source_pointer=self.coord_origins[axis],
                            )
                        )
            new_location[axis] = new_value

        if self.location_origin is None:
            self.location_origin = source_pointer

        if version + 1 == CURRENT_VERSION:
            checkpoint = self.rules.checkpoints().get(str(new_region))
            if checkpoint is None:
                self.report.errors.append(
                    Problem(
                        code="checkpoint-missing",
                        message=f"区域 {new_region!r} 没有检查点配置，迁移结果会缺少出生点。",
                        path="$.location.checkpoint",
                        new=new_region,
                        rule="checkpoints",
                        source_pointer=source_pointer,
                    )
                )
            else:
                new_location["checkpoint"] = checkpoint
                self.report.changes.append(
                    Change(
                        step=step,
                        key="checkpoint",
                        kind="checkpoint",
                        path="$.location.checkpoint",
                        label="区域检查点",
                        old=None,
                        new=checkpoint,
                        rule=f"checkpoints[{new_region}] = {checkpoint}",
                        source_pointer=source_pointer,
                    )
                )
        return new_location

    # ------------------------------------------------------------ 支线

    def _quests(self, quests: Any, version: int, step: str) -> dict:
        if version == 1:
            return self._quests_1_to_2(quests, step)
        return self._quests_2_to_3(quests, step)

    def _quests_1_to_2(self, quests: Any, step: str) -> dict:
        entries = quests if isinstance(quests, list) else []
        grouped: dict[str, list[dict]] = {"active": [], "completed": []}
        for index, quest in enumerate(entries):
            if not isinstance(quest, dict):
                continue
            pointer = f"$.quests[{index}].done"
            quest_origin = f"$.quests[{index}]"
            quest_id = quest.get("id")
            if quest_id is not None:
                self.quest_origins[str(quest_id)] = quest_origin
            done = quest.get("done")
            # done 不是布尔值由源档检查报告; 这里按未完成处理, 保证预览能走完。
            bucket = "completed" if done is True else "active"
            migrated = copy.deepcopy(quest)
            migrated.pop("done", None)
            grouped[bucket].append(migrated)
            self.report.changes.append(
                Change(
                    step=step,
                    key="quest-bucket",
                    kind="quest-bucket",
                    path=pointer,
                    label=f"支线分组: {quest.get('id')}",
                    old=done,
                    new=f"quests.{bucket}",
                    rule=f"quests[{step}] done={done!r} -> {bucket}",
                    source_pointer=f"$.quests[{index}]",
                )
            )
        return grouped

    def _quests_2_to_3(self, quests: Any, step: str) -> dict:
        source = quests if isinstance(quests, dict) else {}
        split_map = self.rules.quest_stage_split(step)
        grouped: dict[str, list[dict]] = {"active": [], "completed": []}
        for bucket, status in (("active", "active"), ("completed", "complete")):
            entries = source.get(bucket)
            entries = entries if isinstance(entries, list) else []
            for index, quest in enumerate(entries):
                if not isinstance(quest, dict):
                    continue
                stage = quest.get("stage")
                pointer = f"$.quests.{bucket}[{index}].stage"
                quest_origin = self.quest_origins.get(str(quest.get("id"))) or f"$.quests.{bucket}[{index}]"
                parts = split_map.get(str(stage))
                migrated = copy.deepcopy(quest)
                migrated.pop("stage", None)
                migrated["status"] = status
                if parts is None:
                    self.report.errors.append(
                        Problem(
                            code="quest-stage-unmapped",
                            message=(
                                f"支线 {quest.get('id')!r} 的 stage={stage!r} 在 {step} "
                                f"的拆分规则中不存在，无法拆成章节/步骤。"
                            ),
                            path=pointer,
                            old=stage,
                            rule=f"quest_stage_split[{step}]",
                            source_pointer=quest_origin,
                        )
                    )
                    self.report.changes.append(
                        Change(
                            step=step,
                            key="quest-stage-unmapped",
                            kind="quest-stage-unmapped",
                            path=pointer,
                            label=f"支线进度缺拆分规则: {quest.get('id')}",
                            old=stage,
                            new=None,
                            rule=f"quest_stage_split[{step}]",
                            source_pointer=quest_origin,
                        )
                    )
                    # 保留原 stage, 便于报告定位; 该校验失败后不会写出。
                    migrated["stage"] = stage
                else:
                    migrated["chapter"] = parts["chapter"]
                    migrated["step"] = parts["step"]
                    self.report.changes.append(
                        Change(
                            step=step,
                            key="quest-split",
                            kind="quest-split",
                            path=pointer,
                            label=f"支线进度拆分: {quest.get('id')}",
                            old=stage,
                            new={"chapter": parts["chapter"], "step": parts["step"]},
                            rule=f"quest_stage_split[{step}][{stage}]",
                            source_pointer=quest_origin,
                        )
                    )
                self.report.changes.append(
                    Change(
                        step=step,
                        key="quest-status",
                        kind="quest-status",
                        path=f"$.quests.{bucket}[{index}].status",
                        label=f"支线状态: {quest.get('id')}",
                        old=bucket,
                        new=status,
                        rule=f"quests[{step}] {bucket} -> status={status!r}",
                        source_pointer=quest_origin,
                    )
                )
                grouped[bucket].append(migrated)
        return grouped

    # ------------------------------------------------------------ 元数据

    def _migration_block(self) -> dict:
        warnings = [
            {
                "code": problem.code,
                "message": problem.message,
                "path": problem.path,
                "rule": problem.rule,
                "source_pointer": problem.source_pointer,
                "old": problem.old,
                "new": problem.new,
            }
            for problem in self.report.warnings
        ]
        history = [
            {
                "step": change.step,
                "kind": change.kind,
                "path": change.path,
                "old": change.old,
                "new": change.new,
                "rule": change.rule,
                "source_pointer": change.source_pointer,
            }
            for change in self.report.changes
            if change.step != "final"
        ]
        return {
            "tool": TOOL_VERSION,
            "source_format": self.source.version,
            "source_sha256": self.source.sha256,
            "rules_digest": self.rules.digest,
            "steps": list(self.steps),
            "history": history,
            "warnings": warnings,
        }


# ---------------------------------------------------------------- 序列化/校验


def _clean_number(value: float) -> float | int:
    try:
        rounded = round(float(value), 6)
    except (OverflowError, ValueError):
        return value
    if not math.isfinite(rounded):
        # 极端坐标会在输出校验里被拒绝, 这里不再强行取整。
        return value
    if rounded == int(rounded):
        return int(rounded)
    return rounded


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _serialize(data: dict) -> bytes:
    # allow_nan=False: 坐标里混入 NaN/Infinity 时直接报错, 而不是写出非法 JSON。
    text = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)
    return (text + "\n").encode("utf-8")


def _reread(payload: bytes, rules: Rules) -> tuple[list[Problem], dict | None]:
    """从即将写出的字节重新解析, 提前发现任何写出后才暴露的问题。"""

    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return (
            [
                Problem(
                    code="output-unparseable",
                    message="迁移结果无法被重新解析",
                    detail=str(exc),
                )
            ],
            None,
        )
    if not isinstance(data, dict):
        return [Problem(code="output-not-object", message="迁移结果顶层不是对象")], None
    problems: list[Problem] = []
    try:
        validate_shape(data, CURRENT_VERSION)
    except SaveReadError as exc:
        problems.append(
            Problem(code="output-shape", message=exc.message, detail=exc.detail)
        )
    problems.extend(checks.check_output(data, rules))
    return problems, data


def _check_invariants(
    source: dict,
    planned: dict,
    reread: dict,
    rules: Rules,
    plan: _Planner,
) -> list[Problem]:
    problems: list[Problem] = []
    source_snapshot = checks.snapshot_progress(source, rules)
    target_snapshot = checks.snapshot_progress(reread, rules)
    planned_snapshot = checks.snapshot_progress(planned, rules)

    def differing(name: str, expected: Any, actual: Any, *, note: str = "") -> None:
        if expected != actual:
            problems.append(
                Problem(
                    code=f"invariant-{name}",
                    message=f"关键进度比对失败: {name} 与预期不一致{('（' + note + '）') if note else ''}",
                    old=expected,
                    new=actual,
                )
            )

    differing("player", source_snapshot["player"], target_snapshot["player"], note="玩家名/等级/经验应保持")

    # 位置: 对比计划结果与重新读入结果; 源档位置由坐标规则负责。
    differing(
        "location",
        planned_snapshot["location"],
        target_snapshot["location"],
        note="重新读入后的位置应与迁移计划一致",
    )

    expected_qty = (
        source_snapshot["inventory"]["total_qty"]
        - plan.dropped_item_qty
        - plan.failed_slot_qty
    )
    if target_snapshot["inventory"]["total_qty"] != expected_qty:
        problems.append(
            Problem(
                code="invariant-inventory-total",
                message=(
                    f"背包总数量 {target_snapshot['inventory']['total_qty']} 与预期 {expected_qty} 不一致"
                    f"（源档 {source_snapshot['inventory']['total_qty']}，规则移除 {plan.dropped_item_qty}）"
                ),
                old=expected_qty,
                new=target_snapshot["inventory"]["total_qty"],
            )
        )
    expected_slots = (
        source_snapshot["inventory"]["slot_count"]
        - plan.dropped_item_count
        - plan.merged_slot_count
        - plan.failed_slot_count
    )
    if target_snapshot["inventory"]["slot_count"] != expected_slots:
        problems.append(
            Problem(
                code="invariant-inventory-slots",
                message=(
                    f"背包格数 {target_snapshot['inventory']['slot_count']} 与预期 {expected_slots} 不一致"
                ),
                old=expected_slots,
                new=target_snapshot["inventory"]["slot_count"],
            )
        )

    # 支线: id 集合与状态分组必须保持; 进度按规则拆分。
    try:
        source_quests = {quest["id"]: quest for quest in source_snapshot["quests"]["entries"]}
        target_quests = {quest["id"]: quest for quest in target_snapshot["quests"]["entries"]}
    except TypeError:
        # id 不是可哈希的标量 (例如数组/对象), 无法可靠比对; 交给源档检查报告。
        return problems
    missing = sorted(set(source_quests) - set(target_quests), key=str)
    extra = sorted(set(target_quests) - set(source_quests), key=str)
    if missing:
        problems.append(
            Problem(
                code="invariant-quests-missing",
                message=f"迁移后缺少支线: {missing}",
                old=missing,
                new=[],
            )
        )
    if extra:
        problems.append(
            Problem(
                code="invariant-quests-extra",
                message=f"迁移后多出支线: {extra}",
                old=[],
                new=extra,
            )
        )
    for quest_id, quest in source_quests.items():
        migrated = target_quests.get(quest_id)
        if migrated is None:
            continue
        if quest["status"] != migrated["status"]:
            problems.append(
                Problem(
                    code="invariant-quest-status",
                    message=f"支线 {quest_id} 的状态从 {quest['status']} 变成 {migrated['status']}",
                    old=quest["status"],
                    new=migrated["status"],
                )
            )
        if "chapter" in migrated:
            expected = _expected_chapter_step(source, quest_id, rules)
            actual = (migrated.get("chapter"), migrated.get("step"))
            if expected is not None and expected != actual:
                problems.append(
                    Problem(
                        code="invariant-quest-progress",
                        message=f"支线 {quest_id} 的进度拆分不符合规则: 预期 {expected}, 实际 {actual}",
                        old=expected,
                        new=actual,
                    )
                )
    return problems


def _expected_chapter_step(source: dict, quest_id: Any, rules: Rules) -> tuple[int, int] | None:
    quests = source.get("quests")
    stages: list[Any] = []
    if isinstance(quests, list):  # v1: 支线是平铺数组
        stages = [q.get("stage") for q in quests if isinstance(q, dict) and q.get("id") == quest_id]
    elif isinstance(quests, dict):  # v2: active / completed 两个分组
        for bucket in ("active", "completed"):
            entries = quests.get(bucket)
            if not isinstance(entries, list):
                continue
            stages.extend(
                quest.get("stage") for quest in entries if isinstance(quest, dict) and quest.get("id") == quest_id
            )
    if not stages:
        return None
    parts = rules.quest_stage_split("2->3").get(str(stages[0]))
    return (parts["chapter"], parts["step"]) if parts else None


def _collect_errors(report: Report) -> None:
    """把所有校验项的阻断问题汇总去重; 同一个问题只报一次。"""

    collected: list[Problem] = []
    seen: set[tuple] = set()
    for entry in report.validation.values():
        for problem in entry.get("problems", []):
            identity = problem.identity()
            if identity in seen:
                continue
            seen.add(identity)
            collected.append(problem)
    report.errors = collected


# ---------------------------------------------------------------- 写出


def _write_output(
    *,
    output_path: Path,
    source: Save,
    payload: bytes,
    report: Report,
    rules: Rules,
    force: bool,
) -> dict:
    source_path = source.path.resolve()
    target_path = output_path.resolve()
    if target_path == source_path:
        raise OutputConflictError("输出路径不能与源存档相同；原存档必须保持原样。")

    target_path.parent.mkdir(parents=True, exist_ok=True)
    new_sha = hashlib.sha256(payload).hexdigest()
    existed = target_path.exists()
    previous: bytes | None = None

    if existed:
        previous = target_path.read_bytes()
        if previous == payload:
            report.notes.append("目标文件已存在且内容一致，未重复写入（重跑安全）。")
            _verify_written(target_path, payload, source, report, rules)
            return {"mode": "reused", "path": str(target_path), "sha256": new_sha}
        if not force:
            raise OutputConflictError(
                f"目标文件已存在且内容不同: {target_path}",
                detail="默认不覆盖，以免改坏已有结果；确认后加 --force，或换一个输出路径。",
            )

    fd, temp_name = tempfile.mkstemp(prefix=f".{target_path.name}.", suffix=".tmp", dir=target_path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, 0o644)
        os.replace(temp_path, target_path)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise

    # 落盘后再读一遍; 万一写入/复核失败, 回滚到原内容（或删除新文件），
    # 保证目标路径上不会留下一个游戏可能误读的坏存档。
    try:
        _verify_written(target_path, payload, source, report, rules)
    except BaseException:
        if previous is not None:
            target_path.write_bytes(previous)
        else:
            target_path.unlink(missing_ok=True)
        raise

    report.notes.append("输出为原子写入；已重新读入校验，源存档未被修改。")
    mode = "overwritten" if existed else "written"
    return {"mode": mode, "path": str(target_path), "sha256": new_sha}


def _verify_written(
    target_path: Path,
    payload: bytes,
    source: Save,
    report: Report,
    rules: Rules,
) -> None:
    written = target_path.read_bytes()
    if written != payload:
        raise ValidationError(
            "写出后的文件与校验过的内容不一致",
            problems=[Problem(code="write-mismatch", message="写入校验失败", path=str(target_path))],
        )
    _verify_source_untouched(source)
    reread_problems, _ = _reread(written, rules)
    if reread_problems:
        report.validation["written"] = {"ok": False, "problems": reread_problems}
        raise ValidationError(
            "写出后的存档重新读入失败",
            problems=[problem.to_dict() for problem in reread_problems],
        )
    report.validation["written"] = {"ok": True, "problems": []}


def _verify_source_untouched(source: Save) -> None:
    if not source.path.exists():
        raise ValidationError(
            "源存档在迁移过程中被移走",
            problems=[Problem(code="source-missing", message="源存档不存在", path=str(source.path))],
        )
    current = hashlib.sha256(source.path.read_bytes()).hexdigest()
    if current != source.sha256:
        raise ValidationError(
            "源存档内容在迁移过程中发生变化",
            problems=[
                Problem(
                    code="source-changed",
                    message="源存档 SHA-256 与读取时不一致",
                    path=str(source.path),
                    old=source.sha256,
                    new=current,
                )
            ],
        )


# ---------------------------------------------------------------- 报告基座


def _base_report(mode: str, source: Save, rules: Rules) -> Report:
    return Report(
        mode=mode,
        source={
            "path": str(source.path),
            "sha256": source.sha256,
            "version": source.version,
            "version_label": rules.version_label(source.version),
            "build": rules.build(source.version),
        },
        rules={
            "path": str(rules.path),
            "digest": rules.digest,
            "game": rules.game,
        },
        source_version=source.version,
        target_version=CURRENT_VERSION,
        status="ok",
    )


def _dropped_top_level_fields(raw: dict, version: int) -> list[Problem]:
    allowed = TOP_LEVEL_FIELDS[version]
    problems = []
    for key in raw:
        if key in allowed:
            continue
        problems.append(
            Problem(
                code="source-field-unknown",
                message=f"源档顶层字段 {key!r} 不在 v{version} 的格式定义中，已原样保留，请确认游戏能忽略它。",
                path=f"$.{key}",
                old=raw[key],
            )
        )
    return problems


# 供 report.render_text 的进度渲染使用
__all__ = [
    "inspect_save",
    "check_save",
    "preview_save",
    "migrate_file",
    "resolve_rules",
    "OutputConflictError",
    "SUPPORTED_VERSIONS",
]
