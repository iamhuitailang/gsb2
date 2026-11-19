"""规则行为测试：安全 / 风险 / 边界配置。"""
import json
import unittest

from gha_audit.loader import is_workflow, line_of, load_file, wf_get
from gha_audit.rules import analyze_workflow

from helpers import EXAMPLES, CliTestCase, run_cli


def analyze(path):
    data, _, error = load_file(path)
    assert error is None, error
    return analyze_workflow(path, data)


def rule_ids(findings):
    return {f.rule_id for f in findings}


class TestLoader(unittest.TestCase):
    def test_on_key_parsed_as_boolean_true(self):
        # YAML 1.1 会把 on: 解析成布尔 True，工具必须兼容
        data, _, error = load_file(f"{EXAMPLES}/safe/ci.yml")
        self.assertIsNone(error)
        self.assertIsNotNone(wf_get(data, "on"))
        self.assertTrue(is_workflow(data))

    def test_line_numbers_tracked(self):
        data, _, error = load_file(f"{EXAMPLES}/safe/ci.yml")
        self.assertIsNone(error)
        self.assertEqual(line_of(data, "permissions"), 10)
        job = data["jobs"]["test"]
        self.assertEqual(line_of(job, "permissions"), 16)


class TestSafeExample(CliTestCase):
    def test_safe_workflow_has_no_findings(self):
        findings = analyze(self.example("safe", "ci.yml"))
        self.assertEqual(findings, [])

    def test_safe_workflow_exit_code(self):
        code, out, _ = run_cli(self.example("safe", "ci.yml"))
        self.assertEqual(code, 0, out)


class TestRiskyExample(CliTestCase):
    @classmethod
    def setUpClass(cls):
        cls.findings = analyze(f"{EXAMPLES}/risky/legacy.yml")

    def test_all_expected_rules_fire(self):
        self.assertTrue(
            {"GHA001", "GHA010", "GHA020", "GHA021", "GHA030", "GHA031"}
            <= rule_ids(self.findings),
            rule_ids(self.findings))

    def test_write_all_is_high(self):
        f = next(f for f in self.findings if f.rule_id == "GHA001")
        self.assertEqual(f.level, "high")
        self.assertEqual(f.line, 6)

    def test_injection_points_at_run_line_with_context_evidence(self):
        f = next(f for f in self.findings if f.rule_id == "GHA020")
        self.assertEqual(f.level, "high")
        self.assertEqual(f.job, "build")
        self.assertIn("github.event.pull_request.title", f.evidence)
        # 依据中不应包含 run 脚本原文
        self.assertFalse(any("echo" in e for e in f.evidence))

    def test_risky_trigger_checkout_combo(self):
        f = next(f for f in self.findings if f.rule_id == "GHA030")
        self.assertEqual(f.level, "high")

    def test_exit_code_is_findings(self):
        code, out, _ = run_cli(self.example("risky", "legacy.yml"))
        self.assertEqual(code, 1, out)


class TestEdgeCases(CliTestCase):
    @classmethod
    def setUpClass(cls):
        cls.findings = analyze(f"{EXAMPLES}/edge/cases.yml")

    def by_job(self, rule_id):
        return {f.job for f in self.findings if f.rule_id == rule_id}

    def test_job_level_empty_permissions_override_workflow(self):
        # pinned-ok 任务声明了 permissions: {}，不应再按工作流级写权限报 GHA031
        self.assertNotIn("pinned-ok", self.by_job("GHA031"))
        # reusable 任务继承工作流级 contents: write 且 secrets: inherit
        self.assertIn("reusable", self.by_job("GHA031"))

    def test_dynamic_uses_is_undetermined_not_silent(self):
        f = next(f for f in self.findings
                 if f.rule_id == "GHA010" and f.job == "dynamic")
        self.assertEqual(f.confidence, "undetermined")

    def test_local_action_and_pinned_sha_not_flagged(self):
        self.assertNotIn("pinned-ok", self.by_job("GHA010"))

    def test_env_var_pattern_not_flagged_as_injection(self):
        self.assertNotIn("comments", self.by_job("GHA020"))

    def test_reusable_workflow_unpinned(self):
        f = next(f for f in self.findings
                 if f.rule_id == "GHA010" and f.job == "reusable")
        self.assertEqual(f.level, "medium")


class TestPermissionInheritance(unittest.TestCase):
    def test_undeclared_permissions_is_undetermined(self):
        findings = analyze(f"{EXAMPLES}/risky/legacy.yml")
        # legacy.yml 声明了 write-all，不应再报 GHA002
        self.assertNotIn("GHA002", rule_ids(findings))


if __name__ == "__main__":
    unittest.main()
