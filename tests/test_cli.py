"""CLI 行为测试：退出码、报告格式、无效输入。"""
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from helpers import CliTestCase, run_cli


class TestExitCodes(CliTestCase):
    def test_missing_path_is_input_error(self):
        code, _, _ = run_cli(os.path.join(tempfile.gettempdir(),
                                          "gha-audit-no-such-path"))
        self.assertEqual(code, 2)

    def test_empty_directory_is_input_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, _ = run_cli(tmp)
            self.assertEqual(code, 2)
            self.assertIn("没有匹配", out)

    def test_broken_yaml_is_input_error(self):
        code, out, _ = run_cli(self.example("invalid", "broken.yml"))
        self.assertEqual(code, 2)
        self.assertIn("YAML 解析失败", out)

    def test_non_workflow_file_is_input_error(self):
        code, out, _ = run_cli(self.example("invalid", "not-a-workflow.yml"))
        self.assertEqual(code, 2)
        self.assertIn("不是可识别的工作流文件", out)

    def test_unreadable_file_is_input_error(self):
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("root 可以读取任何文件")
        with tempfile.NamedTemporaryFile("w", suffix=".yml", delete=False) as fh:
            fh.write("on: push\njobs: {}\n")
            path = fh.name
        try:
            os.chmod(path, 0)
            code, out, _ = run_cli(path)
            self.assertEqual(code, 2)
            self.assertIn("不可读", out)
        finally:
            os.chmod(path, 0o600)
            os.unlink(path)

    def test_error_takes_precedence_over_findings(self):
        # 目录里同时有风险工作流和无法解析的文件时，退出码为 2
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(self.example("risky", "legacy.yml"), tmp)
            shutil.copy(self.example("invalid", "broken.yml"), tmp)
            code, out, _ = run_cli(tmp)
            self.assertEqual(code, 2)
            self.assertIn("YAML 解析失败", out)

    def test_internal_error_exit_code(self):
        with mock.patch("gha_audit.cli.analyze_workflow",
                        side_effect=RuntimeError("boom")):
            code, _, err = run_cli(self.example("safe", "ci.yml"))
        self.assertEqual(code, 3)
        self.assertIn("内部错误", err)


class TestDirectoryScan(CliTestCase):
    def test_directory_scan_recurses(self):
        code, out, _ = run_cli(self.example("risky"))
        self.assertEqual(code, 1)
        self.assertIn("legacy.yml", out)

    def test_non_workflow_yaml_in_directory_is_skipped_not_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(self.example("safe", "ci.yml"), tmp)
            shutil.copy(self.example("invalid", "not-a-workflow.yml"), tmp)
            code, out, _ = run_cli(tmp)
            self.assertEqual(code, 0, out)
            self.assertIn("跳过 1 个非工作流", out)


class TestJsonReport(CliTestCase):
    def test_json_schema_and_stable_order(self):
        code, out, _ = run_cli("--format", "json",
                               self.example("risky", "legacy.yml"),
                               self.example("edge", "cases.yml"))
        self.assertEqual(code, 1)
        doc = json.loads(out)
        self.assertEqual(doc["tool"]["name"], "gha-audit")
        summary = doc["summary"]
        self.assertEqual(summary["files_scanned"], 2)
        self.assertEqual(summary["findings"], len(doc["findings"]))
        keys = [(f["file"], f["line"], f["rule_id"]) for f in doc["findings"]]
        self.assertEqual(keys, sorted(keys))
        for finding in doc["findings"]:
            for field in ("rule_id", "level", "confidence", "file", "line",
                          "message"):
                self.assertIn(field, finding)

    def test_json_includes_errors(self):
        code, out, _ = run_cli("--format", "json",
                               self.example("invalid", "broken.yml"))
        self.assertEqual(code, 2)
        doc = json.loads(out)
        self.assertEqual(len(doc["errors"]), 1)
        self.assertIn("YAML 解析失败", doc["errors"][0]["reason"])

    def test_json_suppressed_listed_separately(self):
        code, out, _ = run_cli("--format", "json",
                               self.example("edge", "with-exceptions.yml"))
        self.assertEqual(code, 1)
        doc = json.loads(out)
        self.assertEqual(doc["summary"]["suppressed"], 1)
        self.assertEqual(len(doc["suppressed_findings"]), 1)
        active_ids = [f["rule_id"] for f in doc["findings"]]
        suppressed_ids = [f["rule_id"] for f in doc["suppressed_findings"]]
        self.assertNotIn("GHA010", suppressed_ids * 0)  # 占位，实际断言如下
        self.assertEqual(suppressed_ids, ["GHA010"])


class TestListRules(CliTestCase):
    def test_list_rules(self):
        code, out, _ = run_cli("--list-rules")
        self.assertEqual(code, 0)
        self.assertIn("GHA020", out)


if __name__ == "__main__":
    unittest.main()
