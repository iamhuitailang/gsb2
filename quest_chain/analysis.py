"""任务图静态诊断与影响分析。

诊断项:
1. 循环依赖 (Tarjan 强连通分量, 给出环上的路径)
2. 没有入口任务 (整张图没有无前置的任务)
3. 不可达任务 (从入口 BFS 无法到达; 主线为 error, optional 支线降为 warning)
4. 无法到达任何结局的任务 (给出可走到的最远节点路径)
5. 互斥死路 (A、B 互斥且存在任务同时依赖两者 -> 永远无法接取)
6. 条件表达式引用了不存在的任务 / flag / 变量, 或语法错误
7. 互斥任务之间存在前置依赖 (配置矛盾)
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from .conditions import ConditionError, extract_references, lint_condition
from .model import Project, Quest

ERROR = "error"
WARNING = "warning"


@dataclass
class Issue:
    code: str
    severity: str
    message: str
    quest_ids: List[str] = field(default_factory=list)
    path: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            "quest_ids": list(self.quest_ids),
            "path": list(self.path),
        }


# ---------------------------------------------------------------------------
# 图结构工具
# ---------------------------------------------------------------------------


def dependency_graph(project: Project) -> Dict[str, List[str]]:
    """返回 quest_id -> 前置任务 id 列表 (依赖方向: 任务 -> 它依赖的任务)。"""

    return {q.id: list(q.prerequisites) for q in project.quests}


def successor_graph(project: Project) -> Dict[str, List[str]]:
    """返回 quest_id -> 后继任务 id 列表 (完成方向: 前置 -> 后续)。"""

    succ: Dict[str, List[str]] = {q.id: [] for q in project.quests}
    for quest in project.quests:
        for pre in quest.prerequisites:
            if pre in succ:
                succ[pre].append(quest.id)
    for targets in succ.values():
        targets.sort()
    return succ


def find_cycles(project: Project) -> List[List[str]]:
    """用 Tarjan 算法找出所有大小 >1 的强连通分量, 以及自环。

    每个环按依赖方向排列 (相邻两个任务中, 后者是前者的前置)。
    """

    graph = dependency_graph(project)
    index_counter = [0]
    stack: List[str] = []
    on_stack: Set[str] = set()
    indices: Dict[str, int] = {}
    lowlink: Dict[str, int] = {}
    cycles: List[List[str]] = []

    def strongconnect(node: str) -> None:
        indices[node] = index_counter[0]
        lowlink[node] = index_counter[0]
        index_counter[0] += 1
        stack.append(node)
        on_stack.add(node)

        for neighbor in graph.get(node, []):
            if neighbor not in indices:
                strongconnect(neighbor)
                lowlink[node] = min(lowlink[node], lowlink[neighbor])
            elif neighbor in on_stack:
                lowlink[node] = min(lowlink[node], indices[neighbor])

        if lowlink[node] == indices[node]:
            component: List[str] = []
            while True:
                member = stack.pop()
                on_stack.discard(member)
                component.append(member)
                if member == node:
                    break
            if len(component) > 1:
                cycles.append(_order_cycle(component, graph))
            elif node in graph.get(node, []):
                cycles.append([node])

    for qid in graph:
        if qid not in indices:
            strongconnect(qid)
    return cycles


def _order_cycle(component: List[str], graph: Dict[str, List[str]]) -> List[str]:
    """把 SCC 内的节点按真实依赖边排成一条可读的环。"""

    members = set(component)
    start = sorted(component)[0]
    ordered = [start]
    current = start
    visited = {start}
    while True:
        nexts = [n for n in graph.get(current, []) if n in members and n not in visited]
        if not nexts:
            break
        nxt = sorted(nexts)[0]
        ordered.append(nxt)
        visited.add(nxt)
        current = nxt
    return ordered


def reachable_from_entries(project: Project) -> Set[str]:
    """从所有入口沿「前置 -> 后继」方向 BFS, 返回可达任务集合。"""

    succ = successor_graph(project)
    visited: Set[str] = set()
    queue = deque(q.id for q in project.entry_quests())
    while queue:
        node = queue.popleft()
        if node in visited:
            continue
        visited.add(node)
        for nxt in succ.get(node, []):
            if nxt not in visited:
                queue.append(nxt)
    return visited


def _bfs_path(graph: Dict[str, List[str]], start: str, targets: Set[str]) -> Optional[List[str]]:
    """在给定邻接表上找 start 到 targets 中任一节点的最短路径。"""

    if start in targets:
        return [start]
    queue = deque([(start, [start])])
    seen = {start}
    while queue:
        node, path = queue.popleft()
        for nxt in graph.get(node, []):
            if nxt in seen:
                continue
            new_path = path + [nxt]
            if nxt in targets:
                return new_path
            seen.add(nxt)
            queue.append((nxt, new_path))
    return None


def _path_to_entry(project: Project, quest_id: str) -> Optional[List[str]]:
    """沿依赖方向找到入口的路径 (入口 -> ... -> quest_id 的反查结果)。"""

    graph = dependency_graph(project)
    entries = {q.id for q in project.entry_quests()}
    dep_path = _bfs_path(graph, quest_id, entries)
    if dep_path is None:
        return None
    return list(reversed(dep_path))


# ---------------------------------------------------------------------------
# 主诊断入口
# ---------------------------------------------------------------------------


def analyze_project(project: Project) -> List[Issue]:
    issues: List[Issue] = []
    ids = set(project.ids())
    quest_index = {q.id: q for q in project.quests}

    # 1. 循环依赖
    cycles = find_cycles(project)
    for cycle in cycles:
        shown = cycle + [cycle[0]]
        issues.append(
            Issue(
                code="CYCLE",
                severity=ERROR,
                message="存在循环依赖: " + " -> ".join(shown) + " (箭头指向前置任务)",
                quest_ids=list(cycle),
                path=shown,
            )
        )

    # 2. 入口检查
    if project.quests and not project.entry_quests():
        issues.append(
            Issue(
                code="NO_ENTRY",
                severity=ERROR,
                message="整张任务图没有入口任务 (每个任务都至少有一个前置), 玩家无法开始",
                quest_ids=project.ids(),
            )
        )

    # 3. 可达性 (环上的任务不可达时不在此重复报错, 归入 CYCLE)
    cyclic_ids: Set[str] = set()
    for cycle in cycles:
        cyclic_ids.update(cycle)
    reachable = reachable_from_entries(project)
    for quest in project.quests:
        if quest.id in reachable or quest.id in cyclic_ids:
            continue
        # 给出卡住原因: 沿着前置链找到第一个不可达的前置
        blocker = _first_unreachable_prerequisite(quest, reachable, cyclic_ids)
        reason = f"任务 {quest.id} 从任何入口都无法到达"
        if blocker:
            reason += f", 卡在前置链上的 {blocker}"
        issues.append(
            Issue(
                code="UNREACHABLE",
                severity=WARNING if quest.optional else ERROR,
                message=reason,
                quest_ids=[quest.id],
            )
        )

    # 4. 结局可达性 (条件表达式里的引用也算路径)
    endings = {q.id for q in project.ending_quests()}
    if not endings:
        issues.append(
            Issue(
                code="NO_ENDING",
                severity=ERROR,
                message="任务图没有标记任何结局任务 (is_ending=true)",
            )
        )
    else:
        reachable_endings = endings & reachable
        if not reachable_endings and not cyclic_ids:
            issues.append(
                Issue(
                    code="ENDING_UNREACHABLE",
                    severity=ERROR,
                    message="没有任何结局可以从入口到达",
                    quest_ids=sorted(endings),
                )
            )
        # 无法到达任何结局的任务 (环上节点已由 CYCLE 报告, 不再重复;
        # 条件表达式里的任务引用只是运行时判断, 不算结构路径, 因此这里只看前置边)
        succ = successor_graph(project)
        for quest in project.quests:
            if quest.id not in reachable or quest.id in cyclic_ids:
                continue
            path = _bfs_path(succ, quest.id, endings)
            if path is None:
                issues.append(
                    Issue(
                        code="NO_PATH_TO_ENDING",
                        severity=WARNING if quest.optional else ERROR,
                        message=(
                            f"任务 {quest.id} 无法走到任何结局, 这条链是死路"
                            + (" (可选支线)" if quest.optional else "")
                        ),
                        quest_ids=[quest.id],
                        path=_dead_end_trace(succ, quest.id),
                    )
                )

    # 5. 互斥死路: 某任务的 (传递) 前置中同时包含一对互斥任务
    ancestors = _ancestors(project)
    reported_mutex_pairs: Set[Tuple[str, str, str]] = set()
    for quest in project.quests:
        req = ancestors[quest.id] | ({quest.id} if not quest.prerequisites else set())
        for a in sorted(req):
            qa = quest_index.get(a)
            if not qa:
                continue
            for b in qa.exclusive_with:
                if b not in req or b == a:
                    continue
                pair_key = (quest.id, *sorted((a, b)))
                if pair_key in reported_mutex_pairs:
                    continue
                reported_mutex_pairs.add(pair_key)
                lo, hi = sorted((a, b))
                path_a = _path_between(project, lo, quest.id) or [lo]
                path_b = _path_between(project, hi, quest.id) or [hi]
                issues.append(
                    Issue(
                        code="MUTEX_DEAD_END",
                        severity=ERROR,
                        message=(
                            f"任务 {quest.id} 同时依赖互斥任务 {lo} 与 {hi}, "
                            "玩家无论如何选择都无法接取该任务"
                        ),
                        quest_ids=[quest.id, lo, hi],
                        path=sorted(set(path_a + path_b)),
                    )
                )

    # 6. 互斥与前置关系矛盾
    for quest in project.quests:
        for other in quest.exclusive_with:
            if other in ancestors[quest.id]:
                issues.append(
                    Issue(
                        code="MUTEX_PREREQUISITE_CONFLICT",
                        severity=ERROR,
                        message=(
                            f"任务 {quest.id} 与 {other} 互斥, 但 {other} 又是它的(传递)前置, "
                            "该任务永远无法完成"
                        ),
                        quest_ids=[quest.id, other],
                    )
                )

    # 7. 条件表达式检查
    for quest in project.quests:
        if not quest.condition.strip():
            continue
        problems = lint_condition(
            quest.condition,
            known_quests=ids,
            known_flags=set(project.initial_flags),
            known_variables=set(project.initial_variables),
        )
        try:
            refs = extract_references(quest.condition)
        except ConditionError:
            refs = {"quests": [], "flags": [], "variables": []}
        broken_quest_refs = {ref for ref in refs["quests"] if ref not in ids}
        for problem in problems:
            # 任务缺失引用统一由 CONDITION_BROKEN_REF 报告, 避免重复
            if "不存在的任务" in problem and broken_quest_refs:
                continue
            severity = WARNING if "未知函数" in problem else ERROR
            issues.append(
                Issue(
                    code="CONDITION_INVALID",
                    severity=severity,
                    message=f"任务 {quest.id} 的条件表达式: {problem}",
                    quest_ids=[quest.id],
                )
            )
        for ref in sorted(broken_quest_refs):
            issues.append(
                Issue(
                    code="CONDITION_BROKEN_REF",
                    severity=ERROR,
                    message=f"任务 {quest.id} 的条件引用了不存在的任务 {ref!r}",
                    quest_ids=[quest.id, ref],
                )
            )

    return _dedupe_issues(issues)


def _first_unreachable_prerequisite(
    quest: Quest, reachable: Set[str], cyclic_ids: Set[str]
) -> Optional[str]:
    for pre in quest.prerequisites:
        if pre in cyclic_ids:
            return pre
        if pre not in reachable:
            return pre
    return None


def _dead_end_trace(succ: Dict[str, List[str]], start: str) -> List[str]:
    """沿后继走到一个叶子, 用于展示死路的具体路径。"""

    path = [start]
    current = start
    seen = {start}
    while succ.get(current):
        nxt = succ[current][0]
        if nxt in seen:
            break
        path.append(nxt)
        seen.add(nxt)
        current = nxt
    return path


def _ancestors(project: Project) -> Dict[str, Set[str]]:
    """每个任务的所有传递前置 (沿 prerequisites 展开)。"""

    graph = dependency_graph(project)
    cache: Dict[str, Set[str]] = {}

    def resolve(node: str, stack: Set[str]) -> Set[str]:
        if node in cache:
            return cache[node]
        result: Set[str] = set()
        for pre in graph.get(node, []):
            if pre in stack:
                continue  # 环保护
            result.add(pre)
            result |= resolve(pre, stack | {pre})
        cache[node] = result
        return result

    for qid in graph:
        resolve(qid, {qid})
    return cache


def _path_between(project: Project, start: str, target: str) -> Optional[List[str]]:
    """沿依赖方向找 start 到 target 的链 (target 依赖 start 时返回 [start,...,target])。"""

    succ = successor_graph(project)
    return _bfs_path(succ, start, {target})


def _dedupe_issues(issues: List[Issue]) -> List[Issue]:
    seen: Set[Tuple[str, str]] = set()
    result: List[Issue] = []
    for issue in issues:
        key = (issue.code, issue.message)
        if key not in seen:
            seen.add(key)
            result.append(issue)
    order = {ERROR: 0, WARNING: 1}
    result.sort(key=lambda i: (order.get(i.severity, 2), i.code, i.message))
    return result


# ---------------------------------------------------------------------------
# 影响分析
# ---------------------------------------------------------------------------


def downstream_impact(project: Project, quest_id: str) -> Dict[str, Any]:
    """返回修改某个任务/条件后, 直接或间接依赖它的后续任务。"""

    ids = set(project.ids())
    if quest_id not in ids:
        return {"quest_id": quest_id, "found": False, "direct": [], "transitive": [], "endings": []}
    succ = successor_graph(project)
    direct = sorted(succ.get(quest_id, []))

    visited: Set[str] = set()
    queue = deque(direct)
    while queue:
        node = queue.popleft()
        if node in visited:
            continue
        visited.add(node)
        queue.extend(succ.get(node, []))

    endings = {q.id for q in project.ending_quests()}
    return {
        "quest_id": quest_id,
        "found": True,
        "direct": direct,
        "transitive": sorted(visited),
        "endings": sorted(visited & endings),
    }


def compare_projects(before: Project, after: Project) -> Dict[str, Any]:
    """对比两个工程版本, 列出任务与条件的增删改及受影响的后续任务。"""

    before_map = {q.id: q for q in before.quests}
    after_map = {q.id: q for q in after.quests}

    added = sorted(set(after_map) - set(before_map))
    removed = sorted(set(before_map) - set(after_map))
    changed: List[Dict[str, Any]] = []

    watched_fields = (
        "prerequisites",
        "condition",
        "exclusive_with",
        "is_ending",
        "optional",
        "rewards",
    )
    for qid in sorted(set(before_map) & set(after_map)):
        old, new = before_map[qid], after_map[qid]
        fields_changed: List[str] = []
        for fname in watched_fields:
            old_val = old.to_dict()[fname]
            new_val = new.to_dict()[fname]
            if old_val != new_val:
                fields_changed.append(fname)
        if fields_changed:
            impact = downstream_impact(after, qid)
            changed.append(
                {
                    "quest_id": qid,
                    "fields": fields_changed,
                    "before": {f: old.to_dict()[f] for f in fields_changed},
                    "after": {f: new.to_dict()[f] for f in fields_changed},
                    "affected_direct": impact["direct"],
                    "affected_transitive": impact["transitive"],
                    "affected_endings": impact["endings"],
                }
            )

    # 被删除任务影响到的任务 (在旧图上计算)
    removal_impact: List[Dict[str, Any]] = []
    for qid in removed:
        impact = downstream_impact(before, qid)
        removal_impact.append(
            {
                "quest_id": qid,
                "affected_direct": impact["direct"],
                "affected_transitive": impact["transitive"],
            }
        )

    return {
        "added": added,
        "removed": removed,
        "changed": changed,
        "removal_impact": removal_impact,
        "flags_changed": before.initial_flags != after.initial_flags
        or before.initial_variables != after.initial_variables,
    }
