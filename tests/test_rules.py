"""Rule parsing, overlap resolution, rule versions and semantic identity."""

from __future__ import annotations

import json
import unittest

from tests.support import WorkbenchTestCase, scan_with_rules
from workbench.default_rules import default_rules
from workbench.rules import RuleConfigError, parse_rules, shannon_entropy

OVERLAP_RULES = {
    "rules": [
        {
            "id": "specific-github",
            "family": "token.github",
            "name": "GitHub token",
            "severity": "critical",
            "priority": 80,
            "pattern": r"\bghp_[A-Za-z0-9]{36,251}\b",
        },
        {
            "id": "generic-api-key",
            "family": "token.generic-api-key",
            "name": "Generic key",
            "severity": "medium",
            "priority": 20,
            "pattern": r"(?i)(?:api[_-]?key)\s*[:=]\s*['\"](?P<secret>[A-Za-z0-9._-]{16,128})['\"]",
            "secret_group": "secret",
            "min_entropy": 2.5,
        },
    ]
}


class RuleParsingTests(unittest.TestCase):
    def test_default_rules_parse(self):
        rule_set = parse_rules(default_rules(), "<default>")
        self.assertGreaterEqual(len(rule_set.rules), 8)
        self.assertTrue(all(rule.version for rule in rule_set.rules))

    def test_invalid_regex_is_rejected_with_rule_id(self):
        broken = {"rules": [dict(default_rules()["rules"][0], pattern="(unclosed")]}
        with self.assertRaises(RuleConfigError) as ctx:
            parse_rules(broken)
        self.assertIn("private-key-pem", str(ctx.exception))

    def test_duplicate_family_rejected(self):
        first = default_rules()["rules"][0]
        second = dict(first, id="other-id", family=first["family"])
        with self.assertRaises(RuleConfigError) as ctx:
            parse_rules({"rules": [first, second]})
        self.assertIn("family", str(ctx.exception))

    def test_unknown_field_rejected(self):
        rule = dict(default_rules()["rules"][0], surprise=True)
        with self.assertRaises(RuleConfigError):
            parse_rules({"rules": [rule]})

    def test_named_group_must_exist(self):
        rule = dict(default_rules()["rules"][0], secret_group="missing")
        with self.assertRaises(RuleConfigError):
            parse_rules({"rules": [rule]})

    def test_version_changes_on_cosmetic_edit_but_semantic_hash_does_not(self):
        rules = default_rules()
        before = parse_rules(rules, "<a>")
        rules2 = json.loads(json.dumps(rules))
        rules2["rules"][0]["name"] = "Renamed detector"
        rules2["rules"][0]["severity"] = "high"
        after = parse_rules(rules2, "<b>")
        self.assertNotEqual(before.rules[0].version, after.rules[0].version)
        self.assertEqual(before.rules[0].semantic_hash, after.rules[0].semantic_hash)

    def test_version_and_semantic_hash_change_on_pattern_edit(self):
        rules = default_rules()
        before = parse_rules(rules, "<a>")
        rules2 = json.loads(json.dumps(rules))
        rules2["rules"][0]["pattern"] = r"-----BEGIN (?:RSA )?PRIVATE KEY-----"
        after = parse_rules(rules2, "<b>")
        self.assertNotEqual(before.rules[0].version, after.rules[0].version)
        self.assertNotEqual(before.rules[0].semantic_hash, after.rules[0].semantic_hash)

    def test_entropy_helper(self):
        self.assertLess(shannon_entropy("aaaaaaaa"), 0.5)
        self.assertGreater(shannon_entropy("aB3$xZ9!qW2&"), 3.0)


class OverlapTests(WorkbenchTestCase):
    def test_overlapping_rules_report_once_with_overlap_marker(self):
        root = self.make_project(
            {"src/app.py": 'GITHUB = {"api_key": "ghp_0123456789abcdefghijklmnopqrstuvwxyz012345"}\n'}
        )
        output = scan_with_rules(root, OVERLAP_RULES)
        self.assertEqual(len(output.findings), 1)
        finding = output.findings[0]
        self.assertEqual(finding["rule_id"], "specific-github")
        self.assertIn("generic-api-key", finding["overlaps"])
        self.assertIn("[REDACTED]", finding["preview"])

    def test_non_overlapping_rules_both_reported(self):
        root = self.make_project(
            {
                "src/app.py": (
                    'token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz012345"\n'
                    'other = \'api_key: "AbCdEf0123456789XyZ"\'\n'
                )
            }
        )
        output = scan_with_rules(root, OVERLAP_RULES)
        rules = sorted(finding["rule_id"] for finding in output.findings)
        self.assertEqual(rules, ["generic-api-key", "specific-github"])

    def test_allowlist_suppresses_placeholder(self):
        rules = {
            "rules": [
                dict(
                    OVERLAP_RULES["rules"][1],
                    allowlist=[r"(?i)your[_-]?api[_-]?key"],
                )
            ]
        }
        root = self.make_project({"x.py": 'api_key = "your_api_key_here_0000"\n'})
        output = scan_with_rules(root, rules)
        self.assertEqual(output.findings, [])

    def test_entropy_floor_rejects_low_entropy_value(self):
        root = self.make_project({"x.py": 'api_key = "aaaaaaaaaaaaaaaaaaaaaaaa"\n'})
        output = scan_with_rules(root, OVERLAP_RULES)
        self.assertEqual([f for f in output.findings if f["rule_id"] == "generic-api-key"], [])


class DefaultRuleIntegrationTests(WorkbenchTestCase):
    def test_demo_project_hits_expected_families(self):
        root = self.copy_demo()
        scan = self.run_scan(root)
        self.assertEqual(scan["status"], "completed", scan.get("error"))
        families = {finding["family"] for finding in self.findings(scan["id"])}
        self.assertIn("cloud.aws.secret-access-key", families)
        self.assertIn("cloud.aws.access-key-id", families)
        self.assertIn("db.connection-password", families)
        self.assertIn("token.bearer", families)
        self.assertIn("token.github", families)
        self.assertIn("key.private-key", families)

    def test_placeholder_values_are_not_reported(self):
        root = self.copy_demo()
        scan = self.run_scan(root)
        db_findings = self.by_rule(scan["id"], "db-connection-password")
        paths = {(item["path"], item["line"]) for item in db_findings}
        self.assertFalse(any(line == 7 for _, line in paths), "the changeme DSN must be allow-listed")


if __name__ == "__main__":
    unittest.main()
