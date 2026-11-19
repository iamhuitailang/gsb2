"""字符集合运算的单元测试。"""

import unittest

from regex_risk.charsets import (
    CharSet,
    overlap,
    shorthand,
    subtract_ranges,
)


class CharSetTest(unittest.TestCase):
    def test_literal_overlap_yes_and_no(self):
        a = CharSet.literal("a")
        b = CharSet.literal("a")
        c = CharSet.literal("b")
        self.assertEqual(overlap(a, b), "yes")
        self.assertEqual(overlap(a, c), "no")

    def test_range_overlap(self):
        digits = CharSet.exact(((ord("0"), ord("9")),))
        letters = CharSet.exact(((ord("a"), ord("z")),))
        alpha_num = digits.union(letters)
        self.assertEqual(overlap(digits, alpha_num), "yes")
        self.assertEqual(overlap(digits, letters), "no")

    def test_complement_of_exact_is_any(self):
        digits = shorthand("d")
        non_digits = digits.complement()
        self.assertEqual(non_digits.kind, "any")
        # 补集与原集合不相交，与另一个精确集合按剩余成员判断。
        self.assertEqual(overlap(non_digits, digits), "no")
        letters = CharSet.exact(((ord("a"), ord("z")),))
        self.assertEqual(overlap(non_digits, letters), "yes")

    def test_any_sets_always_overlap_each_other(self):
        dot = CharSet.dot()
        non_digits = shorthand("D")
        self.assertEqual(overlap(dot, non_digits), "yes")

    def test_shorthand_uppercase_is_complement(self):
        self.assertEqual(shorthand("D"), shorthand("d").complement())
        self.assertEqual(shorthand("W"), shorthand("w").complement())
        self.assertEqual(shorthand("S"), shorthand("s").complement())

    def test_subtract_ranges(self):
        base = ((0, 10),)
        self.assertEqual(subtract_ranges(base, ((3, 5),)), ((0, 2), (6, 10)))
        self.assertEqual(subtract_ranges(base, ((0, 10),)), ())

    def test_overlap_unknown_is_maybe(self):
        self.assertEqual(overlap(None, CharSet.literal("a")), "maybe")

    def test_disjoint_negated_class_members(self):
        # [^\d] 与 \d 不相交
        neg_digits = shorthand("d").complement()
        self.assertEqual(overlap(neg_digits, shorthand("d")), "no")


if __name__ == "__main__":
    unittest.main()
