"""玩家行为模拟器。

任务状态机::

    locked (等待中/已失效)  --条件满足-->  available (可接取)
    available               --接取-->      active
    active                  --完成-->      completed (终态, 触发奖励)
    available/active        --失败-->      failed    (终态)
    completed/failed 为粘滞终态, 不会被重算覆盖。

失效判定 (locked 但永远等不到解锁) 与普通等待分开给出原因:
- 前置任务 failed
- 互斥任务进入 completed/failed
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .conditions import ConditionError, truthy_evaluate
from .model import Project, Quest, Reward

TERMINAL_STATES = ("completed", "failed")


@dataclass
class StepDiff:
    """一步操作前后的状态差分, 供前端高亮。"""

    action: str
    quest_id: str
    ok: bool = True
    message: str = ""
    new_available: List[str] = field(default_factory=list)
    new_active: List[str] = field(default_factory=list)
    new_locked: List[str] = field(default_factory=list)
    new_completed: List[str] = field(default_factory=list)
    new_failed: List[str] = field(default_factory=list)
    invalidated: List[Dict[str, str]] = field(default_factory=list)
    rewards_gained: List[Dict[str, Any]] = field(default_factory=list)
    endings_reached: List[str] = field(default_factory=list)
    events: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "action": self.action,
            "quest_id": self.quest_id,
            "ok": self.ok,
            "message": self.message,
            "new_available": self.new_available,
            "new_active": self.new_active,
            "new_locked": self.new_locked,
            "new_completed": self.new_completed,
            "new_failed": self.new_failed,
            "invalidated": self.invalidated,
            "rewards_gained": self.rewards_gained,
            "endings_reached": self.endings_reached,
            "events": self.events,
        }


class Simulator:
    def __init__(self, project: Project) -> None:
        self.project = project
        self.quest_index: Dict[str, Quest] = {q.id: q for q in project.quests}
        self.quest_states: Dict[str, str] = {}
        self.blocked_reasons: Dict[str, str] = {}
        self.flags: Dict[str, Any] = copy.deepcopy(project.initial_flags)
        self.variables: Dict[str, float] = copy.deepcopy(project.initial_variables)
        self.inventory: Dict[str, Dict[str, Any]] = {"item": {}, "currency": {}}
        self.history: List[Dict[str, Any]] = []  # 每步之前的快照, 用于撤销
        self.log: List[str] = []
        self.reset()

    # ------------------------------------------------------------------
    # 快照 / 重置 / 撤销
    # ------------------------------------------------------------------

    def reset(self) -> None:
        self.quest_states = {q.id: "locked" for q in self.project.quests}
        self.flags = copy.deepcopy(self.project.initial_flags)
        self.variables = copy.deepcopy(self.project.initial_variables)
        self.inventory = {"item": {}, "currency": {}}
        self.history = []
        self.log = ["模拟已重置"]
        self._recompute()

    def snapshot(self) -> Dict[str, Any]:
        return {
            "quest_states": copy.deepcopy(self.quest_states),
            "blocked_reasons": copy.deepcopy(self.blocked_reasons),
            "flags": copy.deepcopy(self.flags),
            "variables": copy.deepcopy(self.variables),
            "inventory": copy.deepcopy(self.inventory),
            "log": list(self.log),
        }

    def restore(self, data: Dict[str, Any]) -> None:
        self.quest_states = copy.deepcopy(data["quest_states"])
        self.blocked_reasons = copy.deepcopy(data.get("blocked_reasons", {}))
        self.flags = copy.deepcopy(data["flags"])
        self.variables = copy.deepcopy(data["variables"])
        self.inventory = copy.deepcopy(data.get("inventory", {"item": {}, "currency": {}}))
        self.log = list(data.get("log", []))
        self.history = []

    def export_progress(self) -> Dict[str, Any]:
        """导出可保存到磁盘的模拟进度 (与工程文件分开存储)。"""

        return {
            "kind": "quest-sim-progress",
            "format_version": 1,
            "project_name": self.project.name,
            "quest_states": copy.deepcopy(self.quest_states),
            "flags": copy.deepcopy(self.flags),
            "variables": copy.deepcopy(self.variables),
            "inventory": copy.deepcopy(self.inventory),
            "log": list(self.log),
        }

    def load_progress(self, data: Dict[str, Any]) -> List[str]:
        """载入模拟进度, 返回警告列表 (工程结构已变化时提示状态对不上的任务)。"""

        if data.get("kind") != "quest-sim-progress":
            raise ValueError("不是合法的模拟进度文件 (缺少 kind=quest-sim-progress)")
        known = set(self.project.ids())
        warnings: List[str] = []
        saved_states = data.get("quest_states", {})
        unknown = [qid for qid in saved_states if qid not in known]
        if unknown:
            warnings.append(f"进度中的以下任务在当前工程中已不存在: {', '.join(sorted(unknown))}")
        self.restore(
            {
                "quest_states": {qid: st for qid, st in saved_states.items() if qid in known},
                "blocked_reasons": {},
                "flags": copy.deepcopy(data.get("flags", {})),
                "variables": copy.deepcopy(data.get("variables", {})),
                "inventory": copy.deepcopy(
                    data.get("inventory", {"item": {}, "currency": {}})
                ),
                "log": list(data.get("log", [])),
            }
        )
        # 工程里新增的任务补齐为 locked, 再统一重算
        for qid in known:
            self.quest_states.setdefault(qid, "locked")
        self._recompute()
        return warnings

    def undo(self) -> bool:
        if not self.history:
            return False
        self.restore(self.history.pop())
        self.log.append("撤销了上一步操作")
        return True

    # ------------------------------------------------------------------
    # 状态计算
    # ------------------------------------------------------------------

    def _context(self) -> Dict[str, Any]:
        return {
            "quest_states": self.quest_states,
            "flags": self.flags,
            "variables": self.variables,
        }

    def _invalidation_reason(self, quest: Quest) -> Optional[str]:
        """返回任务永远无法解锁的原因; None 表示仍在正常等待。"""

        for pre in quest.prerequisites:
            if self.quest_states.get(pre) == "failed":
                return f"前置任务 {pre} 已失败"
        for other in quest.exclusive_with:
            state = self.quest_states.get(other)
            if state in TERMINAL_STATES:
                return f"互斥任务 {other} 已{ '完成' if state == 'completed' else '失败' }"
        return None

    def _recompute(self) -> None:
        """根据当前 flags/variables 与任务终态重算所有非终态任务。"""

        self.blocked_reasons = {}
        for quest in self.project.quests:
            current = self.quest_states.get(quest.id, "locked")
            if current in TERMINAL_STATES:
                continue

            # 1. 永久失效优先: 前置失败或互斥任务已进入终态
            reason = self._invalidation_reason(quest)
            if reason is not None:
                self.quest_states[quest.id] = "locked"
                self.blocked_reasons[quest.id] = reason
                continue

            # 2. 前置尚未全部完成 -> 普通等待
            waiting = [
                pre for pre in quest.prerequisites
                if self.quest_states.get(pre) != "completed"
            ]
            if waiting:
                self.quest_states[quest.id] = "locked"
                self.blocked_reasons[quest.id] = "等待前置: " + ", ".join(waiting)
                continue

            # 3. 前置完成, 检查 DSL 条件
            condition_ok = True
            if quest.condition.strip():
                try:
                    condition_ok = truthy_evaluate(quest.condition, self._context())
                except ConditionError as exc:
                    condition_ok = False
                    self.blocked_reasons[quest.id] = f"条件求值失败: {exc.message}"
            if not condition_ok:
                self.quest_states[quest.id] = "locked"
                self.blocked_reasons.setdefault(quest.id, "条件尚未满足")
                continue

            # 4. active 为粘滞状态: 一旦接取, 只要没失效就保持
            if current != "active":
                self.quest_states[quest.id] = "available"
            self.blocked_reasons.pop(quest.id, None)

    def statuses(self) -> Dict[str, str]:
        return dict(self.quest_states)

    def quests_by_state(self, state: str) -> List[str]:
        return sorted(qid for qid, st in self.quest_states.items() if st == state)

    def can_act(self, quest_id: str) -> bool:
        return self.quest_states.get(quest_id) in ("available", "active")

    # ------------------------------------------------------------------
    # 操作
    # ------------------------------------------------------------------

    def step(self, action: str, quest_id: str) -> StepDiff:
        """执行 accept / complete / fail 之一, 返回差分。"""

        quest = self.quest_index.get(quest_id)
        if quest is None:
            return StepDiff(action=action, quest_id=quest_id, ok=False, message="任务不存在")

        before = self.snapshot()
        before_states = dict(self.quest_states)
        state = self.quest_states[quest_id]

        if action == "accept":
            if state != "available":
                return StepDiff(
                    action=action, quest_id=quest_id, ok=False,
                    message=f"任务当前状态为 {state}, 只有 available 可接取",
                )
            self.quest_states[quest_id] = "active"
            event = f"接取任务 {quest_id}"
        elif action == "complete":
            if state not in ("available", "active"):
                return StepDiff(
                    action=action, quest_id=quest_id, ok=False,
                    message=f"任务当前状态为 {state}, 无法完成",
                )
            self.quest_states[quest_id] = "completed"
            event = f"完成任务 {quest_id}"
        elif action == "fail":
            if state not in ("available", "active"):
                return StepDiff(
                    action=action, quest_id=quest_id, ok=False,
                    message=f"任务当前状态为 {state}, 无法失败",
                )
            self.quest_states[quest_id] = "failed"
            event = f"任务失败 {quest_id}"
        else:
            return StepDiff(
                action=action, quest_id=quest_id, ok=False,
                message=f"未知操作 {action!r} (支持 accept/complete/fail)",
            )

        diff = StepDiff(action=action, quest_id=quest_id)
        self.log.append(event)
        diff.events.append(event)

        if action == "complete":
            diff.rewards_gained = self._apply_rewards(quest, diff)

        self._recompute()
        self._fill_diff(diff, before_states)
        diff.endings_reached = self._check_endings(before_states)
        self.history.append(before)
        return diff

    def _fill_diff(self, diff: StepDiff, before_states: Dict[str, str]) -> None:
        for qid, after_state in self.quest_states.items():
            before_state = before_states.get(qid, "locked")
            if before_state == after_state:
                continue
            bucket = {
                "available": diff.new_available,
                "active": diff.new_active,
                "locked": diff.new_locked,
                "completed": diff.new_completed,
                "failed": diff.new_failed,
            }.get(after_state)
            if bucket is not None:
                bucket.append(qid)
            if after_state == "locked" and before_state in ("available", "active"):
                diff.invalidated.append(
                    {"quest_id": qid, "reason": self.blocked_reasons.get(qid, "已失效")}
                )

    def _check_endings(self, before_states: Dict[str, str]) -> List[str]:
        reached = []
        for quest in self.project.ending_quests():
            if (
                self.quest_states.get(quest.id) == "completed"
                and before_states.get(quest.id) != "completed"
            ):
                reached.append(quest.id)
                self.log.append(f"达成结局: {quest.title or quest.id} ({quest.id})")
        return reached

    # ------------------------------------------------------------------
    # 奖励
    # ------------------------------------------------------------------

    def _apply_rewards(self, quest: Quest, diff: StepDiff) -> List[Dict[str, Any]]:
        gained: List[Dict[str, Any]] = []
        for reward in quest.rewards:
            entry = self._apply_one_reward(reward, diff)
            if entry is not None:
                gained.append(entry)
        return gained

    def _apply_one_reward(self, reward: Reward, diff: StepDiff) -> Optional[Dict[str, Any]]:
        p = reward.payload
        if reward.type in ("item", "currency"):
            key_field = "item_id" if reward.type == "item" else "currency_id"
            bucket = self.inventory[reward.type]
            bucket[p[key_field]] = bucket.get(p[key_field], 0) + p["amount"]
            event = f"获得 {reward.type} {p[key_field]} x{p['amount']}"
        elif reward.type == "flag":
            self.flags[p["flag"]] = p["value"]
            event = f"设置 flag {p['flag']} = {p['value']!r}"
        elif reward.type == "variable":
            name, op, value = p["variable"], p["op"], p["value"]
            current = self.variables.get(name, 0)
            self.variables[name] = {
                "+=": current + value,
                "-=": current - value,
                "*=": current * value,
                "/=": current / value if value != 0 else current,
                "=": value,
            }[op]
            event = f"变量 {name} {op} {value} -> {self.variables[name]}"
        elif reward.type == "quest":
            target, target_state = p["quest_id"], p["state"]
            if target in self.quest_states:
                self.quest_states[target] = target_state
                event = f"奖励触发: 任务 {target} 置为 {target_state}"
            else:
                event = f"奖励引用的任务 {target} 不存在, 已忽略"
        else:  # pragma: no cover - 模型层已拦截
            return None
        self.log.append(event)
        diff.events.append(event)
        return reward.to_dict()

    # ------------------------------------------------------------------
    # 卡住检测 / 局面总结
    # ------------------------------------------------------------------

    def stuck_info(self) -> Optional[Dict[str, Any]]:
        """当前局面是否卡住: 没有可接取/进行中的任务, 且尚有任务未到终态。"""

        pending = [
            qid for qid, state in self.quest_states.items() if state not in TERMINAL_STATES
        ]
        if not pending:
            return None
        if self.quests_by_state("available") or self.quests_by_state("active"):
            return None
        blocked = [
            {"quest_id": qid, "reason": self.blocked_reasons.get(qid, "条件未满足")}
            for qid in sorted(pending)
        ]
        endings_done = [
            q.id for q in self.project.ending_quests()
            if self.quest_states.get(q.id) == "completed"
        ]
        return {
            "stuck": True,
            "blocked_quests": blocked,
            "ending_reached": bool(endings_done),
            "completed_endings": endings_done,
        }

    def summary(self) -> Dict[str, Any]:
        counts: Dict[str, int] = {}
        for state in self.quest_states.values():
            counts[state] = counts.get(state, 0) + 1
        return {
            "counts": counts,
            "available": self.quests_by_state("available"),
            "active": self.quests_by_state("active"),
            "completed": self.quests_by_state("completed"),
            "failed": self.quests_by_state("failed"),
            "locked": self.quests_by_state("locked"),
            "blocked_reasons": dict(self.blocked_reasons),
            "flags": dict(self.flags),
            "variables": dict(self.variables),
            "inventory": copy.deepcopy(self.inventory),
            "stuck": self.stuck_info(),
            "steps_taken": len(self.history),
        }
