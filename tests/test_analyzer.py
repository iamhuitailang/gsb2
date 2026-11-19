"""核心风险判断的单元测试。

覆盖四类要求的样本：明显危险的写法、形似但安全的写法、
边界输入（空模式、可空重复等）以及不合法表达式。
测试只做静态分析，不会对任何输入执行匹配。
"""

import unittest

from regex_risk.analyzer import analyze_pattern


def codes(pattern):
    findings, error, notes = analyze_pattern(pattern)
    assert error is None, f"{pattern!r} 意外编译失败：{error}"
    return [item.code for item in findings], notes


def levels(pattern):
    findings, error, _ = analyze_pattern(pattern)
    assert error is None, f"{pattern!r} 意外编译失败：{error}"
    return [item.level for item in findings]


class NestedRepeatTest(unittest.TestCase):
    def test_unbounded_nested_repeat_is_high(self):
        found, _ = codes(r"(a+)+")
        self.assertIn("nested-unbounded-repeat", found)
        self.assertEqual(levels(r"(a+)+"), ["high"])

    def test_nullable_nested_repeat_is_high(self):
        for pattern in ("(a*)*", "(a?)*", "((a*)*)*"):
            found, _ = codes(pattern)
            self.assertIn("nested-nullable-repeat", found, pattern)

    def test_variable_bounded_inner_repeat_is_high(self):
        found, _ = codes(r"(a{1,2})*")
        self.assertIn("nested-bounded-repeat", found)

    def test_fixed_bounded_inner_repeat_is_clean(self):
        # 固定次数的内层重复不会制造歧义拆分。
        found, _ = codes(r"(a{2})*")
        self.assertEqual(found, [])

    def test_nested_but_disjoint_first_last_is_clean(self):
        # 内层首尾字符集合不相交时，重复次数没有歧义。
        found, _ = codes(r"(ab+)*")
        self.assertEqual(found, [])

    def test_boundary_ambiguity_with_successor_is_high(self):
        # 内层无上限重复可把字符让给后继、再由下一轮吞并：(a+ab+)+ 是经典 ReDoS。
        found, _ = codes(r"(a+ab+)+")
        self.assertIn("nested-boundary-repeat", found)

    def test_inner_repeat_with_disjoint_successor_is_clean(self):
        # 形似但安全：内层重复的后继匹配不同字符，让不出边界。
        for pattern in (r"(x+y+)+", r"(\d+abc)+", r"(a+b)+", r"([a-z]+\d+)+"):
            found, _ = codes(pattern)
            self.assertEqual(found, [], pattern)

    def test_possessive_quantifier_neutralizes_risk(self):
        found, notes = codes("(a+)*+")
        self.assertEqual(found, [])
        self.assertTrue(any("独占量词" in note for note in notes))

    def test_atomic_group_neutralizes_risk(self):
        found, notes = codes("(?>a+)*")
        self.assertEqual(found, [])
        self.assertTrue(any("原子组" in note for note in notes))


class AlternativesTest(unittest.TestCase):
    def test_overlapping_branches_under_repeat_are_high(self):
        for pattern in ("(a|a)*", "(a|[ab])*", "(aa|ab)*", "(a|ab)*"):
            found, _ = codes(pattern)
            self.assertIn("overlapping-alternatives", found, pattern)

    def test_disjoint_branches_are_clean(self):
        # 分支首字符互不重叠，重复时每个输入字符只有一种选择。
        for pattern in ("(a|b)*", "(ab|cd)*", "(foo|bar)*", "(x|y|z)+"):
            found, _ = codes(pattern)
            self.assertEqual(found, pattern and [])

    def test_alternatives_without_outer_repeat_are_clean(self):
        # 不在无上限重复内部的分支歧义只有线性代价。
        found, _ = codes("cat|car|cab")
        self.assertEqual(found, [])


class AdjacentRepeatTest(unittest.TestCase):
    def test_overlapping_adjacent_repeats_are_medium(self):
        found, _ = codes(r"\d*\d*")
        self.assertEqual(found, ["adjacent-overlapping-repeat"])
        self.assertEqual(levels(r"\d*\d*"), ["medium"])

    def test_disjoint_adjacent_repeats_are_clean(self):
        for pattern in (r"[0-9]*[a-z]*", "a*b*", r"\d+\s+"):
            found, _ = codes(pattern)
            self.assertEqual(found, [])

    def test_literal_anchor_repeats_not_flagged(self):
        found, _ = codes("a+b+")
        self.assertEqual(found, [])


class BackReferenceTest(unittest.TestCase):
    def test_backref_inside_unbounded_repeat_is_medium(self):
        found, _ = codes(r"(a)\1*")
        self.assertIn("backref-in-repeat", found)
        self.assertEqual(levels(r"(a)\1*"), ["medium"])

    def test_named_backref_inside_repeat(self):
        found, _ = codes(r"(?P<q>a)(?P=q)*")
        self.assertIn("backref-in-repeat", found)

    def test_backref_outside_repeat_is_clean(self):
        found, _ = codes(r"(a)b\1")
        self.assertEqual(found, [])

    def test_backref_notes_uncertainty(self):
        _, notes = codes(r"(a)\1*")
        self.assertTrue(any("反向引用" in note for note in notes))


class SafeLookalikeTest(unittest.TestCase):
    def test_common_safe_patterns_have_no_findings(self):
        safe_patterns = [
            r"[a-z]+",
            r"\d{3}-\d{4}",
            r"https?://[\w./-]+",
            r"^[A-Z][a-z]*$",
            r"foo|bar",
            r"a{3}",
            r"(\d{4})-(\d{2})-(\d{2})",
            r"[[:^digit:]]",  # 字符集合内的普通字符，不会让分析器崩溃
            r"(?:ab|cd)+|ef",
            r"\bword\b",
        ]
        for pattern in safe_patterns:
            found, _ = codes(pattern)
            self.assertEqual(found, [], f"{pattern!r} 不应报告风险")

    def test_simple_alternation_repeat_not_overreported(self):
        # 需求明确：互不重叠的简单分支重复不能一概报成高风险。
        found, _ = codes("(a|b|c|d)*")
        self.assertEqual(found, [])


class BoundaryTest(unittest.TestCase):
    def test_empty_pattern(self):
        found, error, notes = analyze_pattern("")
        self.assertIsNone(error)
        self.assertEqual(found, [])

    def test_empty_branch_inside_repeat(self):
        # 可空的重复结构应被识别为高风险而不是静默跳过。
        found, _ = codes("(a|)*")
        self.assertIn("nested-nullable-repeat", found)

    def test_empty_group_repeat(self):
        found, _ = codes("()*")
        self.assertIn("nested-nullable-repeat", found)

    def test_lazy_quantifier_still_flagged(self):
        found, _ = codes("(a+)*?")
        self.assertIn("nested-unbounded-repeat", found)

    def test_lookaround_repeat_is_clean_with_note(self):
        found, notes = codes("(?=a)*")
        self.assertEqual(found, [])
        self.assertTrue(any("环视" in note for note in notes))

    def test_conditional_group_only_structural_note(self):
        found, notes = codes(r"(a)(?(1)b|c)*")
        self.assertTrue(any("条件分组" in note for note in notes))

    def test_position_reports_are_within_pattern(self):
        findings, error, _ = analyze_pattern("xx(a+)+")
        self.assertIsNone(error)
        for item in findings:
            self.assertGreaterEqual(item.position, 0)
            self.assertLessEqual(item.end_position, len("xx(a+)+"))
            self.assertLess(item.position, item.end_position)


class InvalidPatternTest(unittest.TestCase):
    def test_invalid_pattern_returns_error_not_findings(self):
        for pattern in ("^*", r"\q", "(a)\\2", "[]", r"\z", "a{2,1}"):
            findings, error, notes = analyze_pattern(pattern)
            self.assertIsNone(findings, pattern)
            self.assertIsNotNone(error, pattern)
            self.assertIn("re 编译失败", error)

    def test_overflow_repeat_is_invalid(self):
        findings, error, _ = analyze_pattern("a{999999999999999999999}")
        self.assertIsNone(findings)
        self.assertIsNotNone(error)

    def test_quantifier_on_anchor_or_boundary_is_invalid(self):
        for pattern in (r"\b?", r"\b*", r"\B+", r"\A?", "^?", "$+", r"(?#x)*"):
            findings, error, _ = analyze_pattern(pattern)
            self.assertIsNone(findings, pattern)
            self.assertIsNotNone(error, pattern)

    def test_variable_width_lookbehind_is_invalid(self):
        for pattern in (r"(?<=a*)x", r"(?<!a+)x", r"(?<=ab?)x", r"(?<=a|bb)x"):
            findings, error, _ = analyze_pattern(pattern)
            self.assertIsNone(findings, pattern)
            self.assertIsNotNone(error, pattern)

    def test_fixed_width_and_nested_lookbehind_are_valid(self):
        for pattern in (r"(?<=abc)x", r"(?<!a{2})x", r"(?<!(?!a))x",
                        r"(?<=(?=ab))x", r"(?<=(?P<g>$)?\.{2})x"):
            findings, error, _ = analyze_pattern(pattern)
            self.assertIsNone(error, pattern)
            self.assertEqual(findings, [])

    def test_lookaround_quantifier_is_valid(self):
        # 环视本身可以加量词；只有锚点/单词边界不行。
        for pattern in ("(?=a)*", "(?=a)+", "(?<!a){2}"):
            findings, error, _ = analyze_pattern(pattern)
            self.assertIsNone(error, pattern)

    def test_error_continues_without_partial_findings(self):
        # 非法表达式不输出误导性的部分风险结论。
        findings, error, _ = analyze_pattern("(a+)*\\q")
        self.assertIsNone(findings)
        self.assertIsNotNone(error)


class FindingShapeTest(unittest.TestCase):
    def test_every_finding_has_required_fields(self):
        findings, error, _ = analyze_pattern("(a|a)*")
        self.assertIsNone(error)
        self.assertTrue(findings)
        for item in findings:
            self.assertIn(item.level, ("high", "medium", "low", "info"))
            self.assertTrue(item.code)
            self.assertTrue(item.reason)
            self.assertTrue(item.snippet)


if __name__ == "__main__":
    unittest.main()
