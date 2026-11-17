"""CLI 端到端测试: 退出码、报告脱敏、new-only 与错误处理。"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from secretscan.cli import run

SECRET = "Zx9Qm4Tv7Lk2Pw8Rn5Yc3Hf6Dg1Ja0Nb"
AWS_KEY = "AKIAEXAMPLE333333333"


def _write_project(root: str) -> None:
    with open(os.path.join(root, "app.py"), "w", encoding="utf-8") as handle:
        handle.write(f'password = "{SECRET}"\n')
        handle.write(f'AWS = "{AWS_KEY}"\n')


class ExitCodeTest(unittest.TestCase):
    def test_missing_root_returns_2(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = run(["/nonexistent/path/secretscan-xyz"])
        self.assertEqual(code, 2)

    def test_invalid_config_returns_2(self):
        with tempfile.TemporaryDirectory() as root:
            config_path = os.path.join(root, "bad.toml")
            with open(config_path, "w", encoding="utf-8") as handle:
                handle.write("max_file_bytes = -1\n")
            code = run([root, "-c", config_path])
            self.assertEqual(code, 2)

    def test_corrupt_baseline_returns_2(self):
        with tempfile.TemporaryDirectory() as root:
            _write_project(root)
            baseline = os.path.join(root, "b.json")
            with open(baseline, "w", encoding="utf-8") as handle:
                handle.write("{broken")
            code = run([root, "-b", baseline])
            self.assertEqual(code, 2)

    def test_clean_tree_returns_0(self):
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "ok.py"), "w", encoding="utf-8") as handle:
                handle.write("TIMEOUT = 30\nNAME = 'billing'\n")
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = run([root])
            self.assertEqual(code, 0)

    def test_findings_return_1_then_baseline_then_0(self):
        with tempfile.TemporaryDirectory() as root:
            _write_project(root)
            baseline = os.path.join(root, "baseline.json")
            with redirect_stdout(io.StringIO()):
                first_code = run([root])
            self.assertEqual(first_code, 1)

            # 更新基线后再次扫描: 无新增, 退出码 0。
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                update_code = run([root, "--update-baseline", baseline])
            self.assertEqual(update_code, 0)
            with redirect_stdout(io.StringIO()):
                second_code = run([root, "-b", baseline])
            self.assertEqual(second_code, 0)

    def test_new_only_filters_report(self):
        with tempfile.TemporaryDirectory() as root:
            _write_project(root)
            baseline = os.path.join(root, "baseline.json")
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                run([root, "--update-baseline", baseline])
            # 新增一个未确认的密钥。
            with open(os.path.join(root, "app.py"), "a", encoding="utf-8") as handle:
                handle.write('token = "Qm7Tn3Kp8Wv2Lx5Rc9Yf4Hj6Ds1Za0Xb"\n')
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = run([root, "-b", baseline, "--new-only", "-f", "json"])
            self.assertEqual(code, 1)
            payload = json.loads(stdout.getvalue())
            self.assertEqual(len(payload["new_findings"]), 1)
            self.assertEqual(
                payload["new_findings"][0]["rule_id"], "credential.assignment"
            )
            self.assertEqual(payload["summary"]["finding_count"], 1)
            self.assertGreater(payload["summary"]["total_finding_count"], 1)


class RedactionTest(unittest.TestCase):
    def test_text_report_never_contains_secret_or_root(self):
        with tempfile.TemporaryDirectory() as root:
            _write_project(root)
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = run([root, "-f", "text"])
            output = stdout.getvalue()
            self.assertEqual(code, 1)
            self.assertNotIn(SECRET, output)
            self.assertNotIn(AWS_KEY, output)
            self.assertIn("***REDACTED***", output)
            self.assertNotIn(root, output)  # 绝对根目录不出现
            self.assertIn("app.py", output)  # 相对路径出现

    def test_json_report_never_contains_secret_or_root(self):
        with tempfile.TemporaryDirectory() as root:
            _write_project(root)
            out_file = os.path.join(root, "report.json")
            with redirect_stdout(io.StringIO()):
                code = run([root, "-f", "json", "-o", out_file])
            self.assertEqual(code, 1)
            raw = open(out_file, encoding="utf-8").read()
            self.assertNotIn(SECRET, raw)
            self.assertNotIn(AWS_KEY, raw)
            self.assertNotIn(root, raw)
            payload = json.loads(raw)
            finding = payload["findings"][0]
            self.assertEqual(
                set(finding),
                {
                    "path", "line", "column", "rule_id", "severity",
                    "reason", "match_length", "fingerprint", "context_redacted",
                },
            )
            self.assertIn("***REDACTED***", finding["context_redacted"])

    def test_sorting_is_stable_across_formats(self):
        with tempfile.TemporaryDirectory() as root:
            _write_project(root)
            text_buffer, json_buffer = io.StringIO(), io.StringIO()
            with redirect_stdout(text_buffer):
                run([root, "-f", "text"])
            with redirect_stdout(json_buffer):
                run([root, "-f", "json"])
            payload = json.loads(json_buffer.getvalue())
            json_order = [(f["path"], f["line"], f["column"]) for f in payload["findings"]]
            self.assertEqual(json_order, sorted(json_order))


class ErrorResilienceTest(unittest.TestCase):
    def test_unreadable_file_does_not_lose_other_results(self):
        with tempfile.TemporaryDirectory() as root:
            _write_project(root)
            locked = os.path.join(root, "locked.txt")
            with open(locked, "w", encoding="utf-8") as handle:
                handle.write(SECRET)
            os.chmod(locked, 0o000)
            try:
                if os.access(locked, os.R_OK):  # root 用户等场景下权限位无效
                    self.skipTest("当前进程可读权限位为 000 的文件, 无法模拟")
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    code = run([root, "-f", "json"])
            finally:
                os.chmod(locked, 0o644)
            self.assertEqual(code, 1)
            payload = json.loads(stdout.getvalue())
            kinds = {w["kind"] for w in payload["warnings"]}
            self.assertIn("read-error", kinds)
            # app.py 的发现仍然存在。
            self.assertTrue(
                any(f["path"] == "app.py" for f in payload["findings"])
            )


if __name__ == "__main__":
    unittest.main()
