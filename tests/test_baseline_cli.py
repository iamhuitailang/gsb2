"""基线对比与 CLI 端到端测试。"""

import json
import os
import tempfile
import unittest

from sqli_scanner.baseline import (
    diff_against_baseline,
    load_baseline,
    save_baseline,
)
from sqli_scanner.cli import main
from sqli_scanner.scanner import scan_source

VULN_CODE = '''
def view(request):
    keyword = request.args.get("keyword")
    cursor.execute("SELECT * FROM t WHERE n = '" + keyword + "'")
'''

SAFE_CODE = '''
def view(request):
    keyword = request.args.get("keyword")
    cursor.execute("SELECT * FROM t WHERE n = ?", (keyword,))
'''

OTHER_VULN = '''
def view(request):
    keyword = request.args.get("keyword")
    cursor.execute("SELECT * FROM other WHERE n = '" + keyword + "'")
'''


class BaselineTests(unittest.TestCase):
    def test_diff_new_existing_missing(self):
        first = scan_source(VULN_CODE, path="m.py")
        baseline_map = {f.finding_id: f for f in first.findings}

        # 代码不变：全部 existing
        same = scan_source(VULN_CODE, path="m.py")
        diff = diff_against_baseline(same.findings, baseline_map)
        self.assertEqual(len(diff.existing), 1)
        self.assertEqual(diff.new, [])
        self.assertEqual(diff.missing, [])

        # 改成安全写法：原问题 missing
        safe = scan_source(SAFE_CODE, path="m.py")
        diff = diff_against_baseline(safe.findings, baseline_map)
        self.assertEqual(diff.existing, [])
        self.assertEqual(len(diff.missing), 1)

        # 换成另一条问题：旧的 missing、新的 new
        other = scan_source(OTHER_VULN, path="m.py")
        diff = diff_against_baseline(other.findings, baseline_map)
        self.assertEqual(len(diff.new), 1)
        self.assertEqual(len(diff.missing), 1)

    def test_save_and_load_roundtrip(self):
        result = scan_source(VULN_CODE, path="m.py")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "nested", "baseline.json")
            save_baseline(path, result.root, result.findings)
            loaded = load_baseline(path)
            self.assertEqual(set(loaded.keys()), {f.finding_id for f in result.findings})
            with open(path, encoding="utf-8") as fh:
                payload = json.load(fh)
            self.assertEqual(payload["tool"], "sqli_scanner")
            self.assertEqual(payload["findings"][0]["path"], "m.py")


class CliTests(unittest.TestCase):
    def _make_project(self, root):
        with open(os.path.join(root, "vuln.py"), "w", encoding="utf-8") as fh:
            fh.write(VULN_CODE)
        with open(os.path.join(root, "safe.py"), "w", encoding="utf-8") as fh:
            fh.write(SAFE_CODE)

    def test_scan_text_and_json_output(self):
        with tempfile.TemporaryDirectory() as root:
            self._make_project(root)
            json_path = os.path.join(root, "out", "report.json")
            code = main(["scan", root, "--json", json_path])
            self.assertEqual(code, 0)
            with open(json_path, encoding="utf-8") as fh:
                payload = json.load(fh)
            self.assertEqual(payload["summary"]["total"], 1)
            self.assertEqual(payload["summary"]["vulnerability"], 1)
            self.assertEqual(payload["findings"][0]["path"], "vuln.py")
            self.assertEqual(sorted(payload["files_scanned"]), ["safe.py", "vuln.py"])

    def test_fail_on_finding_exit_code(self):
        with tempfile.TemporaryDirectory() as root:
            self._make_project(root)
            self.assertEqual(main(["scan", root, "--fail-on-finding"]), 1)

            safe_root = os.path.join(root, "safe_only")
            os.makedirs(safe_root)
            with open(os.path.join(safe_root, "safe.py"), "w", encoding="utf-8") as fh:
                fh.write(SAFE_CODE)
            self.assertEqual(main(["scan", safe_root, "--fail-on-finding"]), 0)

    def test_baseline_and_diff_workflow(self):
        with tempfile.TemporaryDirectory() as root:
            self._make_project(root)
            baseline_path = os.path.join(root, "baseline.json")
            self.assertEqual(main(["baseline", root, "-o", baseline_path]), 0)
            self.assertTrue(os.path.exists(baseline_path))

            # 未修改代码：diff 应显示 existing
            rc = main(["diff", root, "-b", baseline_path])
            self.assertEqual(rc, 0)
            loaded = load_baseline(baseline_path)
            self.assertEqual(len(loaded), 1)

            # 修复后：diff 应显示 missing
            with open(os.path.join(root, "vuln.py"), "w", encoding="utf-8") as fh:
                fh.write(SAFE_CODE)
            self.assertEqual(main(["diff", root, "-b", baseline_path]), 0)

    def test_scan_skips_venv(self):
        with tempfile.TemporaryDirectory() as root:
            self._make_project(root)
            venv_dir = os.path.join(root, ".venv", "lib")
            os.makedirs(venv_dir)
            with open(os.path.join(venv_dir, "dep.py"), "w", encoding="utf-8") as fh:
                fh.write(VULN_CODE)
            json_path = os.path.join(root, "report.json")
            main(["scan", root, "--json", json_path])
            with open(json_path, encoding="utf-8") as fh:
                payload = json.load(fh)
            self.assertNotIn(".venv/lib/dep.py", payload["files_scanned"])

    def test_syntax_error_file_warns_not_crash(self):
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "broken.py"), "w", encoding="utf-8") as fh:
                fh.write("def broken(:\n")
            rc = main(["scan", root])
            self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
