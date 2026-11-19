"""正则表达式风险静态分析器。

分析完全基于 :mod:`regex_risk.parser` 生成的语法树，不会对任何输入
实际执行匹配，因此分析 ``(a+)+`` 这类危险表达式本身也不会卡住进程。

风险分级：

* ``high``：存在明确的歧义重复结构，匹配失败时回溯路径随输入长度
  指数级增长（灾难性回溯的典型形态）；
* ``medium``：存在可能导致显著重复尝试的结构，但是否真的放大取决于
  具体输入或无法完全静态确定的内容；
* ``low``：只发现很弱的可疑信号，大概率无害，值得人工扫一眼；
* ``info``：不是风险，只是说明分析边界或被原子组/独占量词消解的结构。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from . import charsets
from .parser import (
    Alt,
    Anchor,
    AnyChar,
    AtomicGroup,
    BackRef,
    CharClass,
    Comment,
    Concat,
    Conditional,
    Empty,
    Group,
    Literal,
    Lookaround,
    NonCapture,
    Node,
    Repeat,
    RegexParseError,
    WordBoundary,
    parse_pattern,
)

RISK_LEVELS = ("high", "medium", "low", "info")

# Python 3.13 对特别深的嵌套会直接拒绝编译，这里留足余量。
_MAX_TRAVERSE_DEPTH = 200


@dataclass
class Finding:
    """一条分析发现。"""

    level: str
    code: str
    position: int          # 模式内 0 基起始下标
    end_position: int      # 模式内 0 基结束下标（不含）
    reason: str
    snippet: str


@dataclass
class _State:
    findings: List[Finding] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    # 已生成 note 的去重键，避免同一类边界说明反复出现。
    note_keys: Set[str] = field(default_factory=set)
    # 已经报过的 (code, position)，避免同一结构被多条规则重复报告。
    finding_keys: Set[Tuple[str, int]] = field(default_factory=set)
    pattern: str = ""
    # 条件分组/环视等只做结构识别，记录后跳过其内部歧义分析。
    skip_depth: int = 0

    def add_finding(self, level: str, code: str, node: Node, reason: str,
                    end: Optional[int] = None) -> None:
        key = (code, node.pos)
        if key in self.finding_keys:
            return
        self.finding_keys.add(key)
        end_pos = end if end is not None else _node_end(node, self.pattern)
        snippet = self.pattern[node.pos:end_pos]
        self.findings.append(
            Finding(level, code, node.pos, end_pos, reason, snippet)
        )

    def add_note(self, key: str, text: str) -> None:
        if key not in self.note_keys:
            self.note_keys.add(key)
            self.notes.append(text)


def analyze_pattern(pattern: str) -> Tuple[Optional[List[Finding]], Optional[str], List[str]]:
    """分析一条正则表达式。

    返回 ``(findings, error, notes)``：

    * 表达式无法通过 :func:`re.compile` 时，``findings`` 为 None，
      ``error`` 为错误说明，其它行仍可由调用方继续分析；
    * 正常时 ``findings`` 为发现列表（可能为空），``error`` 为 None。
    """
    try:
        re.compile(pattern)
    except (re.error, OverflowError, MemoryError) as exc:
        return None, _describe_compile_error(exc), []

    try:
        tree, parser_notes = parse_pattern(pattern)
    except RegexParseError as exc:
        # re.compile 已通过但自带解析器不认识：明确说明边界，不伪装成结论。
        return [], None, [
            f"位置 {exc.position} 附近的写法未被分析器支持（{exc.message}），"
            "该模式只做了编译合法性检查，未做完整风险分析"
        ]

    state = _State(pattern=pattern)
    for note in parser_notes:
        state.add_note(note, note)

    try:
        _analyze_node(tree, state, neutral=False, unbounded_ancestors=[])
    except RecursionError:
        state.add_note(
            "deep-nesting",
            "模式嵌套过深，分析在部分子树上提前终止，结论可能不完整",
        )

    state.findings.sort(key=lambda item: (item.position, RISK_LEVELS.index(item.level)))
    return state.findings, None, state.notes


def _describe_compile_error(exc: Exception) -> str:
    pos = getattr(exc, "pos", None)
    if pos is not None:
        return f"re 编译失败：{exc}（位置 {pos}）"
    return f"re 编译失败：{exc}"


# ---------------------------------------------------------------------
# 结构属性：可空性、首字符集合、尾字符集合
# ---------------------------------------------------------------------

def _is_nullable(node: Node) -> bool:
    if isinstance(node, (Empty, Anchor, WordBoundary, Comment)):
        return True
    if isinstance(node, (Literal, AnyChar, CharClass, BackRef)):
        return False
    if isinstance(node, Repeat):
        return node.min_count == 0 or _is_nullable(node.node)
    if isinstance(node, (Group, NonCapture, AtomicGroup)):
        return _is_nullable(node.node)
    if isinstance(node, Lookaround):
        return True
    if isinstance(node, Concat):
        return all(_is_nullable(child) for child in node.nodes)
    if isinstance(node, Alt):
        return any(_is_nullable(branch) for branch in node.branches)
    if isinstance(node, Conditional):
        # 条件分组本身允许两个分支都为空，保守按可空处理。
        return True
    return True


def _first_set(node: Node, state: _State) -> Optional[charsets.CharSet]:
    if isinstance(node, Empty) or isinstance(node, (Anchor, WordBoundary, Comment)):
        return charsets.CharSet.exact()
    if isinstance(node, Literal):
        return charsets.CharSet.literal(node.char)
    if isinstance(node, AnyChar):
        return charsets.CharSet.dot()
    if isinstance(node, CharClass):
        return node.charset
    if isinstance(node, BackRef):
        state.add_note(
            "backref-content",
            "反向引用匹配的内容取决于运行时捕获结果，字符集合判断只能按“可能重叠”近似",
        )
        return None
    if isinstance(node, Repeat):
        return _first_set(node.node, state)
    if isinstance(node, (Group, NonCapture, AtomicGroup)):
        return _first_set(node.node, state)
    if isinstance(node, Lookaround):
        state.add_note(
            "lookaround",
            "环视 (?=...)/(?<=...) 是零宽断言，其内部结构不参与量词歧义判断",
        )
        return charsets.CharSet.exact()
    if isinstance(node, Concat):
        combined = charsets.CharSet.exact()
        for child in node.nodes:
            child_set = _first_set(child, state)
            if child_set is None:
                if not _is_nullable(child):
                    return None
                continue
            combined = combined.union(child_set)
            if not _is_nullable(child):
                break
        return combined
    if isinstance(node, Alt):
        combined = charsets.CharSet.exact()
        for branch in node.branches:
            branch_set = _first_set(branch, state)
            if branch_set is None:
                return None
            combined = combined.union(branch_set)
        return combined
    if isinstance(node, Conditional):
        return None
    return None


def _last_set(node: Node, state: _State) -> Optional[charsets.CharSet]:
    if isinstance(node, Empty) or isinstance(node, (Anchor, WordBoundary, Comment)):
        return charsets.CharSet.exact()
    if isinstance(node, Literal):
        return charsets.CharSet.literal(node.char)
    if isinstance(node, AnyChar):
        return charsets.CharSet.dot()
    if isinstance(node, CharClass):
        return node.charset
    if isinstance(node, BackRef):
        return None
    if isinstance(node, Repeat):
        if node.min_count == 0:
            return charsets.CharSet.exact()
        return _last_set(node.node, state)
    if isinstance(node, (Group, NonCapture, AtomicGroup)):
        return _last_set(node.node, state)
    if isinstance(node, Lookaround):
        return charsets.CharSet.exact()
    if isinstance(node, Concat):
        combined = charsets.CharSet.exact()
        for child in reversed(node.nodes):
            child_set = _last_set(child, state)
            if child_set is None:
                if not _is_nullable(child):
                    return None
                continue
            combined = combined.union(child_set)
            if not _is_nullable(child):
                break
        return combined
    if isinstance(node, Alt):
        combined = charsets.CharSet.exact()
        for branch in node.branches:
            branch_set = _last_set(branch, state)
            if branch_set is None:
                return None
            combined = combined.union(branch_set)
        return combined
    if isinstance(node, Conditional):
        return None
    return None


# ---------------------------------------------------------------------
# 遍历与规则
# ---------------------------------------------------------------------

def _analyze_node(node: Node, state: _State, neutral: bool,
                  unbounded_ancestors: List[Repeat]) -> None:
    if len(unbounded_ancestors) > _MAX_TRAVERSE_DEPTH:
        raise RecursionError("pattern nesting too deep")

    if isinstance(node, Repeat):
        _analyze_repeat(node, state, neutral, unbounded_ancestors)
        return
    if isinstance(node, AtomicGroup):
        state.add_note(
            "atomic",
            "原子组 (?>...) 或独占量词（如 *+、++）会禁止内部回溯，"
            "其中的歧义结构不会放大匹配开销",
        )
        _analyze_node(node.node, state, neutral=True,
                      unbounded_ancestors=unbounded_ancestors)
        return
    if isinstance(node, Conditional):
        # 条件分组只做结构识别，内部歧义不纳入完整分析。
        return
    if isinstance(node, Lookaround):
        _analyze_lookaround(node, state, neutral, unbounded_ancestors)
        return
    if isinstance(node, BackRef):
        _analyze_backref(node, state, neutral, unbounded_ancestors)
        return
    if isinstance(node, Alt):
        _analyze_alt(node, state, neutral, unbounded_ancestors)
        return
    if isinstance(node, Concat):
        _analyze_concat(node, state, neutral, unbounded_ancestors)
        return
    if isinstance(node, (Group, NonCapture)):
        _analyze_node(node.node, state, neutral, unbounded_ancestors)
        return
    # Literal / CharClass / Anchor / WordBoundary / Empty / Comment / AnyChar
    return


def _is_unbounded(repeat: Repeat) -> bool:
    return repeat.max_count is None


def _is_lookaround_only(node: Node) -> bool:
    """整棵子树是否不消费任何字符、且只含断言类结构（环视/锚点/注释）。

    空捕获组 ``()`` 虽然匹配空串，但不属于断言，因此返回 False，
    保证 ``()*`` 这类可空重复仍会被规则 A 报告。
    """
    if isinstance(node, (Lookaround, Anchor, WordBoundary, Comment)):
        return True
    if isinstance(node, Empty):
        return False
    if isinstance(node, (NonCapture, AtomicGroup)):
        return _is_lookaround_only(node.node)
    if isinstance(node, Group):
        return False
    if isinstance(node, Concat):
        return all(_is_lookaround_only(child) for child in node.nodes)
    if isinstance(node, Alt):
        return all(_is_lookaround_only(branch) for branch in node.branches)
    if isinstance(node, Repeat):
        return _is_lookaround_only(node.node)
    return False


def _analyze_repeat(node: Repeat, state: _State, neutral: bool,
                    unbounded_ancestors: List[Repeat]) -> None:
    child_neutral = neutral or node.possessive
    if _is_unbounded(node) and not node.possessive:
        # 规则 A/B/D 都只在外层量词无上限时才可能指数级放大。
        current_ancestors = unbounded_ancestors + [node]
        if not neutral:
            _check_nested_repeats(node, state)
            _check_alternation_under_repeat(node, state)
        else:
            _note_neutralized(node, state)
        _analyze_node(node.node, state, child_neutral, current_ancestors)
    else:
        if node.possessive:
            state.add_note(
                "atomic",
                "原子组 (?>...) 或独占量词（如 *+、++）会禁止内部回溯，"
                "其中的歧义结构不会放大为性能风险",
            )
        _analyze_node(node.node, state, child_neutral, unbounded_ancestors)


def _note_neutralized(node: Repeat, state: _State) -> None:
    state.add_note(
        "neutralized",
        f"位置 {node.pos} 的无上限重复位于原子组/独占量词作用域内，"
        "回溯被禁止，歧义不会放大为性能风险",
    )


def _direct_children(node: Node) -> List[Node]:
    if isinstance(node, Concat):
        return node.nodes
    if isinstance(node, Alt):
        return node.branches
    if isinstance(node, (Group, NonCapture, AtomicGroup)):
        return [node.node]
    return []


def _iter_repeat_successors(root: Node):
    """产出 (内层 Repeat, 后继节点) 对。

    后继指拼接顺序中排在该重复之后、可能承接其让出字符的最近兄弟结构；
    重复位于分支或分组末尾时后继为 None。环视、原子组内部不参与。
    """
    pairs: List[Tuple[Repeat, Optional[Node]]] = []

    def walk(node: Node) -> None:
        if isinstance(node, (AtomicGroup, Lookaround, Conditional)):
            return
        if isinstance(node, Concat):
            for idx, child in enumerate(node.nodes):
                if isinstance(child, Repeat):
                    successor = node.nodes[idx + 1] if idx + 1 < len(node.nodes) else None
                    pairs.append((child, successor))
                walk(child)
            return
        if isinstance(node, Repeat):
            walk(node.node)
            return
        for child in _direct_children(node):
            walk(child)

    walk(root)
    return pairs


def _check_nested_repeats(outer: Repeat, state: _State) -> None:
    """规则 A：无上限重复内部又出现重复（嵌套量词）。

    关键判据是“外层一次重复整体”的性质，而不是内层量词自身：

    * 外层重复体可以匹配空串 -> 同一位置存在无数种重复次数拆分；
    * 外层重复体首尾可匹配同一字符 -> 相邻两轮重复的边界不唯一。
    环视是零宽断言，不消费字符，其内部的重复不参与判断。
    """
    inner_repeats: List[Repeat] = []

    def collect(current: Node) -> None:
        if isinstance(current, AtomicGroup):
            return  # 原子组内部不参与外层回溯
        if isinstance(current, Lookaround):
            return  # 环视不消费字符
        if isinstance(current, Repeat):
            if current is not outer:
                inner_repeats.append(current)
            if not current.possessive:
                collect(current.node)
            return
        if isinstance(current, Conditional):
            return
        for child in _direct_children(current):
            collect(child)

    collect(outer.node)

    # 可空的外层重复体：即使没有嵌套量词（例如 (a|)*、()*），零宽重复本身
    # 也会让同一位置产生无数种次数拆分。
    nullable_body = (
        _is_nullable(outer.node)
        or any(
            inner.min_count == 0 and not inner.possessive
            for inner in inner_repeats
        )
    )
    if nullable_body:
        # 整个重复体只由零宽断言/锚点组成（如 (?=a)*）时不消费字符，
        # 不存在回溯放大；空捕获组 ()* 仍然可空，需要报告。
        if not _is_lookaround_only(outer.node):
            state.add_finding(
                "high",
                "nested-nullable-repeat",
                outer,
                "无上限重复的重复体可以匹配空串，匹配失败时同一输入位置会产生大量"
                "等价的重复次数拆分，回溯路径随长度指数级增长",
            )
            return

    if not inner_repeats:
        return

    # 用外层重复体整体的首/尾字符集合判断相邻两轮重复的边界是否唯一。
    body_first = _first_set(outer.node, state)
    body_last = _last_set(outer.node, state)
    relation = charsets.overlap(body_last, body_first)

    has_unbounded_inner = any(
        _is_unbounded(inner) and not inner.possessive for inner in inner_repeats
    )
    if has_unbounded_inner:
        if relation == "yes":
            state.add_finding(
                "high",
                "nested-unbounded-repeat",
                outer,
                "两层重复都没有上限，且外层重复体首尾可匹配同一字符，"
                "匹配失败时每个字符都有多种重复次数组合，回溯量随长度指数级增长",
            )
            return
        if relation == "maybe":
            state.add_finding(
                "medium",
                "nested-unbounded-repeat-uncertain",
                outer,
                "两层无上限重复的首尾字符集合无法静态确定是否重叠，"
                "若运行时内容重叠，回溯量可能随长度指数级增长",
            )
            return
        # 整体首尾不重叠时，仍可能存在“内层无上限重复 + 后继可匹配同一字符”
        # 的组合（如 (a+ab+)+：a+ 让出一个 a 给后面的 a）。判据是内层重复的
        # 尾字符与其后继结构的首字符重叠，且该字符也能出现在重复体开头，
        # 这样内层重复才能把字符让给后继、再由下一轮重复重新吞并。
        for inner, successor in _iter_repeat_successors(outer.node):
            if inner.possessive or not _is_unbounded(inner) or successor is None:
                continue
            inner_last = _last_set(inner.node, state)
            successor_first = _first_set(successor, state)
            local = charsets.overlap(inner_last, successor_first)
            cross = charsets.overlap(successor_first, body_first)
            if local == "yes" and cross == "yes":
                state.add_finding(
                    "high",
                    "nested-boundary-repeat",
                    outer,
                    "内层无上限重复与其后继结构可匹配同一字符，且该字符也能出现在"
                    "重复体开头，内层重复可把字符让给后继再由下一轮吞并，"
                    "匹配失败时回溯量随长度指数级增长",
                )
                return
            if "maybe" in (local, cross) and "no" not in (local, cross):
                state.add_finding(
                    "medium",
                    "nested-boundary-repeat-uncertain",
                    outer,
                    "内层无上限重复与后继结构是否匹配同一字符无法静态确定，"
                    "若运行时重叠，重复边界不唯一，回溯量可能随长度指数级增长",
                )
                return
        return

    # 内层全部是有界重复；只有次数可变（如 {1,3}）时才可能放大。
    variable_bounded = [
        inner for inner in inner_repeats
        if not inner.possessive and inner.min_count != inner.max_count
    ]
    if not variable_bounded:
        return
    if relation == "yes":
        state.add_finding(
            "high",
            "nested-bounded-repeat",
            outer,
            "无上限重复内部包含次数可变的有界重复，且外层重复体首尾可匹配同一"
            "字符，失败时按有界次数反复组合，回溯量随长度快速增长",
        )
    elif relation == "maybe":
        state.add_finding(
            "medium",
            "nested-bounded-repeat-uncertain",
            outer,
            "无上限重复内部的可变次数有界重复，首尾字符集合是否重叠无法静态"
            "确定，重叠时回溯量会明显放大",
        )


def _check_alternation_under_repeat(outer: Repeat, state: _State) -> None:
    """规则 B：被无上限重复包裹的分支之间可能匹配相同内容。"""
    alts: List[Alt] = []

    def collect(current: Node) -> None:
        if isinstance(current, AtomicGroup):
            return
        if isinstance(current, (Conditional, Lookaround)):
            return
        if isinstance(current, Alt):
            alts.append(current)
            return  # 分支内部的 Alt 会在遍历时单独处理
        for child in _direct_children(current):
            collect(child)

    collect(outer.node)
    for alt in alts:
        # 含空分支的可空结构已由规则 A 的 nested-nullable-repeat 覆盖。
        branch_sets = [
            (branch, _first_set(branch, state))
            for branch in alt.branches
            if not isinstance(branch, Empty) and not _is_nullable(branch)
        ]
        if len(branch_sets) < 2:
            continue
        for idx in range(len(branch_sets)):
            for jdx in range(idx + 1, len(branch_sets)):
                left_node, left_set = branch_sets[idx]
                right_node, right_set = branch_sets[jdx]
                relation = charsets.overlap(left_set, right_set)
                if relation == "no":
                    continue
                if relation == "yes":
                    state.add_finding(
                        "high",
                        "overlapping-alternatives",
                        left_node,
                        "重复作用域内的两个分支首字符可以相同，同一输入存在多种"
                        "分支选择，匹配失败时回溯路径随长度指数级增长",
                        end=_node_end(right_node, state.pattern),
                    )
                else:
                    state.add_finding(
                        "medium",
                        "overlapping-alternatives-uncertain",
                        left_node,
                        "重复作用域内分支的首字符集合是否重叠无法静态确定，"
                        "若运行时重叠会产生大量等价分支选择",
                        end=_node_end(right_node, state.pattern),
                    )


def _analyze_alt(node: Alt, state: _State, neutral: bool,
                 unbounded_ancestors: List[Repeat]) -> None:
    # 不在无上限重复内部的分支歧义只会在线性扫描中付出常数代价，不单独报告。
    for branch in node.branches:
        _analyze_node(branch, state, neutral, unbounded_ancestors)


def _analyze_concat(node: Concat, state: _State, neutral: bool,
                    unbounded_ancestors: List[Repeat]) -> None:
    # 规则 C：相邻的两个无上限重复可能匹配同一段内容（多项式级回溯）。
    if not neutral:
        for idx in range(len(node.nodes) - 1):
            left = node.nodes[idx]
            right = node.nodes[idx + 1]
            if not (isinstance(left, Repeat) and isinstance(right, Repeat)):
                continue
            if left.possessive or right.possessive:
                continue
            if not (_is_unbounded(left) and _is_unbounded(right)):
                continue
            relation = charsets.overlap(
                _last_set(left.node, state), _first_set(right.node, state)
            )
            if relation == "yes":
                state.add_finding(
                    "medium",
                    "adjacent-overlapping-repeat",
                    left,
                    "相邻的两个无上限重复可匹配同一字符，边界位置不唯一，"
                    "失败时尝试次数约随输入长度平方增长",
                    end=_node_end(right, state.pattern),
                )
            elif relation == "maybe":
                state.add_finding(
                    "low",
                    "adjacent-overlapping-repeat-uncertain",
                    left,
                    "相邻无上限重复的字符集合是否重叠无法静态确定，重叠时"
                    "边界尝试会明显增多",
                    end=_node_end(right, state.pattern),
                )
    for child in node.nodes:
        _analyze_node(child, state, neutral, unbounded_ancestors)


def _analyze_backref(node: BackRef, state: _State, neutral: bool,
                     unbounded_ancestors: List[Repeat]) -> None:
    state.add_note(
        "backref-content",
        "反向引用匹配的内容取决于运行时捕获结果，字符集合判断只能按“可能重叠”近似",
    )
    # 规则 D：反向引用处于无上限重复内部时，重复会反复扩展匹配内容。
    if not neutral and unbounded_ancestors:
        state.add_finding(
            "medium",
            "backref-in-repeat",
            node,
            "反向引用位于无上限重复内部，捕获内容随每轮重复变化，"
            "匹配失败时引擎会反复扩展并回溯各轮捕获，开销可能显著放大",
        )


def _analyze_lookaround(node: Lookaround, state: _State, neutral: bool,
                        unbounded_ancestors: List[Repeat]) -> None:
    state.add_note(
        "lookaround",
        "环视 (?=...)/(?<=...) 是零宽断言，其内部结构不参与量词歧义判断",
    )
    _analyze_node(node.node, state, neutral, unbounded_ancestors)


def _node_end(node: Node, pattern: str) -> int:
    """取节点在模式中的结束下标；无法精确计算时退化为起始下标 + 1。"""
    if isinstance(node, Repeat):
        return max(node.quantifier_end, _node_end(node.node, pattern))
    if isinstance(node, (Group, NonCapture, AtomicGroup)):
        # 分组节点从 '(' 开始，结束位置取匹配的右括号之后。
        close = _find_matching_close(pattern, node.pos)
        return close if close is not None else _node_end(node.node, pattern)
    if isinstance(node, Concat) and node.nodes:
        return _node_end(node.nodes[-1], pattern)
    if isinstance(node, Alt) and node.branches:
        return _node_end(node.branches[-1], pattern)
    if isinstance(node, Literal):
        return node.pos + 1
    if isinstance(node, CharClass):
        end = pattern.find("]", node.pos)
        return end + 1 if end != -1 else node.pos + 1
    if isinstance(node, BackRef):
        if isinstance(node.ref, str):
            # (?P=name) 形式：结束于右括号之后；\g<...> 不是合法 re 语法。
            close = _find_matching_close(pattern, node.pos)
            return close if close is not None else node.pos + 1
        end = node.pos + 1  # 反斜杠
        while end < len(pattern) and pattern[end].isdigit():
            end += 1
        return end
    return node.pos + 1


def _find_matching_close(pattern: str, open_pos: int):
    """返回与 open_pos 处 '(' 配对的 ')' 之后的下标，找不到时返回 None。"""
    if open_pos >= len(pattern) or pattern[open_pos] != "(":
        return None
    depth = 0
    index = open_pos
    in_class = False
    while index < len(pattern):
        ch = pattern[index]
        if ch == "\\":
            index += 2
            continue
        if ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        elif not in_class:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    return index + 1
        index += 1
    return None
