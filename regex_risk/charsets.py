"""字符集合的近似建模与集合运算。

分析器需要回答两个字符集合“能否匹配同一个字符”，用于判断重复分支、
相邻量词等结构之间是否存在歧义。这里把字符集合统一表示成若干个
Unicode 码位区间：

* ``exact`` 集合：区间内的码位都属于该集合；
* ``any`` 集合：除区间（排除区）外的所有码位都属于该集合，
  用来表示 ``[^...]``、点号这类补集。

只要表达式不使用 ``re.IGNORECASE``，这里的判断是确定的；
``maybe`` 只在调用方把反向引用等无法静态确定的结构交给
:func:`overlap` 时出现。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence, Tuple

# re.DOTALL 未开启时，点号不匹配行结束符；默认同时排除 \n 与 \r。
_DOT_EXCLUDED = ((10, 10), (13, 13))

Range = Tuple[int, int]


def merge_ranges(ranges: Iterable[Range]) -> Tuple[Range, ...]:
    """合并重叠/相邻的闭区间，返回有序且互不相交的区间元组。"""
    ordered = sorted(ranges)
    merged: List[Range] = []
    for lo, hi in ordered:
        if lo > hi:
            lo, hi = hi, lo
        if merged and lo <= merged[-1][1] + 1:
            if hi > merged[-1][1]:
                merged[-1] = (merged[-1][0], hi)
        else:
            merged.append((lo, hi))
    return tuple(merged)


def subtract_ranges(base: Sequence[Range], cut: Sequence[Range]) -> Tuple[Range, ...]:
    """从 ``base`` 的区间中挖掉 ``cut`` 覆盖的部分。"""
    result: List[Range] = []
    cuts = list(cut)
    for lo, hi in base:
        pieces = [(lo, hi)]
        for clo, chi in cuts:
            next_pieces: List[Range] = []
            for plo, phi in pieces:
                if chi < plo or clo > phi:
                    next_pieces.append((plo, phi))
                    continue
                if plo < clo:
                    next_pieces.append((plo, min(phi, clo - 1)))
                if chi < phi:
                    next_pieces.append((max(plo, chi + 1), phi))
            pieces = next_pieces
        result.extend(pieces)
    return merge_ranges(result)


@dataclass(frozen=True)
class CharSet:
    """一个字符集合。

    kind == "exact" 时，``ranges`` 是集合成员；
    kind == "any" 时，``ranges`` 是被排除的码位，集合为全集减去排除区。
    """

    kind: str
    ranges: Tuple[Range, ...]

    @classmethod
    def exact(cls, ranges: Iterable[Range] = ()) -> "CharSet":
        return cls("exact", merge_ranges(ranges))

    @classmethod
    def literal(cls, char: str) -> "CharSet":
        cp = ord(char)
        return cls("exact", ((cp, cp),))

    @classmethod
    def any_but(cls, exclusions: Iterable[Range] = ()) -> "CharSet":
        return cls("any", merge_ranges(exclusions))

    @classmethod
    def dot(cls) -> "CharSet":
        return cls.any_but(_DOT_EXCLUDED)

    def complement(self) -> "CharSet":
        if self.kind == "exact":
            if not self.ranges:
                return CharSet.any_but(())
            return CharSet.any_but(self.ranges)
        # 全集减去排除区之后再取补集，就是排除区本身。
        return CharSet.exact(self.ranges)

    def union(self, other: "CharSet") -> "CharSet":
        if self.kind == "exact" and other.kind == "exact":
            return CharSet.exact(self.ranges + other.ranges)
        if self.kind == "any" and other.kind == "any":
            # (U\\A) ∪ (U\\B) = U \\ (A ∩ B)
            common = _intersect_ranges(self.ranges, other.ranges)
            return CharSet.any_but(common)
        if self.kind == "any":
            any_set, exact_set = self, other
        else:
            any_set, exact_set = other, self
        # (U\\A) ∪ B = U \\ (A \\ B)
        remaining = subtract_ranges(any_set.ranges, exact_set.ranges)
        return CharSet.any_but(remaining)


def _intersect_ranges(a: Sequence[Range], b: Sequence[Range]) -> Tuple[Range, ...]:
    result: List[Range] = []
    i = j = 0
    while i < len(a) and j < len(b):
        lo = max(a[i][0], b[j][0])
        hi = min(a[i][1], b[j][1])
        if lo <= hi:
            result.append((lo, hi))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return tuple(result)


# 与 re 默认（Unicode 模式）保持一致的近似：这里按 ASCII 常见范围建模，
# ASCII 之外的字母/数字/空白造成的偏差在 README 中说明。
SHORTHAND_SETS = {
    "d": CharSet.exact(((ord("0"), ord("9")),)),
    "w": CharSet.exact(
        (
            (ord("0"), ord("9")),
            (ord("A"), ord("Z")),
            (ord("a"), ord("z")),
            (ord("_"), ord("_")),
        )
    ),
    "s": CharSet.exact(
        (
            (9, 13),   # \t \n \v \f \r
            (32, 32),  # 空格
        )
    ),
}


def shorthand(letter: str) -> CharSet:
    """返回 \\d \\w \\s 等简写字符集合（大写形式自动取补集）。"""
    base = SHORTHAND_SETS[letter.lower()]
    if letter.islower():
        return base
    return base.complement()


def overlap(a: Optional[CharSet], b: Optional[CharSet]) -> str:
    """判断两个字符集合是否可能匹配同一个字符。

    返回 ``"yes"``（一定存在公共字符）、``"no"``（完全不相交）
    或 ``"maybe"``（信息不足，例如反向引用无法静态确定内容）。
    """
    if a is None or b is None:
        return "maybe"
    if a.kind == "exact" and b.kind == "exact":
        return "yes" if _intersect_ranges(a.ranges, b.ranges) else "no"
    if a.kind == "any" and b.kind == "any":
        # 两个“几乎全集”的集合，排除区都是有限的，必然仍有公共字符。
        return "yes"
    exact = a if a.kind == "exact" else b
    any_set = b if a.kind == "exact" else a
    leftover = subtract_ranges(exact.ranges, any_set.ranges)
    return "yes" if leftover else "no"
