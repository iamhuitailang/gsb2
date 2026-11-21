"""任务图数据模型、工程文件读写与运行时数据导出/导入。

工程文件 (`.qchain.json`) 结构::

    {
      "format_version": 1,
      "name": "...",
      "description": "...",
      "initial_flags": {...},
      "initial_variables": {...},
      "quests": [ Quest, ... ]
    }

单个 Quest 结构见 :class:`Quest` 的字段说明。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Tuple

FORMAT_VERSION = 1

VALID_STATES = ("available", "active", "completed", "failed", "locked")

# 奖励类型 -> 必需字段
REWARD_TYPES = {
    "item": ("item_id", "amount"),
    "currency": ("currency_id", "amount"),
    "flag": ("flag", "value"),
    "variable": ("variable", "op", "value"),
    "quest": ("quest_id",),  # 直接把另一任务置为某状态, 字段 state
}


class ProjectError(Exception):
    """工程文件结构层面的错误 (区别于 analysis 的图诊断问题)。"""


@dataclass
class Reward:
    """任务完成奖励。

    type 取值:
      item     -> item_id + amount
      currency -> currency_id + amount
      flag     -> flag + value (任意标量)
      variable -> variable + op (+=, -=, *=, /=, =) + value
      quest    -> quest_id + state (completed/failed/active/available)
    """

    type: str
    payload: Dict[str, Any] = field(default_factory=dict)
    note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        data = {"type": self.type}
        data.update(self.payload)
        if self.note:
            data["note"] = self.note
        return data

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "Reward":
        if not isinstance(data, dict):
            raise ProjectError(f"奖励必须是对象, 实际为 {type(data).__name__}")
        rtype = data.get("type")
        if rtype not in REWARD_TYPES:
            raise ProjectError(
                f"未知奖励类型 {rtype!r}, 可选: {', '.join(REWARD_TYPES)}"
            )
        payload = {k: v for k, v in data.items() if k not in ("type", "note")}
        missing = [key for key in REWARD_TYPES[rtype] if key not in payload]
        if missing:
            raise ProjectError(f"{rtype} 类型奖励缺少字段: {', '.join(missing)}")
        if rtype == "variable" and payload["op"] not in ("+=", "-=", "*=", "/=", "="):
            raise ProjectError(
                f"variable 奖励的 op 非法: {payload['op']!r} (支持 += -= *= /= =)"
            )
        if rtype == "quest" and payload.get("state") not in (
            "completed",
            "failed",
            "active",
            "available",
        ):
            raise ProjectError("quest 奖励的 state 必须是 completed/failed/active/available")
        return Reward(type=rtype, payload=payload, note=data.get("note", ""))


@dataclass
class Quest:
    """任务节点。

    字段说明:
      id:            唯一标识
      title:         展示名
      description:   描述
      prerequisites: 前置任务 id 列表 (全部完成才可接取; 等价于 all_of 条件)
      condition:     额外 DSL 表达式, 与前置任务取 AND; 空串表示无
      exclusive_with:互斥任务 id 列表 (对称关系, 加载时自动补全反向边)
      is_ending:     是否为结局任务
      optional:      是否为可选支线 (不可达时降级为警告)
      rewards:       完成奖励
      position:      编辑器画布坐标 {"x":..,"y":..}
    """

    id: str
    title: str = ""
    description: str = ""
    prerequisites: List[str] = field(default_factory=list)
    condition: str = ""
    exclusive_with: List[str] = field(default_factory=list)
    is_ending: bool = False
    optional: bool = False
    rewards: List[Reward] = field(default_factory=list)
    position: Dict[str, float] = field(default_factory=lambda: {"x": 0.0, "y": 0.0})

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "prerequisites": list(self.prerequisites),
            "condition": self.condition,
            "exclusive_with": list(self.exclusive_with),
            "is_ending": self.is_ending,
            "optional": self.optional,
            "rewards": [r.to_dict() for r in self.rewards],
            "position": dict(self.position),
        }

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "Quest":
        if not isinstance(data, dict):
            raise ProjectError(f"任务必须是对象, 实际为 {type(data).__name__}")
        qid = data.get("id")
        if not isinstance(qid, str) or not qid.strip():
            raise ProjectError("任务缺少非空字符串字段 id")
        for list_field in ("prerequisites", "exclusive_with"):
            value = data.get(list_field, [])
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise ProjectError(f"任务 {qid} 的 {list_field} 必须是字符串数组")
        rewards: List[Reward] = []
        for raw_reward in data.get("rewards", []):
            rewards.append(Reward.from_dict(raw_reward))
        position = data.get("position", {"x": 0.0, "y": 0.0})
        if not isinstance(position, dict) or "x" not in position or "y" not in position:
            raise ProjectError(f"任务 {qid} 的 position 必须包含 x 与 y")
        return Quest(
            id=qid,
            title=str(data.get("title", "")),
            description=str(data.get("description", "")),
            prerequisites=list(data.get("prerequisites", [])),
            condition=str(data.get("condition", "")),
            exclusive_with=list(data.get("exclusive_with", [])),
            is_ending=bool(data.get("is_ending", False)),
            optional=bool(data.get("optional", False)),
            rewards=rewards,
            position={"x": float(position["x"]), "y": float(position["y"])},
        )


@dataclass
class Project:
    name: str = ""
    description: str = ""
    initial_flags: Dict[str, Any] = field(default_factory=dict)
    initial_variables: Dict[str, float] = field(default_factory=dict)
    quests: List[Quest] = field(default_factory=list)
    format_version: int = FORMAT_VERSION

    # -- 便捷查询 -----------------------------------------------------------

    def get(self, quest_id: str) -> Optional[Quest]:
        for quest in self.quests:
            if quest.id == quest_id:
                return quest
        return None

    def ids(self) -> List[str]:
        return [q.id for q in self.quests]

    def normalize_exclusive(self) -> None:
        """把互斥关系补全为对称关系并去重。"""

        index = {q.id: q for q in self.quests}
        for quest in self.quests:
            for other in list(quest.exclusive_with):
                if other in index and quest.id not in index[other].exclusive_with:
                    index[other].exclusive_with.append(quest.id)
        for quest in self.quests:
            seen: set = set()
            deduped: List[str] = []
            for other in quest.exclusive_with:
                if other != quest.id and other not in seen:
                    seen.add(other)
                    deduped.append(other)
            quest.exclusive_with = deduped

    def entry_quests(self) -> List[Quest]:
        """没有任何前置任务的任务即入口候选。"""

        return [q for q in self.quests if not q.prerequisites]

    def ending_quests(self) -> List[Quest]:
        return [q for q in self.quests if q.is_ending]

    # -- 序列化 -------------------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        return {
            "format_version": self.format_version,
            "name": self.name,
            "description": self.description,
            "initial_flags": dict(self.initial_flags),
            "initial_variables": dict(self.initial_variables),
            "quests": [q.to_dict() for q in self.quests],
        }

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "Project":
        if not isinstance(data, dict):
            raise ProjectError("工程文件根节点必须是对象")
        version = data.get("format_version", 1)
        if not isinstance(version, int) or version > FORMAT_VERSION:
            raise ProjectError(
                f"工程文件版本 {version!r} 不受支持 (当前支持到 {FORMAT_VERSION})"
            )
        quests = [Quest.from_dict(raw) for raw in data.get("quests", [])]
        flags = data.get("initial_flags", {})
        variables = data.get("initial_variables", {})
        if not isinstance(flags, dict) or not isinstance(variables, dict):
            raise ProjectError("initial_flags / initial_variables 必须是对象")
        project = Project(
            name=str(data.get("name", "")),
            description=str(data.get("description", "")),
            initial_flags=dict(flags),
            initial_variables={k: float(v) for k, v in variables.items()},
            quests=quests,
            format_version=version,
        )
        # 重复 id
        seen: set = set()
        duplicates = []
        for quest in project.quests:
            if quest.id in seen:
                duplicates.append(quest.id)
            seen.add(quest.id)
        if duplicates:
            raise ProjectError(f"存在重复的任务 id: {', '.join(sorted(set(duplicates)))}")
        project.normalize_exclusive()
        return project


# ---------------------------------------------------------------------------
# 文件读写
# ---------------------------------------------------------------------------


def load_project(path: str) -> Project:
    try:
        with open(path, "r", encoding="utf-8") as fp:
            data = json.load(fp)
    except FileNotFoundError as exc:
        raise ProjectError(f"文件不存在: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ProjectError(f"JSON 解析失败: {exc}") from exc
    return Project.from_dict(data)


def save_project(project: Project, path: str) -> None:
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(project.to_dict(), fp, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# 运行时导出 / 导入
# ---------------------------------------------------------------------------

# 导出给游戏读取的精简结构 (去掉编辑器坐标等)
_EXPORTED_QUEST_FIELDS = (
    "id",
    "title",
    "description",
    "prerequisites",
    "condition",
    "exclusive_with",
    "is_ending",
    "optional",
    "rewards",
)


def export_runtime(project: Project) -> Dict[str, Any]:
    """导出游戏侧读取的运行时数据。"""

    return {
        "format_version": FORMAT_VERSION,
        "kind": "quest-runtime",
        "name": project.name,
        "initial_flags": dict(project.initial_flags),
        "initial_variables": dict(project.initial_variables),
        "quests": [
            {field: value for field, value in quest.to_dict().items() if field in _EXPORTED_QUEST_FIELDS}
            for quest in project.quests
        ],
    }


def import_runtime(data: Dict[str, Any]) -> Tuple[Project, List[str]]:
    """导入游戏数据 (也兼容完整工程文件), 返回 (工程, 严重问题列表)。

    结构错误直接抛 :class:`ProjectError`; 引用缺失等问题收集后返回,
    由调用方决定是否继续 (编辑器允许带着问题导入)。
    """

    if not isinstance(data, dict):
        raise ProjectError("导入数据根节点必须是对象")
    if data.get("kind") == "quest-runtime":
        # 补成工程文件形态再走统一解析
        data = {
            "format_version": data.get("format_version", FORMAT_VERSION),
            "name": data.get("name", ""),
            "description": data.get("description", ""),
            "initial_flags": data.get("initial_flags", {}),
            "initial_variables": data.get("initial_variables", {}),
            "quests": [
                dict(q, position={"x": 0.0, "y": 0.0}) for q in data.get("quests", [])
            ],
        }
    project = Project.from_dict(data)

    problems: List[str] = []
    ids = set(project.ids())

    # 引用完整性
    for quest in project.quests:
        for ref in quest.prerequisites:
            if ref not in ids:
                problems.append(f"任务 {quest.id} 的前置任务 {ref!r} 不存在")
        for ref in quest.exclusive_with:
            if ref not in ids:
                problems.append(f"任务 {quest.id} 的互斥任务 {ref!r} 不存在")
        for reward in quest.rewards:
            if reward.type == "quest" and reward.payload["quest_id"] not in ids:
                problems.append(
                    f"任务 {quest.id} 的奖励引用了不存在的任务 {reward.payload['quest_id']!r}"
                )

    # 条件表达式语法与引用
    # 延迟导入避免循环依赖
    from .conditions import lint_condition

    for quest in project.quests:
        if not quest.condition.strip():
            continue
        for problem in lint_condition(
            quest.condition,
            known_quests=ids,
            known_flags=set(project.initial_flags),
            known_variables=set(project.initial_variables),
        ):
            # 自定义函数注入提示在导入场景下忽略
            if "未知函数" in problem:
                continue
            problems.append(f"任务 {quest.id} 的条件表达式: {problem}")
    return project, problems
