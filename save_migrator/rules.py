"""规则文件加载与校验。

映射表放在外部 JSON (默认 ``rules/default_rules.json``), 策划可以直接改,
改完用同一份原档重跑, 再用 ``compare`` 对照两次结果。规则文件本身会被
逐项校验, 缺字段、类型写错或映射自相矛盾都会在迁移前明确报错。
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

from .errors import MigrationError

STEPS = ("1->2", "2->3")
CURRENT_VERSION = 3


class RuleError(MigrationError):
    """规则文件不可用。"""

    kind = "rules"


def canonical_json(value: object) -> str:
    """规则的规范化序列化; 只用于算 digest, 不受缩进/键序影响。"""

    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise RuleError(message)


def _require_map(raw: dict, key: str) -> dict:
    value = raw.get(key)
    _require(isinstance(value, dict), f"规则缺少对象字段 {key!r}")
    return value


def _require_str_keys(value: dict, where: str) -> None:
    for key in value:
        _require(isinstance(key, str), f"{where} 的键必须是字符串: {key!r}")


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


@dataclass(frozen=True)
class Rules:
    raw: dict
    path: Path
    digest: str

    @property
    def game(self) -> str:
        return self.raw["game"]

    @property
    def current_version(self) -> int:
        return self.raw["current_version"]

    def version_label(self, version: int) -> str:
        entry = self.raw["versions"].get(str(version), {})
        return entry.get("label") or f"v{version}"

    def build(self, version: int) -> str:
        return self.raw["builds"][str(version)]

    def item_map(self, step: str) -> dict[str, int]:
        return {k: v for k, v in self.raw["items"][step].items()}

    def removed_items(self, step: str) -> dict[str, str]:
        return dict(self.raw["removed_items"].get(step, {}))

    def item_catalog(self, version: int) -> dict[str, str]:
        return dict(self.raw["item_catalog"].get(str(version), {}))

    def region_map(self, step: str) -> dict[str, str]:
        return dict(self.raw["regions"][step])

    def map_transform(self, step: str) -> dict:
        return dict(self.raw["map_transforms"][step])

    def quest_stage_split(self, step: str) -> dict[str, dict[str, int]]:
        return {k: dict(v) for k, v in self.raw["quest_stage_split"][step].items()}

    def checkpoints(self) -> dict[str, str]:
        return dict(self.raw["checkpoints"])

    def quest_labels(self) -> dict[str, str]:
        return dict(self.raw["quest_labels"])

    def inventory_capacity(self) -> int:
        return int(self.raw["inventory_capacity"])

    def max_stack(self) -> int:
        return int(self.raw["max_stack"])

    def world_bounds(self) -> dict[str, list[float]]:
        return self.raw["world_bounds"]

    def player_limits(self) -> dict[str, list[int]]:
        return self.raw["player_limits"]


def load_rules(path: str | Path) -> Rules:
    rule_path = Path(path)
    try:
        text = rule_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuleError(f"读不到规则文件: {rule_path}", detail=str(exc)) from exc
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuleError(
            f"规则文件不是合法 JSON: {rule_path}",
            detail=f"第 {exc.lineno} 行第 {exc.colno} 列: {exc.msg}",
        ) from exc
    _validate(raw)
    digest = hashlib.sha256(canonical_json(raw).encode("utf-8")).hexdigest()
    return Rules(raw=raw, path=rule_path, digest=digest)


def _validate(raw: object) -> None:
    _require(isinstance(raw, dict), "规则文件的顶层必须是对象")
    assert isinstance(raw, dict)

    _require(raw.get("schema") == 1, "规则文件的 schema 必须是 1")
    _require(isinstance(raw.get("game"), str) and raw["game"].strip(), "规则缺少游戏名 game")
    _require(raw.get("current_version") == CURRENT_VERSION, f"规则 current_version 必须是 {CURRENT_VERSION}")

    versions = _require_map(raw, "versions")
    builds = _require_map(raw, "builds")
    for version in (1, 2, 3):
        entry = versions.get(str(version))
        _require(isinstance(entry, dict), f"versions 缺少版本 {version}")
        _require(isinstance(entry.get("label"), str), f"versions[{version}] 缺少 label")
        _require(isinstance(builds.get(str(version)), str), f"builds 缺少版本 {version}")

    items = _require_map(raw, "items")
    regions = _require_map(raw, "regions")
    transforms = _require_map(raw, "map_transforms")
    removed = _require_map(raw, "removed_items")
    for step in STEPS:
        step_items = _require_map(items, step)
        _require_str_keys(step_items, f"items[{step}]")
        for old, new in step_items.items():
            _require(_is_int(new), f"items[{step}][{old}] 必须是整数编号")
            _require(new > 0, f"items[{step}][{old}] 编号必须为正整数")

        step_removed = removed.get(step, {})
        _require(isinstance(step_removed, dict), f"removed_items[{step}] 必须是对象")
        _require_str_keys(step_removed, f"removed_items[{step}]")
        for old, reason in step_removed.items():
            _require(isinstance(reason, str) and reason, f"removed_items[{step}][{old}] 必须写明原因")
        overlap = set(step_items) & set(step_removed)
        _require(not overlap, f"items[{step}] 与 removed_items[{step}] 重复定义: {sorted(overlap)}")

        step_regions = _require_map(regions, step)
        _require_str_keys(step_regions, f"regions[{step}]")
        for old, new in step_regions.items():
            _require(isinstance(new, str) and new, f"regions[{step}][{old}] 必须是非空字符串")

        transform = _require_map(transforms, step)
        for field in ("scale", "offset_x", "offset_y"):
            _require(_is_number(transform.get(field)), f"map_transforms[{step}].{field} 必须是数字")
        _require(transform["scale"] != 0, f"map_transforms[{step}].scale 不能为 0")

    catalog = _require_map(raw, "item_catalog")
    current_catalog = catalog.get(str(CURRENT_VERSION))
    _require(isinstance(current_catalog, dict) and current_catalog, "item_catalog 缺少当前版本的物品表")
    _require_str_keys(current_catalog, "item_catalog")
    for item_id, name in current_catalog.items():
        _require(item_id.isdigit(), f"item_catalog 的编号必须是数字字符串: {item_id!r}")
        _require(isinstance(name, str) and name, f"item_catalog[{item_id}] 必须是非空字符串")

    checkpoints = _require_map(raw, "checkpoints")
    _require_str_keys(checkpoints, "checkpoints")
    for region, checkpoint in checkpoints.items():
        _require(isinstance(checkpoint, str) and checkpoint, f"checkpoints[{region}] 必须是非空字符串")

    # 中间版本的目标区域必须能被下一步继续映射, 最终区域必须有检查点。
    chained = sorted(set(regions["1->2"].values()) - set(regions["2->3"]))
    _require(not chained, f"regions[2->3] 缺少 1->2 的目标区域: {chained}")
    final_missing = sorted(set(regions["2->3"].values()) - set(checkpoints))
    _require(not final_missing, f"checkpoints 缺少最终区域: {final_missing}")

    split = _require_map(raw, "quest_stage_split")
    split_2_3 = _require_map(split, "2->3")
    _require_str_keys(split_2_3, "quest_stage_split[2->3]")
    seen_pairs: dict[tuple[int, int], str] = {}
    for stage, parts in split_2_3.items():
        _require(stage.isdigit(), f"quest_stage_split[2->3] 的键必须是数字字符串: {stage!r}")
        _require(isinstance(parts, dict), f"quest_stage_split[2->3][{stage}] 必须是对象")
        _require(_is_int(parts.get("chapter")) and parts["chapter"] > 0, f"quest_stage_split[2->3][{stage}].chapter 必须是正整数")
        _require(_is_int(parts.get("step")) and parts["step"] > 0, f"quest_stage_split[2->3][{stage}].step 必须是正整数")
        pair = (parts["chapter"], parts["step"])
        _require(pair not in seen_pairs, f"quest_stage_split[2->3] 的章节/步骤重复: {stage} 与 {seen_pairs.get(pair)}")
        seen_pairs[pair] = stage

    labels = _require_map(raw, "quest_labels")
    _require_str_keys(labels, "quest_labels")
    for quest_id, name in labels.items():
        _require(isinstance(name, str) and name, f"quest_labels[{quest_id}] 必须是非空字符串")

    capacity = raw.get("inventory_capacity")
    _require(_is_int(capacity) and capacity > 0, "inventory_capacity 必须是正整数")
    max_stack = raw.get("max_stack")
    _require(_is_int(max_stack) and max_stack > 0, "max_stack 必须是正整数")

    bounds = _require_map(raw, "world_bounds")
    for axis in ("x", "y"):
        pair = bounds.get(axis)
        _require(
            isinstance(pair, list)
            and len(pair) == 2
            and all(_is_number(v) for v in pair)
            and pair[0] < pair[1],
            f"world_bounds.{axis} 必须是 [最小, 最大]",
        )

    limits = _require_map(raw, "player_limits")
    for field in ("level", "xp"):
        pair = limits.get(field)
        _require(
            isinstance(pair, list)
            and len(pair) == 2
            and all(_is_int(v) for v in pair)
            and pair[0] <= pair[1],
            f"player_limits.{field} 必须是 [最小, 最大]",
        )

    # 每一步的映射目标都必须能被下一步消化: 要么继续映射, 要么明确移除;
    # 最后一步的目标必须在当前版本物品表里。
    stranded = sorted(
        str(item_id)
        for item_id in set(items["1->2"].values())
        if str(item_id) not in items["2->3"] and str(item_id) not in removed.get("2->3", {})
    )
    _require(not stranded, f"1->2 映射出的物品在 2->3 既无映射也未标记移除: {stranded}")
    missing = sorted(
        str(item_id) for item_id in set(items["2->3"].values()) if str(item_id) not in current_catalog
    )
    _require(not missing, f"item_catalog 缺少映射目标物品: {missing}")
