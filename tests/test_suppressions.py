"""行内例外机制测试。"""
import tempfile
import textwrap
import unittest
from datetime import date

from gha_audit.loader import load_file
from gha_audit.rules import RULES, analyze_workflow
from gha_audit.suppressions import apply_suppressions, parse_suppressions

from helpers import EXAMPLES, CliTestCase, run_cli

TODAY = date(2026, 11, 19)


def scan_file(path):
    data, text, error = load_file(path)
    assert error is None, error
    findings = analyze_workflow(path, data)
    suppressions, exc_findings = parse_suppressions(path, text, set(RULES), TODAY)
    apply_suppressions(findings, suppressions)
    return findings + exc_findings


class TestExceptionsExample(CliTestCase):
    @classmethod
    def setUpClass(cls):
        cls.path = f"{EXAMPLES}/edge/with-exceptions.yml"
        cls.findings = scan_file(cls.path)

    def active(self, rule_id):
        return [f for f in self.findings
                if f.rule_id == rule_id and not f.suppressed]

    def test_valid_exception_suppresses_only_its_own_line(self):
        suppressed = [f for f in self.findings if f.suppressed]
        self.assertEqual(len(suppressed), 1)
        self.assertEqual(suppressed[0].rule_id, "GHA010")
        self.assertIn("actions/checkout@v4", suppressed[0].evidence[0])

    def test_expired_exception_does_not_suppress(self):
        # setup-node 的例外已过期：发现仍然有效，并额外报告 GHA902
        self.assertTrue(any("setup-node" in f.evidence[0]
                            for f in self.active("GHA010")))
        self.assertEqual(len(self.active("GHA902")), 1)

    def test_unknown_rule_reference_reported(self):
        self.assertEqual(len(self.active("GHA901")), 1)
        # 无效例外不能豁免下一行的 setup-python
        self.assertTrue(any("setup-python" in f.evidence[0]
                            for f in self.active("GHA010")))

    def test_exception_does_not_leak_to_other_lines(self):
        # cache@v4 没有任何例外覆盖
        self.assertTrue(any("actions/cache" in f.evidence[0]
                            for f in self.active("GHA010")))


class TestExceptionScopeAcrossFiles(unittest.TestCase):
    def test_exception_does_not_leak_to_other_files(self):
        # 同一规则在另一个文件中的发现不受 with-exceptions.yml 的例外影响
        risky = scan_file(f"{EXAMPLES}/risky/legacy.yml")
        active = [f for f in risky if f.rule_id == "GHA010" and not f.suppressed]
        self.assertTrue(active)

    def test_malformed_exception_reported(self):
        content = textwrap.dedent("""\
            name: t
            on: push
            permissions:
              contents: read
            jobs:
              a:
                runs-on: ubuntu-latest
                steps:
                  # gha-audit: ???
                  - uses: actions/checkout@v4
            """)
        with tempfile.NamedTemporaryFile("w", suffix=".yml", delete=False) as fh:
            fh.write(content)
            path = fh.name
        try:
            findings = scan_file(path)
        finally:
            import os
            os.unlink(path)
        self.assertTrue(any(f.rule_id == "GHA901" for f in findings))
        # 格式错误的例外不豁免任何发现
        self.assertTrue(any(f.rule_id == "GHA010" and not f.suppressed
                            for f in findings))


if __name__ == "__main__":
    unittest.main()
