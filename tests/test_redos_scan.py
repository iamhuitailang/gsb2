import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import redos_scan


def kinds(findings):
    return {f["kind"] for f in findings}


def levels(findings):
    return {f["level"] for f in findings}


class TestAnalyzePattern(unittest.TestCase):
    """核心判断：明显危险、相似但安全、边界情况。"""

    def test_nested_quantifier_high(self):
        for pat in (r"(a+)+", r"(a*)*", r"(\w+)*", r"(a+){2,}", r"x(a|b+)*$"):
            findings = redos_scan.analyze_pattern(pat)
            self.assertIn("nested-repeat", kinds(findings), pat)
            self.assertIn("high", levels(findings), pat)

    def test_ambiguous_alternation_high(self):
        # 注意：(\w|\d)+ 会被解析器合并成字符类 [\w\d]+，是安全的，
        # 只有无法合并的分支才保留选择点。
        for pat in (r"(a|a)+", r"(\w+|\d)+", r"(ab|a)*"):
            findings = redos_scan.analyze_pattern(pat)
            self.assertIn("ambiguous-alternation", kinds(findings), pat)
            self.assertIn("high", levels(findings), pat)

    def test_adjacent_repeats_medium(self):
        for pat in (r"a*a*", r"\d+\d+", r".*.*"):
            findings = redos_scan.analyze_pattern(pat)
            self.assertIn("adjacent-repeat", kinds(findings), pat)
            self.assertIn("medium", levels(findings), pat)

    def test_backref_in_repeat_medium(self):
        findings = redos_scan.analyze_pattern(r"(x)(\1)+")
        self.assertIn("backref-in-repeat", kinds(findings))
        self.assertIn("medium", levels(findings))

    def test_nullable_repeat_low(self):
        findings = redos_scan.analyze_pattern(r"(a?)*")
        self.assertIn("nullable-repeat", kinds(findings))
        self.assertIn("low", levels(findings))

    def test_large_bounded_nested_medium(self):
        findings = redos_scan.analyze_pattern(r"(a{1,1000})+")
        self.assertIn("nested-repeat", kinds(findings))
        self.assertIn("medium", levels(findings))
        self.assertNotIn("high", levels(findings))

    def test_safe_patterns_no_findings(self):
        safe = [
            r"abc",
            r"a{2,5}",
            r"\d{4}-\d{2}-\d{2}",
            r"(ab|cd)*",          # 分支互不重叠，不应误报
            r"(foo|bar|baz)+",    # 分支首字符不同
            r"a*b",               # 单个无界重复
            r"^\s*\w+@\w+\.\w+$",
            r"(x)\1",             # 反向引用不在无界重复内
        ]
        for pat in safe:
            findings = redos_scan.analyze_pattern(pat)
            self.assertEqual([], findings, pat)

    def test_uncertain_negated_class_low(self):
        # 相邻无界重复含否定字符集，无法精确判断 -> 保守低级别提示
        findings = redos_scan.analyze_pattern(r"[^a]+[^b]+")
        self.assertIn("adjacent-repeat", kinds(findings))
        self.assertIn("low", levels(findings))
        self.assertTrue(all(f.get("confidence") == "low" for f in findings))

    def test_possessive_repeat_breaks_nesting(self):
        # Python 3.11+ 支持占有型量词；它切断回溯，不应报嵌套高风险
        try:
            findings = redos_scan.analyze_pattern(r"(a*+)+")
        except Exception:
            self.skipTest("当前 Python 版本不支持占有型量词")
        self.assertNotIn("nested-repeat", kinds(findings))

    def test_every_finding_has_fields(self):
        findings = redos_scan.analyze_pattern(r"(a+)+")
        self.assertTrue(findings)
        for f in findings:
            self.assertIn(f["level"], ("high", "medium", "low"))
            self.assertTrue(f["fragment"])
            self.assertTrue(f["message"])
            self.assertTrue(f["kind"])


class TestScanText(unittest.TestCase):
    """行号定位、空行、错误表达式。"""

    def test_line_numbers_ignore_blank_lines(self):
        text = "(a+)+\n\nabc\n(\na*a*\n"
        results = redos_scan.scan_text(text)
        self.assertEqual([1, 3, 4, 5], [r["line"] for r in results])
        self.assertEqual("findings", results[0]["status"])
        self.assertEqual("ok", results[1]["status"])
        self.assertEqual("invalid", results[2]["status"])
        self.assertEqual("findings", results[3]["status"])

    def test_invalid_patterns_reported_and_scan_continues(self):
        text = "(\na{2,1}\n(a|a)+\n"
        results = redos_scan.scan_text(text)
        self.assertEqual("invalid", results[0]["status"])
        self.assertEqual("invalid", results[1]["status"])
        self.assertEqual("findings", results[2]["status"])
        for r in results[:2]:
            self.assertTrue(r["error"])

    def test_clean_input_all_ok(self):
        results = redos_scan.scan_text("abc\n\\d{4}\n")
        self.assertTrue(all(r["status"] == "ok" for r in results))


class TestCli(unittest.TestCase):
    """输出格式与退出码。"""

    def _run(self, argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = redos_scan.main(argv)
        return code, buf.getvalue()

    def _write(self, content, mode="w"):
        fd, path = tempfile.mkstemp(suffix=".txt")
        with os.fdopen(fd, mode) as fh:
            fh.write(content)
        self.addCleanup(os.unlink, path)
        return path

    def test_text_report_and_exit_1_on_findings(self):
        path = self._write("(a+)+\nabc\n")
        code, out = self._run([path])
        self.assertEqual(1, code)
        self.assertIn("第 1 行 [高]", out)
        self.assertIn("(a+)+", out)

    def test_exit_0_and_explicit_clean_message(self):
        path = self._write("abc\n\\d{4}\n")
        code, out = self._run([path])
        self.assertEqual(0, code)
        self.assertIn("未发现问题", out)

    def test_json_output_stable_and_parseable(self):
        path = self._write("(a+)+\n\n(\nabc\n")
        code1, out1 = self._run([path, "--format", "json"])
        code2, out2 = self._run([path, "--format", "json"])
        self.assertEqual(1, code1)
        self.assertEqual(out1, out2)  # 输出稳定
        doc = json.loads(out1)
        self.assertEqual(4, doc["summary"]["total_lines"])
        self.assertEqual(1, doc["summary"]["invalid"])
        self.assertEqual(1, doc["summary"]["findings"])
        self.assertEqual([1, 3, 4], [r["line"] for r in doc["results"]])
        statuses = {r["line"]: r["status"] for r in doc["results"]}
        self.assertEqual(
            {1: "findings", 3: "invalid", 4: "ok"}, statuses)

    def test_missing_file_exit_2(self):
        code, _ = self._run(["/nonexistent/path/patterns.txt"])
        self.assertEqual(2, code)

    def test_non_utf8_file_exit_2(self):
        path = self._write(b"\xff\xfe\x00bad", mode="wb")
        code, _ = self._run([path])
        self.assertEqual(2, code)


if __name__ == "__main__":
    unittest.main()
