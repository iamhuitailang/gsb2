"""Python 正则表达式子集的递归下降解析器。

只覆盖分析所需的语法结构：字面量、常见转义、字符集合、捕获/非捕获分组、
环视、原子组、条件分组、量词（含独占量词）、分支和反向引用。
能用 :func:`re.compile` 编译通过、但解析器不支持的写法会记录到
``parser.notes`` 中，分析器据此说明判断边界，而不是给出确定结论。
"""

from __future__ import annotations

import re
import sys
import unicodedata
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from . import charsets

# 简单转义到实际字符的映射（\b 不在其中：字符集合外是单词边界）。
_SIMPLE_ESCAPES = {
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "f": "\f",
    "v": "\v",
    "a": "\a",
    "0": "\0",
}

# 字符串语义的锚点（Python re 只支持 A/Z/z 中的 \A \Z，\z 留给报错分支）。
_ANCHORS = {
    "A": "at_start",
    "Z": "at_end",
}

class RegexParseError(Exception):
    """解析器自身的语法错误（正常情况下 re.compile 已先拦住）。"""

    def __init__(self, message: str, position: int):
        super().__init__(message)
        self.message = message
        self.position = position


@dataclass
class Node:
    pos: int  # 在原始模式中的起始下标（0 基）


@dataclass
class Empty(Node):
    pass


@dataclass
class Literal(Node):
    char: str


@dataclass
class CharClass(Node):
    charset: charsets.CharSet
    negated: bool


@dataclass
class AnyChar(Node):
    pass


@dataclass
class Anchor(Node):
    kind: str  # ^ $ \A \Z \z 等


@dataclass
class WordBoundary(Node):
    kind: str  # \\b 或 \\B


@dataclass
class Group(Node):
    index: Optional[int]  # 捕获组编号，非捕获组为 None
    node: Node
    name: Optional[str] = None


@dataclass
class NonCapture(Node):
    node: Node
    flags_added: int = 0
    flags_removed: int = 0


@dataclass
class Lookaround(Node):
    node: Node
    is_ahead: bool
    is_positive: bool


@dataclass
class AtomicGroup(Node):
    node: Node


@dataclass
class Conditional(Node):
    condition_ref: object  # 组编号(int)或组名(str)
    yes_branch: Node
    no_branch: Optional[Node]


@dataclass
class Repeat(Node):
    node: Node
    min_count: int
    max_count: Optional[int]  # None 表示无上限
    lazy: bool
    possessive: bool
    quantifier_end: int = 0  # 量词（含惰性/独占标记）之后的下标


@dataclass
class Concat(Node):
    nodes: List[Node]


@dataclass
class Alt(Node):
    branches: List[Node]


@dataclass
class BackRef(Node):
    ref: object  # 组编号(int)或组名(str)


@dataclass
class Comment(Node):
    pass


class RegexParser:
    def __init__(self, pattern: str):
        self.pattern = pattern
        self.i = 0
        self.group_count = 0
        self.group_names: Dict[str, int] = {}
        self.notes: List[str] = []
        # 条件分组引用的 (组名/组号, 出现位置, 出现时已存在的组, 已存在的组名)。
        self._condition_refs: List[Tuple[object, int, int, set]] = []

    # ---- 入口 -------------------------------------------------------

    def parse(self) -> Node:
        node = self._parse_alt()
        if self.i != len(self.pattern):
            raise RegexParseError("unexpected trailing input", self.i)
        # re 要求条件分组引用的捕获组必须在条件出现之前定义（前向引用报错）。
        for ref, ref_pos, scope_groups, scope_names in self._condition_refs:
            if isinstance(ref, str):
                if ref not in scope_names:
                    raise RegexParseError(f"unknown group name '{ref}'", ref_pos)
            elif ref > scope_groups:
                raise RegexParseError(f"invalid group reference {ref}", ref_pos)
        if isinstance(node, Empty):
            self.notes.append("模式为空，不产生匹配结构")
        return node

    # ---- 分支与拼接 --------------------------------------------------

    def _parse_alt(self) -> Node:
        branches = [self._parse_concat()]
        while self._peek() == "|":
            self.i += 1
            branches.append(self._parse_concat())
        if len(branches) == 1:
            return branches[0]
        return Alt(pos=branches[0].pos, branches=branches)

    def _parse_concat(self, stop_at: str = "") -> Node:
        items: List[Node] = []
        start = self.i
        while self.i < len(self.pattern) and self._peek() not in stop_at:
            ch = self._peek()
            if ch == "|":
                break
            if ch == "^":
                atom: Node = Anchor(pos=self.i, kind="start")
                self.i += 1
            elif ch == "$":
                atom = Anchor(pos=self.i, kind="end")
                self.i += 1
            elif ch == ".":
                atom = AnyChar(pos=self.i)
                self.i += 1
            elif ch == "(":
                atom = self._parse_group()
            elif ch == "[":
                atom = self._parse_class()
            elif ch == "\\":
                atom = self._parse_escape_atom()
            elif ch in "*+?":
                raise RegexParseError("nothing to repeat", self.i)
            elif ch == "{":
                # 未形成完整量词的 { 按普通字符处理（与 re 行为一致）。
                scanned = self._scan_brace_quantifier(self.i)
                if scanned is not None:
                    raise RegexParseError("nothing to repeat", self.i)
                atom = Literal(pos=self.i, char="{")
                self.i += 1
            elif ch == ")":
                break
            else:
                atom = Literal(pos=self.i, char=ch)
                self.i += 1
            items.append(self.wrap_quantifier(atom))
        if not items:
            return Empty(pos=start)
        if len(items) == 1:
            return items[0]
        return Concat(pos=start, nodes=items)

    # ---- 分组 --------------------------------------------------------

    def _parse_group(self) -> Node:
        start = self.i
        self.i += 1  # 消费 (
        if self._peek() != "?":
            self.group_count += 1
            index = self.group_count
            inner = self._parse_alt()
            self._expect(")")
            return Group(pos=start, index=index, node=inner)

        self.i += 1  # 消费 ?
        marker = self._peek()
        if marker == "#":
            # (?#...) 注释组
            depth = 1
            self.i += 1
            while self.i < len(self.pattern) and depth:
                if self.pattern[self.i] == "(":
                    depth += 1
                elif self.pattern[self.i] == ")":
                    depth -= 1
                self.i += 1
            if depth:
                raise RegexParseError("unterminated comment group", start)
            return Comment(pos=start)
        if marker in "=<!":
            # (?=...) (?!...) (?<=...) (?<!...) (?<name>...) 等
            return self._parse_special_group(start)
        if marker == "P":
            # (?P<name>...) 或 (?P=name)
            return self._parse_special_group(start)
        if marker == ">":
            # (?>...) 原子组
            return self._parse_special_group(start)
        if marker == ":":
            saved = self.i
            self.i += 1
            inner = self._parse_alt()
            self._expect(")")
            return NonCapture(pos=start, node=inner)
        if marker == "(":
            # 条件分组 (?(id/name)yes-pattern|no-pattern)
            return self._parse_conditional(start)
        if marker in "aiLmsux-":
            return self._parse_noncapture_or_flags(start)
        raise RegexParseError(f"unknown group extension ?{marker}", self.i)

    def _parse_special_group(self, start: int) -> Node:
        # 调用前 '?' 已被消费，self.i 指向扩展标记的首字符。
        # (?P<name>...) 与 (?P=name)：先处理 P 前缀，避免被 < 通配分支抢走。
        if self.pattern.startswith("P<", self.i):
            self.i += 2
            name, name_pos = self._read_group_name(start)
            self._expect(">")
            self.group_count += 1
            index = self.group_count
            if name in self.group_names:
                raise RegexParseError(f"redefinition of group name '{name}'", name_pos)
            self.group_names[name] = index
            inner = self._parse_alt()
            self._expect(")")
            return Group(pos=start, index=index, node=inner, name=name)
        if self.pattern.startswith("P=", self.i):
            self.i += 2
            name, name_pos = self._read_group_name(start)
            self._expect(")")
            if name not in self.group_names:
                raise RegexParseError(f"unknown group name '{name}'", name_pos)
            return BackRef(pos=start, ref=name)
        if self._peek() == "=":
            self.i += 1
            inner = self._parse_alt()
            self._expect(")")
            return Lookaround(start, inner, True, True)
        if self._peek() == "!":
            self.i += 1
            inner = self._parse_alt()
            self._expect(")")
            return Lookaround(start, inner, True, False)
        if self.pattern.startswith("<=", self.i):
            self.i += 2
            inner = self._parse_alt()
            self._expect(")")
            self._require_fixed_width(inner, start)
            return Lookaround(start, inner, False, True)
        if self.pattern.startswith("<!", self.i):
            self.i += 2
            inner = self._parse_alt()
            self._expect(")")
            self._require_fixed_width(inner, start)
            return Lookaround(start, inner, False, False)
        if self._peek() == ">":
            self.i += 1
            inner = self._parse_alt()
            self._expect(")")
            return AtomicGroup(pos=start, node=inner)
        if self._peek() == "<":
            # (?<name>...) 命名捕获组的另一种写法
            self.i += 1
            name, name_pos = self._read_group_name(start)
            self._expect(">")
            self.group_count += 1
            index = self.group_count
            if name in self.group_names:
                raise RegexParseError(f"redefinition of group name '{name}'", name_pos)
            self.group_names[name] = index
            inner = self._parse_alt()
            self._expect(")")
            return Group(pos=start, index=index, node=inner, name=name)
        raise RegexParseError("unknown group extension", self.i)

    def _parse_noncapture_or_flags(self, start: int) -> Node:
        body_start = self.i
        flags_added = flags_removed = 0
        sign = 1
        while self.i < len(self.pattern):
            ch = self.pattern[self.i]
            if ch == "-":
                sign = -1
                self.i += 1
            elif ch in "aiLmsux":
                if sign > 0:
                    flags_added |= _FLAG_BITS[ch]
                else:
                    flags_removed |= _FLAG_BITS[ch]
                self.i += 1
            else:
                break
        if self._peek() == ":":
            self.i += 1
            inner = self._parse_alt()
            self._expect(")")
            node = NonCapture(
                pos=start, node=inner,
                flags_added=flags_added, flags_removed=flags_removed,
            )
            if flags_added & re.IGNORECASE or flags_removed & re.IGNORECASE:
                self.notes.append(
                    f"位置 {start} 附近使用了大小写相关标志，字符集合判断按大小写敏感近似"
                )
            return node
        if self._peek() == ")":
            self.i += 1
            rest = self._parse_alt()
            if self.i != len(self.pattern):
                raise RegexParseError("global flags not at the start", body_start)
            if flags_added & re.IGNORECASE:
                self.notes.append(
                    f"位置 {start} 附近使用了全局大小写标志，字符集合判断按大小写敏感近似"
                )
            return NonCapture(
                pos=start, node=rest,
                flags_added=flags_added, flags_removed=flags_removed,
            )
        raise RegexParseError("malformed non-capturing group flags", body_start)

    def _parse_conditional(self, start: int) -> Node:
        self.i += 1  # 消费 (，此时指向条件内部
        cond_pos = self.i
        if self._peek() is not None and (
            self._peek().isalpha() or self._peek() == "_"
        ):
            # 裸组名：(?(name)yes|no)，re 不接受引号包裹的组名
            name_begin = self.i
            while self.i < len(self.pattern) and (
                self.pattern[self.i].isalnum() or self.pattern[self.i] == "_"
            ):
                self.i += 1
            ref: object = self.pattern[name_begin:self.i]
        else:
            num_begin = self.i
            while self.i < len(self.pattern) and self.pattern[self.i].isdigit():
                self.i += 1
            if num_begin == self.i:
                raise RegexParseError("missing condition in conditional group", cond_pos)
            ref = int(self.pattern[num_begin:self.i])
        # 记录条件出现时的作用域快照：re 不允许条件引用之后才定义的捕获组。
        scope_groups = self.group_count
        scope_names = set(self.group_names)
        self._expect(")")
        yes_branch = self._parse_concat(stop_at="|)")
        no_branch = None
        if self._peek() == "|":
            self.i += 1
            no_branch = self._parse_concat(stop_at=")")
        self._expect(")")
        self._condition_refs.append((ref, cond_pos, scope_groups, scope_names))
        self.notes.append(
            f"位置 {start} 的条件分组 (?(...)) 只做结构识别，分支歧义未纳入完整分析"
        )
        return Conditional(start, ref, yes_branch, no_branch)

    # ---- 字符集合 ----------------------------------------------------

    def _parse_class(self) -> Node:
        start = self.i
        self.i += 1  # 消费 [
        negated = False
        if self._peek() == "^":
            negated = True
            self.i += 1
        positive_members: List[charsets.CharSet] = []
        negative_members: List[charsets.CharSet] = []
        first = True
        while self.i < len(self.pattern) and (first or self._peek() != "]"):
            first = False
            ch = self._peek()
            if ch == "]":
                member = charsets.CharSet.literal("]")
                self.i += 1
            elif ch == "\\":
                member = self._parse_class_escape()
            elif ch == "[":
                # 字符集合中的 [ 只是普通字符
                member = charsets.CharSet.literal("[")
                self.i += 1
            else:
                member = charsets.CharSet.literal(ch)
                self.i += 1
            # 处理 x-y 形式的区间
            if self._peek() == "-" and self.i + 1 < len(self.pattern) \
                    and self.pattern[self.i + 1] != "]":
                range_pos = self.i
                self.i += 1  # 消费 -
                if self._peek() == "\\":
                    end_member = self._parse_class_escape()
                else:
                    end_char = self.pattern[self.i]
                    end_member = charsets.CharSet.literal(end_char)
                    self.i += 1
                lo_set, hi_set = member, end_member
                lo = _single_codepoint(lo_set)
                hi = _single_codepoint(hi_set)
                if lo is None or hi is None:
                    raise RegexParseError("bad character range", range_pos)
                if lo > hi:
                    raise RegexParseError("bad character range", range_pos)
                member = charsets.CharSet.exact(((lo, hi),))
            if member.kind == "any":
                # 字符集合内部的 \D \W \S：其补集才是参与并集的成员。
                negative_members.append(member)
            else:
                positive_members.append(member)
        if self.i >= len(self.pattern):
            raise RegexParseError("unterminated character set", start)
        self.i += 1  # 消费 ]

        combined = charsets.CharSet.exact()
        for member in positive_members:
            combined = combined.union(member)
        for member in negative_members:
            combined = combined.union(member.complement())
        if negated:
            combined = combined.complement()
        return CharClass(pos=start, charset=combined, negated=negated)

    def _parse_class_escape(self) -> charsets.CharSet:
        start = self.i
        self.i += 1  # 消费反斜杠
        ch = self._peek()
        if ch is None:
            raise RegexParseError("bad escape (end of pattern)", start)
        self.i += 1
        if ch in "dDwWsS":
            # 字符集合内部的 \D \W \S 表示“不属于该简写集合”的成员。
            return charsets.shorthand(ch)
        if ch in _SIMPLE_ESCAPES:
            return charsets.CharSet.literal(_SIMPLE_ESCAPES[ch])
        if ch == "x":
            return charsets.CharSet.literal(self._read_hex_escape(start))
        if ch == "u":
            digits = self._consume(4)
            return charsets.CharSet.literal(chr(int(digits, 16)))
        if ch == "U":
            digits = self._consume(8)
            return charsets.CharSet.literal(chr(int(digits, 16)))
        if ch == "N":
            return charsets.CharSet.literal(self._read_named_unicode(start))
        if ch in "01234567":
            octal = self._read_octal(ch)
            return charsets.CharSet.literal(chr(int(octal, 8)))
        if ch == "a":
            return charsets.CharSet.literal("\a")
        if ch == "b":
            # 字符集合内的 \b 是退格
            return charsets.CharSet.literal("\b")
        # 其它转义在字符集合里按字面字符处理，例如 \. \[ \-
        return charsets.CharSet.literal(ch)

    # ---- 转义原子 ----------------------------------------------------

    def _parse_escape_atom(self) -> Node:
        start = self.i
        self.i += 1  # 消费反斜杠
        ch = self._peek()
        if ch is None:
            raise RegexParseError("bad escape (end of pattern)", start)
        self.i += 1
        # 注意：\b 在字符集合外是单词边界，不是退格符（退格只在 [...] 内成立）。
        if ch in ("b", "B"):
            return WordBoundary(pos=start, kind=ch)
        if ch in _SIMPLE_ESCAPES:
            return Literal(pos=start, char=_SIMPLE_ESCAPES[ch])
        if ch in "dDwWsS":
            return CharClass(pos=start, charset=charsets.shorthand(ch), negated=ch.isupper())
        if ch in _ANCHORS:
            return Anchor(pos=start, kind=_ANCHORS[ch])
        if ch in "01234567":
            return self._parse_numeric_escape(start, ch)
        if ch == "x":
            return Literal(pos=start, char=self._read_hex_escape(start))
        if ch == "u":
            digits = self._consume(4)
            return Literal(pos=start, char=chr(int(digits, 16)))
        if ch == "U":
            digits = self._consume(8)
            return Literal(pos=start, char=chr(int(digits, 16)))
        if ch == "N":
            return Literal(pos=start, char=self._read_named_unicode(start))
        # 未被识别的字母转义在 re 中属于 bad escape（正常情况下 re.compile
        # 会先拦住，这里保持同样的报错行为）；标点转义按字面字符处理。
        if ch.isalpha():
            raise RegexParseError(f"bad escape \\{ch}", start)
        return Literal(pos=start, char=ch)

    def _parse_numeric_escape(self, start: int, first: str) -> Node:
        if first == "0":
            octal = self._read_octal(first)
            return Literal(pos=start, char=chr(int(octal, 8)))
        # 与 re 一致：数字转义最多读取两位十进制，当作反向引用。
        digits = first
        while len(digits) < 2 and self._peek() is not None and self._peek().isdigit():
            digits += self.pattern[self.i]
            self.i += 1
        ref = int(digits)
        if ref > self.group_count:
            raise RegexParseError(f"invalid group reference {ref}", start)
        return BackRef(pos=start, ref=ref)

    def _read_octal(self, first: str) -> str:
        digits = first
        while len(digits) < 3 and self._peek() is not None and self._peek() in "01234567":
            digits += self.pattern[self.i]
            self.i += 1
        return digits

    def _read_hex_escape(self, start: int) -> str:
        if self._peek() == "{":
            self.i += 1
            begin = self.i
            while self._peek() is not None and self._peek() != "}":
                self.i += 1
            digits = self.pattern[begin:self.i]
            self._expect("}")
            return chr(int(digits, 16))
        digits = self._consume(2)
        return chr(int(digits, 16))

    def _read_named_unicode(self, start: int) -> str:
        self._expect("{")
        begin = self.i
        while self._peek() is not None and self._peek() != "}":
            self.i += 1
        name = self.pattern[begin:self.i]
        self._expect("}")
        try:
            return unicodedata.lookup(name)
        except KeyError:
            raise RegexParseError(f"undefined Unicode character name {name!r}", start)

    # ---- 量词 --------------------------------------------------------

    def wrap_quantifier(self, atom: Node) -> Node:
        """在解析出原子之后尝试消费量词，没有量词时原样返回。"""
        quant_pos = self.i
        symbol = self._try_parse_symbol_quantifier()
        if symbol is not None:
            min_count, max_count = symbol
        else:
            scanned = self._scan_brace_quantifier(self.i)
            if scanned is None:
                return atom
            min_count, max_count, end = scanned
            self.i = end
        lazy = False
        possessive = False
        if self._peek() == "?":
            lazy = True
            self.i += 1
        elif self._peek() == "+":
            possessive = True
            self.i += 1
        if isinstance(atom, (Anchor, WordBoundary)):
            raise RegexParseError("nothing to repeat", quant_pos)
        if isinstance(atom, Comment):
            # 注释组 (?#...) 不消费字符，re 同样拒绝在其后加量词。
            raise RegexParseError("nothing to repeat", quant_pos)
        return Repeat(
            pos=quant_pos,
            node=atom,
            min_count=min_count,
            max_count=max_count,
            lazy=lazy,
            possessive=possessive,
            quantifier_end=self.i,
        )

    def _try_parse_symbol_quantifier(self):
        ch = self._peek()
        if ch == "*":
            self.i += 1
            return (0, None)
        if ch == "+":
            self.i += 1
            return (1, None)
        if ch == "?":
            self.i += 1
            return (0, 1)
        return None

    def _scan_brace_quantifier(self, pos: int):
        """无副作用地扫描 {m} {m,} {,n} {m,n}。

        是合法量词时返回 (最小次数, 最大次数或 None, 右花括号之后的下标)；
        花括号不构成量词（例如 ``a{``、``a{}``）时返回 None，由调用方按字面量处理。
        """
        if pos >= len(self.pattern) or self.pattern[pos] != "{":
            return None
        j = pos + 1
        begin = j
        while j < len(self.pattern) and self.pattern[j].isdigit():
            j += 1
        min_text = self.pattern[begin:j]
        if j < len(self.pattern) and self.pattern[j] == "}":
            if not min_text:
                return None  # {} 整体按字面量处理
            value = int(min_text)
            if value > _MAX_REPEAT:
                raise RegexParseError("the repetition number is too large", pos)
            return (value, value, j + 1)
        if j < len(self.pattern) and self.pattern[j] == ",":
            j += 1
            max_begin = j
            while j < len(self.pattern) and self.pattern[j].isdigit():
                j += 1
            max_text = self.pattern[max_begin:j]
            if j >= len(self.pattern) or self.pattern[j] != "}":
                return None  # 不是完整量词，{ 按字面量处理
            min_value = int(min_text) if min_text else 0
            if max_text:
                max_value: Optional[int] = int(max_text)
                if max_value > _MAX_REPEAT:
                    raise RegexParseError("the repetition number is too large", pos)
                if min_value > max_value:
                    raise RegexParseError("min repeat greater than max repeat", pos)
            else:
                max_value = None
            return (min_value, max_value, j + 1)
        return None

    # ---- 小工具 ------------------------------------------------------

    def _read_group_name(self, start: int) -> Tuple[str, int]:
        begin = self.i
        if not self.pattern[begin:begin + 1].isalpha() and self.pattern[begin:begin + 1] != "_":
            raise RegexParseError("missing group name", start)
        while self.i < len(self.pattern) and (
            self.pattern[self.i].isalnum() or self.pattern[self.i] == "_"
        ):
            self.i += 1
        if begin == self.i:
            raise RegexParseError("missing group name", start)
        return self.pattern[begin:self.i], begin

    def _consume(self, count: int) -> str:
        end = self.i + count
        if end > len(self.pattern):
            raise RegexParseError("incomplete escape sequence", self.i)
        text = self.pattern[self.i:end]
        self.i = end
        return text

    def _expect(self, ch: str) -> None:
        if self._peek() != ch:
            found = self._peek()
            raise RegexParseError(f"expected {ch!r} but found {found!r}", self.i)
        self.i += 1

    def _require_fixed_width(self, node: Node, start: int) -> None:
        if self._fixed_width(node) is None:
            raise RegexParseError(
                "look-behind requires fixed-width pattern", start
            )

    def _fixed_width(self, node: Node) -> Optional[int]:
        """返回节点的固定匹配宽度；宽度可变时返回 None。

        可空节点（如可选的零宽断言 ``($)?``）的宽度按 0 处理，
        因为它要么不出现、要么只匹配固定宽度，不破坏整体定宽性。
        """
        if isinstance(node, (Literal, AnyChar, CharClass)):
            return 1
        if isinstance(node, (Empty, Anchor, WordBoundary, Comment, Lookaround)):
            return 0
        if isinstance(node, BackRef):
            return None  # 捕获内容长度运行时才知道
        if isinstance(node, Repeat):
            inner_width = self._fixed_width(node.node)
            if inner_width is None:
                return None
            if inner_width == 0:
                # 重复零宽结构（如 ($)?、(?=x)*）宽度恒为 0，仍然定宽。
                return 0
            if node.max_count is None or node.min_count != node.max_count:
                return None
            return inner_width * node.max_count
        if isinstance(node, (Group, NonCapture, AtomicGroup)):
            return self._fixed_width(node.node)
        if isinstance(node, Concat):
            total = 0
            for child in node.nodes:
                width = self._fixed_width(child)
                if width is None:
                    return None
                total += width
            return total
        if isinstance(node, Alt):
            widths = {self._fixed_width(branch) for branch in node.branches}
            if None in widths or len(widths) != 1:
                return None
            return widths.pop()
        if isinstance(node, Conditional):
            return None
        return None

    def _peek(self) -> Optional[str]:
        if self.i >= len(self.pattern):
            return None
        return self.pattern[self.i]


# re 在 3.11 起对超大重复数抛 OverflowError，这里沿用同样的上限。
_MAX_REPEAT = sys.maxsize

_FLAG_BITS = {
    "i": re.IGNORECASE,
    "a": re.ASCII,
    "L": re.LOCALE,
    "m": re.MULTILINE,
    "s": re.DOTALL,
    "u": re.UNICODE,
    "x": re.VERBOSE,
}


def _single_codepoint(sset: charsets.CharSet) -> Optional[int]:
    if sset.kind == "exact" and len(sset.ranges) == 1 and sset.ranges[0][0] == sset.ranges[0][1]:
        return sset.ranges[0][0]
    return None


def parse_pattern(pattern: str) -> Tuple[Node, List[str]]:
    """解析模式，返回 (AST, 分析边界说明列表)。"""
    parser = RegexParser(pattern)
    tree = parser.parse()
    return tree, parser.notes
