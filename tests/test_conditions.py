"""条件表达式 DSL 的单元测试。"""

import unittest

from quest_chain.conditions import (
    ConditionError,
    ConditionEvalError,
    ConditionSyntaxError,
    evaluate,
    extract_references,
    lint_condition,
    truthy_evaluate,
)


class ParserTests(unittest.TestCase):
    def test_literals_and_empty(self):
        self.assertTrue(truthy_evaluate(""))
        self.assertTrue(truthy_evaluate("true"))
        self.assertFalse(truthy_evaluate("false"))
        self.assertEqual(evaluate("42"), 42)
        self.assertEqual(evaluate('"hello"'), "hello")
        self.assertAlmostEqual(evaluate("1.5"), 1.5)

    def test_keywords_case_insensitive(self):
        ctx = {"flags": {"a": True, "b": False}}
        self.assertTrue(truthy_evaluate("a AND NOT b", ctx))
        self.assertTrue(truthy_evaluate("a && !b", ctx))
        self.assertTrue(truthy_evaluate("b OR a", ctx))
        self.assertTrue(truthy_evaluate("b || a", ctx))

    def test_precedence_and_parentheses(self):
        ctx = {"flags": {"a": True, "b": False, "c": True}}
        # and 优先级高于 or: (a and b) or c -> True
        self.assertTrue(truthy_evaluate("a and b or c", ctx))
        self.assertFalse(truthy_evaluate("a and (b or false)", ctx))
        self.assertTrue(truthy_evaluate("not false and (false or true)", ctx))

    def test_comparisons(self):
        ctx = {"variables": {"rep": 30}}
        self.assertTrue(truthy_evaluate('var("rep") >= 25', ctx))
        self.assertTrue(truthy_evaluate('var("rep") == 30', ctx))
        self.assertTrue(truthy_evaluate('var("rep") != 0', ctx))
        self.assertFalse(truthy_evaluate('var("rep") < 10', ctx))
        self.assertTrue(truthy_evaluate('var("missing", 5) > 3', ctx))

    def test_chained_comparison_rejected(self):
        with self.assertRaises(ConditionSyntaxError):
            evaluate("1 < 2 < 3")

    def test_string_compare(self):
        ctx = {"quest_states": {"q1": "completed"}}
        self.assertTrue(truthy_evaluate('q_state("q1") == "completed"', ctx))
        with self.assertRaises(ConditionEvalError):
            evaluate('"a" < "b"')

    def test_syntax_errors(self):
        for bad in ("var(", 'flag("x"', "1 +", ")", "var(\"x\") >", "&& true"):
            with self.assertRaises(ConditionError, msg=bad):
                evaluate(bad)

    def test_unterminated_string(self):
        with self.assertRaises(ConditionSyntaxError):
            evaluate('"abc')


class BuiltinFunctionTests(unittest.TestCase):
    CTX = {
        "quest_states": {
            "q1": "completed",
            "q2": "failed",
            "q3": "active",
        },
        "flags": {"got_sword": True, "secret": False},
        "variables": {"rep": 12},
    }

    def test_q_meet_and_failed(self):
        self.assertTrue(truthy_evaluate('q_meet("q1")', self.CTX))
        self.assertFalse(truthy_evaluate('q_meet("q3")', self.CTX))
        self.assertTrue(truthy_evaluate('q_failed("q2")', self.CTX))
        self.assertEqual(evaluate('q_state("q3")', self.CTX), "active")
        self.assertEqual(evaluate('q_state("unknown")', self.CTX), "locked")

    def test_any_all_none(self):
        self.assertTrue(truthy_evaluate('any_of("q1", "q3")', self.CTX))
        self.assertFalse(truthy_evaluate('all_of("q1", "q3")', self.CTX))
        self.assertTrue(truthy_evaluate('all_of("q1")', self.CTX))
        self.assertTrue(truthy_evaluate('all_of()', self.CTX))
        # q2 failed, 不算 meet; none_of 要求从未完成/失败
        self.assertTrue(truthy_evaluate('none_of("q3")', self.CTX))
        self.assertFalse(truthy_evaluate('none_of("q1")', self.CTX))

    def test_flag_and_var(self):
        self.assertTrue(truthy_evaluate('flag("got_sword")', self.CTX))
        self.assertFalse(truthy_evaluate('flag("secret")', self.CTX))
        self.assertFalse(truthy_evaluate('flag("missing")', self.CTX))
        self.assertEqual(evaluate('var("rep")', self.CTX), 12)
        self.assertEqual(evaluate('var("nope", 7)', self.CTX), 7)
        self.assertEqual(evaluate('var("nope")', self.CTX), 0)

    def test_bare_identifier(self):
        self.assertTrue(truthy_evaluate("got_sword", self.CTX))
        self.assertFalse(truthy_evaluate("secret", self.CTX))

    def test_unknown_function_and_arity(self):
        with self.assertRaises(ConditionEvalError):
            evaluate('nope("x")')
        with self.assertRaises(ConditionEvalError):
            evaluate('q_meet()')
        with self.assertRaises(ConditionEvalError):
            evaluate('flag("a", "b")')

    def test_custom_injected_function(self):
        ctx = {"functions": {"level": lambda: 5}}
        self.assertTrue(truthy_evaluate("level() >= 3", ctx))

    def test_truthy_rules(self):
        self.assertFalse(truthy_evaluate("0"))
        self.assertTrue(truthy_evaluate('"" or 1'))
        self.assertFalse(truthy_evaluate('"false"'))


class ReferenceAndLintTests(unittest.TestCase):
    def test_extract_references(self):
        expr = 'q_meet("q1") and any_of("q2","q1") and flag("sword") and var("rep") >= 10 and bare'
        refs = extract_references(expr)
        self.assertEqual(refs["quests"], ["q1", "q2"])
        self.assertEqual(set(refs["flags"]), {"sword", "bare"})
        self.assertEqual(refs["variables"], ["rep"])

    def test_lint_clean(self):
        expr = 'q_meet("q1") and flag("f") and var("v") > 1'
        self.assertEqual(
            lint_condition(expr, known_quests={"q1"}, known_flags={"f"}, known_variables={"v"}),
            [],
        )

    def test_lint_reports_missing(self):
        problems = lint_condition(
            'q_meet("ghost") and flag("noflag")',
            known_quests={"q1"},
            known_flags={"other_flag"},
            known_variables={"other_var"},
        )
        self.assertTrue(any("ghost" in p for p in problems))
        self.assertTrue(any("noflag" in p for p in problems))

    def test_lint_syntax_error(self):
        self.assertEqual(len(lint_condition("var(")), 1)

    def test_chinese_identifier(self):
        ctx = {"flags": {"拿到圣剑": True}}
        self.assertTrue(truthy_evaluate("拿到圣剑", ctx))


if __name__ == "__main__":
    unittest.main()
