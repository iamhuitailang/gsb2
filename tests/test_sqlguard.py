"""sqlguard 自动化测试，可用 python -m unittest 或 pytest 运行。"""
import json
import tempfile
import unittest
from pathlib import Path

from sqlguard.cli import main
from sqlguard.report import partition_findings, render_json, render_text
from sqlguard.scanner import run_scan

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def scan_examples(*names):
    return run_scan([str(EXAMPLES / n) for n in names])


class ExampleScanTests(unittest.TestCase):
    def test_concat_detected(self):
        r = scan_examples("vulnerable_concat.py")
        self.assertEqual(len(r.findings), 1)
        f = r.findings[0]
        self.assertEqual(f.rule, "SQLI001")
        self.assertEqual(f.severity, "high")
        self.assertEqual(f.confidence, "confirmed")
        self.assertTrue(any("sys.argv" in s.text for s in f.path))
        self.assertTrue(any("execute" in s.text for s in f.path))

    def test_parameterized_query_is_safe(self):
        r = scan_examples("safe_parameterized.py")
        self.assertEqual(r.findings, [])

    def test_cross_function_propagation(self):
        r = scan_examples("cross_function.py")
        self.assertEqual(len(r.findings), 1)
        f = r.findings[0]
        self.assertEqual(f.rule, "SQLI001")
        texts = " ".join(s.text for s in f.path)
        self.assertIn("build_query", texts)
        self.assertIn("read_user_input", texts)

    def test_shadowing_and_reassignment_are_safe(self):
        r = scan_examples("shadowing.py")
        self.assertEqual(r.findings, [])

    def test_dynamic_structure_not_protected_by_placeholders(self):
        r = scan_examples("dynamic_structure.py")
        self.assertEqual(len(r.findings), 1)
        self.assertEqual(r.findings[0].rule, "SQLI002")

    def test_web_request_source(self):
        r = scan_examples("web_request.py")
        self.assertEqual(len(r.findings), 1)
        self.assertEqual(r.findings[0].rule, "SQLI001")

    def test_unparsable_file_is_reported_not_skipped(self):
        r = scan_examples("unparsable.py")
        self.assertEqual(r.findings, [])
        self.assertEqual(len(r.errors), 1)
        self.assertIn("unparsable.py", r.errors[0]["file"])

    def test_examples_directory_as_a_whole(self):
        r = run_scan([str(EXAMPLES)])
        self.assertEqual(len(r.errors), 1)
        rules = sorted(f.rule for f in r.findings)
        self.assertEqual(rules, ["SQLI001", "SQLI001", "SQLI001", "SQLI002"])


class TempFileTests(unittest.TestCase):
    def scan_source(self, source, name="sample.py"):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        p = Path(self._tmp.name) / name
        p.write_text(source, encoding="utf-8")
        return run_scan([str(p)])

    def test_uncertain_when_passing_through_unknown_call(self):
        r = self.scan_source(
            "import sys\n"
            "from extlib import transform\n"
            "def main(cur):\n"
            "    v = transform(sys.argv[1])\n"
            "    cur.execute('SELECT * FROM t WHERE x = \"%s\"' % v)\n"
        )
        self.assertEqual(len(r.findings), 1)
        f = r.findings[0]
        self.assertEqual(f.rule, "SQLI003")
        self.assertEqual(f.confidence, "uncertain")

    def test_no_duplicate_findings_for_chained_variables(self):
        r = self.scan_source(
            "def f(cur):\n"
            "    a = input()\n"
            "    b = a\n"
            "    c = b\n"
            "    cur.execute('SELECT ' + c)\n"
        )
        self.assertEqual(len(r.findings), 1)

    def test_int_conversion_sanitizes(self):
        r = self.scan_source(
            "def f(cur):\n"
            "    v = int(input())\n"
            "    cur.execute('SELECT * FROM t WHERE id = %d' % v)\n"
        )
        self.assertEqual(r.findings, [])

    def test_fstring_concat_and_percent_all_detected(self):
        r = self.scan_source(
            "import sys\n"
            "def f(cur):\n"
            "    a = sys.argv[1]\n"
            "    cur.execute(f'SELECT {a}')\n"
            "    cur.execute('SELECT ' + a)\n"
            "    cur.execute('SELECT %s' % a)\n"
        )
        self.assertEqual(len(r.findings), 3)
        self.assertTrue(all(f.rule == "SQLI001" for f in r.findings))

    def test_directory_scan_ignores_venv_and_vcs(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "pkg").mkdir()
            (root / "pkg" / "x.py").write_text(
                "import sys\ncur.execute('SELECT ' + sys.argv[1])\n",
                encoding="utf-8")
            for hidden in (".venv", ".git", "__pycache__"):
                (root / hidden).mkdir()
                (root / hidden / "bad.py").write_text(
                    "import sys\ncur.execute('SELECT ' + sys.argv[1])\n",
                    encoding="utf-8")
            r = run_scan([str(root)])
        self.assertEqual(r.files_scanned, 1)
        self.assertEqual(len(r.findings), 1)

    def test_extra_exclude_patterns(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "a.py").write_text(
                "import sys\ncur.execute('SELECT ' + sys.argv[1])\n",
                encoding="utf-8")
            (root / "skipme").mkdir()
            (root / "skipme" / "b.py").write_text(
                "import sys\ncur.execute('SELECT ' + sys.argv[1])\n",
                encoding="utf-8")
            r = run_scan([str(root)], ["skipme"])
        self.assertEqual(r.files_scanned, 1)
        self.assertEqual(len(r.findings), 1)


class IgnoreAndReportTests(unittest.TestCase):
    def test_ignore_by_finding_id_keeps_new_findings_visible(self):
        r = scan_examples("vulnerable_concat.py", "web_request.py")
        self.assertEqual(len(r.findings), 2)
        target = r.findings[0]
        active, ignored = partition_findings(r.findings, {target.id: "历史代码"})
        self.assertEqual(len(active), 1)
        self.assertEqual(len(ignored), 1)
        self.assertEqual(ignored[0][1], "历史代码")
        # 未被忽略的另一条（相当于“新增问题”）仍然显示
        self.assertNotEqual(active[0].id, target.id)

    def test_json_report_contains_ignore_reason_and_is_stable(self):
        r = scan_examples("vulnerable_concat.py")
        fid = r.findings[0].id
        active, ignored = partition_findings(r.findings, {fid: "已确认无风险"})
        doc1 = render_json(r, active, ignored)
        doc2 = render_json(r, active, ignored)
        self.assertEqual(doc1, doc2)
        doc = json.loads(doc1)
        self.assertEqual(doc["summary"]["ignored"], 1)
        self.assertEqual(doc["findings"], [])
        self.assertEqual(doc["ignored"][0]["ignore_reason"], "已确认无风险")
        self.assertEqual(doc["ignored"][0]["id"], fid)

    def test_json_report_contains_errors(self):
        r = scan_examples("unparsable.py")
        active, ignored = partition_findings(r.findings, {})
        doc = json.loads(render_json(r, active, ignored))
        self.assertEqual(doc["summary"]["errors"], 1)
        self.assertIn("unparsable.py", doc["errors"][0]["file"])

    def test_text_report_shows_path_and_finding_id(self):
        r = scan_examples("vulnerable_concat.py")
        active, ignored = partition_findings(r.findings, {})
        text = render_text(r, active, ignored)
        self.assertIn("SQLI001", text)
        self.assertIn("传播路径", text)
        self.assertIn(r.findings[0].id, text)


class CliTests(unittest.TestCase):
    def test_exit_codes(self):
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "report.txt")
            code_safe = main([str(EXAMPLES / "safe_parameterized.py"),
                              "-o", out])
            code_vuln = main([str(EXAMPLES / "vulnerable_concat.py"),
                              "-o", out])
        self.assertEqual(code_safe, 0)
        self.assertEqual(code_vuln, 1)

    def test_json_output_and_ignore_file(self):
        r = scan_examples("vulnerable_concat.py")
        fid = r.findings[0].id
        with tempfile.TemporaryDirectory() as d:
            ignore_file = Path(d) / "ignores.txt"
            ignore_file.write_text(
                f"# 忽略清单\n{fid} 历史代码，暂不修复\n", encoding="utf-8")
            out = Path(d) / "report.json"
            code = main([str(EXAMPLES / "vulnerable_concat.py"),
                         "--format", "json",
                         "--ignore-file", str(ignore_file),
                         "-o", str(out)])
            doc = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual(doc["summary"]["findings"], 0)
        self.assertEqual(doc["summary"]["ignored"], 1)
        self.assertEqual(doc["ignored"][0]["ignore_reason"], "历史代码，暂不修复")


if __name__ == "__main__":
    unittest.main()
