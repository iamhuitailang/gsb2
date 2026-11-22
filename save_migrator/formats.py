"""存档读取、版本识别与结构检查。

这里只做"能不能安全地开始迁移"的结构检查, 具体数值是否合理交给
迁移后的关键字段校验。这样坏掉的业务字段 (例如等级 750) 会出现在
校验报告里, 而不是在读取阶段含糊地报一句 JSON 错误。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .errors import SaveReadError, UnknownVersionError

SUPPORTED_VERSIONS = (1, 2, 3)
CURRENT_VERSION = 3


@dataclass(frozen=True)
class Save:
    path: Path
    raw: dict
    sha256: str
    version: int

    @property
    def short_sha(self) -> str:
        return self.sha256[:12]


def _short_sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_save(path: str | Path) -> Save:
    save_path = Path(path)
    try:
        payload = save_path.read_bytes()
    except OSError as exc:
        raise SaveReadError(f"读不到存档文件: {save_path}", detail=str(exc)) from exc
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SaveReadError(f"存档不是 UTF-8 文本: {save_path}", detail=str(exc)) from exc
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SaveReadError(
            f"存档不是合法 JSON: {save_path}",
            detail=f"第 {exc.lineno} 行第 {exc.colno} 列: {exc.msg}",
        ) from exc
    if not isinstance(raw, dict):
        raise SaveReadError(f"存档顶层必须是对象: {save_path}", detail=f"实际是 {type(raw).__name__}")

    version = detect_version(raw, save_path)
    validate_shape(raw, version)
    return Save(path=save_path, raw=raw, sha256=_short_sha(payload), version=version)


def detect_version(raw: dict, path: Path | None = None) -> int:
    found = raw.get("format", None)
    where = f" ({path})" if path else ""
    if isinstance(found, bool) or not isinstance(found, int):
        raise UnknownVersionError(
            f"无法识别存档版本{where}: format={found!r}; 本工具支持 {list(SUPPORTED_VERSIONS)}",
            found=found,
            supported=list(SUPPORTED_VERSIONS),
        )
    if found not in SUPPORTED_VERSIONS:
        raise UnknownVersionError(
            f"无法识别存档版本{where}: format={found}; 本工具支持 {list(SUPPORTED_VERSIONS)}",
            found=found,
            supported=list(SUPPORTED_VERSIONS),
        )
    return found


# ---------------------------------------------------------------- 结构检查


def _expect_dict(value: object, path: str) -> dict:
    if not isinstance(value, dict):
        raise SaveReadError(f"{path} 应为对象", detail=f"实际是 {type(value).__name__}")
    return value


def _expect_list(value: object, path: str) -> list:
    if not isinstance(value, list):
        raise SaveReadError(f"{path} 应为数组", detail=f"实际是 {type(value).__name__}")
    return value


def _need(mapping: dict, key: str, path: str) -> object:
    if key not in mapping:
        raise SaveReadError(f"{path} 缺少字段 {key!r}")
    return mapping[key]


def _need_str(mapping: dict, key: str, path: str) -> str:
    value = _need(mapping, key, path)
    if not isinstance(value, str) or not value.strip():
        raise SaveReadError(f"{path}.{key} 应为非空字符串", detail=f"实际是 {value!r}")
    return value


def _entries(mapping: dict, key: str, path: str) -> list[dict]:
    items = _expect_list(_need(mapping, key, path), f"{path}.{key}")
    result = []
    for index, item in enumerate(items):
        result.append(_expect_dict(item, f"{path}.{key}[{index}]"))
    return result


def _check_player(raw: dict) -> None:
    player = _expect_dict(_need(raw, "player", "$"), "$.player")
    _need_str(player, "name", "$.player")
    _need(player, "level", "$.player")
    _need(player, "xp", "$.player")


def _check_meta(raw: dict) -> None:
    meta = _expect_dict(_need(raw, "meta", "$"), "$.meta")
    _need_str(meta, "save_id", "$.meta")


def validate_shape(raw: dict, version: int) -> None:
    _check_meta(raw)
    _check_player(raw)

    location = _expect_dict(_need(raw, "location", "$"), "$.location")
    if version == 1:
        _need_str(location, "map", "$.location")
    else:
        _need_str(location, "region", "$.location")
    _need(location, "x", "$.location")
    _need(location, "y", "$.location")

    inventory = _expect_dict(_need(raw, "inventory", "$"), "$.inventory")
    if version == 1:
        for index, entry in enumerate(_entries(inventory, "items", "$.inventory")):
            _need(entry, "item", f"$.inventory.items[{index}]")
            _need(entry, "qty", f"$.inventory.items[{index}]")
    else:
        for index, entry in enumerate(_entries(inventory, "slots", "$.inventory")):
            _need(entry, "id", f"$.inventory.slots[{index}]")
            _need(entry, "qty", f"$.inventory.slots[{index}]")

    # 旧格式的进度字段只检查"存在", 具体数值留给关键字段检查;
    # 这样坏字段能一次出现在校验报告里, 而不是在读档阶段被笼统拒绝。
    if version == 1:
        for index, quest in enumerate(_entries(raw, "quests", "$")):
            _need(quest, "id", f"$.quests[{index}]")
            _need(quest, "stage", f"$.quests[{index}]")
            _need(quest, "done", f"$.quests[{index}]")
    else:
        quests = _expect_dict(_need(raw, "quests", "$"), "$.quests")
        for bucket in ("active", "completed"):
            for index, quest in enumerate(_entries(quests, bucket, "$.quests")):
                _need(quest, "id", f"$.quests.{bucket}[{index}]")
                if version == 2:
                    _need(quest, "stage", f"$.quests.{bucket}[{index}]")
                else:
                    for key in ("chapter", "step", "status"):
                        _need(quest, key, f"$.quests.{bucket}[{index}]")
