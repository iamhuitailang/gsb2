"""规则引擎测试: 稳定标识、严重级别、重叠去重与高熵信号。"""

import unittest

from secretscan.config import Config
from secretscan.rules import (
    EntropyRule,
    RawMatch,
    RegexRule,
    build_custom_rules,
    dedupe_matches,
)
from secretscan.errors import ConfigError


class RuleIdentityTest(unittest.TestCase):
    def test_builtin_rules_have_stable_ids_and_severities(self):
        config = Config()
        rules = config.build_rules()
        ids = {rule.rule_id for rule in rules}
        expected = {
            "credential.assignment",
            "aws.access_key_id",
            "github.pat",
            "slack.token",
            "google.api_key",
            "pem.private_key",
            "auth.bearer",
            "entropy.high",
        }
        self.assertTrue(expected.issubset(ids))
        for rule in rules:
            self.assertIn(rule.severity, ("low", "medium", "high", "critical"))

    def test_assignment_matches_value_span_not_whole_line(self):
        rule = next(
            item
            for item in Config().build_rules()
            if item.rule_id == "credential.assignment"
        )
        line = 'password = "Fak3-Passw0rd-For-Demo-Only"'
        matches = rule.scan_line(line)
        self.assertEqual(len(matches), 1)
        start, end = matches[0].start, matches[0].end
        self.assertEqual(line[start:end], "Fak3-Passw0rd-For-Demo-Only")

    def test_custom_rule_requires_fields(self):
        with self.assertRaises(ConfigError):
            build_custom_rules([{"id": "x", "pattern": "a"}])  # 缺 severity
        with self.assertRaises(ConfigError):
            build_custom_rules(
                [{"id": "Bad Id", "pattern": "a", "severity": "high"}]
            )

    def test_custom_rule_bad_regex_fails_fast(self):
        with self.assertRaises(ConfigError):
            build_custom_rules(
                [{"id": "x.bad", "pattern": "([a-z", "severity": "low"}]
            )

    def test_custom_rule_uses_value_group(self):
        rules = build_custom_rules(
            [
                {
                    "id": "corp.tok",
                    "pattern": r"CORP_TOKEN\s*=\s*(?P<value>[A-Za-z0-9]{8,})",
                    "severity": "medium",
                }
            ]
        )
        line = "CORP_TOKEN = AbCdEf1234567890Zy"
        matches = rules[0].scan_line(line)
        self.assertEqual(line[matches[0].start : matches[0].end], "AbCdEf1234567890Zy")


class DedupeTest(unittest.TestCase):
    def test_overlapping_matches_keep_highest_severity(self):
        low = RawMatch(0, 30, "entropy.high", "low", "low reason")
        critical = RawMatch(5, 25, "aws.access_key_id", "critical", "known format")
        kept = dedupe_matches([low, critical])
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0].rule_id, "aws.access_key_id")

    def test_equal_severity_tie_breaks_by_rule_id(self):
        first = RawMatch(0, 10, "aaa.rule", "high", "a")
        second = RawMatch(0, 10, "bbb.rule", "high", "b")
        kept = dedupe_matches([second, first])
        self.assertEqual([item.rule_id for item in kept], ["aaa.rule"])

    def test_non_overlapping_matches_both_kept(self):
        left = RawMatch(0, 5, "a.rule", "high", "a")
        right = RawMatch(10, 15, "b.rule", "low", "b")
        kept = dedupe_matches([left, right])
        self.assertEqual(len(kept), 2)

    def test_assignment_and_entropy_on_same_secret_do_not_duplicate(self):
        # 端到端: 同一高熵赋值只产生一条告警 (assignment 严重级别更高)。
        config = Config()
        scanner_rules = config.build_rules()
        line = 'client_secret = "Zx9Qm4Tv7Lk2Pw8Rn5Yc3Hf6Dg1Ja0Nb"'
        raw = []
        for rule in scanner_rules:
            raw.extend(rule.scan_line(line))
        kept = dedupe_matches(raw)
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0].rule_id, "credential.assignment")


class EntropyTest(unittest.TestCase):
    def setUp(self):
        self.rule = EntropyRule()

    def test_high_entropy_random_string_detected(self):
        token = "Zx9Qm4Tv7Lk2Pw8Rn5Yc3Hf6Dg1Ja0Nb"
        matches = self.rule.scan_line(f"raw = {token}")
        self.assertTrue(any(token in line for line in [token]))
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].rule_id, "entropy.high")
        self.assertEqual(matches[0].severity, "low")

    def test_plain_english_word_not_flagged(self):
        matches = self.rule.scan_line(
            "the quick brown fox jumps over the lazy dog repeatedly"
        )
        self.assertEqual(matches, [])

    def test_long_digit_run_not_flagged(self):
        matches = self.rule.scan_line("timestamp = 20261118093015123456")
        self.assertEqual(matches, [])

    def test_short_token_below_min_length_ignored(self):
        matches = self.rule.scan_line("x = Ab1")
        self.assertEqual(matches, [])

    def test_shannon_entropy_monotonic_basic(self):
        low = EntropyRule.shannon_entropy("aaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        high = EntropyRule.shannon_entropy("aB3$xQ9mZ1vL7pR2sT6uW8yC4dF")
        self.assertLess(low, high)


if __name__ == "__main__":
    unittest.main()
