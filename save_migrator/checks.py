"""迁移前的关键字段检查与迁移后的不变量校验。

原则: 源档本身如果有坏字段, 迁移仍可以继续走完并生成预览, 但会被记为
阻断问题 (``error``), 不会写出存档。这样策划能一次看到全部受影响内容,
而不是修一个字段重跑一次。
"""

from __future__ import annotations

import math
from typing import Any

from .report import Problem
from .rules import Rules

CURRENT_VERSION = 3


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    # JSON 解析器默认接受超大整数和 NaN/Infinity; 它们都不能作为坐标写入存档。
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _pointer(*parts: object) -> str:
    return "$" + "".join(f"[{part}]" if isinstance(part, int) else f".{part}" for part in parts)


# ---------------------------------------------------------------- 源档检查


def check_source(save: dict, rules: Rules) -> list[Problem]:
    problems: list[Problem] = []
    player = save.get("player") or {}
    if not isinstance(player, dict):  # formats.validate_shape 已拒绝, 这里兜底
        player = {}
    level = player.get("level")
    xp = player.get("xp")
    level_min, level_max = rules.player_limits()["level"]
    xp_min, xp_max = rules.player_limits()["xp"]
    if not _is_int(level) or not (level_min <= level <= level_max):
        problems.append(
            Problem(
                code="player-level-out-of-range",
                message=f"玩家等级 {level!r} 不在允许范围 {level_min}..{level_max}",
                path=_pointer("player", "level"),
                old=level,
                rule=f"player_limits.level = {[level_min, level_max]}",
            )
        )
    if not _is_int(xp) or not (xp_min <= xp <= xp_max):
        problems.append(
            Problem(
                code="player-xp-out-of-range",
                message=f"玩家经验 {xp!r} 不在允许范围 {xp_min}..{xp_max}",
                path=_pointer("player", "xp"),
                old=xp,
                rule=f"player_limits.xp = {[xp_min, xp_max]}",
            )
        )

    location = save.get("location") or {}
    if not isinstance(location, dict):  # formats.validate_shape 已拒绝, 这里兜底
        location = {}
    _check_coords(problems, location, _pointer("location"), "source")

    inventory = save.get("inventory") or {}
    if not isinstance(inventory, dict):
        inventory = {}
    entries = inventory.get("items") if "items" in inventory else inventory.get("slots")
    entries = entries if isinstance(entries, list) else []
    capacity = rules.inventory_capacity()
    if len(entries) > capacity:
        problems.append(
            Problem(
                code="inventory-over-capacity",
                message=f"背包 {len(entries)} 格，超过容量 {capacity}",
                path=_pointer("inventory"),
                old=len(entries),
                new=capacity,
                rule=f"inventory_capacity = {capacity}",
            )
        )
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        id_key = "item" if "items" in inventory else "id"
        item_id = entry.get(id_key)
        if not _is_int(item_id):
            problems.append(
                Problem(
                    code="item-id-invalid",
                    message=f"第 {index} 格物品编号为 {item_id!r}，应为整数",
                    path=_pointer("inventory", "items" if "items" in inventory else "slots", index, id_key),
                    old=item_id,
                    rule="物品编号必须是整数",
                )
            )
        qty = entry.get("qty")
        if not _is_int(qty) or qty <= 0:
            problems.append(
                Problem(
                    code="item-qty-invalid",
                    message=f"第 {index} 格数量为 {qty!r}，应为正整数",
                    path=_pointer("inventory", "items" if "items" in inventory else "slots", index, "qty"),
                    old=qty,
                    rule="qty 必须是正整数",
                )
            )
        elif qty > rules.max_stack():
            problems.append(
                Problem(
                    code="item-stack-too-big",
                    message=f"第 {index} 格数量 {qty} 超过单格上限 {rules.max_stack()}",
                    path=_pointer("inventory", "items" if "items" in inventory else "slots", index, "qty"),
                    old=qty,
                    new=rules.max_stack(),
                    rule=f"max_stack = {rules.max_stack()}",
                )
            )

    _check_source_quests(problems, save)
    return problems


def _check_source_quests(problems: list[Problem], save: dict) -> None:
    version = save.get("format")
    quests = save.get("quests")
    if version == 1:
        entries = quests if isinstance(quests, list) else []
        seen: dict[str, int] = {}
        for index, quest in enumerate(entries):
            if not isinstance(quest, dict):
                continue
            quest_id = quest.get("id")
            if not isinstance(quest_id, str) or not quest_id.strip():
                problems.append(
                    Problem(
                        code="quest-id-invalid",
                        message=f"支线 {index} 的 id 不是非空字符串: {quest_id!r}",
                        path=_pointer("quests", index, "id"),
                        old=quest_id,
                    )
                )
            elif quest_id in seen:
                problems.append(
                    Problem(
                        code="quest-id-duplicate",
                        message=f"支线 id {quest_id!r} 同时出现在第 {seen[quest_id]} 条和第 {index} 条",
                        path=_pointer("quests", index, "id"),
                        old=quest_id,
                    )
                )
            else:
                seen[quest_id] = index
            if not isinstance(quest.get("done"), bool):
                problems.append(
                    Problem(
                        code="quest-done-invalid",
                        message=f"支线 {quest.get('id')!r} 的 done={quest.get('done')!r} 不是布尔值",
                        path=_pointer("quests", index, "done"),
                        old=quest.get("done"),
                        rule="done 必须是 true / false",
                    )
                )
            if not _is_int(quest.get("stage")):
                problems.append(
                    Problem(
                        code="quest-stage-invalid",
                        message=f"支线 {quest.get('id')!r} 的 stage={quest.get('stage')!r} 不是整数",
                        path=_pointer("quests", index, "stage"),
                        old=quest.get("stage"),
                        rule="stage 必须是整数",
                    )
                )
        return
    if not isinstance(quests, dict):
        return
    seen: dict[str, str] = {}
    for bucket in ("active", "completed"):
        entries = quests.get(bucket)
        entries = entries if isinstance(entries, list) else []
        for index, quest in enumerate(entries):
            if not isinstance(quest, dict):
                continue
            quest_id = quest.get("id")
            if not isinstance(quest_id, str) or not quest_id.strip():
                problems.append(
                    Problem(
                        code="quest-id-invalid",
                        message=f"支线 {bucket}[{index}] 的 id 不是非空字符串: {quest_id!r}",
                        path=_pointer("quests", bucket, index, "id"),
                        old=quest_id,
                    )
                )
            elif quest_id in seen:
                problems.append(
                    Problem(
                        code="quest-id-duplicate",
                        message=f"支线 id {quest_id!r} 同时出现在 {seen[quest_id]} 和 {bucket}[{index}]",
                        path=_pointer("quests", bucket, index, "id"),
                        old=quest_id,
                    )
                )
            else:
                seen[quest_id] = f"{bucket}[{index}]"
            if version == 2 and not _is_int(quest.get("stage")):
                problems.append(
                    Problem(
                        code="quest-stage-invalid",
                        message=f"支线 {quest.get('id')!r} 的 stage={quest.get('stage')!r} 不是整数",
                        path=_pointer("quests", bucket, index, "stage"),
                        old=quest.get("stage"),
                        rule="stage 必须是整数",
                    )
                )


def _check_coords(problems: list[Problem], location: dict, path: str, ctx: str) -> None:
    for axis, value in (("x", location.get("x")), ("y", location.get("y"))):
        if not _is_number(value):
            problems.append(
                Problem(
                    code=f"{ctx}-coord-not-number",
                    message=f"坐标 {axis} 不是数字: {value!r}",
                    path=f"{path}.{axis}",
                    old=value,
                    rule="坐标必须是数字",
                )
            )


# ---------------------------------------------------------------- 迁移后检查


def check_output(save: dict, rules: Rules) -> list[Problem]:
    problems: list[Problem] = []

    if save.get("format") != CURRENT_VERSION:
        problems.append(
            Problem(
                code="output-version",
                message=f"迁移结果 format={save.get('format')!r}，应为 {CURRENT_VERSION}",
                path=_pointer("format"),
                old=save.get("format"),
                new=CURRENT_VERSION,
            )
        )

    player = save.get("player") or {}
    if not isinstance(player, dict):
        player = {}
    for field in ("level", "xp"):
        value = player.get(field)
        low, high = rules.player_limits()[field]
        if not _is_int(value) or not (low <= value <= high):
            problems.append(
                Problem(
                    code=f"output-player-{field}",
                    message=f"迁移后玩家 {field}={value!r} 不在 {low}..{high}",
                    path=_pointer("player", field),
                    old=value,
                    rule=f"player_limits.{field}",
                )
            )

    location = save.get("location") or {}
    if not isinstance(location, dict):
        location = {}
    region = location.get("region")
    checkpoints = rules.checkpoints()
    if not isinstance(region, str) or region not in checkpoints:
        problems.append(
            Problem(
                code="output-region-unknown",
                message=f"迁移后区域 {region!r} 不在检查点表中",
                path=_pointer("location", "region"),
                new=region,
                rule="checkpoints",
            )
        )
    bounds = rules.world_bounds()
    for axis in ("x", "y"):
        value = location.get(axis)
        low, high = bounds[axis]
        if not _is_number(value) or not (low <= value <= high):
            problems.append(
                Problem(
                    code=f"output-coord-{axis}",
                    message=f"迁移后坐标 {axis}={value!r} 超出世界范围 {low}..{high}",
                    path=_pointer("location", axis),
                    new=value,
                    rule=f"world_bounds.{axis}",
                )
            )

    inventory = save.get("inventory") or {}
    if not isinstance(inventory, dict):
        inventory = {}
    slots = inventory.get("slots")
    slots = slots if isinstance(slots, list) else []
    capacity = rules.inventory_capacity()
    if len(slots) > capacity:
        problems.append(
            Problem(
                code="output-inventory-over-capacity",
                message=f"迁移后背包 {len(slots)} 格，超过容量 {capacity}",
                path=_pointer("inventory", "slots"),
                new=len(slots),
                rule=f"inventory_capacity = {capacity}",
            )
        )
    catalog = rules.item_catalog(CURRENT_VERSION)
    seen_ids = set()
    for index, slot in enumerate(slots):
        if not isinstance(slot, dict):
            problems.append(
                Problem(
                    code="output-slot-not-object",
                    message=f"第 {index} 格不是对象",
                    path=_pointer("inventory", "slots", index),
                )
            )
            continue
        item_id = slot.get("id")
        qty = slot.get("qty")
        if not _is_int(item_id) or str(item_id) not in catalog:
            problems.append(
                Problem(
                    code="output-item-unknown",
                    message=f"第 {index} 格物品编号 {item_id!r} 不在当前版本物品表中",
                    path=_pointer("inventory", "slots", index, "id"),
                    new=item_id,
                    rule="item_catalog",
                )
            )
        elif item_id in seen_ids:
            problems.append(
                Problem(
                    code="output-item-duplicate",
                    message=f"物品编号 {item_id} 在背包中出现多次",
                    path=_pointer("inventory", "slots", index, "id"),
                    new=item_id,
                )
            )
        else:
            seen_ids.add(item_id)
        if not _is_int(qty) or qty <= 0:
            problems.append(
                Problem(
                    code="output-qty-invalid",
                    message=f"第 {index} 格数量 {qty!r} 不是正整数",
                    path=_pointer("inventory", "slots", index, "qty"),
                    new=qty,
                )
            )
        elif qty > rules.max_stack():
            problems.append(
                Problem(
                    code="output-stack-too-big",
                    message=f"第 {index} 格数量 {qty} 超过单格上限 {rules.max_stack()}",
                    path=_pointer("inventory", "slots", index, "qty"),
                    new=qty,
                    rule=f"max_stack = {rules.max_stack()}",
                )
            )

    quests = save.get("quests") or {}
    if not isinstance(quests, dict) or "active" not in quests or "completed" not in quests:
        problems.append(
            Problem(
                code="output-quests-shape",
                message="迁移后支线缺少 active/completed 分组",
                path=_pointer("quests"),
            )
        )
    else:
        for bucket, expected_status in (("active", "active"), ("completed", "complete")):
            entries = quests.get(bucket)
            if not isinstance(entries, list):
                problems.append(
                    Problem(
                        code="output-quests-shape",
                        message=f"quests.{bucket} 不是数组",
                        path=_pointer("quests", bucket),
                    )
                )
                continue
            for index, quest in enumerate(entries):
                if not isinstance(quest, dict):
                    problems.append(
                        Problem(
                            code="output-quest-shape",
                            message=f"quests.{bucket}[{index}] 不是对象",
                            path=_pointer("quests", bucket, index),
                        )
                    )
                    continue
                if not isinstance(quest.get("id"), str) or not quest["id"].strip():
                    problems.append(
                        Problem(
                            code="output-quest-id",
                            message=f"quests.{bucket}[{index}] 的 id 不是非空字符串: {quest.get('id')!r}",
                            path=_pointer("quests", bucket, index, "id"),
                            new=quest.get("id"),
                        )
                    )
                for field in ("chapter", "step"):
                    value = quest.get(field)
                    if not _is_int(value) or value <= 0:
                        problems.append(
                            Problem(
                                code="output-quest-progress",
                                message=f"支线 {quest.get('id')!r} 的 {field}={value!r} 不是正整数",
                                path=_pointer("quests", bucket, index, field),
                                new=value,
                            )
                        )
                if quest.get("status") != expected_status:
                    problems.append(
                        Problem(
                            code="output-quest-status",
                            message=(
                                f"支线 {quest.get('id')!r} 位于 {bucket} 但 status={quest.get('status')!r}"
                            ),
                            path=_pointer("quests", bucket, index, "status"),
                            new=quest.get("status"),
                            rule=f"status 应为 {expected_status!r}",
                        )
                    )
    return problems


# ---------------------------------------------------------------- 不变量


def snapshot_progress(save: dict, rules: Rules) -> dict:
    """把关键进度抽成可比较的结构; migration 与 compare 都用它。"""

    version = save.get("format")
    player = save.get("player") if isinstance(save.get("player"), dict) else {}
    location = save.get("location") if isinstance(save.get("location"), dict) else {}
    inventory = save.get("inventory") if isinstance(save.get("inventory"), dict) else {}
    entries = inventory.get("items") if "items" in inventory else inventory.get("slots")
    entries = entries if isinstance(entries, list) else []

    items = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        item_id = entry.get("item") if "item" in entry else entry.get("id")
        name = rules.item_catalog(int(version) if isinstance(version, int) else CURRENT_VERSION).get(str(item_id))
        items.append(
            {
                "id": item_id,
                "source_id": entry.get("item") if "item" in entry else item_id,
                "name": name,
                "qty": entry.get("qty"),
            }
        )

    region = location.get("region") or location.get("map")
    # 检查点只存在于 v3 的位置信息里; 旧版的 map 名不能直接当作检查点键。
    checkpoint = (
        rules.checkpoints().get(str(region))
        if version == CURRENT_VERSION and region is not None
        else None
    )
    quests = _snapshot_quests(save, rules)
    return {
        "player": {
            "name": player.get("name"),
            "level": player.get("level"),
            "xp": player.get("xp"),
        },
        "location": {
            "region": location.get("region"),
            "map": location.get("map"),
            "x": location.get("x"),
            "y": location.get("y"),
            "checkpoint": checkpoint,
        },
        "inventory": {
            "slot_count": len(items),
            "total_qty": sum(item["qty"] for item in items if _is_int(item["qty"])),
            "items": items,
        },
        "quests": quests,
    }


def _snapshot_quests(save: dict, rules: Rules) -> dict:
    labels = rules.quest_labels()
    version = save.get("format")
    entries: list[dict] = []

    if version == 1:
        raw_quests = save.get("quests")
        raw_quests = raw_quests if isinstance(raw_quests, list) else []
        for quest in raw_quests:
            if not isinstance(quest, dict):
                continue
            done = quest.get("done")
            entries.append(
                {
                    "id": quest.get("id"),
                    "name": labels.get(str(quest.get("id"))),
                    "status": "complete" if done is True else "active",
                    "stage": quest.get("stage"),
                }
            )
    else:
        quests = save.get("quests") if isinstance(save.get("quests"), dict) else {}
        for bucket, status in (("active", "active"), ("completed", "complete")):
            raw_bucket = quests.get(bucket)
            raw_bucket = raw_bucket if isinstance(raw_bucket, list) else []
            for quest in raw_bucket:
                if not isinstance(quest, dict):
                    continue
                entry = {"id": quest.get("id"), "name": labels.get(str(quest.get("id"))), "status": status}
                if "chapter" in quest:
                    entry["chapter"] = quest.get("chapter")
                    entry["step"] = quest.get("step")
                elif "stage" in quest:
                    entry["stage"] = quest.get("stage")
                entries.append(entry)

    active = [q for q in entries if q["status"] == "active"]
    completed = [q for q in entries if q["status"] == "complete"]
    return {
        "active_count": len(active),
        "completed_count": len(completed),
        "entries": entries,
    }
